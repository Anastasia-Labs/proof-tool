import { describe, expect, it } from "vitest";
import { assertLaceBrowserIdentity, createLaceBrowserLauncher, laceBrowserOptions } from "./lace-browser-launcher.mjs";

describe("Lace claim browser selection", () => {
  it("uses Edge for fixture funding and the existing wallet profile", async () => {
    const calls = [];
    const launcher = createLaceBrowserLauncher(
      {
        launch: (options) => calls.push({ options }),
        launchPersistentContext: (directory, options) => calls.push({ directory, options }),
      },
      {
        RECLAIM_E2E_LACE_BROWSER_CHANNEL: "msedge",
        RECLAIM_E2E_LACE_BROWSER_EXECUTABLE: "/opt/microsoft/msedge/msedge",
      },
    );
    await launcher.launch({ headless: true });
    await launcher.launchPersistentContext("/existing/lace-profile", { headless: false, channel: "chromium" });
    expect(calls).toEqual([
      { options: { headless: true, channel: "msedge", executablePath: "/opt/microsoft/msedge/msedge" } },
      {
        directory: "/existing/lace-profile",
        options: { headless: false, channel: "msedge", executablePath: "/opt/microsoft/msedge/msedge" },
      },
    ]);
  });

  it("rejects unsupported channels and overrides of bundled Chromium", () => {
    expect(() => laceBrowserOptions({ RECLAIM_E2E_LACE_BROWSER_CHANNEL: "chrome" })).toThrow();
    expect(() => laceBrowserOptions({ RECLAIM_E2E_LACE_BROWSER_EXECUTABLE: "/other/browser" })).toThrow();
    expect(() =>
      laceBrowserOptions({
        RECLAIM_E2E_LACE_BROWSER_CHANNEL: "msedge",
        RECLAIM_E2E_LACE_BROWSER_EXECUTABLE: "relative/edge",
      }),
    ).toThrow();
    expect(laceBrowserOptions({})).toEqual({ channel: "chromium" });
  });

  it("refuses an Edge result when the browser identifies as Chromium", () => {
    expect(() => assertLaceBrowserIdentity("Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36", "msedge")).toThrow();
    expect(() =>
      assertLaceBrowserIdentity("Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0", "msedge"),
    ).not.toThrow();
  });
});
