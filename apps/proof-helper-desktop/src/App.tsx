import {
  CheckCircle2,
  CircleStop,
  Download,
  ExternalLink,
  FolderKey,
  Info,
  Loader2,
  Power,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Wrench,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopApi,
  HelperStartup,
  KeyBundleProgress,
  KeyBundleStatus,
  ProofAssetInstallProgress,
  RuntimeDiagnostics,
} from "./desktopApi";
import { tauriDesktopApi } from "./desktopApi";

type AppProps = {
  api?: DesktopApi;
  showDeveloperControls?: boolean;
};

type BusyState = "status" | "start" | "stop" | "install" | "delete" | null;
type Tone = "ok" | "warn" | "bad" | "idle";

const defaultSiteURL = import.meta.env.VITE_PROOF_SITE_URL ?? "http://127.0.0.1:3002";
// Extra browser origins (beyond the site URL) the local helper should accept,
// e.g. Vercel branch-preview deployments. Baked at build time via
// VITE_PROOF_HELPER_ALLOWED_ORIGINS as a comma-separated list.
const defaultAllowedOrigins = parseOriginList(import.meta.env.VITE_PROOF_HELPER_ALLOWED_ORIGINS);
const defaultSidecarPath = import.meta.env.VITE_PROOF_HELPER_SIDECAR_PATH ?? "";
const defaultFixtureMode = import.meta.env.VITE_PROOF_HELPER_FIXTURE === "1";
const defaultDevCreateKeys = import.meta.env.VITE_PROOF_HELPER_DEV_CREATE_KEYS === "1";
const defaultShowDeveloperControls = import.meta.env.VITE_PROOF_HELPER_DEV_CONTROLS === "1";
const appVersion = import.meta.env.VITE_PROOF_HELPER_APP_VERSION ?? "0.1.0";

