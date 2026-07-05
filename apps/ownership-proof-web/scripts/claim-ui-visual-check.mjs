import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const stateMatrix = [
  ["deployment-review", "DeploymentReview.png"],
  ["impacted-wallet", "ImpactedWallet.png"],
  ["available-claims-page-1", "AvailableClaimsPage1.png"],
  ["available-claims-page-2", "AvailableClaimsPage2.png"],
  ["available-claims-asset-modal", "AvailableClaimsAssetModal.png"],
  ["safe-wallet", "SafeWallet.png"],
  ["create-proofs-ready", "CreateProofsReady.png"],
  ["create-proofs-generating", "CreateProofsGenerating.png"],
  ["create-proofs-complete", "CreateProofsComplete.png"],
  ["current-batch", "CurrentBatch.png"],
  ["claim-funds-overview", "ClaimFundsInitialOverview.png"],
  ["claim-review-complete", "ClaimReview.png"],
];

const negativeStates = [
  "deployment-unavailable",
  "wrong-network",
  "scanning-claims",
  "no-matching-funds",
  "safe-wallet-overlap",
  "insufficient-ada",
  "helper-unavailable",
  "proof-failed",
  "signature-rejected",
  "submitted-refreshing",
];

const designDir =
  process.env.DESIGN_DIR ?? "/mnt/c/Users/phili/.codex/generated_images/019f325a-a453-7690-a8f6-03fa112a2ec2";
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3026";
const repoRoot = path.resolve(process.cwd(), "../..");
const outDir = resolveFromRepoRoot(process.env.OUT_DIR ?? "output/playwright/reclaim-owner-claim");
const threshold = Number.parseFloat(process.env.PIXELMATCH_THRESHOLD ?? "0.10");
const maxDiffRatio = Number.parseFloat(process.env.MAX_DIFF_RATIO ?? "0.0075");
const captureNegativeStates = process.env.CLAIM_CAPTURE_NEGATIVE_STATES !== "0";
const strictMode = process.env.CLAIM_VISUAL_STRICT === "1";

const actualDir = path.join(outDir, "actual");
const diffDir = path.join(outDir, "diff");

fs.mkdirSync(actualDir, { recursive: true });
fs.mkdirSync(diffDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1536, height: 1024 },
  deviceScaleFactor: 1,
});

await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });

const results = [];

try {
  for (const [state, referenceName] of stateMatrix) {
    const referencePath = path.join(designDir, referenceName);
    const actualPath = path.join(actualDir, `${state}.png`);
    const diffPath = path.join(diffDir, `${state}.png`);
    const result = await captureState(page, state, actualPath);

    if (!fs.existsSync(referencePath)) {
      results.push({ state, referenceName, actualPath, diffPath, status: "fail", reason: "missing reference" });
      continue;
    }
    if (!result.ok) {
      results.push({ state, referenceName, actualPath, diffPath, status: "fail", reason: result.reason });
      continue;
    }

    const comparison = comparePng(referencePath, actualPath, diffPath);
    results.push({
      state,
      referenceName,
      actualPath,
      diffPath,
      ...comparison,
      strictStatus: comparison.diffRatio <= maxDiffRatio ? "pass" : "fail",
      status: comparison.diffRatio <= maxDiffRatio ? "pass" : strictMode ? "fail" : "review",
      reason:
        comparison.diffRatio <= maxDiffRatio
          ? comparison.reason
          : comparison.reason || "strict pixel threshold exceeded; side-by-side review required",
    });
  }

  if (captureNegativeStates) {
    for (const state of negativeStates) {
      const actualPath = path.join(actualDir, `${state}.png`);
      const result = await captureState(page, state, actualPath);
      results.push({
        state,
        referenceName: "(manual nearest-layout review)",
        actualPath,
        diffPath: "",
        status: result.ok ? "manual" : "fail",
        strictStatus: result.ok ? "manual" : "fail",
        reason: result.ok ? "captured" : result.reason,
      });
    }
  }
} finally {
  await browser.close();
}

printSummary(results);
writeArtifacts(results);

if (results.some((result) => result.status === "fail")) {
  process.exitCode = 1;
}

