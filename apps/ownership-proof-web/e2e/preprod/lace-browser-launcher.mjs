import path from "node:path";

export const LACE_BROWSER_EXECUTABLE_ENV = "RECLAIM_E2E_LACE_BROWSER_EXECUTABLE";

export function laceBrowserOptions(env = process.env) {
  const channel = env.RECLAIM_E2E_LACE_BROWSER_CHANNEL?.trim() || "chromium";
  if (channel !== "chromium" && channel !== "msedge") {
    throw new Error("The Lace claim lane supports bundled Chromium or Microsoft Edge (msedge).");
  }
  const executablePath = env[LACE_BROWSER_EXECUTABLE_ENV]?.trim();
  if (executablePath && (channel !== "msedge" || !path.isAbsolute(executablePath))) {
    throw new Error(`${LACE_BROWSER_EXECUTABLE_ENV} requires msedge and an absolute executable path.`);
  }
  return { channel, ...(executablePath ? { executablePath } : {}) };
}

// Playwright's chromium API also controls Microsoft Edge. Keep fixture
// funding and the persistent Lace journey on the same configured browser.
export function createLaceBrowserLauncher(browserType, env = process.env) {
  const configured = laceBrowserOptions(env);
  return {
    launch: (options) => browserType.launch({ ...options, ...configured }),
    launchPersistentContext: (directory, options) =>
      browserType.launchPersistentContext(directory, { ...options, ...configured }),
  };
}

export function assertLaceBrowserIdentity(userAgent, channel) {
  if (channel === "msedge" && !/\bEdg\/[0-9]+\./u.test(userAgent)) {
    throw new Error("The configured Microsoft Edge claim lane did not launch Microsoft Edge.");
  }
}
