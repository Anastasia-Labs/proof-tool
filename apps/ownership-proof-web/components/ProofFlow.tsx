"use client";

import { CheckCircle2, Copy, Download, ExternalLink, Loader2, Power, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type HelperState =
  | "checking"
  | "offline"
  | "ready"
  | "key_missing"
  | "key_downloading"
  | "update_required"
  | "not_ready";
type FlowState =
  | "idle"
  | "invalid_mnemonic"
  | "invalid_target"
  | "path_not_found"
  | "proving"
  | "proof_generated"
  | "verifying"
  | "verified"
  | "not_verified"
  | "failed";

type ProofArtifact = {
  schema: string;
  circuit_id: string;
  vk_hash: string;
  target_credential: string;
  public_input: string;
  proof: string;
  path?: { account: number; role: number; index: number };
};

type HelperResponse = {
  artifact: ProofArtifact;
  debug_artifact?: ProofArtifact;
};

type HelperStatusResponse = {
  connected?: boolean;
  sidecar_version?: string;
  protocol_version?: string;
  circuit_id?: string;
  key_version?: string;
  key_hash?: string;
  key_ready?: boolean;
  key_state?: string;
  compatibility?: string;
};

type VerifyResponse = {
  verified: boolean;
  reason?: string;
  circuit_id: string;
  vk_hash?: string;
  target_credential?: string;
  public_input?: string;
};

type WorkerSuccess = {
  id: string;
  type: "master-xprv";
  masterXPrv: ArrayBuffer;
};

type WorkerFailure = {
  id: string;
  type: "error";
  code: string;
  message: string;
};

type WorkerResponse = WorkerSuccess | WorkerFailure;

type WorkerLike = {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
};

export type ProofFlowProps = {
  createWorker?: () => WorkerLike;
};

const defaultCreateWorker = () =>
  new Worker(new URL("../workers/ownership-proof-worker.ts", import.meta.url), {
    type: "module",
  }) as WorkerLike;

export function ProofFlow({ createWorker = defaultCreateWorker }: ProofFlowProps) {
  const seedRef = useRef<HTMLTextAreaElement | null>(null);
  const [helperUrl, setHelperUrl] = useState("");
  const [token, setToken] = useState("");
  const [targetCredential, setTargetCredential] = useState("");
  const [helperState, setHelperState] = useState<HelperState>("checking");
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [artifact, setArtifact] = useState<ProofArtifact | null>(null);
  const [verification, setVerification] = useState<VerifyResponse | null>(null);
  const [failure, setFailure] = useState("");
  const [helperNotice, setHelperNotice] = useState("");
  const [autoPaired, setAutoPaired] = useState(false);
  const [copyState, setCopyState] = useState("Copy");

  const normalizedTarget = useMemo(() => normalizeCredential(targetCredential), [targetCredential]);

  const checkHelper = useCallback(async () => {
    if (helperUrl.trim() === "") {
      setHelperState("offline");
      return;
    }
    setHelperState("checking");
    try {
      const response = await fetch(`${trimSlash(helperUrl)}/status`, { method: "GET" });
      if (!response.ok) {
        setHelperState("offline");
        return;
      }
      const status = (await response.json()) as HelperStatusResponse;
      setHelperState(helperStateFromStatus(status));
    } catch {
      setHelperState("offline");
    }
  }, [helperUrl]);

  useEffect(() => {
    void checkHelper();
  }, [checkHelper]);

  useEffect(() => {
    const pairing = readPairingFragment();
    if (!pairing) {
      return;
    }
    setHelperUrl(pairing.helperUrl);
    setToken(pairing.token);
    setAutoPaired(true);
    setHelperNotice("Proof Helper connected automatically.");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  const generateProof = async () => {
    setFailure("");
    setVerification(null);
    setArtifact(null);

    if (!isCredential(normalizedTarget)) {
      setFlowState("invalid_target");
      return;
    }
    if (helperState !== "ready") {
      setFlowState("failed");
      setFailure(helperActionMessage(helperState));
      return;
    }
    if (token.trim() === "") {
      setFlowState("failed");
      setFailure("Open Proof Helper from this page. It will connect automatically.");
      return;
    }

    const seedPhrase = seedRef.current?.value ?? "";
    if (seedRef.current) {
      seedRef.current.value = "";
    }
    setFlowState("proving");

    let masterBytes: Uint8Array | null = null;
    try {
      const workerResponse = await deriveMasterXPrv(seedPhrase, createWorker);
      if (workerResponse.type === "error") {
        setFlowState(workerResponse.code === "invalid_mnemonic" ? "invalid_mnemonic" : "failed");
        setFailure(workerResponse.message);
        return;
      }

      masterBytes = new Uint8Array(workerResponse.masterXPrv);
      const helperResponse = await fetch(`${trimSlash(helperUrl)}/prove`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Proof-Tool-Token": token.trim(),
        },
        body: JSON.stringify({
          master_xprv_base64: bytesToBase64(masterBytes),
          target_credential: normalizedTarget,
          account: 0,
          role: 0,
          index: 0,
        }),
      });

      if (!helperResponse.ok) {
        const errorBody = await safeJSON<{ code?: string; error?: string }>(helperResponse);
        if (errorBody?.code === "path_not_found") {
          setFlowState("path_not_found");
          setFailure(errorBody.error ?? "No matching credential was found.");
          return;
        }
        setFlowState("failed");
        setFailure(errorBody?.error ?? "The local helper could not generate the proof.");
        return;
      }

      const body = (await helperResponse.json()) as HelperResponse;
      setArtifact(body.artifact);
      setFlowState("proof_generated");
    } catch {
      setFlowState("failed");
      setFailure("The proof could not be generated. Check that the helper is running.");
    } finally {
      masterBytes?.fill(0);
    }
  };

  const verifyProof = async (proof: ProofArtifact = artifact as ProofArtifact) => {
    if (!proof) {
      return;
    }
    setFlowState("verifying");
    setFailure("");
    try {
      const response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifact: proof,
          expected_target_credential: normalizedTarget,
        }),
      });
      const body = (await response.json()) as VerifyResponse;
      setVerification(body);
      setFlowState(response.ok && body.verified ? "verified" : "not_verified");
    } catch {
      setFlowState("failed");
      setFailure("The verification service is unavailable. Try again in a moment.");
    }
  };

  const shutdownHelper = async () => {
    if (token.trim() === "") {
      return;
    }
    try {
      await fetch(`${trimSlash(helperUrl)}/shutdown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Proof-Tool-Token": token.trim(),
        },
      });
    } catch {
      // The helper may close the connection while shutting down.
    } finally {
      setToken("");
      setAutoPaired(false);
      setHelperState("offline");
      setHelperNotice("Proof Helper has stopped. You can remove it from your computer when you are done.");
    }
  };

  const copyArtifact = async () => {
    if (!artifact) {
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(artifact, null, 2));
    setCopyState("Copied");
    window.setTimeout(() => setCopyState("Copy"), 1200);
  };

  const downloadArtifact = () => {
    if (!artifact) {
      return;
    }
    const blob = new Blob([`${JSON.stringify(artifact, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ownership-proof.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="shell">
      <aside className="side" aria-label="Proof status">
        <div className="brand">
          <h1>Credential Proof</h1>
          <p>Prove a Cardano payment key credential without sending the recovery phrase to a server.</p>
        </div>
        <div className="status-stack">
          <StatusRow label="Local helper" state={helperState} />
          <StatusRow label="Proof" state={proofStatus(flowState, artifact)} />
          <StatusRow label="Verifier" state={verificationStatus(flowState, verification)} />
        </div>
      </aside>

      <section className="workspace">
        <div className="toolbar">
          <div>
            <h2>Ownership Proof Flow</h2>
            <p>Phrase handling stays in this browser tab and the local helper.</p>
          </div>
          <button className="icon-button" type="button" onClick={checkHelper} aria-label="Refresh helper status">
            <RefreshCw size={18} />
          </button>
        </div>

        <div className="flow">
          <section className="section" aria-labelledby="helper-heading">
            <h3 id="helper-heading">Helper Connection</h3>
            <StateBand
              flowState={flowState}
              helperState={helperState}
              failure={failure}
              helperNotice={helperNotice}
              autoPaired={autoPaired}
            />
            <div className="artifact-actions">
              {helperState === "ready" && token ? (
                <button className="secondary-button" type="button" onClick={shutdownHelper}>
                  <Power size={17} />
                  Stop helper
                </button>
              ) : (
                <InstallActions />
              )}
            </div>
          </section>

          <section className="section" aria-labelledby="proof-heading">
            <h3 id="proof-heading">Proof Details</h3>
            <label className="field">
              <span>Recovery phrase</span>
              <textarea
                ref={seedRef}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Enter the phrase on this device"
              />
            </label>
            <label className="field">
              <span>Payment key credential</span>
              <input
                value={targetCredential}
                onChange={(event) => setTargetCredential(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="56 hex characters"
              />
            </label>
            <button className="primary-button" type="button" onClick={generateProof} disabled={flowState === "proving"}>
              {flowState === "proving" ? <Loader2 size={18} className="spin" /> : <ShieldCheck size={18} />}
              {flowState === "proving" ? "Generating proof" : "Generate proof"}
            </button>
          </section>

          {artifact ? (
            <section className="section" aria-labelledby="artifact-heading">
              <h3 id="artifact-heading">Proof Artifact</h3>
              <p className="fine">
                This artifact is safe to submit for verification. It does not include the recovery phrase, master key,
                or derivation path.
              </p>
              <div className="artifact-actions">
                <button className="secondary-button" type="button" onClick={copyArtifact}>
                  <Copy size={17} />
                  {copyState}
                </button>
                <button className="secondary-button" type="button" onClick={downloadArtifact}>
                  <Download size={17} />
                  Download
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void verifyProof()}
                  disabled={flowState === "verifying"}
                >
                  {flowState === "verifying" ? <Loader2 size={18} /> : <CheckCircle2 size={18} />}
                  {flowState === "verifying" ? "Verifying" : "Verify proof"}
                </button>
              </div>
              {verification ? <VerificationBand verification={verification} /> : null}
            </section>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function StatusRow({
  label,
  state,
}: {
  label: string;
  state: HelperState | "ready" | "pending" | "verified" | "failed";
}) {
  const tone =
    state === "ready" || state === "verified"
      ? "ok"
      : state === "failed" || state === "offline" || state === "update_required"
        ? "bad"
        : "warn";
  return (
    <div className="status-row">
      <i className={`status-dot ${tone}`} aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <span>{statusText(state)}</span>
      </div>
    </div>
  );
}

function StateBand({
  flowState,
  helperState,
  failure,
  helperNotice,
  autoPaired,
}: {
  flowState: FlowState;
  helperState: HelperState;
  failure: string;
  helperNotice: string;
  autoPaired: boolean;
}) {
  if (helperNotice && helperState === "offline") {
    return <ResultBand tone="ok" title="Helper stopped" body={helperNotice} />;
  }
  if (flowState === "invalid_mnemonic") {
    return (
      <ResultBand
        tone="bad"
        title="Check the recovery phrase"
        body="The phrase is not a valid BIP-39 recovery phrase."
      />
    );
  }
  if (flowState === "invalid_target") {
    return (
      <ResultBand
        tone="bad"
        title="Check the credential format"
        body="Paste a 28-byte payment key credential as 56 hex characters."
      />
    );
  }
  if (flowState === "path_not_found") {
    return <ResultBand tone="warn" title="Credential not found" body={failure} />;
  }
  if (flowState === "failed") {
    return <ResultBand tone="bad" title="Action needed" body={failure} />;
  }
  if (helperState === "offline") {
    return (
      <ResultBand
        tone="warn"
        title="Install Proof Helper"
        body="Open the desktop helper to pair this browser automatically."
      />
    );
  }
  if (helperState === "key_missing") {
    return <ResultBand tone="warn" title="Proof assets needed" body="Open Proof Helper to install proof assets." />;
  }
  if (helperState === "key_downloading") {
    return <ResultBand tone="warn" title="Proof assets installing" body="Proof Helper is installing proof assets." />;
  }
  if (helperState === "update_required") {
    return <ResultBand tone="bad" title="Update required" body="Update Proof Helper or proof assets." />;
  }
  if (helperState === "not_ready") {
    return <ResultBand tone="warn" title="Helper not ready" body="Proof Helper is reachable but not ready to prove." />;
  }
  if (helperState === "ready") {
    return (
      <ResultBand
        tone="ok"
        title="Helper connected"
        body={
          autoPaired
            ? "Proof Helper paired automatically. No code needed."
            : "The local helper is ready for a credential proof request."
        }
      />
    );
  }
  return <ResultBand tone="warn" title="Checking helper" body="Waiting for the local helper status." />;
}

function InstallActions() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button className="secondary-button" type="button" onClick={() => setIsOpen(true)}>
        <Download size={17} />
        Install Proof Helper
      </button>
      <a className="secondary-button compact-link" href={releasePage} target="_blank" rel="noreferrer">
        <ExternalLink size={17} />
        Downloads
      </a>
      {isOpen ? <InstallDialog onClose={() => setIsOpen(false)} /> : null}
    </>
  );
}

function InstallDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <h3 id="install-dialog-title">Choose your installer</h3>
            <p>Select the operating system for this computer.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close installer chooser">
            <X size={18} />
          </button>
        </div>
        <div className="platform-list">
          {downloadChoices.map((choice) => (
            <a
              className="platform-choice"
              key={choice.platform}
              href={choice.href}
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
            >
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </span>
              <span className="platform-action">
                {choice.action}
                <ExternalLink size={16} />
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function VerificationBand({ verification }: { verification: VerifyResponse }) {
  if (verification.verified) {
    return <ResultBand tone="ok" title="Verified" body="This proof matches the payment key credential." />;
  }
  return (
    <ResultBand
      tone="bad"
      title="Not verified"
      body={verification.reason ?? "The proof did not match the credential."}
    />
  );
}

function ResultBand({ tone, title, body }: { tone: "ok" | "warn" | "bad"; title: string; body: string }) {
  return (
    <div className={`result-band ${tone}`} role="status">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function proofStatus(flowState: FlowState, artifact: ProofArtifact | null) {
  if (artifact) {
    return "ready";
  }
  if (flowState === "failed" || flowState === "invalid_mnemonic" || flowState === "invalid_target") {
    return "failed";
  }
  return "pending";
}

function verificationStatus(flowState: FlowState, verification: VerifyResponse | null) {
  if (flowState === "verified" && verification?.verified) {
    return "verified";
  }
  if (flowState === "not_verified") {
    return "failed";
  }
  return "pending";
}

function statusText(state: HelperState | "ready" | "pending" | "verified" | "failed") {
  switch (state) {
    case "checking":
      return "Checking";
    case "ready":
      return "Ready";
    case "offline":
      return "Not running";
    case "key_missing":
      return "Key missing";
    case "key_downloading":
      return "Key download";
    case "update_required":
      return "Update required";
    case "not_ready":
      return "Not ready";
    case "verified":
      return "Verified";
    case "failed":
      return "Needs attention";
    default:
      return "Pending";
  }
}

function helperStateFromStatus(status: HelperStatusResponse): HelperState {
  switch (status.compatibility) {
    case "ready":
      return "ready";
    case "key_missing":
      return "key_missing";
    case "key_downloading":
      return "key_downloading";
    case "update_required":
      return "update_required";
    default:
      return status.key_ready ? "ready" : "not_ready";
  }
}

function helperActionMessage(state: HelperState) {
  switch (state) {
    case "key_missing":
      return "Open Proof Helper to install proof assets.";
    case "key_downloading":
      return "Proof Helper is installing proof assets.";
    case "update_required":
      return "Update Proof Helper or proof assets.";
    default:
      return "Open Proof Helper. It will connect to this page automatically.";
  }
}

async function deriveMasterXPrv(seedPhrase: string, createWorker: () => WorkerLike): Promise<WorkerResponse> {
  const worker = createWorker();
  const id = crypto.randomUUID();
  try {
    return await new Promise<WorkerResponse>((resolve) => {
      const listener = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) {
          return;
        }
        worker.removeEventListener("message", listener);
        resolve(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage({ id, type: "derive-master-xprv", seedPhrase });
    });
  } finally {
    worker.terminate();
  }
}

async function safeJSON<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function normalizeCredential(value: string) {
  return value.trim().replace(/^0x/u, "").toLowerCase();
}

function isCredential(value: string) {
  return /^[0-9a-f]{56}$/u.test(value);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function trimSlash(value: string) {
  return value.replace(/\/+$/u, "");
}

type PairingFragment = {
  helperUrl: string;
  token: string;
};

function readPairingFragment(): PairingFragment | null {
  if (typeof window === "undefined" || window.location.hash.length <= 1) {
    return null;
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const helper = params.get("helper");
  const token = params.get("pair");
  if (!helper || !token) {
    return null;
  }
  return {
    helperUrl: normalizeLocalURL(helper),
    token,
  };
}

function normalizeLocalURL(value: string) {
  const trimmed = value.trim();
  if (/^https?:\/\//u.test(trimmed)) {
    return trimSlash(trimmed);
  }
  return `http://${trimSlash(trimmed)}`;
}

const releaseRepo = "https://github.com/Anastasia-Labs/proof-tool-release";
// Pinned release tags: `releases/latest` is unsafe because the repository also
// hosts proof-assets releases, which can become "latest" and break these URLs.
const desktopReleaseTag = "proof-helper-desktop-v0.2.0-preview.1";
const portableReleaseTag = "proof-helper-v0.1.0";
const releasePage = `${releaseRepo}/releases/tag/${desktopReleaseTag}`;
const windowsInstallerDownload = `${releaseRepo}/releases/download/${desktopReleaseTag}/proof-helper_0.2.0_windows_x64_setup.exe`;
const macZipDownload = `${releaseRepo}/releases/download/${portableReleaseTag}/proof-helper_0.1.0_macos_universal.zip`;
const linuxDebDownload = `${releaseRepo}/releases/download/${desktopReleaseTag}/proof-helper_0.2.0_amd64.deb`;

const downloadChoices = [
  {
    platform: "windows",
    label: "Windows",
    description: "Downloads the Windows helper installer.",
    action: "Download installer",
    href: windowsInstallerDownload,
  },
  {
    platform: "mac",
    label: "macOS",
    description: "Downloads the universal macOS helper package (older preview build).",
    action: "Download .zip",
    href: macZipDownload,
  },
  {
    platform: "linux",
    label: "Linux",
    description: "Downloads the Debian package.",
    action: "Download .deb",
    href: linuxDebDownload,
  },
] as const;
