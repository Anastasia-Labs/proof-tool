import { writeFileSync } from "node:fs";
import path from "node:path";

export const HELPER_URL_ENV = "RECLAIM_E2E_HELPER_URL";
export const HELPER_TOKEN_ENV = "RECLAIM_E2E_HELPER_TOKEN";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class PreprodHelperTargetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprodHelperTargetError";
    this.code = code;
  }
}

export function validatePreprodHelperTarget(env = process.env) {
  const rawUrl = env[HELPER_URL_ENV]?.trim();
  const token = env[HELPER_TOKEN_ENV]?.trim();
  if (!rawUrl) {
    throw new PreprodHelperTargetError(
      "helper_url_missing",
      `${HELPER_URL_ENV} is required before approved live preprod proof work.`,
    );
  }
  if (!token) {
    throw new PreprodHelperTargetError(
      "helper_token_missing",
      `${HELPER_TOKEN_ENV} is required before approved live preprod proof work.`,
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PreprodHelperTargetError("helper_url_invalid", `${HELPER_URL_ENV} must be a valid URL.`);
  }
  if (url.protocol !== "http:") {
    throw new PreprodHelperTargetError("helper_url_scheme_invalid", `${HELPER_URL_ENV} must use http on loopback.`);
  }
  if (url.username || url.password) {
    throw new PreprodHelperTargetError(
      "helper_url_credentials_forbidden",
      `${HELPER_URL_ENV} must not contain embedded credentials.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new PreprodHelperTargetError("helper_url_not_loopback", `${HELPER_URL_ENV} must point to a loopback host.`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new PreprodHelperTargetError(
      "helper_url_path_invalid",
      `${HELPER_URL_ENV} must be the helper origin without an endpoint path.`,
    );
  }
  if (url.search || url.hash) {
    throw new PreprodHelperTargetError(
      "helper_url_params_forbidden",
      `${HELPER_URL_ENV} must not contain query or fragment parameters.`,
    );
  }

  const origin = url.origin;
  return {
    schema: "proof-tool-preprod-helper-target-v1",
    helperUrl: origin,
    token,
    tokenRequired: true,
  };
}

export function writePreprodHelperTargetArtifact(target, outputDir, options = {}) {
  const writeFile = options.writeFile ?? writeFileSync;
  const artifactPath = path.join(outputDir, "helper-target.json");
  writeFile(
    artifactPath,
    `${JSON.stringify(
      {
        schema: target.schema,
        helperUrl: target.helperUrl,
        tokenRequired: true,
        token: "[redacted]",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return artifactPath;
}
