"use client";

import { bech32 } from "bech32";
import {
  ArrowLeft,
  CheckCircle2,
  Coins,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
  Wallet,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import type {
  AssetMap,
  BuildReclaimTxResponse,
  DeploymentResponse,
  ReclaimApiError,
  WalletAssetsResponse,
} from "../lib/reclaim/types";
import { LOVELACE_UNIT } from "../lib/reclaim/types";
import { isPaymentCredential, normalizeCredential } from "../lib/reclaim/validation";

type CardanoWalletProvider = {
  name?: string;
  icon?: string;
  enable(): Promise<CardanoWalletApi>;
};

type CardanoWalletApi = {
  getNetworkId(): Promise<number>;
  getUsedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  signTx(txCbor: string, partialSign?: boolean): Promise<string>;
};

type NativeTokenRow = {
  id: number;
  unit: string;
  quantity: string;
};

type FlowState =
  | "idle"
  | "deployment_unavailable"
  | "wallet_connected"
  | "assets_loaded"
  | "building"
  | "built"
  | "signing"
  | "submitted"
  | "failed";

const targetPlaceholder = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const HEX_RE = /^[0-9a-f]+$/iu;

export function ReclaimFundingFlow() {
  const [deployment, setDeployment] = useState<DeploymentResponse | null>(null);
  const [deploymentLoading, setDeploymentLoading] = useState(true);
  const [wallets, setWallets] = useState<Array<[string, CardanoWalletProvider]>>([]);
  const [selectedWallet, setSelectedWallet] = useState("");
  const [walletApi, setWalletApi] = useState<CardanoWalletApi | null>(null);
  const [changeAddress, setChangeAddress] = useState("");
  const [walletAddresses, setWalletAddresses] = useState<string[]>([]);
  const [walletNetworkId, setWalletNetworkId] = useState<number | undefined>();
  const [compromisedCredential, setCompromisedCredential] = useState("");
  const [adaAmount, setAdaAmount] = useState("");
  const [nativeTokens, setNativeTokens] = useState<NativeTokenRow[]>([{ id: 1, unit: "", quantity: "" }]);
  const [inventory, setInventory] = useState<WalletAssetsResponse | null>(null);
  const [builtTx, setBuiltTx] = useState<BuildReclaimTxResponse | null>(null);
  const [submittedTxHash, setSubmittedTxHash] = useState("");
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [failure, setFailure] = useState("");

  const normalizedCredential = useMemo(() => normalizeCredential(compromisedCredential), [compromisedCredential]);
  const deploymentAvailable = deployment?.available === true;
  const canUseWallet = deploymentAvailable && walletApi !== null && walletNetworkId === deployment.deployment.networkId;
  const canBuild =
    deploymentAvailable &&
    canUseWallet &&
    changeAddress.trim() !== "" &&
    walletAddresses.length > 0 &&
    isPaymentCredential(normalizedCredential) &&
    buildAssetMap(adaAmount, nativeTokens) !== null;

  useEffect(() => {
    let mounted = true;
    void fetchDeployment().then((next) => {
      if (!mounted) {
        return;
      }
      setDeployment(next);
      setDeploymentLoading(false);
      setFlowState(next.available ? "idle" : "deployment_unavailable");
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const cardano = ((window as Window & { cardano?: Record<string, unknown> }).cardano ?? {}) as Record<string, unknown>;
    const availableWallets = Object.entries(cardano).filter((entry): entry is [string, CardanoWalletProvider] => {
      const wallet = entry[1] as CardanoWalletProvider | undefined;
      return typeof wallet?.enable === "function";
    });
    setWallets(availableWallets);
    if (availableWallets.length > 0) {
      setSelectedWallet(availableWallets[0][0]);
    }
  }, []);

  const connectWallet = async () => {
    setFailure("");
    setSubmittedTxHash("");
    setBuiltTx(null);
    setInventory(null);
    if (!deploymentAvailable) {
      return;
    }
    const provider = wallets.find(([id]) => id === selectedWallet)?.[1];
    if (!provider) {
      resetWalletState();
      setFlowState("failed");
      setFailure("No Cardano wallet extension is available.");
      return;
    }
    try {
      const api = await provider.enable();
      const networkId = await api.getNetworkId();
      const addressSet = await readCip30WalletAddresses(api, networkId);
      setWalletApi(api);
      setWalletNetworkId(networkId);
      setChangeAddress(addressSet.changeAddress);
      setWalletAddresses(addressSet.walletAddresses);
      setFlowState("wallet_connected");
    } catch (error) {
      resetWalletState();
      setFlowState("failed");
      setFailure(error instanceof Error ? error.message : "Wallet connection failed.");
    }
  };

  const refreshAssets = async () => {
    if (!deploymentAvailable) {
      return;
    }
    setFailure("");
    setInventory(null);
    setBuiltTx(null);
    try {
      const response = await postJSON<WalletAssetsResponse>("/reclaim-api/wallet-assets", {
        changeAddress,
        walletAddresses,
        networkId: walletNetworkId,
      });
      setInventory(response);
      setFlowState("assets_loaded");
    } catch (error) {
      setFlowState("failed");
      setFailure(error instanceof Error ? error.message : "Unable to load wallet assets.");
    }
  };

  const buildTx = async () => {
    if (!deploymentAvailable) {
      return;
    }
    const assets = buildAssetMap(adaAmount, nativeTokens);
    if (!assets) {
      setFlowState("failed");
      setFailure("Select at least one ADA or native token amount.");
      return;
    }
    setFailure("");
    setSubmittedTxHash("");
    setBuiltTx(null);
    setFlowState("building");
    try {
      const response = await postJSON<BuildReclaimTxResponse>("/reclaim-api/build", {
        changeAddress,
        walletAddresses,
        networkId: walletNetworkId,
        compromisedCredential: normalizedCredential,
        assets,
        deploymentId: deployment.deployment.id,
      });
      setBuiltTx(response);
      setFlowState("built");
    } catch (error) {
      setFlowState("failed");
      setFailure(error instanceof Error ? error.message : "Unable to build reclaim transaction.");
    }
  };

  const signAndSubmit = async () => {
    if (!builtTx || !walletApi) {
      return;
    }
    setFailure("");
    setFlowState("signing");
    try {
      const witnessSetCbor = await walletApi.signTx(builtTx.txCbor, true);
      const response = await postJSON<{ txHash: string }>("/reclaim-api/submit", {
        reviewToken: builtTx.reviewToken,
        review: builtTx.review,
        unsignedTxCbor: builtTx.txCbor,
        witnessSetCbor,
      });
      setSubmittedTxHash(response.txHash);
      setFlowState("submitted");
    } catch (error) {
      setFlowState("failed");
      setFailure(error instanceof Error ? error.message : "Wallet signing or transaction submission failed.");
    }
  };

  function resetWalletState() {
    setWalletApi(null);
    setWalletNetworkId(undefined);
    setChangeAddress("");
    setWalletAddresses([]);
    setInventory(null);
    setBuiltTx(null);
    setSubmittedTxHash("");
  }

  return (
    <main className="shell">
      <aside className="side">
        <div className="brand">
          <h1>Reclaim Funding</h1>
          <p>Lock compromised-credential funds at the reclaim contract for owner proof recovery.</p>
        </div>
        <div className="status-stack">
          <StatusRow
            label="Deployment"
            state={deploymentAvailable ? "ok" : deploymentLoading ? "warn" : "bad"}
            text={deploymentStatusText(deployment, deploymentLoading)}
          />
          <StatusRow
            label="Wallet"
            state={canUseWallet ? "ok" : walletApi ? "warn" : "warn"}
            text={walletStatusText(deployment, walletApi, walletNetworkId, changeAddress)}
          />
          <StatusRow label="Transaction" state={txStatusTone(flowState)} text={txStatusText(flowState)} />
        </div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div>
            <h2>Move funds to mkReclaimBase</h2>
            <p>Backend-built Cardano transaction with inline datum.</p>
          </div>
          <a className="secondary-button" href="/">
            <ArrowLeft size={17} aria-hidden="true" />
            Proof
          </a>
        </header>

        <div className="flow">
          {!deploymentAvailable && !deploymentLoading ? (
            <div className="result-band bad" role="status">
              <strong>Reclaim deployment unavailable</strong>
              <span>{deployment?.missing.join(", ") || "Deployment environment variables are missing."}</span>
            </div>
          ) : null}

          <section className="section" aria-labelledby="wallet-section">
            <h3 id="wallet-section">Wallet</h3>
            <div className="field-grid">
              <label className="field">
                <span>Cardano wallet</span>
                <select
                  value={selectedWallet}
                  onChange={(event) => {
                    setSelectedWallet(event.target.value);
                    resetWalletState();
                  }}
                >
                  {wallets.length === 0 ? <option value="">No wallet found</option> : null}
                  {wallets.map(([id, provider]) => (
                    <option key={id} value={id}>
                      {provider.name || id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field action-field">
                <span aria-hidden="true">Connection</span>
                <button className="primary-button" type="button" onClick={connectWallet} disabled={!deploymentAvailable}>
                  <Wallet size={17} aria-hidden="true" />
                  Connect Wallet
                </button>
              </div>
            </div>
            <div className="field" aria-live="polite">
              <span>Address source</span>
              <div className="inventory-empty">
                {walletAddresses.length === 0
                  ? "Connect wallet to load CIP-30 addresses"
                  : `${walletAddresses.length} CIP-30 wallet address${walletAddresses.length === 1 ? "" : "es"} loaded`}
              </div>
              <span className="fine">
                No manual address entry. The change address is read from CIP-30 internally for Lucid change, and the
                backend checks connected wallet addresses for funded inputs.
              </span>
            </div>
            <div className="artifact-actions">
              <button className="secondary-button" type="button" onClick={refreshAssets} disabled={!deploymentAvailable || walletAddresses.length === 0}>
                <RefreshCw size={17} aria-hidden="true" />
                Refresh Assets
              </button>
            </div>
          </section>

          <section className="section" aria-labelledby="credential-section">
            <h3 id="credential-section">Compromised Credential</h3>
            <label className="field">
              <span>Payment key credential</span>
              <input
                value={compromisedCredential}
                onChange={(event) => {
                  setCompromisedCredential(event.target.value);
                  setBuiltTx(null);
                  setSubmittedTxHash("");
                }}
                placeholder={targetPlaceholder}
              />
            </label>
            {compromisedCredential && !isPaymentCredential(normalizedCredential) ? (
              <div className="result-band warn" role="status">
                <strong>Credential format</strong>
                <span>Use a 28-byte hex payment credential.</span>
              </div>
            ) : null}
          </section>

          <section className="section" aria-labelledby="assets-section">
            <h3 id="assets-section">Assets</h3>
            <div className="field-grid">
              <label className="field">
                <span>ADA amount</span>
                <input
                  value={adaAmount}
                  onChange={(event) => {
                    setAdaAmount(event.target.value);
                    setBuiltTx(null);
                    setSubmittedTxHash("");
                  }}
                  inputMode="decimal"
                  placeholder="0.000000"
                />
              </label>
              <div className="field">
                <span>Wallet inventory</span>
                <InventorySummary inventory={inventory} />
              </div>
            </div>

            <div className="asset-editor" aria-label="Native token assets">
              {nativeTokens.map((token, index) => (
                <div className="asset-row" key={token.id}>
                  <label className="field">
                    <span>Asset unit</span>
                    <input
                      value={token.unit}
                      onChange={(event) => updateTokenRow(index, { unit: event.target.value }, setNativeTokens)}
                      placeholder="policyId + tokenName hex"
                    />
                  </label>
                  <label className="field">
                    <span>Quantity</span>
                    <input
                      value={token.quantity}
                      onChange={(event) => updateTokenRow(index, { quantity: event.target.value }, setNativeTokens)}
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </label>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Remove native token ${index + 1}`}
                    onClick={() => removeTokenRow(token.id, setNativeTokens)}
                    disabled={nativeTokens.length === 1}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>

            <div className="artifact-actions">
              <button className="secondary-button" type="button" onClick={() => addTokenRow(setNativeTokens)}>
                <Plus size={17} aria-hidden="true" />
                Token
              </button>
              <button className="primary-button" type="button" onClick={buildTx} disabled={!canBuild || flowState === "building"}>
                {flowState === "building" ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <Coins size={17} aria-hidden="true" />}
                Build Transaction
              </button>
            </div>
          </section>

          {builtTx ? (
            <section className="section" aria-labelledby="review-section">
              <h3 id="review-section">Review</h3>
              <div className="review-grid">
                <ReviewItem label="Destination" value={builtTx.review.reclaimBaseAddress} />
                <ReviewItem label="Credential datum" value={builtTx.review.compromisedCredential} />
                <ReviewItem label="Datum CBOR" value={builtTx.review.datumCbor} />
                <ReviewItem label="Tx hash" value={builtTx.txHash} />
              </div>
              <AssetList assets={builtTx.review.assets} />
              <button className="primary-button" type="button" onClick={signAndSubmit} disabled={!canUseWallet || flowState === "signing"}>
                {flowState === "signing" ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
                Sign and Submit
              </button>
            </section>
          ) : null}

          {submittedTxHash ? (
            <div className="result-band ok" role="status">
              <strong>Transaction submitted</strong>
              <span>{submittedTxHash}</span>
            </div>
          ) : null}

          {failure ? (
            <div className="result-band bad" role="alert">
              <strong>Action failed</strong>
              <span>{failure}</span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function StatusRow({ label, state, text }: { label: string; state: "ok" | "warn" | "bad"; text: string }) {
  return (
    <div className="status-row">
      <span className={`status-dot ${state}`} aria-hidden="true" />
      <span className="status-text">
        <strong>{label}</strong>
        <span>{text}</span>
      </span>
    </div>
  );
}

function InventorySummary({ inventory }: { inventory: WalletAssetsResponse | null }) {
  if (!inventory) {
    return <span className="inventory-empty">Not loaded</span>;
  }
  const assetCount = Object.keys(inventory.assets).length;
  return (
    <span className="inventory-empty">
      {inventory.utxoCount} UTxO{inventory.utxoCount === 1 ? "" : "s"}, {assetCount} asset{assetCount === 1 ? "" : "s"}
    </span>
  );
}

function AssetList({ assets }: { assets: AssetMap }) {
  return (
    <div className="asset-list">
      {sortAssets(assets).map(([unit, quantity]) => (
        <div className="asset-line" key={unit}>
          <span>{formatAssetUnit(unit)}</span>
          <strong>{unit === LOVELACE_UNIT ? formatLovelace(quantity) : quantity}</strong>
        </div>
      ))}
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="review-item">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

async function fetchDeployment(): Promise<DeploymentResponse> {
  const response = await fetch("/reclaim-api/deployment");
  return response.json() as Promise<DeploymentResponse>;
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T | ReclaimApiError;
  if (!response.ok) {
    const error = payload as ReclaimApiError;
    throw new Error(error.error || "Request failed.");
  }
  return payload as T;
}

async function readCip30WalletAddresses(
  api: CardanoWalletApi,
  walletNetworkId: number,
): Promise<{ changeAddress: string; walletAddresses: string[] }> {
  if (typeof api.getChangeAddress !== "function" || typeof api.getUsedAddresses !== "function") {
    throw new Error("Connected wallet is missing required CIP-30 address methods.");
  }

  let rawChangeAddress = "";
  let rawUsedAddresses: string[] = [];
  try {
    [rawChangeAddress, rawUsedAddresses] = await Promise.all([api.getChangeAddress(), api.getUsedAddresses()]);
  } catch {
    throw new Error("Connected wallet did not provide usable CIP-30 payment addresses.");
  }

  if (typeof rawChangeAddress !== "string" || !Array.isArray(rawUsedAddresses) || rawUsedAddresses.some((address) => typeof address !== "string")) {
    throw new Error("Connected wallet returned malformed CIP-30 used addresses.");
  }

  const changeAddress = cip30AddressToBech32(rawChangeAddress, walletNetworkId);
  const walletAddresses = new Set<string>([changeAddress]);
  // Unused wallet addresses are not evidence of spendable UTxOs.
  for (const candidate of rawUsedAddresses) {
    walletAddresses.add(cip30AddressToBech32(candidate, walletNetworkId));
  }

  if (!changeAddress || walletAddresses.size === 0) {
    throw new Error("Connected wallet did not provide a usable CIP-30 payment address.");
  }
  return {
    changeAddress,
    walletAddresses: [...walletAddresses],
  };
}

function cip30AddressToBech32(rawAddress: string, walletNetworkId: number): string {
  const value = rawAddress.trim();
  if (!value) {
    throw new Error("Wallet address is empty.");
  }
  if (value.startsWith("addr")) {
    const decoded = bech32.decode(value, 1000);
    const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
    assertPaymentAddressBytes(bytes, walletNetworkId);
    return value;
  }
  if (value.length % 2 !== 0 || !HEX_RE.test(value)) {
    throw new Error("Wallet address must be bech32 or CIP-30 hex.");
  }
  const bytes = hexToBytes(value);
  assertPaymentAddressBytes(bytes, walletNetworkId);
  const prefix = walletNetworkId === 1 ? "addr" : "addr_test";
  return bech32.encode(prefix, bech32.toWords(bytes), 1000);
}

function assertPaymentAddressBytes(bytes: Uint8Array, walletNetworkId: number): void {
  if (bytes.length === 0) {
    throw new Error("Wallet address is empty.");
  }
  const header = bytes[0];
  const networkId = header & 0x0f;
  if (networkId !== walletNetworkId) {
    throw new Error("Wallet address network does not match the connected wallet.");
  }
  const addressKind = header >> 4;
  if (addressKind === 0x08 || addressKind === 0x0e || addressKind === 0x0f) {
    throw new Error("Wallet address must be a Shelley payment address.");
  }
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function buildAssetMap(adaAmount: string, nativeTokens: NativeTokenRow[]): AssetMap | null {
  const assets: AssetMap = {};
  const lovelace = adaToLovelace(adaAmount);
  if (lovelace && lovelace !== "0") {
    assets[LOVELACE_UNIT] = lovelace;
  }
  for (const token of nativeTokens) {
    const unit = token.unit.trim().toLowerCase();
    const quantity = token.quantity.trim();
    if (!unit && !quantity) {
      continue;
    }
    if (!unit || !/^(0|[1-9][0-9]*)$/u.test(quantity) || BigInt(quantity) <= 0n) {
      return null;
    }
    assets[unit] = ((BigInt(assets[unit] ?? "0") + BigInt(quantity))).toString();
  }
  return Object.keys(assets).length > 0 ? assets : null;
}

function adaToLovelace(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "0";
  }
  const match = /^([0-9]+)(?:\.([0-9]{0,6}))?$/u.exec(trimmed);
  if (!match) {
    return null;
  }
  const whole = BigInt(match[1]);
  const decimal = (match[2] ?? "").padEnd(6, "0");
  return (whole * 1_000_000n + BigInt(decimal || "0")).toString();
}

function updateTokenRow(
  index: number,
  patch: Partial<NativeTokenRow>,
  setNativeTokens: React.Dispatch<React.SetStateAction<NativeTokenRow[]>>,
) {
  setNativeTokens((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
}

function addTokenRow(setNativeTokens: React.Dispatch<React.SetStateAction<NativeTokenRow[]>>) {
  setNativeTokens((rows) => [...rows, { id: nextTokenRowId(rows), unit: "", quantity: "" }]);
}

function removeTokenRow(id: number, setNativeTokens: React.Dispatch<React.SetStateAction<NativeTokenRow[]>>) {
  setNativeTokens((rows) => (rows.length === 1 ? rows : rows.filter((row) => row.id !== id)));
}

function nextTokenRowId(rows: NativeTokenRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
}

function sortAssets(assets: AssetMap): Array<[string, string]> {
  return Object.entries(assets).sort(([left], [right]) => {
    if (left === LOVELACE_UNIT) {
      return -1;
    }
    if (right === LOVELACE_UNIT) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function formatAssetUnit(unit: string): string {
  return unit === LOVELACE_UNIT ? "ADA" : unit;
}

function formatLovelace(quantity: string): string {
  const value = BigInt(quantity);
  const whole = value / 1_000_000n;
  const decimal = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return decimal ? `${whole}.${decimal}` : whole.toString();
}

function deploymentStatusText(deployment: DeploymentResponse | null, loading: boolean): string {
  if (loading) {
    return "Loading deployment";
  }
  if (!deployment?.available) {
    return "Missing configuration";
  }
  return `${deployment.deployment.network} deployment ready`;
}

function walletStatusText(
  deployment: DeploymentResponse | null,
  walletApi: CardanoWalletApi | null,
  networkId: number | undefined,
  changeAddress: string,
): string {
  if (!walletApi) {
    return "Not connected";
  }
  if (deployment?.available && networkId !== deployment.deployment.networkId) {
    return "Network mismatch";
  }
  if (!changeAddress) {
    return "Address needed";
  }
  return "Ready to sign";
}

function txStatusText(flowState: FlowState): string {
  if (flowState === "building") {
    return "Building unsigned tx";
  }
  if (flowState === "built") {
    return "Ready for wallet signature";
  }
  if (flowState === "signing") {
    return "Awaiting wallet";
  }
  if (flowState === "submitted") {
    return "Submitted";
  }
  if (flowState === "failed") {
    return "Needs attention";
  }
  return "Not built";
}

function txStatusTone(flowState: FlowState): "ok" | "warn" | "bad" {
  if (flowState === "submitted") {
    return "ok";
  }
  if (flowState === "failed") {
    return "bad";
  }
  return "warn";
}
