import {
  CheckCircle2,
  ExternalLink,
  FolderKey,
  Loader2,
  Power,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import type { DesktopApi, HelperStartup, KeyBundleStatus } from "./desktopApi";
import { tauriDesktopApi } from "./desktopApi";

type AppProps = {
  api?: DesktopApi;
};

const defaultSiteURL = import.meta.env.VITE_PROOF_SITE_URL ?? "http://127.0.0.1:3002";
const defaultSidecarPath = import.meta.env.VITE_PROOF_HELPER_SIDECAR_PATH ?? "";

export function App({ api = tauriDesktopApi }: AppProps) {
  const [keyStatus, setKeyStatus] = useState<KeyBundleStatus | null>(null);
  const [helperRunning, setHelperRunning] = useState(false);
  const [startup, setStartup] = useState<HelperStartup | null>(null);
  const [siteUrl, setSiteUrl] = useState(defaultSiteURL);
  const [sidecarPath, setSidecarPath] = useState(defaultSidecarPath);
  const [fixture, setFixture] = useState(false);
  const [devCreateKeys, setDevCreateKeys] = useState(false);
  const [busy, setBusy] = useState<"status" | "start" | "stop" | "delete" | null>("status");
  const [message, setMessage] = useState("");

  const keyTone = useMemo(() => toneForKey(keyStatus), [keyStatus]);
  const helperTone = helperRunning ? "ok" : busy === "start" ? "warn" : "idle";

  useEffect(() => {
    let active = true;
    void refresh();
    void api.helperProcessStatus().then((status) => {
      if (active) {
        setHelperRunning(status.running);
      }
    });
    return () => {
      active = false;
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
      const [nextKeyStatus, process] = await Promise.all([api.keyStatus(), api.helperProcessStatus()]);
      setKeyStatus(nextKeyStatus);
      setHelperRunning(process.running);
    } catch (error) {
      setMessage(messageFor(error));
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
        sidecarPath: sidecarPath.trim() || undefined,
        fixture,
        devCreateKeys,
      });
      setStartup(next);
      setHelperRunning(true);
      await api.openUrl(next.pairing_url);
    } catch (error) {
      setMessage(messageFor(error));
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
    } finally {
      setBusy(null);
    }
  };

  const deleteCache = async () => {
    setBusy("delete");
    setMessage("");
    try {
      const next = await api.deleteKeyCache();
      setKeyStatus(next);
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(null);
    }
  };

  const openWebsite = async () => {
    if (!startup) {
      return;
    }
    await api.openUrl(startup.pairing_url);
  };

  return (
    <main className="app-shell">
      <aside className="status-rail" aria-label="Proof Helper status">
        <div className="brand-block">
          <FolderKey size={28} />
          <div>
            <h1>Proof Helper</h1>
            <p>Local prover control</p>
          </div>
        </div>
        <StatusLine label="Key bundle" value={labelForKey(keyStatus)} tone={keyTone} />
        <StatusLine label="Sidecar" value={helperRunning ? "Running" : "Stopped"} tone={helperTone} />
        <StatusLine label="Pairing" value={startup ? "Ready" : "Not paired"} tone={startup ? "ok" : "idle"} />
        <StatusLine label="Protocol" value={startup?.protocol_version ?? "proof-helper-v1"} tone="idle" />
      </aside>

      <section className="workspace" aria-label="Proof Helper controls">
        <header className="workspace-header">
          <div>
            <h2>Desktop Helper</h2>
            <p>{keyStatus?.active_dir ?? "Checking Proof Helper app data"}</p>
          </div>
          <button className="icon-button" type="button" onClick={refreshStatus} aria-label="Refresh status">
            {busy === "status" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
        </header>

        <div className="work-grid">
          <section className="work-section" aria-labelledby="key-heading">
            <div className="section-heading">
              <h3 id="key-heading">Key Cache</h3>
              <StatusBadge tone={keyTone}>{labelForKey(keyStatus)}</StatusBadge>
            </div>
            <dl className="details">
              <Detail label="Version" value={keyStatus?.key_version ?? "Unavailable"} />
              <Detail label="VK hash" value={shortHash(keyStatus?.vk_hash)} />
              <Detail label="Circuit" value={keyStatus?.circuit_id ?? "Unavailable"} />
              <Detail label="App data" value={keyStatus?.app_data_dir ?? "Checking"} />
            </dl>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={deleteCache} disabled={busy === "delete"}>
                {busy === "delete" ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
                Remove cache
              </button>
            </div>
          </section>

          <section className="work-section" aria-labelledby="helper-heading">
            <div className="section-heading">
              <h3 id="helper-heading">Website Pairing</h3>
              <StatusBadge tone={helperTone}>{helperRunning ? "Running" : "Stopped"}</StatusBadge>
            </div>
            <label className="field">
              <span>Website URL</span>
              <input value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span>Sidecar path</span>
              <input
                value={sidecarPath}
                onChange={(event) => setSidecarPath(event.target.value)}
                placeholder="Bundled sidecar or PROOF_HELPER_SIDECAR_PATH"
                spellCheck={false}
              />
            </label>
            <div className="toggle-row">
              <label>
                <input type="checkbox" checked={fixture} onChange={(event) => setFixture(event.target.checked)} />
                Fixture
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={devCreateKeys}
                  onChange={(event) => setDevCreateKeys(event.target.checked)}
                />
                Dev keys
              </label>
            </div>
            <div className="button-row">
              <button className="primary-button" type="button" onClick={connect} disabled={busy === "start"}>
                {busy === "start" ? <Loader2 className="spin" size={17} /> : <ExternalLink size={17} />}
                Connect
              </button>
              <button className="secondary-button" type="button" onClick={stop} disabled={!helperRunning || busy === "stop"}>
                {busy === "stop" ? <Loader2 className="spin" size={17} /> : <Power size={17} />}
                Stop
              </button>
              {startup ? (
                <button className="secondary-button" type="button" onClick={openWebsite}>
                  <ExternalLink size={17} />
                  Open website
                </button>
              ) : null}
            </div>
          </section>
        </div>

        <section className="event-strip" aria-live="polite">
          {message ? (
            <StateMessage tone="bad" text={message} />
          ) : startup ? (
            <StateMessage tone="ok" text={`Paired at ${startup.helper_url}`} />
          ) : keyStatus?.error ? (
            <StateMessage tone="warn" text={keyStatus.error} />
          ) : (
            <StateMessage tone="idle" text="Ready for local helper control." />
          )}
        </section>
      </section>
    </main>
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

function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
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

type Tone = "ok" | "warn" | "bad" | "idle";

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
      return "Missing";
    case "invalid":
      return "Invalid";
    default:
      return status.state;
  }
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

function messageFor(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