async function captureState(page, state, actualPath) {
  const url = `${baseUrl}/claim?fixtureState=${encodeURIComponent(state)}`;
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(`[data-claim-state="${state}"]`, { timeout: 10_000 });
    await page.evaluate(async () => {
      if ("fonts" in document) {
        await document.fonts.ready;
      }
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: actualPath, fullPage: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function comparePng(referencePath, actualPath, diffPath) {
  const reference = PNG.sync.read(fs.readFileSync(referencePath));
  const actual = PNG.sync.read(fs.readFileSync(actualPath));
  if (reference.width !== actual.width || reference.height !== actual.height) {
    return {
      diffPixels: Number.POSITIVE_INFINITY,
      diffRatio: Number.POSITIVE_INFINITY,
      reason: `size mismatch ${actual.width}x${actual.height} vs ${reference.width}x${reference.height}`,
    };
  }

  const diff = new PNG({ width: reference.width, height: reference.height });
  const diffPixels = pixelmatch(reference.data, actual.data, diff.data, reference.width, reference.height, {
    threshold,
  });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return {
    diffPixels,
    diffRatio: diffPixels / (reference.width * reference.height),
    reason: "",
  };
}

function printSummary(rows) {
  const rendered = rows.map((row) => ({
    state: row.state,
    reference: row.referenceName,
    status: row.status,
    strict: row.strictStatus ?? row.status,
    diffPixels: Number.isFinite(row.diffPixels) ? row.diffPixels : "",
    diffRatio: Number.isFinite(row.diffRatio) ? `${(row.diffRatio * 100).toFixed(3)}%` : "",
    actual: path.relative(repoRoot, row.actualPath),
    diff: row.diffPath ? path.relative(repoRoot, row.diffPath) : "",
    reason: row.reason ?? "",
  }));
  console.table(rendered);
  console.log(`Design dir: ${designDir}`);
  console.log(`Output dir: ${outDir}`);
  console.log(`Threshold: ${threshold}`);
  console.log(`Max diff ratio: ${(maxDiffRatio * 100).toFixed(3)}%`);
  console.log(`Mode: ${strictMode ? "strict" : "review"}`);
}

function writeArtifacts(rows) {
  const summaryPath = path.join(outDir, "summary.json");
  const reviewPath = path.join(outDir, "manual-review.md");
  const serializable = rows.map((row) => ({
    state: row.state,
    reference: row.referenceName,
    status: row.status,
    strictStatus: row.strictStatus ?? row.status,
    diffPixels: Number.isFinite(row.diffPixels) ? row.diffPixels : null,
    diffRatio: Number.isFinite(row.diffRatio) ? row.diffRatio : null,
    actual: path.relative(repoRoot, row.actualPath),
    diff: row.diffPath ? path.relative(repoRoot, row.diffPath) : "",
    reason: row.reason ?? "",
  }));
  fs.writeFileSync(summaryPath, `${JSON.stringify(serializable, null, 2)}\n`);
  fs.writeFileSync(reviewPath, renderManualReview(serializable));
}

function renderManualReview(rows) {
  const lines = [
    "# Reclaim Owner Claim Visual Review",
    "",
    `Design directory: \`${designDir}\``,
    `Output directory: \`${path.relative(repoRoot, outDir)}\``,
    `Pixelmatch threshold: \`${threshold}\``,
    `Max diff ratio: \`${(maxDiffRatio * 100).toFixed(3)}%\``,
    "",
    "The canonical screenshots are compared mechanically first. States that fail the strict pixel threshold need side-by-side review of the reference, actual, and diff images.",
    "",
    "| State | Status | Diff | Reference | Actual | Diff Image | Review Notes |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
  ];

  for (const row of rows) {
    const diff = row.diffRatio === null ? "" : `${(row.diffRatio * 100).toFixed(3)}%`;
    const reference =
      row.reference === "(manual nearest-layout review)"
        ? row.reference
        : path.relative(repoRoot, path.join(designDir, row.reference));
    lines.push(
      `| ${row.state} | ${row.status} | ${diff} | ${reference} | ${row.actual} | ${row.diff} | ${reviewNote(row)} |`,
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function reviewNote(row) {
  if (row.status === "pass") {
    return "Strict pixel threshold passed.";
  }
  if (row.status === "review") {
    return "Strict pixel threshold failed; inspect side-by-side artifacts for design conformance.";
  }
  if (row.status === "manual") {
    return "Captured for nearest-layout review.";
  }
  return row.reason || "Needs visual review or polish.";
}

function resolveFromRepoRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}
