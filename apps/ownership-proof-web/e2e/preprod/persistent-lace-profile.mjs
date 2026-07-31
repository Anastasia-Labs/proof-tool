import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const PERSISTENT_LACE_PROFILE_DIR_NAME = "lace-e2e-preprod-profile-v2";
export const LACE_PROFILE_ENV_FILE_ENV = "RECLAIM_E2E_LACE_PROFILE_ENV_FILE";
export const LACE_WALLET_PASSWORD_ENV = "RECLAIM_E2E_LACE_WALLET_PASSWORD";

const INITIALIZED_PROFILE_PATHS = Object.freeze([
  "Local State",
  path.join("Default", "Preferences"),
  path.join("Default", "Local Extension Settings"),
]);

export class PersistentLaceProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PersistentLaceProfileError";
    this.code = code;
  }
}

export function persistentLaceProfileEnvFile(repoRoot) {
  return path.join(repoRoot, "output", "playwright", PERSISTENT_LACE_PROFILE_DIR_NAME, "profile.env");
}

export function loadPersistentLaceProfileEnv(options) {
  const env = options.env;
  const profileEnvFile = path.resolve(options.profileEnvFile);
  const fileExists = options.fileExists ?? existsSync;
  const readTextFile = options.readTextFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  if (!fileExists(profileEnvFile)) {
    throw new PersistentLaceProfileError(
      "persistent_lace_profile_env_missing",
      "The persistent Lace profile.env is missing. Restore it with the existing profile; do not bootstrap a replacement.",
    );
  }

  let profileEnv;
  try {
    profileEnv = parseEnv(readTextFile(profileEnvFile));
  } catch {
    throw new PersistentLaceProfileError(
      "persistent_lace_profile_env_invalid",
      "The persistent Lace profile.env could not be parsed.",
    );
  }
  const effectiveEnv = { ...env, ...profileEnv };
  const profile = assertPersistentLaceProfileSelection({
    env: effectiveEnv,
    fileExists,
    profileEnvFile,
  });
  Object.assign(env, profileEnv);
  return profile;
}

export function assertPersistentLaceProfileSelection({ env, profileEnvFile, fileExists = existsSync }) {
  const expectedProfileDir = path.dirname(path.resolve(profileEnvFile));
  const configured = String(env?.PW_USER_DATA_DIR ?? "").trim();
  if (!configured) {
    throw new PersistentLaceProfileError(
      "persistent_lace_profile_path_missing",
      "The persistent Lace profile.env must set PW_USER_DATA_DIR.",
    );
  }
  const configuredProfileDir = path.resolve(configured);
  if (configuredProfileDir !== expectedProfileDir) {
    throw new PersistentLaceProfileError(
      "persistent_lace_profile_path_mismatch",
      "PW_USER_DATA_DIR must select the persistent Lace profile stored beside the chosen profile.env; refusing to use or create another profile.",
    );
  }
  if (!fileExists(configuredProfileDir)) {
    throw new PersistentLaceProfileError(
      "persistent_lace_profile_missing",
      "The persistent Lace profile is missing. Restore it together with profile.env; do not bootstrap a replacement profile.",
    );
  }
  if (!hasInitializedLaceProfileState(configuredProfileDir, fileExists)) {
    throw new PersistentLaceProfileError(
      "persistent_lace_profile_uninitialized",
      "The persistent Lace profile is uninitialized. Refusing to launch Chromium because that could create a replacement profile; restore the existing profile and profile.env instead.",
    );
  }
  if (!String(env?.[LACE_WALLET_PASSWORD_ENV] ?? "").trim()) {
    throw new PersistentLaceProfileError(
      "persistent_lace_profile_password_missing",
      `The persistent Lace profile.env must set ${LACE_WALLET_PASSWORD_ENV}.`,
    );
  }
  return Object.freeze({
    envFile: path.resolve(profileEnvFile),
    name: path.basename(configuredProfileDir),
    profileDir: configuredProfileDir,
  });
}

export function hasInitializedLaceProfileState(profileDir, fileExists = existsSync) {
  return INITIALIZED_PROFILE_PATHS.every((relativePath) => fileExists(path.join(profileDir, relativePath)));
}
