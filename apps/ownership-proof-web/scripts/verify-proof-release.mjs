#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { blake2b } from "@noble/hashes/blake2b";

const RELEASE_ROOT = "/proof-releases/";
const STABLE_DEPLOYMENT_PATH = "/proof-assets/reclaim-deployment.json";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export async function verifyProofRelease(options = {}) {
  const baseURL = trimSlash(options.baseURL ?? "");
  const live = baseURL.length > 0;
  const webRoot = path.resolve(options.webRoot ?? "public");
  const deploymentLocation = live
    ? new URL(options.deployment ?? STABLE_DEPLOYMENT_PATH, `${baseURL}/`).toString()
    : path.resolve(options.deployment ?? path.join(webRoot, STABLE_DEPLOYMENT_PATH.slice(1)));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const fetched = new Map();

  async function load(location) {
    const key = live
      ? new URL(location, `${baseURL}/`).toString()
      : path.isAbsolute(location) && location.startsWith(`${webRoot}${path.sep}`)
        ? location
        : location.startsWith("/")
          ? path.join(webRoot, location.slice(1))
          : path.resolve(location);
    if (fetched.has(key)) return fetched.get(key);

    let resource;
    if (live) {
      const response = await fetchImpl(key, { redirect: "error" });
      check(response.ok, `${key} returned HTTP ${response.status}`);
      resource = {
        bytes: Buffer.from(await response.arrayBuffer()),
        cacheControl: response.headers.get("cache-control") ?? "",
        corp: response.headers.get("cross-origin-resource-policy") ?? "",
        permissionsPolicy: response.headers.get("permissions-policy") ?? "",
        location: key,
      };
    } else {
      resource = { bytes: await readFile(key), cacheControl: "", corp: "", permissionsPolicy: "", location: key };
    }
    fetched.set(key, resource);
    return resource;
  }

  async function loadJSON(location, label) {
    const resource = await load(location);
    try {
      return { resource, value: JSON.parse(resource.bytes.toString("utf8")) };
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { resource: deploymentResource, value: deployment } = await loadJSON(
    deploymentLocation,
    "deployment descriptor",
  );
  check(deployment?.schema === "proof-tool-reclaim-deployment-v1", "unexpected deployment schema");
  const descriptor = deployment?.proof?.browser_proving;
  check(descriptor?.enabled === true, "browser proving is not enabled");

  const { resource: chunkResource, value: chunk } = await loadJSON(descriptor.chunk_manifest_url, "chunk manifest");
  check(chunk?.schema === "proof-tool-proof-assets-chunk-manifest-v1", "unexpected chunk manifest schema");
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(chunk.release ?? ""), "unsafe or missing release id");
  const releasePrefix = `${RELEASE_ROOT}${chunk.release}/`;
  const runtimeBase = `${releasePrefix}runtime`;
  const assetsBase = `${releasePrefix}assets`;

  const exactDescriptorURLs = {
    runtime_base_url: runtimeBase,
    runtime_manifest_url: `${runtimeBase}/runtime-manifest.json`,
    prover_worker_js_url: `${runtimeBase}/prover-worker.js`,
    wasm_exec_js_url: `${runtimeBase}/wasm_exec.js`,
    manifest_url: `${assetsBase}/manifest.json`,
    manifest_sig_url: `${assetsBase}/manifest.sig`,
    chunk_manifest_url: `${assetsBase}/chunk-manifest.json`,
    chunk_manifest_sig_url: `${assetsBase}/chunk-manifest.sig`,
    deployment_manifest_url: `${assetsBase}/reclaim-deployment.json`,
    vk_url: `${assetsBase}/ownership.vk`,
    pk_index_url: `${assetsBase}/ownership.pk.idx.json`,
    proof_wasm_url: `${runtimeBase}/proof-destination.wasm`,
    worker_js_url: `${runtimeBase}/msm-worker.js`,
    msm_worker_wasm_url: `${runtimeBase}/msmworker.wasm`,
  };
  for (const [field, expected] of Object.entries(exactDescriptorURLs)) {
    equal(descriptor[field], expected, `descriptor ${field}`);
  }
  for (const field of ["pk_url", "ccs_url"]) {
    checkHTTPS(descriptor[field], `descriptor ${field}`);
  }
  checkHTTPS(chunk.transport?.base_url, "chunk transport base_url");
  check(chunk.transport?.requires_https === true, "chunk transport must require HTTPS");
  check(chunk.transport?.supports_range === true, "chunk transport must support range requests");

  const versionedDeployment = await load(descriptor.deployment_manifest_url);
  equalBytes(versionedDeployment.bytes, deploymentResource.bytes, "stable and versioned deployment descriptors");

  const [{ resource: keyManifestResource, value: keyManifest }, manifestSig, chunkSig] = await Promise.all([
    loadJSON(descriptor.manifest_url, "key manifest"),
    load(descriptor.manifest_sig_url),
    load(descriptor.chunk_manifest_sig_url),
  ]);
  verifyDetached(keyManifestResource.bytes, manifestSig.bytes, descriptor.manifest_public_key_hex, "key manifest");
  verifyDetached(chunkResource.bytes, chunkSig.bytes, descriptor.chunk_manifest_public_key_hex, "chunk manifest");

  const [manifestKeyFile, chunkKeyFile] = await Promise.all([
    load(`${assetsBase}/manifest-public-key.hex`),
    load(`${assetsBase}/chunk-manifest-public-key.hex`),
  ]);
  equal(manifestKeyFile.bytes.toString("utf8").trim(), descriptor.manifest_public_key_hex, "manifest public key file");
  equal(
    chunkKeyFile.bytes.toString("utf8").trim(),
    descriptor.chunk_manifest_public_key_hex,
    "chunk manifest public key file",
  );

  equal(digest(keyManifestResource.bytes, "sha256"), chunk.coherence?.key_manifest_sha256, "key manifest sha256");
  equal(
    digest(keyManifestResource.bytes, "blake2b256"),
    chunk.coherence?.key_manifest_blake2b256,
    "key manifest blake2b256",
  );
  verifyKeyCoherence(keyManifest, chunk.coherence, deployment);

  const { value: runtimeManifest } = await loadJSON(descriptor.runtime_manifest_url, "runtime manifest");
  check(Array.isArray(runtimeManifest?.files) && runtimeManifest.files.length > 0, "runtime manifest has no files");
  const runtimeFiles = new Map(runtimeManifest.files.map((entry) => [entry.filename, entry]));
  for (const filename of [
    "proof-destination.wasm",
    "msmworker.wasm",
    "wasm_exec.js",
    "msm-worker.js",
    "prover-worker.js",
  ]) {
    const entry = runtimeFiles.get(filename);
    check(entry, `runtime manifest does not pin ${filename}`);
    const resource = await load(`${runtimeBase}/${filename}`);
    verifyDigestEntry(
      resource.bytes,
      {
        size: entry.size_bytes,
        sha256: withPrefix("sha256", entry.sha256),
        blake2b256: withPrefix("blake2b256", entry.blake2b256),
      },
      `runtime ${filename}`,
    );
  }

  const [proverWorker, msmWorker, verifyingKey] = await Promise.all([
    load(descriptor.prover_worker_js_url),
    load(descriptor.worker_js_url),
    load(descriptor.vk_url),
  ]);
  check(proverWorker.bytes.length > 0, "prover-worker.js is empty");
  verifyDigestEntry(msmWorker.bytes, chunk.assets?.["worker.js"], "MSM worker JavaScript");
  verifyDigestEntry(
    await bytesOf(load(descriptor.proof_wasm_url)),
    chunk.assets?.["proof-destination.wasm"],
    "proof WASM",
  );
  verifyDigestEntry(
    await bytesOf(load(descriptor.msm_worker_wasm_url)),
    chunk.assets?.["msmworker.wasm"],
    "MSM worker WASM",
  );
  verifyDigestEntry(verifyingKey.bytes, chunk.assets?.["ownership.vk"], "verifying key");

  equal(descriptor.ccs_blake2b256, chunk.assets?.["ownership-destination.ccs"]?.blake2b256, "descriptor CCS hash");
  equal(descriptor.ccs_blake2b256, keyManifest.constraint_system_hash, "key manifest CCS hash");

  const { value: pkIndex } = await loadJSON(descriptor.pk_index_url, "proving key index");
  equal(pkIndex.file_size, keyManifest.proving_key_size, "proving key index file size");
  equal(pkIndex.file_size, chunk.proving_key_index?.file_size, "signed proving key index file size");
  const signedSections = Object.fromEntries(
    (chunk.proving_key_index?.sections ?? []).map((section) => [section.name, section]),
  );
  deepEqual(pkIndex.sections, signedSections, "proving key index sections");
  verifySignedChunks(chunk);

  if (live) {
    const { resource: runtimePointerResource, value: runtimePointer } = await loadJSON(
      "/claim-api/deployment",
      "runtime deployment pointer",
    );
    check(runtimePointer?.available === true, "runtime deployment pointer is unavailable");
    const runtimeComparableDeployment = structuredClone(deployment);
    // The server-side validator intentionally drops the informational
    // preprod_notes extension from the runtime response.
    delete runtimeComparableDeployment.preprod_notes;
    deepEqual(runtimePointer.manifest, runtimeComparableDeployment, "runtime and static deployment manifests");
    deepEqual(runtimePointer.deployment?.proof?.browser_proving, descriptor, "runtime browser-proving descriptor");
    check(
      runtimePointerResource.cacheControl.toLowerCase().includes("no-store"),
      `runtime deployment pointer must use no-store (cache-control: ${runtimePointerResource.cacheControl || "missing"})`,
    );
    const claimDocument = await load("/claim");
    const permissionsPolicy = claimDocument.permissionsPolicy.toLowerCase();
    check(
      permissionsPolicy.includes("loopback-network=(self)") ||
        permissionsPolicy.includes("local-network-access=(self)"),
      `claim document does not enable loopback-network permission (permissions-policy: ${claimDocument.permissionsPolicy || "missing"})`,
    );
    verifyMutableHeaders(deploymentResource, "stable deployment pointer");
    for (const resource of fetched.values()) {
      const pathname = new URL(resource.location).pathname;
      if (pathname.startsWith(releasePrefix)) verifyImmutableHeaders(resource, pathname);
    }
  }

  return {
    ok: true,
    mode: live ? "live" : "local",
    release: chunk.release,
    deployment_id: deployment.deployment_id,
    checked_resources: fetched.size,
    bulk_assets: {
      proving_key_url: descriptor.pk_url,
      constraint_system_url: descriptor.ccs_url,
      chunk_transport_url: chunk.transport.base_url,
    },
  };
}

function verifyKeyCoherence(keyManifest, coherence, deployment) {
  const checks = {
    key_version: keyManifest.key_version,
    circuit_id: keyManifest.circuit_id,
    vk_hash: keyManifest.vk_hash,
    proving_key_size: keyManifest.proving_key_size,
    proving_key_sha256: keyManifest.proving_key_sha256,
    proving_key_blake2b256: keyManifest.proving_key_blake2b256,
    verifying_key_sha256: keyManifest.verifying_key_sha256,
    verifying_key_size: keyManifest.verifying_key_size,
    constraint_system_hash: keyManifest.constraint_system_hash,
    setup_transcript_hash: keyManifest.setup_transcript_hash,
    circuit_source_commit: keyManifest.circuit_source_commit,
    gnark_version: keyManifest.gnark_version,
    proof_tool_version: keyManifest.proof_tool_version,
  };
  for (const [field, expected] of Object.entries(checks)) equal(coherence?.[field], expected, `coherence ${field}`);
  equal(deployment.proof?.key_version, coherence.key_version, "deployment key version");
  equal(deployment.proof?.circuit_id, coherence.circuit_id, "deployment circuit id");
  equal(deployment.proof?.vk_hash, coherence.vk_hash, "deployment VK hash");
  equal(deployment.reclaim_global?.verifier_vk_hash, coherence.vk_hash, "on-chain VK hash");
  equal(deployment.proof?.cardano_vk_blake2b256, coherence.cardano_vk_blake2b256, "Cardano VK hash");
  equal(
    deployment.reclaim_global?.batch_transcript_vk_hash,
    coherence.cardano_vk_blake2b256,
    "batch transcript VK hash",
  );
  equal(deployment.deployment_id, coherence.deployment_id, "deployment id");
  equal(deployment.source_commit, coherence.deployment_source_commit, "deployment source commit");
}

function verifySignedChunks(chunk) {
  const chunks = chunk.proving_key?.chunks;
  check(Array.isArray(chunks) && chunks.length > 0, "signed proving key chunk list is empty");
  let offset = 0;
  for (const [index, entry] of chunks.entries()) {
    equal(entry.index, index, `chunk ${index} index`);
    equal(entry.offset, offset, `chunk ${index} offset`);
    check(
      Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= chunk.proving_key.chunk_size,
      `chunk ${index} has invalid size`,
    );
    check(/^ownership\.pk\.part\d{4}$/u.test(entry.path), `chunk ${index} has unsafe path`);
    checkDigestString(entry.sha256, "sha256", `chunk ${index} sha256`);
    checkDigestString(entry.blake2b256, "blake2b256", `chunk ${index} blake2b256`);
    offset += entry.size;
  }
  equal(offset, chunk.coherence?.proving_key_size, "signed chunk coverage");
}

function verifyDetached(raw, signatureFile, publicKeyHex, label) {
  check(/^[0-9a-f]{64}$/iu.test(publicKeyHex ?? ""), `${label} public key is invalid`);
  const signatureHex = signatureFile.toString("utf8").trim();
  check(/^[0-9a-f]{128}$/iu.test(signatureHex), `${label} signature is invalid`);
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  check(
    verifySignature(null, raw, publicKey, Buffer.from(signatureHex, "hex")),
    `${label} signature verification failed`,
  );
}

function verifyDigestEntry(bytes, entry, label) {
  check(entry && typeof entry === "object", `${label} is not pinned`);
  equal(bytes.length, entry.size, `${label} size`);
  equal(digest(bytes, "sha256"), entry.sha256, `${label} sha256`);
  equal(digest(bytes, "blake2b256"), entry.blake2b256, `${label} blake2b256`);
}

function digest(bytes, algorithm) {
  if (algorithm === "sha256") return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return `blake2b256:${Buffer.from(blake2b(Uint8Array.from(bytes), { dkLen: 32 })).toString("hex")}`;
}

function verifyMutableHeaders(resource, label) {
  const cache = resource.cacheControl.toLowerCase();
  check(!cache.includes("immutable"), `${label} must not be immutable`);
  check(
    cache.includes("max-age=0") || cache.includes("no-store"),
    `${label} must revalidate (cache-control: ${resource.cacheControl || "missing"})`,
  );
  equal(resource.corp.toLowerCase(), "same-origin", `${label} CORP header`);
}

function verifyImmutableHeaders(resource, label) {
  const cache = resource.cacheControl.toLowerCase();
  check(
    cache.includes("immutable") && cache.includes("max-age=31536000"),
    `${label} must have immutable one-year caching`,
  );
  equal(resource.corp.toLowerCase(), "same-origin", `${label} CORP header`);
}

function checkHTTPS(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not an absolute URL`);
  }
  equal(parsed.protocol, "https:", `${label} protocol`);
}

function checkDigestString(value, prefix, label) {
  check(new RegExp(`^${prefix}:[0-9a-f]{64}$`, "iu").test(value ?? ""), `${label} is invalid`);
}

function withPrefix(prefix, value) {
  return typeof value === "string" && value.startsWith(`${prefix}:`) ? value : `${prefix}:${value}`;
}

async function bytesOf(resourcePromise) {
  return (await resourcePromise).bytes;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label} mismatch: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function equalBytes(actual, expected, label) {
  if (!actual.equals(expected)) throw new Error(`${label} do not match byte-for-byte`);
}

function deepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} mismatch`);
}

function trimSlash(value) {
  return value.replace(/\/+$/u, "");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--web-root") options.webRoot = value;
    else if (flag === "--deployment") options.deployment = value;
    else if (flag === "--base-url") options.baseURL = value;
    else throw new Error(`unknown argument: ${flag}`);
    check(value && !value.startsWith("--"), `${flag} requires a value`);
    index += 1;
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  verifyProofRelease(parseArgs(process.argv.slice(2)))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `proof release verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