export function App({ api = tauriDesktopApi, showDeveloperControls = defaultShowDeveloperControls }: AppProps) {
  const [keyStatus, setKeyStatus] = useState<KeyBundleStatus | null>(null);
  const [helperRunning, setHelperRunning] = useState(false);
  const [startup, setStartup] = useState<HelperStartup | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [siteUrl, setSiteUrl] = useState(defaultSiteURL);
  const [sidecarPath, setSidecarPath] = useState(defaultSidecarPath);
  const [bundleSourceDir, setBundleSourceDir] = useState("");
  const [trustedManifestKey, setTrustedManifestKey] = useState("");
  const [signatureKeyId, setSignatureKeyId] = useState("proof-helper-release-v1");
  const [fixture, setFixture] = useState(defaultFixtureMode);
  const [devCreateKeys, setDevCreateKeys] = useState(defaultDevCreateKeys);
  const [busy, setBusy] = useState<BusyState>("status");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<Tone>("idle");
  const [installProgress, setInstallProgress] = useState<ProofAssetInstallProgress | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);

  const keyTone = useMemo(() => toneForKey(keyStatus), [keyStatus]);
  const helperTone = helperRunning || startup ? "ok" : busy === "start" ? "warn" : "idle";
  const view = useMemo(
    () => buildViewModel({ keyStatus, helperRunning, startup, busy, message, messageTone }),
    [busy, helperRunning, keyStatus, message, messageTone, startup],
  );

  useEffect(() => {
    let active = true;
    let unlistenKeyBundle: (() => void) | undefined;
    let unlistenProofAssets: (() => void) | undefined;
    void api
      .onKeyBundleProgress((progress) => {
        if (active) {
          setInstallProgress(localInstallProgress(progress));
        }
      })
      .then((nextUnlisten) => {
        if (active) {
          unlistenKeyBundle = nextUnlisten;
        } else {
          nextUnlisten();
        }
      })
      .catch((error) => {
        if (active) {
          setMessage(messageFor(error));
          setMessageTone("bad");
        }
      });
    void api
      .onProofAssetInstallProgress((progress) => {
        if (active) {
          setInstallProgress(progress);
        }
      })
      .then((nextUnlisten) => {
        if (active) {
          unlistenProofAssets = nextUnlisten;
        } else {
          nextUnlisten();
        }
      })
      .catch((error) => {
        if (active) {
          setMessage(messageFor(error));
          setMessageTone("bad");
        }
      });
    void refresh();
    void api.helperProcessStatus().then((status) => {
      if (active) {
        setHelperRunning(status.running);
      }
    });
    void api.runtimeDiagnostics().then((diagnostics) => {
      if (active) {
        setRuntimeDiagnostics(diagnostics);
      }
    });
    return () => {
      active = false;
      unlistenKeyBundle?.();
      unlistenProofAssets?.();
    };

    async function refresh() {
      try {
        const status = await api.keyStatus();
        if (active) {
          setKeyStatus(status);
          setMessage("");
        }
      } catch (error) {
        if (active) {
          setMessage(messageFor(error));
          setMessageTone("bad");
        }
      } finally {
        if (active) {
          setBusy(null);
        }
      }
    }
  }, [api]);

  const refreshStatus = async () => {
    setBusy("status");
    setMessage("");
    try {
      const [nextKeyStatus, process, diagnostics] = await Promise.all([
        api.keyStatus(),
        api.helperProcessStatus(),
        api.runtimeDiagnostics(),
      ]);
      setKeyStatus(nextKeyStatus);
      setHelperRunning(process.running);
      setRuntimeDiagnostics(diagnostics);
    } catch (error) {
      setMessage(messageFor(error));
      setMessageTone("bad");
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy("start");
    setMessage("");
    try {
      const next = await api.startHelper({
        siteUrl,
        allowedOrigins: defaultAllowedOrigins,
        sidecarPath: sidecarPath.trim() || undefined,
        fixture,
        devCreateKeys,
      });
      setStartup(next);
      setHelperRunning(true);
      void api
        .keyStatus()
        .then((status) => setKeyStatus(status))
        .catch(() => undefined);
      await api.openUrl(next.pairing_url);
    } catch (error) {
      setMessage(messageFor(error));
      setMessageTone("bad");
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy("stop");
    setMessage("");
    try {
      await api.stopHelper();
      setHelperRunning(false);
      setStartup(null);
    } catch (error) {
      setMessage(messageFor(error));
      setMessageTone("bad");
    } finally {
      setBusy(null);
    }
  };

  const deleteCache = async () => {
    setBusy("delete");
    setMessage("");
    setInstallProgress(null);
    try {
      const next = await api.deleteKeyCache();
      setKeyStatus(next);
    } catch (error) {
      setMessage(messageFor(error));
      setMessageTone("bad");
    } finally {
      setBusy(null);
    }
  };

  const installProofAssets = async () => {
    setBusy("install");
    setMessage("");
    setCancelRequested(false);
    setInstallProgress(null);
    try {
      const next = await api.installProofAssetsRelease();
      setKeyStatus(next);
      setMessage("Proof assets installed and verified.");
      setMessageTone("ok");
    } catch (error) {
      const text = messageFor(error);
      setMessage(
        text.includes("not enough disk space")
          ? `Not enough free disk space to install the proof assets (about 5 GB needed). Free up some space, then click Install proof assets to retry. (${text})`
          : text,
      );
      setMessageTone("bad");
    } finally {
      setBusy(null);
    }
  };

  // First-run convenience: the proof assets are required for everything the
  // app does, so start installing them as soon as the app opens and finds
  // them missing. Attempted once per app run — on failure (e.g. low disk
  // space) the message above explains and the Install button retries.
  // Deliberately not triggered for the "invalid" state, which keeps its
  // explicit Blocked/replace flow.
  const autoInstallAttempted = useRef(false);
  useEffect(() => {
    if (autoInstallAttempted.current) {
      return;
    }
    if (keyStatus?.state !== "missing" || busy !== null) {
      return;
    }
    autoInstallAttempted.current = true;
    void installProofAssets();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot, guarded by ref
  }, [keyStatus, busy]);

  const installBundle = async () => {
    setBusy("install");
    setMessage("");
    setCancelRequested(false);
    setInstallProgress(null);
    try {
      const next = await api.activateKeyBundle({
        sourceDir: bundleSourceDir,
        trustedManifestPublicKeyHex: trustedManifestKey,
        expectedSignatureKeyId: signatureKeyId,
        minFreeBytes: 1,
      });
      setKeyStatus(next);
      setMessage("Proof assets installed and verified.");
      setMessageTone("ok");
    } catch (error) {
      setMessage(messageFor(error));
      setMessageTone("bad");
    } finally {
      setBusy(null);
    }
  };

  const cancelInstall = async () => {
    setCancelRequested(true);
    setMessage("");
    try {
      await api.cancelKeyBundleActivation();
    } catch (error) {
      setMessage(messageFor(error));
      setMessageTone("bad");
      setCancelRequested(false);
    }
  };

  const openWebsite = async () => {
    if (!startup) {
      return;
    }
    await api.openUrl(startup.pairing_url);
  };

  const proofAssetsBlocked = Boolean(keyStatus && !keyStatus.ready);
  const primaryAction = proofAssetsBlocked ? installProofAssets : startup ? openWebsite : connect;
  const primaryLabel = proofAssetsBlocked
    ? keyStatus?.state === "missing"
      ? "Install Proof Assets"
      : "Replace Proof Assets"
    : startup
      ? "Return to Reclaim"
      : "Open Reclaim";
  const primaryIcon = proofAssetsBlocked ? "install" : "open";
  const primaryDisabled =
    busy === "start" || busy === "status" || busy === "install" || (!proofAssetsBlocked && helperRunning && !startup);

  return (
    <ProductionShell
      keyStatus={keyStatus}
      keyTone={keyTone}
      helperTone={helperTone}
      helperRunning={helperRunning}
      startup={startup}
      siteUrl={siteUrl}
      appVersion={appVersion}
      runtimeDiagnostics={runtimeDiagnostics}
      view={view}
      busy={busy}
      message={message}
      messageTone={messageTone}
      installProgress={installProgress}
      onRefresh={refreshStatus}
      onPrimaryAction={primaryAction}
      primaryLabel={primaryLabel}
      primaryIcon={primaryIcon}
      primaryDisabled={primaryDisabled}
      onStop={stop}
      onDeleteProofAssets={deleteCache}
      onCancelInstall={cancelInstall}
      cancelRequested={cancelRequested}
    >
      {showDeveloperControls ? (
        <AdvancedDeveloperControls
          bundleSourceDir={bundleSourceDir}
          trustedManifestKey={trustedManifestKey}
          signatureKeyId={signatureKeyId}
          siteUrl={siteUrl}
          sidecarPath={sidecarPath}
          fixture={fixture}
          devCreateKeys={devCreateKeys}
          busy={busy}
          cancelRequested={cancelRequested}
          onBundleSourceDirChange={setBundleSourceDir}
          onTrustedManifestKeyChange={setTrustedManifestKey}
          onSignatureKeyIdChange={setSignatureKeyId}
          onSiteUrlChange={setSiteUrl}
          onSidecarPathChange={setSidecarPath}
          onFixtureChange={setFixture}
          onDevCreateKeysChange={setDevCreateKeys}
          onInstallBundle={installBundle}
          onCancelInstall={cancelInstall}
        />
      ) : null}
    </ProductionShell>
  );
}

function ProductionShell({
  keyStatus,
  keyTone,
  helperTone,
  helperRunning,
  startup,
  siteUrl,
  appVersion,
  runtimeDiagnostics,
  view,
  busy,
  message,
  messageTone,
  installProgress,
  primaryDisabled,
  primaryLabel,
  primaryIcon,
  onRefresh,
  onPrimaryAction,
  onStop,
  onDeleteProofAssets,
  onCancelInstall,
  cancelRequested,
  children,
}: {
  keyStatus: KeyBundleStatus | null;
  keyTone: Tone;
  helperTone: Tone;
  helperRunning: boolean;
  startup: HelperStartup | null;
  siteUrl: string;
  appVersion: string;
  runtimeDiagnostics: RuntimeDiagnostics | null;
  view: ViewModel;
  busy: BusyState;
  message: string;
  messageTone: Tone;
  installProgress: ProofAssetInstallProgress | null;
  primaryDisabled: boolean;
  primaryLabel: string;
  primaryIcon: "install" | "open";
  onRefresh: () => void;
  onPrimaryAction: () => void;
  onStop: () => void;
  onDeleteProofAssets: () => void;
  onCancelInstall: () => void;
  cancelRequested: boolean;
  children?: React.ReactNode;
}) {
  return (
    <main className="app-shell">
      <aside className="status-rail" aria-label="Proof Helper status">
        <div className="brand-block">
          <FolderKey size={28} />
          <div>
            <h1>Proof Helper</h1>
            <p>Local reclaim support</p>
          </div>
        </div>
        <StatusLine label="Proof assets" value={labelForKey(keyStatus)} tone={keyTone} />
        <StatusLine label="Local helper" value={helperRunning || startup ? "Running" : "Stopped"} tone={helperTone} />
        <StatusLine label="Reclaim website" value={startup ? "Connected" : "Not connected"} tone={startup ? "ok" : "idle"} />
        <StatusLine label="App version" value={appVersion} tone="idle" />
      </aside>

      <section className="workspace" aria-label="Proof Helper workspace">
        <header className="workspace-header">
          <div>
            <h2>{view.label}</h2>
            <p>{view.sentence}</p>
          </div>
          <button className="icon-button" type="button" onClick={onRefresh} aria-label="Refresh status">
            {busy === "status" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
        </header>

        <section className={`current-state ${view.tone}`} aria-live="polite">
          <div className="state-icon" aria-hidden="true">
            <view.Icon size={26} />
          </div>
          <div className="state-copy">
            <span>{view.eyebrow}</span>
            <h3>{view.headline}</h3>
            <p>{view.detail}</p>
          </div>
          <div className="state-actions">
            <button className="primary-button" type="button" onClick={onPrimaryAction} disabled={primaryDisabled}>
              {busy === "start" || busy === "install" ? (
                <Loader2 className="spin" size={17} />
              ) : primaryIcon === "install" ? (
                <Download size={17} />
              ) : (
                <ExternalLink size={17} />
              )}
              {primaryLabel}
            </button>
            {busy === "install" ? (
              <button className="secondary-button" type="button" onClick={onCancelInstall} disabled={cancelRequested}>
                {cancelRequested ? <Loader2 className="spin" size={17} /> : <CircleStop size={17} />}
                Cancel Install
              </button>
            ) : null}
            {helperRunning || startup ? (
              <button className="secondary-button" type="button" onClick={onStop} disabled={busy === "stop"}>
                {busy === "stop" ? <Loader2 className="spin" size={17} /> : <Power size={17} />}
                Stop Helper
              </button>
            ) : null}
          </div>
        </section>

        {busy === "install" || installProgress ? <InstallProgressView progress={installProgress} /> : null}

        <section className="support-grid" aria-label="Proof Helper details">
          <SupportItem
            label="Proof assets"
            value={proofAssetSummary(keyStatus)}
            tone={keyTone}
            detail={keyStatus?.error ?? proofAssetDetail(keyStatus)}
          />
          <SupportItem
            label="Website connection"
            value={startup ? "Paired" : "Waiting"}
            tone={startup ? "ok" : "idle"}
            detail={startup ? "The reclaim website can talk to this computer." : "Open Reclaim pairs the browser automatically."}
          />
          <SupportItem
            label="Local secrets"
            value="Stay on this computer"
            tone="idle"
            detail="Proofs are created on this computer. Your recovery phrase is never sent to Reclaim servers."
          />
        </section>

        {message ? (
          <section className="event-strip" aria-live="polite">
            <StateMessage tone={messageTone} text={message} />
          </section>
        ) : null}

        <DiagnosticsDrawer
          keyStatus={keyStatus}
          startup={startup}
          siteUrl={siteUrl}
          runtimeDiagnostics={runtimeDiagnostics}
          busy={busy}
          onDeleteProofAssets={onDeleteProofAssets}
        />

        {children}
      </section>
    </main>
  );
}

function AdvancedDeveloperControls({
  bundleSourceDir,
  trustedManifestKey,
  signatureKeyId,
  siteUrl,
  sidecarPath,
  fixture,
  devCreateKeys,
  busy,
  cancelRequested,
  onBundleSourceDirChange,
  onTrustedManifestKeyChange,
  onSignatureKeyIdChange,
  onSiteUrlChange,
  onSidecarPathChange,
  onFixtureChange,
  onDevCreateKeysChange,
  onInstallBundle,
  onCancelInstall,
}: {
  bundleSourceDir: string;
  trustedManifestKey: string;
  signatureKeyId: string;
  siteUrl: string;
  sidecarPath: string;
  fixture: boolean;
  devCreateKeys: boolean;
  busy: BusyState;
  cancelRequested: boolean;
  onBundleSourceDirChange: (value: string) => void;
  onTrustedManifestKeyChange: (value: string) => void;
  onSignatureKeyIdChange: (value: string) => void;
  onSiteUrlChange: (value: string) => void;
  onSidecarPathChange: (value: string) => void;
  onFixtureChange: (value: boolean) => void;
  onDevCreateKeysChange: (value: boolean) => void;
  onInstallBundle: () => void;
  onCancelInstall: () => void;
}) {
  return (
    <details className="developer-panel" open>
      <summary>
        <Wrench size={17} />
        Developer controls
      </summary>
      <div className="developer-grid">
        <label className="field">
          <span>Bundle source</span>
          <input
            value={bundleSourceDir}
            onChange={(event) => onBundleSourceDirChange(event.target.value)}
            placeholder="Directory with manifest.json and key files"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Manifest public key</span>
          <input
            value={trustedManifestKey}
            onChange={(event) => onTrustedManifestKeyChange(event.target.value)}
            placeholder="64 hex characters"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Signature key id</span>
          <input
            value={signatureKeyId}
            onChange={(event) => onSignatureKeyIdChange(event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Website URL</span>
          <input value={siteUrl} onChange={(event) => onSiteUrlChange(event.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          <span>Sidecar path</span>
          <input
            value={sidecarPath}
            onChange={(event) => onSidecarPathChange(event.target.value)}
            placeholder="Bundled sidecar or PROOF_HELPER_SIDECAR_PATH"
            spellCheck={false}
          />
        </label>
        <div className="toggle-row">
          <label>
            <input type="checkbox" checked={fixture} onChange={(event) => onFixtureChange(event.target.checked)} />
            Fixture
          </label>
          <label>
            <input
              type="checkbox"
              checked={devCreateKeys}
              onChange={(event) => onDevCreateKeysChange(event.target.checked)}
            />
            Dev keys
          </label>
        </div>
      </div>
      <div className="button-row">
        <button
          className="primary-button"
          type="button"
          onClick={onInstallBundle}
          disabled={busy === "install" || bundleSourceDir.trim() === "" || trustedManifestKey.trim() === ""}
        >
          {busy === "install" ? <Loader2 className="spin" size={17} /> : <FolderKey size={17} />}
          Install local proof assets
        </button>
        {busy === "install" ? (
          <button className="secondary-button" type="button" onClick={onCancelInstall} disabled={cancelRequested}>
            {cancelRequested ? <Loader2 className="spin" size={17} /> : <CircleStop size={17} />}
            Cancel install
          </button>
        ) : null}
      </div>
    </details>
  );
}

function DiagnosticsDrawer({
  keyStatus,
  startup,
  siteUrl,
  runtimeDiagnostics,
  busy,
  onDeleteProofAssets,
}: {
  keyStatus: KeyBundleStatus | null;
  startup: HelperStartup | null;
  siteUrl: string;
  runtimeDiagnostics: RuntimeDiagnostics | null;
  busy: BusyState;
  onDeleteProofAssets: () => void;
}) {
  return (
    <details className="diagnostics-drawer">
      <summary>
        <Info size={17} />
        Diagnostics
      </summary>
      <dl className="details">
        <Detail label="Site" value={originLabel(siteUrl)} />
        <Detail label="Platform" value={runtimePlatformLabel(runtimeDiagnostics)} />
        <Detail label="Executable" value={runtimeDiagnostics?.current_exe ?? "Unavailable"} />
        <Detail label="Resources" value={runtimeDiagnostics?.resource_dir ?? "Unavailable"} />
        <Detail label="Bundled sidecar" value={sidecarCandidateSummary(runtimeDiagnostics)} />
        <Detail label="Helper endpoint" value={redactedHelperEndpoint(startup?.helper_url)} />
        <Detail label="Helper version" value={startup?.sidecar_version ?? "Not running"} />
        <Detail label="Protocol" value={startup?.protocol_version ?? "proof-helper-v1"} />
        <Detail label="Circuit" value={keyStatus?.circuit_id ?? startup?.circuit_id ?? "Unavailable"} />
        <Detail label="Key version" value={keyStatus?.key_version ?? startup?.key_version ?? "Unavailable"} />
        <Detail label="Key hash" value={shortHash(keyStatus?.vk_hash ?? startup?.key_hash)} />
        <Detail label="Expected release" value={keyStatus?.expected_release_tag ?? "Unavailable"} />
        <Detail label="Installed release" value={keyStatus?.installed_release_tag ?? "None"} />
        <Detail label="Signature key" value={keyStatus?.signature_key_id ?? "Unavailable"} />
        <Detail label="Expected hash" value={shortHash(keyStatus?.expected_vk_hash)} />
        <Detail label="Installed at" value={keyStatus?.installed_at ?? "Unavailable"} />
        <Detail label="App data" value={keyStatus?.app_data_dir ?? "Checking"} />
        <Detail label="Last error" value={keyStatus?.error ?? "None"} />
      </dl>
      <button
        className="secondary-button danger-button"
        type="button"
        onClick={onDeleteProofAssets}
        disabled={busy === "delete" || busy === "install"}
      >
        {busy === "delete" ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
        Remove proof assets
      </button>
    </details>
  );
}

function InstallProgressView({ progress }: { progress: ProofAssetInstallProgress | null }) {
  const percent = progressPercent(progress);
  return (
    <div className="progress-block" aria-label="Proof asset activation progress">
      <div>
        <span>{progress ? installProgressLabel(progress) : "Preparing proof assets"}</span>
        <strong>{percent === null ? "Starting" : `${percent}%`}</strong>
      </div>
      <progress value={percent ?? 0} max={100} />
    </div>
  );
}

function SupportItem({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: Tone }) {
  return (
    <div className="support-item">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <p>{detail}</p>
      <i className={`dot ${tone}`} aria-hidden="true" />
    </div>
  );
}

function StatusLine({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="status-line">
      <i className={`dot ${tone}`} aria-hidden="true" />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StateMessage({ tone, text }: { tone: Tone; text: string }) {
  const Icon = tone === "bad" ? ShieldAlert : CheckCircle2;
  return (
    <div className={`state-message ${tone}`}>
      <Icon size={18} />
      <span>{text}</span>
    </div>
  );
}

type ViewModel = {
  label: string;
  sentence: string;
  eyebrow: string;
  headline: string;
  detail: string;
  tone: Tone;
  Icon: typeof CheckCircle2;
};

function buildViewModel({
  keyStatus,
  helperRunning,
  startup,
  busy,
  message,
  messageTone,
}: {
  keyStatus: KeyBundleStatus | null;
  helperRunning: boolean;
  startup: HelperStartup | null;
  busy: BusyState;
  message: string;
  messageTone: Tone;
}): ViewModel {
  if (message && messageTone === "bad") {
    return {
      label: "Blocked",
      sentence: "Proof Helper needs attention before the reclaim flow can continue.",
      eyebrow: "Action needed",
      headline: "Something stopped the helper",
      detail: message,
      tone: "bad",
      Icon: ShieldAlert,
    };
  }
  if (busy === "install") {
    return {
      label: "Updating proof assets",
      sentence: "Proof Helper is downloading and verifying signed proof assets.",
      eyebrow: "Working",
      headline: "Installing proof assets",
      detail: "The current active assets stay untouched until the replacement passes verification.",
      tone: "warn",
      Icon: Loader2,
    };
  }
  if (busy === "start") {
    return {
      label: "Opening Reclaim",
      sentence: "Proof Helper is starting locally and pairing the reclaim website.",
      eyebrow: "Working",
      headline: "Opening the browser",
      detail: "Keep this app open while the reclaim website creates proofs through the local helper.",
      tone: "warn",
      Icon: Loader2,
    };
  }
  if (busy === "stop") {
    return {
      label: "Stopping Helper",
      sentence: "The local helper is shutting down.",
      eyebrow: "Working",
      headline: "Closing the local connection",
      detail: "You can reopen Reclaim from this app when you need to continue.",
      tone: "warn",
      Icon: Loader2,
    };
  }
  if (!keyStatus || busy === "status") {
    return {
      label: "Checking",
      sentence: "Proof Helper is checking local proof assets and helper status.",
      eyebrow: "Starting up",
      headline: "Checking this computer",
      detail: "This usually takes a moment.",
      tone: "idle",
      Icon: Loader2,
    };
  }
  if (keyStatus.state === "missing") {
    return {
      label: "Proof assets need setup",
      sentence: "Install proof assets before opening the reclaim flow.",
      eyebrow: "Setup needed",
      headline: "Proof assets are not installed",
      detail: "Proof Helper will download and verify signed proof assets before enabling Reclaim.",
      tone: "warn",
      Icon: ShieldAlert,
    };
  }
  if (!keyStatus.ready) {
    return {
      label: "Blocked",
      sentence: "The installed proof assets did not pass verification.",
      eyebrow: "Action needed",
      headline: "Replace proof assets",
      detail: keyStatus.error ?? "Proof generation is blocked until valid assets are installed.",
      tone: "bad",
      Icon: ShieldAlert,
    };
  }
  if (startup || helperRunning) {
    return {
      label: "Connected",
      sentence: "Proof Helper is running locally and the reclaim website is paired.",
      eyebrow: "Ready in browser",
      headline: "Continue in Reclaim",
      detail: startup
        ? "Return to the browser to finish the reclaim flow."
        : "Stop the helper and open Reclaim again if the browser is not already connected.",
      tone: "ok",
      Icon: CheckCircle2,
    };
  }
  if (keyStatus.ready) {
    return {
      label: "Ready",
      sentence: "Proof assets are ready on this computer.",
      eyebrow: "Ready to connect",
      headline: "Open the reclaim website",
      detail: "Proof Helper will start locally and pair with the official reclaim flow.",
      tone: "ok",
      Icon: CheckCircle2,
    };
  }
  return {
    label: "Checking",
    sentence: "Proof Helper is checking local proof assets and helper status.",
    eyebrow: "Starting up",
    headline: "Checking this computer",
    detail: "This usually takes a moment.",
    tone: "idle",
    Icon: Loader2,
  };
}

function toneForKey(status: KeyBundleStatus | null): Tone {
  if (!status) {
    return "idle";
  }
  if (status.ready) {
    return "ok";
  }
  if (status.state === "missing") {
    return "warn";
  }
  return "bad";
}

function labelForKey(status: KeyBundleStatus | null) {
  if (!status) {
    return "Checking";
  }
  switch (status.state) {
    case "ready":
      return "Ready";
    case "missing":
      return "Needs setup";
    case "invalid":
      return "Blocked";
    default:
      return status.state;
  }
}

function proofAssetSummary(status: KeyBundleStatus | null) {
  if (!status) {
    return "Checking";
  }
  if (status.ready) {
    return status.installed_release_tag ?? status.key_version ?? "Ready";
  }
  if (status.state === "missing") {
    return "Needs setup";
  }
  return "Blocked";
}

function proofAssetDetail(status: KeyBundleStatus | null) {
  if (!status) {
    return "Checking signed proof assets.";
  }
  if (status.ready) {
    return `Verified against ${shortHash(status.vk_hash ?? status.expected_vk_hash)}.`;
  }
  if (status.state === "missing") {
    return status.expected_release_tag
      ? `Expected release: ${status.expected_release_tag}.`
      : "Proof Helper will download and verify signed proof assets.";
  }
  return "Replace proof assets before opening Reclaim.";
}

function shortHash(value?: string | null) {
  if (!value) {
    return "Unavailable";
  }
  if (value.length <= 28) {
    return value;
  }
  return `${value.slice(0, 18)}...${value.slice(-8)}`;
}

function redactedHelperEndpoint(value?: string | null) {
  if (!value) {
    return "Not running";
  }
  try {
    const parsed = new URL(value);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return "Local helper running";
  }
}

function originLabel(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return "Official reclaim site";
  }
}

function runtimePlatformLabel(diagnostics: RuntimeDiagnostics | null) {
  if (!diagnostics) {
    return "Checking";
  }
  return `${platformName(diagnostics.os)} / ${diagnostics.arch}`;
}

function sidecarCandidateSummary(diagnostics: RuntimeDiagnostics | null) {
  if (!diagnostics || diagnostics.bundled_sidecar_candidates.length === 0) {
    return "Unavailable";
  }
  return diagnostics.bundled_sidecar_candidates.join(" | ");
}

function platformName(os: string) {
  switch (os) {
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    case "macos":
      return "macOS";
    default:
      return os || "Unknown";
  }
}

function parseOriginList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const seen: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed && !seen.includes(trimmed)) {
      seen.push(trimmed);
    }
  }
  return seen;
}

function messageFor(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function localInstallProgress(progress: KeyBundleProgress): ProofAssetInstallProgress {
  return {
    release_tag: "local-source",
    phase: "extracting",
    file_name: progress.file_name,
    copied_bytes: progress.copied_bytes,
    total_bytes: progress.total_bytes,
    message: `Copying ${progress.file_name}.`,
  };
}

function installProgressLabel(progress: ProofAssetInstallProgress) {
  if (progress.release_tag === "local-source" && progress.file_name) {
    return `Copying ${progress.file_name}`;
  }
  if (progress.file_name) {
    return `${phaseLabel(progress.phase)} ${progress.file_name}`;
  }
  return progress.message || phaseLabel(progress.phase);
}

function phaseLabel(phase: ProofAssetInstallProgress["phase"]) {
  switch (phase) {
    case "checking":
      return "Checking";
    case "downloading":
      return "Downloading";
    case "verifying_archive":
      return "Verifying archive";
    case "extracting":
      return "Extracting";
    case "verifying_bundle":
      return "Verifying bundle";
    case "activating":
      return "Activating";
    case "complete":
      return "Complete";
    default:
      return "Installing";
  }
}

function progressPercent(progress: ProofAssetInstallProgress | null) {
  if (!progress || progress.total_bytes <= 0) {
    return null;
  }
  return Math.min(100, Math.floor((progress.copied_bytes / progress.total_bytes) * 100));
}
