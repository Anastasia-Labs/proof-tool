async (page) => {
  page.setDefaultTimeout(0);

  const baseURL = 'http://127.0.0.1:8788/';
  const outputDir = 'experiments/wasm-prover/output';
  const cases = [
    {
      name: 'p0-over-w8-s32-rf2',
      tuning: { worker_count: 8, shard_count: 32, range_fetch_concurrency: 2 },
    },
  ];

  const summaries = [];
  for (const testCase of cases) {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__proverLoaded === true, null, { timeout: 0 });

    const started = Date.now();
    const result = await page.evaluate(async (testCase) => {
      const req = structuredClone(globalThis.__defaultProofRequest);
      req.tuning = { ...(req.tuning || {}), ...(testCase.tuning || {}) };
      const result = await globalThis.proveDestination(JSON.stringify(req), (progress) => {
        const stage = document.getElementById('stage');
        if (stage) stage.textContent = `${testCase.name}: ${progress.stage}`;
      });
      return {
        name: testCase.name,
        tuning: req.tuning,
        wall_seconds: result.wall_seconds,
        prove_ms: result.ms,
        peak_heap_gib: result.peak_heap_gib,
        engine: result.engine,
        verified_locally: result.verified_locally,
        trace: result.trace,
        artifact: result.artifact,
      };
    }, testCase);
    result.playwright_wall_seconds = (Date.now() - started) / 1000;

    const traceDownload = page.waitForEvent('download');
    await page.evaluate((result) => {
      const blob = new Blob([JSON.stringify(result, null, 2) + '\n'], {
        type: 'application/json',
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${result.name}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, result);
    const download = await traceDownload;
    const outputPath = `${outputDir}/${result.name}.json`;
    await download.saveAs(outputPath);

    summaries.push({
      name: result.name,
      tuning: result.tuning,
      wall_seconds: result.wall_seconds,
      prove_ms: result.prove_ms,
      peak_heap_gib: result.peak_heap_gib,
      engine: result.engine,
      verified_locally: result.verified_locally,
      trace_events: result.trace && result.trace.events ? result.trace.events.length : 0,
      output_path: outputPath,
    });
  }

  return summaries;
}
