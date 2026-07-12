import { createRequire } from 'node:module';
import path from 'node:path';

export async function createBrowserAdapter({ repoRoot, baseURL }) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(path.join(repoRoot, 'apps/ownership-proof-web/node_modules/playwright'));
  let browser;
  let page;

  async function ensurePage() {
    if (page) return page;
    browser = await chromium.launch({ headless: true, chromiumSandbox: false });
    page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__proverLoaded === true, null, { timeout: 0 });
    return page;
  }

  return {
    async capabilities() {
      const activePage = await ensurePage();
      return activePage.evaluate(() => globalThis.__wasmProverCapabilities || { optimization_flags: [] });
    },
    async runCase(testCase) {
      const activePage = await ensurePage();
      return activePage.evaluate(async ({ name, tuning }) => {
        const request = structuredClone(globalThis.__defaultProofRequest);
        request.tuning = { ...(request.tuning || {}), ...tuning };
        const result = await globalThis.proveDestination(JSON.stringify(request), () => {});
        const keyManifestResponse = await fetch(request.artifacts.manifest_url);
        const keyManifestRaw = await keyManifestResponse.text();
        const keyManifest = JSON.parse(keyManifestRaw);
        const chunkManifestResponse = await fetch(request.artifacts.chunk_manifest_url);
        const chunkManifestRaw = await chunkManifestResponse.text();
        const chunkManifest = JSON.parse(chunkManifestRaw);
        const deploymentManifestResponse = await fetch(request.artifacts.deployment_manifest_url);
        const deploymentManifestRaw = await deploymentManifestResponse.text();
        if (!deploymentManifestResponse.ok) {
          throw new Error(`deployment manifest fetch returned ${deploymentManifestResponse.status}`);
        }
        const sha256 = async (raw) => {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
          return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        };
        const keyManifestSHA256 = await sha256(keyManifestRaw);
        if (chunkManifest.coherence.key_manifest_sha256 !== keyManifestSHA256) {
          throw new Error('key manifest raw SHA-256 disagrees with chunk-manifest coherence');
        }
        for (const field of [
          'circuit_id',
          'vk_hash',
          'proving_key_sha256',
          'proving_key_blake2b256',
          'verifying_key_sha256',
          'constraint_system_hash',
        ]) {
          if (chunkManifest.coherence[field] !== keyManifest[field]) {
            throw new Error(`key/chunk manifest coherence mismatch for ${field}`);
          }
        }
        return {
          name,
          ...result,
          asset_identity: {
            key_manifest_sha256: keyManifestSHA256,
            key_manifest_blake2b256: chunkManifest.coherence.key_manifest_blake2b256,
            chunk_manifest_sha256: await sha256(chunkManifestRaw),
            deployment_manifest_sha256: await sha256(deploymentManifestRaw),
            proving_key_sha256: keyManifest.proving_key_sha256,
            proving_key_blake2b256: keyManifest.proving_key_blake2b256,
            constraint_system_hash: keyManifest.constraint_system_hash,
            verifying_key_sha256: keyManifest.verifying_key_sha256,
            vk_hash: keyManifest.vk_hash,
            circuit_id: keyManifest.circuit_id,
            key_version: keyManifest.key_version,
          },
        };
      }, testCase);
    },
    async close() {
      await browser?.close();
    },
  };
}
