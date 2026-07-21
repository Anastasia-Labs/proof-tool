#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createRealLaceProfileDriverFromEnv } from "./real-lace-driver.mjs";

const DEFAULT_OUTPUT_DIR = "output/preprod-e2e/lace-profile";

async function main() {
  const env = process.env;
  const outputDir = path.resolve(process.cwd(), env.RECLAIM_E2E_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR);
  mkdirSync(outputDir, { recursive: true });
  const artifactPath = path.join(outputDir, "lace-profile-validation.json");
  let context = null;
  try {
    const driver = await createRealLaceProfileDriverFromEnv({
      env,
      cwd: process.cwd(),
    });
    context = await driver.launchBrowserContext(chromium, { headless: false });
    const artifact = await driver.validateProfile();
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(`lace_profile_validation=${artifactPath}`);
  } catch (error) {
    console.error(
      `${error?.code ?? "lace_profile_validation_failed"}: ${error?.message ?? "Lace profile validation failed."}`,
    );
    process.exitCode = 1;
  } finally {
    if (context && typeof context.close === "function") {
      await context.close();
    }
  }
}

await main();
