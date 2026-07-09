import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const stateMatrix = [
  ["loading-deployment", "00-loading-deployment-redesign.png"],
  ["deployment-unavailable", "01-deployment-unavailable-redesign.png"],
  ["ready-idle", "02-ready-idle-redesign.png"],
  ["wallet-connected", "03-wallet-connected-redesign.png"],
  ["credential-format-warning", "04-credential-format-warning-redesign.png"],
  ["assets-loaded", "05-assets-loaded-redesign.png"],
  ["building-transaction", "06-building-transaction-redesign.png"],
  ["review-built", "07-review-built-redesign.png"],
  ["signing-awaiting-wallet", "08-signing-awaiting-wallet-redesign.png"],
  ["submitted", "09-submitted-redesign.png"],
  ["failed-build", "10-failed-build-redesign.png"],
];

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3026";
const repoRoot = path.resolve(process.cwd(), "../..");
const outDir = resolveFromRepoRoot(process.env.OUT_DIR ?? "output/playwright/lock-funds");
const designDir = resolveFromRepoRoot(process.env.DESIGN_DIR ?? "output/playwright/lock-funds/redesigns");
const threshold = Number.parseFloat(process.env.PIXELMATCH_THRESHOLD ?? "0.10");
const maxDiffRatio = Number.parseFloat(process.env.MAX_DIFF_RATIO ?? "0.02");
const strictMode = process.env.LOCK_FUNDS_VISUAL_STRICT === "1";

const actualDir = path.join(outDir, "actual");
const mobileDir = path.join(actualDir, "mobile");
const diffDir = path.join(outDir, "diff");

fs.mkdirSync(actualDir, { recursive: true });
fs.mkdirSync(mobileDir, { recursive: true });
fs.mkdirSync(diffDir, { recursive: true });

const browser = await chromium.launch();
const desktopPage = await browser.newPage({
  viewport: { width: 1536, height: 1024 },
  deviceScaleFactor: 1,
});
const mobilePage = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  deviceScaleFactor: 2,
});

await desktopPage.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
await mobilePage.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });

const results = [];

try {
  for (const [index, [state, referenceName]] of stateMatrix.entries()) {
    const actualName = `${String(index).padStart(2, "0")}-${state}.png`;
    const actualPath = path.join(actualDir, actualName);
    const mobilePath = path.join(mobileDir, actualName);
    const diffPath = path.join(diffDir, actualName);
    const referencePath = path.join(designDir, referenceName);

    const desktopCapture = await captureState(desktopPage, state, actualPath);
    const mobileCapture = await captureState(mobilePage, state, mobilePath);

    if (!desktopCapture.ok || !mobileCapture.ok) {
      results.push({
        state,
        referenceName,
        actualPath,
        mobilePath,
        diffPath,
        status: "fail",
        strictStatus: "fail",
        reason: desktopCapture.reason || mobileCapture.reason,
      });
      continue;
    }

    if (!fs.existsSync(referencePath)) {
      results.push({
        state,
        referenceName,
        actualPath,
        mobilePath,
        diffPath,
        status: "manual",
        strictStatus: "manual",
        reason: "missing reference",
      });
      continue;
    }

    const comparison = comparePng(referencePath, actualPath, diffPath);
    const strictStatus = comparison.diffRatio <= maxDiffRatio ? "pass" : "fail";
    results.push({
      state,
      referenceName,
      actualPath,
      mobilePath,
      diffPath,
      ...comparison,
      strictStatus,
      status: strictStatus === "pass" ? "pass" : strictMode ? "fail" : "review",
      reason:
        strictStatus === "pass"
          ? comparison.reason
          : comparison.reason || "strict pixel threshold exceeded; side-by-side review required",
    });
  }
} finally {
  await browser.close();
}

printSummary(results);
writeArtifacts(results);

if (results.some((result) => result.status === "fail")) {
  process.exitCode = 1;
}

async function captureState(page, state, screenshotPath) {
  const url = `${baseUrl}/reclaim?fixtureState=${encodeURIComponent(state)}`;
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(`[data-lock-funds-state="${state}"]`, { timeout: 10_000 });
    await assertNoProofNav(page);
    await page.evaluate(async () => {
      if ("fonts" in document) {
        await document.fonts.ready;
      }
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function assertNoProofNav(page) {
  const proofLinks = await page.getByRole("link", { name: /^Proof$/i }).count();
  if (proofLinks > 0) {
    throw new Error("Unexpected Proof nav item rendered.");
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
    mobile: path.relative(repoRoot, row.mobilePath),
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
    mobile: path.relative(repoRoot, row.mobilePath),
    diff: row.diffPath ? path.relative(repoRoot, row.diffPath) : "",
    reason: row.reason ?? "",
  }));
  fs.writeFileSync(summaryPath, `${JSON.stringify(serializable, null, 2)}\n`);
  fs.writeFileSync(reviewPath, renderManualReview(serializable));
}

function renderManualReview(rows) {
  const lines = [
    "# Lock Funds Visual Review",
    "",
    `Design directory: \`${path.relative(repoRoot, designDir)}\``,
    `Output directory: \`${path.relative(repoRoot, outDir)}\``,
    `Pixelmatch threshold: \`${threshold}\``,
    `Max diff ratio: \`${(maxDiffRatio * 100).toFixed(3)}%\``,
    "",
    "Desktop screenshots are compared mechanically when the generated redesign exists at the same size. Mobile screenshots are captured for layout review.",
    "",
    "| State | Status | Diff | Reference | Actual | Mobile | Diff Image | Review Notes |",
    "| --- | --- | ---: | --- | --- | --- | --- | --- |",
  ];

  for (const row of rows) {
    const diff = row.diffRatio === null ? "" : `${(row.diffRatio * 100).toFixed(3)}%`;
    const reference = path.relative(repoRoot, path.join(designDir, row.reference));
    lines.push(
      `| ${row.state} | ${row.status} | ${diff} | ${reference} | ${row.actual} | ${row.mobile} | ${row.diff} | ${row.reason} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function resolveFromRepoRoot(candidate) {
  return path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate);
}
