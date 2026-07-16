"use client";

import { bech32 } from "bech32";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Coins,
  FileText,
  Globe2,
  KeyRound,
  Landmark,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import type {
  AssetMap,
  BuildReclaimTxResponse,
  DeploymentResponse,
  ReclaimApiError,
  WalletAssetsResponse,
} from "../lib/reclaim/types";
import { LOVELACE_UNIT } from "../lib/reclaim/types";
import { isPaymentCredential, normalizeCredential } from "../lib/reclaim/validation";
import {
  ReclaimAppShell,
  ReclaimNotice,
  ReclaimPageHeading,
  ReclaimPanel,
  ReclaimReviewRow,
  ReclaimSummaryTiles,
} from "./ReclaimShell";
import type { ReclaimShellStep, ReclaimShellStepStatus, ReclaimSummaryTile } from "./ReclaimShell";

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
  manual?: boolean;
};

type NativeAssetOption = {
  unit: string;
  label: string;
  policyId: string;
  tokenNameHex: string;
  available: string;
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

type LockFundsVisualState =
  | "loading-deployment"
  | "deployment-unavailable"
  | "ready-idle"
  | "wallet-connected"
  | "credential-format-warning"
  | "assets-loaded"
  | "building-transaction"
  | "review-built"
  | "signing-awaiting-wallet"
  | "submitted"
  | "failed-build";

type LockStepId = "deployment" | "wallet" | "credential" | "assets" | "review" | "submit";

type LockFundsStep = {
  id: number;
  key: LockStepId;
  label: string;
  icon: LucideIcon;
};

const credentialPlaceholder = "Paste the 56-character payment key hash";
const credentialEmptyHint = "Enter the compromised credential to continue.";
const credentialFormatHint = "Use a 28-byte hex payment credential.";
const fixtureCompromisedCredential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const HEX_RE = /^[0-9a-f]+$/iu;

const lockFundsSteps: LockFundsStep[] = [
  { id: 1, key: "deployment", label: "Deployment", icon: Rocket },
  { id: 2, key: "wallet", label: "Funding wallet", icon: Wallet },
  { id: 3, key: "credential", label: "Compromised credential", icon: KeyRound },
  { id: 4, key: "assets", label: "Assets", icon: Layers },
  { id: 5, key: "review", label: "Review transaction", icon: FileText },
  { id: 6, key: "submit", label: "Submit", icon: Send },
];

export function ReclaimFundingFlow() {
  const [fixtureState, setFixtureState] = useState<LockFundsVisualState | null | undefined>(undefined);
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
  const [nativeTokens, setNativeTokens] = useState<NativeTokenRow[]>([]);
  const [inventory, setInventory] = useState<WalletAssetsResponse | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [builtTx, setBuiltTx] = useState<BuildReclaimTxResponse | null>(null);
  const [submittedTxHash, setSubmittedTxHash] = useState("");
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [failure, setFailure] = useState("");
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [tokenSearch, setTokenSearch] = useState("");
  const [selectedTokenUnit, setSelectedTokenUnit] = useState("");
  const [selectedTokenQuantity, setSelectedTokenQuantity] = useState("1");
  const [tokenPickerError, setTokenPickerError] = useState("");

  const normalizedCredential = useMemo(() => normalizeCredential(compromisedCredential), [compromisedCredential]);
  const requestedAssets = useMemo(() => buildAssetMap(adaAmount, nativeTokens), [adaAmount, nativeTokens]);
  const nativeAssetOptions = useMemo(() => walletNativeAssetOptions(inventory), [inventory]);
  const filteredNativeAssetOptions = useMemo(
    () => filterNativeAssetOptions(nativeAssetOptions, tokenSearch),
    [nativeAssetOptions, tokenSearch],
  );
  const selectedToken = nativeAssetOptions.find((option) => option.unit === selectedTokenUnit) ?? null;
  const deploymentAvailable = deployment?.available === true;
  const canUseWallet =
    deploymentAvailable && walletApi !== null && walletNetworkId === deployment.deployment.networkId;
  const canBuild =
    deploymentAvailable &&
    canUseWallet &&
    changeAddress.trim() !== "" &&
    walletAddresses.length > 0 &&
    isPaymentCredential(normalizedCredential) &&
    requestedAssets !== null;
  const selectedWalletName = wallets.find(([id]) => id === selectedWallet)?.[1].name || selectedWallet || "No wallet selected";
  const viewState = fixtureState ?? deriveLockFundsVisualState({
    deployment,
    deploymentLoading,
    canUseWallet,
    compromisedCredential,
    normalizedCredential,
    inventory,
    builtTx,
    submittedTxHash,
    flowState,
    failure,
  });
  const steps = deriveLockFundsSteps({
    deployment,
    deploymentLoading,
    canUseWallet,
    walletApi,
    walletNetworkId,
    walletAddresses,
    compromisedCredential,
    normalizedCredential,
    inventory,
    builtTx,
    submittedTxHash,
    flowState,
    failure,
  });
  const buildBlockedReason = canBuild
    ? ""
    : lockBuildBlockedReason({
        deployment,
        deploymentLoading,
        walletApi,
        walletNetworkId,
        changeAddress,
        walletAddresses,
        compromisedCredential,
        normalizedCredential,
        adaAmount,
        nativeTokens,
        requestedAssets,
      });
  const heading = lockFundsHeading(viewState);
  const summaryTiles = lockFundsSummaryTiles({
    deployment,
    deploymentLoading,
    canUseWallet,
    canBuild,
    walletName: selectedWalletName,
    flowState,
    requestedAssets,
    builtTx,
    submittedTxHash,
    failure,
  });

  useEffect(() => {
    setFixtureState(readLockFundsFixtureState());
  }, []);

  useEffect(() => {
    if (fixtureState === undefined) {
      return;
    }
    if (fixtureState) {
      const fixture = createLockFundsFixture(fixtureState);
      setDeployment(fixture.deployment);
      setDeploymentLoading(fixture.deploymentLoading);
      setWallets(fixture.wallets);
      setSelectedWallet(fixture.selectedWallet);
      setWalletApi(fixture.walletApi);
      setChangeAddress(fixture.changeAddress);
      setWalletAddresses(fixture.walletAddresses);
      setWalletNetworkId(fixture.walletNetworkId);
      setCompromisedCredential(fixture.compromisedCredential);
      setAdaAmount(fixture.adaAmount);
      setNativeTokens(fixture.nativeTokens);
      setInventory(fixture.inventory);
      setBuiltTx(fixture.builtTx);
      setSubmittedTxHash(fixture.submittedTxHash);
      setFlowState(fixture.flowState);
      setFailure(fixture.failure);
      return;
    }
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
  }, [fixtureState]);

  useEffect(() => {
    if (fixtureState === undefined) {
      return;
    }
    if (fixtureState) {
      return;
    }
    const cardano = ((window as Window & { cardano?: Record<string, unknown> }).cardano ?? {}) as Record<string, unknown>;
    const availableWallets = Object.entries(cardano).filter((entry): entry is [string, CardanoWalletProvider] => {
      const wallet = entry[1] as CardanoWalletProvider | undefined;
      return typeof wallet?.enable === "function";
    });
    setWallets(availableWallets);
    if (availableWallets.length > 0) {
      setSelectedWallet(availableWallets[0][0]);
    }
  }, [fixtureState]);

  useEffect(() => {
    if (!tokenPickerOpen) {
      return;
    }
    if (selectedTokenUnit && nativeAssetOptions.some((option) => option.unit === selectedTokenUnit)) {
      return;
    }
    setSelectedTokenUnit(nativeAssetOptions[0]?.unit ?? "");
  }, [nativeAssetOptions, selectedTokenUnit, tokenPickerOpen]);

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
    setTokenPickerError("");
    setInventory(null);
    setBuiltTx(null);
    setSubmittedTxHash("");
    setAssetsLoading(true);
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
    } finally {
      setAssetsLoading(false);
    }
  };

  const buildTx = async () => {
    if (!deploymentAvailable) {
      return;
    }
    const assets = requestedAssets;
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

  function resetReviewedTransaction() {
    setBuiltTx(null);
    setSubmittedTxHash("");
    setFlowState((current) => {
      if (current === "built" || current === "signing" || current === "submitted") {
        return inventory ? "assets_loaded" : walletApi ? "wallet_connected" : "idle";
      }
      return current;
    });
  }

  function lockAnotherBatch() {
    setFailure("");
    setBuiltTx(null);
    setSubmittedTxHash("");
    setFlowState(inventory ? "assets_loaded" : canUseWallet ? "wallet_connected" : "idle");
  }

  function openTokenPicker() {
    setTokenPickerOpen(true);
    setTokenSearch("");
    setTokenPickerError("");
    setSelectedTokenQuantity("1");
    setSelectedTokenUnit(nativeAssetOptions[0]?.unit ?? "");
  }

  function closeTokenPicker() {
    setTokenPickerOpen(false);
    setTokenPickerError("");
  }

  function addSelectedToken() {
    if (!selectedToken) {
      setTokenPickerError(nativeAssetOptions.length === 0 ? "Refresh wallet inventory before choosing a token." : "Select a token from the wallet inventory.");
      return;
    }
    const quantity = selectedTokenQuantity.trim();
    if (!isPositiveInteger(quantity)) {
      setTokenPickerError("Enter a positive whole-number quantity.");
      return;
    }
    if (BigInt(quantity) > BigInt(selectedToken.available)) {
      setTokenPickerError("Amount to lock cannot exceed the connected wallet balance for this asset.");
      return;
    }
    setNativeTokens((rows) => upsertTokenRow(rows, selectedToken.unit, quantity));
    resetReviewedTransaction();
    closeTokenPicker();
  }

  function enterTokenManually() {
    setNativeTokens((rows) => [...rows, { id: nextTokenRowId(rows), unit: "", quantity: "", manual: true }]);
    resetReviewedTransaction();
    closeTokenPicker();
  }

  const controlsDisabled = deploymentLoading || !deploymentAvailable;
  const credentialEmpty = compromisedCredential.trim() === "";
  const credentialInvalid = !credentialEmpty && !isPaymentCredential(normalizedCredential);
  const addressSourceText =
    walletAddresses.length === 0
      ? "Connect wallet to load CIP-30 addresses"
      : `${walletAddresses.length} CIP-30 wallet address${walletAddresses.length === 1 ? "" : "es"} loaded`;
  const reviewAssets = builtTx?.review.assets ?? requestedAssets ?? {};
  const contextGridClass = builtTx ? "lock-context-grid compact" : "lock-context-grid";

  return (
    <>
    <ReclaimAppShell active="lock" steps={steps} state={viewState}>
      <ReclaimPageHeading title={heading.title} subtitle={heading.subtitle} icon={heading.icon} />

      <div className="claim-page-body">
        {submittedTxHash ? (
          <ReclaimNotice icon={Check} title="Transaction submitted" tone="ok">
            The transaction has been successfully submitted. Transaction hash: {submittedTxHash}
          </ReclaimNotice>
        ) : null}

          {!deploymentAvailable && !deploymentLoading ? (
          <ReclaimNotice icon={CircleAlert} title="Reclaim deployment unavailable" tone="bad">
            {deployment?.missing.join(", ") || "Deployment environment variables are missing."}
          </ReclaimNotice>
        ) : null}

        {failure ? (
          <ReclaimNotice icon={CircleAlert} title="Action failed" tone="bad">
            {failure}
          </ReclaimNotice>
        ) : null}

        <ReclaimSummaryTiles tiles={summaryTiles} />

        {submittedTxHash ? (
          <>
            <ReclaimSummaryTiles
              tiles={[
                {
                  icon: Globe2,
                  label: "Network",
                  value: deploymentAvailable ? deployment.deployment.network : "Unavailable",
                },
                {
                  icon: Coins,
                  label: "Locked value",
                  value: summarizeAssets(reviewAssets),
                },
                {
                  icon: Landmark,
                  label: "Destination",
                  value: "ReclaimBase",
                  detail: deploymentAvailable ? abbreviateMiddle(deployment.deployment.reclaimBaseAddress, 28) : undefined,
                },
                {
                  icon: CheckCircle2,
                  label: "Submit",
                  value: "Complete",
                  emphasis: true,
                },
              ]}
            />
            <ReclaimPanel title="Review / receipt" icon={FileText} className="lock-review-panel">
              {builtTx ? (
                <>
                  <ReclaimReviewRow label="Destination" value={builtTx.review.reclaimBaseAddress} />
                  <ReclaimReviewRow label="Credential datum" value={builtTx.review.compromisedCredential} />
                  <ReclaimReviewRow label="Datum CBOR" value={builtTx.review.datumCbor} />
                </>
              ) : null}
              <ReclaimReviewRow label="Tx hash" value={submittedTxHash} />
              <div className="lock-asset-table-block">
                <strong>Assets locked</strong>
                <AssetList assets={reviewAssets} />
              </div>
            </ReclaimPanel>
            <div className="lock-receipt-actions">
              <button className="claim-secondary-button" type="button" onClick={lockAnotherBatch}>
                <RefreshCw size={21} aria-hidden="true" />
                Lock another batch
              </button>
              <a className="claim-secondary-button lock-claim-link" href="/claim">
                Go to Claim funds
                <Send size={20} aria-hidden="true" />
              </a>
            </div>
          </>
        ) : (
          <>
            <div className={contextGridClass}>
          <ReclaimPanel title="Wallet" icon={Wallet}>
            <div className="lock-field-grid">
              <label className="lock-field">
                <span>Cardano wallet</span>
                <select
                  value={selectedWallet}
                  onChange={(event) => {
                    setSelectedWallet(event.target.value);
                    resetWalletState();
                  }}
                  disabled={controlsDisabled}
                >
                  {wallets.length === 0 ? <option value="">No wallet found</option> : null}
                  {wallets.map(([id, provider]) => (
                    <option key={id} value={id}>
                      {provider.name || id}
                    </option>
                  ))}
                </select>
              </label>
              {!builtTx ? (
                <div className="lock-field">
                  <span aria-hidden="true">Connection</span>
                  <button className="claim-primary-button lock-panel-action" type="button" onClick={connectWallet} disabled={controlsDisabled}>
                    <Wallet size={20} aria-hidden="true" />
                    Connect Wallet
                  </button>
                </div>
              ) : null}
            </div>
            <label className="lock-field" aria-live="polite">
              <span>Address source</span>
              <input readOnly value={addressSourceText} />
            </label>
            <p className="lock-readout">{addressSourceText}</p>
            {changeAddress ? (
              <div className="lock-field">
                <span>Change address</span>
                <code className="lock-code-readout">{abbreviateMiddle(changeAddress, 32)}</code>
              </div>
            ) : null}
            <p className="claim-muted">
              No manual address entry. The change address is read from CIP-30 internally for Lucid change, and the backend checks connected wallet addresses for funded inputs.
            </p>
            <div className="claim-panel-toolbar">
              <button className="claim-secondary-button" type="button" onClick={refreshAssets} disabled={controlsDisabled || walletAddresses.length === 0}>
                <RefreshCw size={20} aria-hidden="true" />
                Refresh Assets
              </button>
            </div>
          </ReclaimPanel>

          <ReclaimPanel title="Compromised credential" icon={KeyRound}>
            <div className="lock-field">
              <div className="lock-field-label">
                <label htmlFor="lock-compromised-credential">Payment key credential</label>
                <em className="lock-required-flag">Required</em>
              </div>
              <input
                id="lock-compromised-credential"
                value={compromisedCredential}
                onChange={(event) => {
                  setCompromisedCredential(event.target.value);
                  resetReviewedTransaction();
                }}
                placeholder={credentialPlaceholder}
                disabled={controlsDisabled}
                required
                aria-invalid={credentialInvalid || undefined}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {credentialEmpty ? (
              <p className="lock-field-hint" aria-live="polite">
                <KeyRound size={16} aria-hidden="true" />
                {credentialEmptyHint}
              </p>
            ) : null}
            <p className="claim-muted">Funds locked for recovery using proof of ownership for this payment key credential.</p>
            {credentialInvalid ? (
              <ReclaimNotice icon={ShieldAlert} title="Credential format" tone="bad">
                {credentialFormatHint}
              </ReclaimNotice>
            ) : null}
          </ReclaimPanel>

          <ReclaimPanel title="Assets to lock" icon={Coins}>
            <div className="lock-field-grid">
              <label className="lock-field">
                <span>ADA amount</span>
                <input
                  value={adaAmount}
                  onChange={(event) => {
                    setAdaAmount(event.target.value);
                    resetReviewedTransaction();
                  }}
                  inputMode="decimal"
                  placeholder="0.000000"
                  disabled={controlsDisabled}
                />
              </label>
              <label className="lock-field">
                <span>Wallet inventory</span>
                <input readOnly value={inventorySummaryText(inventory)} />
              </label>
            </div>
            <p className="lock-readout">{inventorySummaryText(inventory)}</p>

            <div className="lock-asset-editor" aria-label="Native token assets">
              {nativeTokens.length === 0 ? (
                <p className="lock-token-empty">No native tokens selected. Use Token to choose assets from the connected wallet.</p>
              ) : null}
              {nativeTokens.map((token, index) => (
                <div className="lock-asset-row" key={token.id}>
                  {token.manual || !token.unit ? (
                    <label className="lock-field">
                      <span>Asset unit</span>
                      <input
                        value={token.unit}
                        onChange={(event) => {
                          updateTokenRow(index, { unit: event.target.value }, setNativeTokens);
                          resetReviewedTransaction();
                        }}
                        placeholder="policyId + tokenName hex"
                        disabled={controlsDisabled}
                      />
                    </label>
                  ) : (
                    <div className="lock-field">
                      <span>Asset</span>
                      <div className="lock-selected-token">
                        <strong>{formatNativeAssetLabel(token.unit)}</strong>
                        <code>{abbreviateMiddle(token.unit, 34)}</code>
                      </div>
                    </div>
                  )}
                  <label className="lock-field">
                    <span>Quantity</span>
                    <input
                      value={token.quantity}
                      onChange={(event) => {
                        updateTokenRow(index, { quantity: event.target.value }, setNativeTokens);
                        resetReviewedTransaction();
                      }}
                      inputMode="numeric"
                      placeholder="0"
                      disabled={controlsDisabled}
                    />
                  </label>
                  <button
                    className="claim-icon-button lock-remove-token"
                    type="button"
                    aria-label={`Remove native token ${index + 1}`}
                    onClick={() => {
                      removeTokenRow(token.id, setNativeTokens);
                      resetReviewedTransaction();
                    }}
                    disabled={controlsDisabled}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>

            <div className="claim-panel-toolbar">
              <button
                className="claim-secondary-button"
                type="button"
                onClick={openTokenPicker}
                disabled={controlsDisabled}
              >
                <Plus size={20} aria-hidden="true" />
                Token
              </button>
              <button
                className="claim-primary-button lock-build-button"
                type="button"
                onClick={buildTx}
                disabled={!canBuild || flowState === "building"}
                aria-describedby={buildBlockedReason ? "lock-build-blocked-reason" : undefined}
              >
                {flowState === "building" ? <Loader2 className="spin" size={20} aria-hidden="true" /> : <Coins size={20} aria-hidden="true" />}
                Build Transaction
              </button>
            </div>
            {buildBlockedReason ? (
              <p className="lock-build-hint" id="lock-build-blocked-reason" role="status">
                <CircleAlert size={16} aria-hidden="true" />
                {buildBlockedReason}
              </p>
            ) : null}
          </ReclaimPanel>

            </div>

            {flowState === "building" ? (
              <ReclaimPanel title="Review" icon={FileText} className="lock-review-panel">
                <div className="lock-review-loading">
                  <Loader2 className="spin" size={28} aria-hidden="true" />
                  <div>
                    <strong>Building unsigned tx</strong>
                    <p className="claim-muted">The backend is constructing a transaction pinned to the deployment manifest.</p>
                  </div>
                </div>
              </ReclaimPanel>
            ) : null}

            {builtTx ? (
              <ReclaimPanel title="Review" icon={FileText} className="lock-review-panel">
                <div className="lock-review-layout">
                  <div>
                    <ReclaimReviewRow label="Destination" value={builtTx.review.reclaimBaseAddress} />
                    <ReclaimReviewRow label="Credential datum" value={builtTx.review.compromisedCredential} />
                    <ReclaimReviewRow label="Datum CBOR" value={builtTx.review.datumCbor} />
                    <ReclaimReviewRow label="Tx hash" value={builtTx.txHash} />
                  </div>
                  <div className="lock-asset-table-block">
                    <strong>Assets in transaction</strong>
                    <AssetList assets={builtTx.review.assets} />
                    <button className="claim-primary-button lock-submit-button" type="button" onClick={signAndSubmit} disabled={!canUseWallet || flowState === "signing"}>
                      {flowState === "signing" ? <Loader2 className="spin" size={20} aria-hidden="true" /> : <Send size={20} aria-hidden="true" />}
                      Sign and Submit
                    </button>
                    <p className="claim-muted">These assets will be locked at the reclaim contract.</p>
                    <p className="claim-muted lock-submit-note">You will be prompted by your wallet to sign the transaction.</p>
                  </div>
                </div>
              </ReclaimPanel>
            ) : null}
          </>
        )}
      </div>
    </ReclaimAppShell>
    {tokenPickerOpen ? (
      <TokenPickerModal
        assetsLoading={assetsLoading}
        canRefreshInventory={deploymentAvailable && walletAddresses.length > 0}
        filteredOptions={filteredNativeAssetOptions}
        inventory={inventory}
        onAdd={addSelectedToken}
        onClose={closeTokenPicker}
        onManual={enterTokenManually}
        onRefresh={refreshAssets}
        onSearch={setTokenSearch}
        onSelect={(unit) => {
          setSelectedTokenUnit(unit);
          setSelectedTokenQuantity("1");
          setTokenPickerError("");
        }}
        onQuantityChange={(quantity) => {
          setSelectedTokenQuantity(quantity);
          setTokenPickerError("");
        }}
        search={tokenSearch}
        selectedOption={selectedToken}
        selectedQuantity={selectedTokenQuantity}
        tokenPickerError={tokenPickerError}
      />
    ) : null}
    </>
  );
}

function readLockFundsFixtureState(): LockFundsVisualState | null {
  if (typeof window === "undefined") {
    return null;
  }
  const fixtureAllowed = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_LOCK_FUNDS_UI_FIXTURE === "1";
  if (!fixtureAllowed) {
    return null;
  }
  const candidate = new URLSearchParams(window.location.search).get("fixtureState");
  return isLockFundsVisualState(candidate) ? candidate : null;
}

function isLockFundsVisualState(value: string | null): value is LockFundsVisualState {
  return (
    value === "loading-deployment" ||
    value === "deployment-unavailable" ||
    value === "ready-idle" ||
    value === "wallet-connected" ||
    value === "credential-format-warning" ||
    value === "assets-loaded" ||
    value === "building-transaction" ||
    value === "review-built" ||
    value === "signing-awaiting-wallet" ||
    value === "submitted" ||
    value === "failed-build"
  );
}

type LockFundsFixture = {
  deployment: DeploymentResponse | null;
  deploymentLoading: boolean;
  wallets: Array<[string, CardanoWalletProvider]>;
  selectedWallet: string;
  walletApi: CardanoWalletApi | null;
  changeAddress: string;
  walletAddresses: string[];
  walletNetworkId: number | undefined;
  compromisedCredential: string;
  adaAmount: string;
  nativeTokens: NativeTokenRow[];
  inventory: WalletAssetsResponse | null;
  builtTx: BuildReclaimTxResponse | null;
  submittedTxHash: string;
  flowState: FlowState;
  failure: string;
};

function createLockFundsFixture(state: LockFundsVisualState): LockFundsFixture {
  const deployment = fixtureDeployment();
  const unavailableDeployment: DeploymentResponse = {
    available: false,
    deployment: null,
    missing: ["RECLAIM_BASE_ADDRESS"],
  };
  const walletApi = fixtureWalletApi();
  const connected = state !== "loading-deployment" && state !== "deployment-unavailable" && state !== "ready-idle";
  const credential =
    state === "credential-format-warning"
      ? "not-a-28-byte-payment-credential"
      : state === "ready-idle" || state === "wallet-connected"
        ? ""
        : fixtureCompromisedCredential;
  const hasAssets =
    state === "assets-loaded" ||
    state === "building-transaction" ||
    state === "review-built" ||
    state === "signing-awaiting-wallet" ||
    state === "submitted" ||
    state === "failed-build";
  const builtTx = state === "review-built" || state === "signing-awaiting-wallet" || state === "submitted" ? fixtureBuiltTx() : null;

  return {
    deployment: state === "loading-deployment" ? null : state === "deployment-unavailable" ? unavailableDeployment : deployment,
    deploymentLoading: state === "loading-deployment",
    wallets: [["lace", fixtureProvider(walletApi)]],
    selectedWallet: "lace",
    walletApi: connected ? walletApi : null,
    changeAddress: connected ? fixtureWalletAddress : "",
    walletAddresses: connected ? [fixtureWalletAddress, fixtureUsedWalletAddress] : [],
    walletNetworkId: connected ? 0 : undefined,
    compromisedCredential: credential,
    adaAmount: hasAssets ? "1.5" : "",
    nativeTokens: hasAssets ? [{ id: 1, unit: fixtureTokenUnit, quantity: "2" }] : [],
    inventory: hasAssets ? fixtureInventory() : null,
    builtTx,
    submittedTxHash: state === "submitted" ? "submitted-hash" : "",
    flowState: fixtureFlowState(state),
    failure: state === "failed-build" ? "Mock build rejected for screenshot coverage." : "",
  };
}

function fixtureFlowState(state: LockFundsVisualState): FlowState {
  switch (state) {
    case "deployment-unavailable":
      return "deployment_unavailable";
    case "wallet-connected":
    case "credential-format-warning":
      return "wallet_connected";
    case "assets-loaded":
      return "assets_loaded";
    case "building-transaction":
      return "building";
    case "review-built":
      return "built";
    case "signing-awaiting-wallet":
      return "signing";
    case "submitted":
      return "submitted";
    case "failed-build":
      return "failed";
    default:
      return "idle";
  }
}

function fixtureProvider(api: CardanoWalletApi): CardanoWalletProvider {
  return {
    name: "Lace Demo Wallet",
    enable: async () => api,
  };
}

function fixtureWalletApi(): CardanoWalletApi {
  return {
    getNetworkId: async () => 0,
    getUsedAddresses: async () => [fixtureUsedWalletAddressHex],
    getChangeAddress: async () => fixtureWalletAddressHex,
    signTx: async () => "84a100",
  };
}

function fixtureDeployment(): DeploymentResponse {
  return {
    available: true,
    deployment: {
      id: "preprod:reclaim-base:commit",
      network: "Preprod",
      networkId: 0,
      reclaimBaseAddress: "addr_test1wreclaimbase00000000000000000000000000000000000000000",
      reclaimBaseScriptHash: "reclaim-base-script-hash",
      reclaimGlobalCredential: "reclaim-global-credential",
      reclaimGlobalScriptHash: "reclaim-global-script-hash",
      paramsCurrencySymbol: "params-policy",
      paramsTokenName: "params-token",
      verifierVkHash: "vk-hash",
      contractVersion: "v1",
      sourceCommit: "commit",
    },
    missing: [],
  };
}

function fixtureInventory(): WalletAssetsResponse {
  return {
    changeAddress: fixtureWalletAddress,
    walletAddresses: [fixtureWalletAddress, fixtureUsedWalletAddress],
    network: "Preprod",
    networkId: 0,
    utxoCount: 2,
    assets: {
      [LOVELACE_UNIT]: "3000000",
      [fixtureTokenUnit]: "5",
    },
  };
}

function fixtureBuiltTx(): BuildReclaimTxResponse {
  const deployment = fixtureDeployment();
  if (!deployment.available) {
    throw new Error("Fixture deployment unavailable.");
  }
  return {
    txCbor: "84a400",
    txHash: "body-hash",
    reviewHash: "review-hash",
    reviewToken: "review-token",
    review: {
      changeAddress: fixtureWalletAddress,
      walletAddresses: [fixtureWalletAddress, fixtureUsedWalletAddress],
      reclaimBaseAddress: deployment.deployment.reclaimBaseAddress,
      compromisedCredential: fixtureCompromisedCredential,
      datumCbor: "d8799f581c19e07fbcff",
      assets: {
        [LOVELACE_UNIT]: "1500000",
        [fixtureTokenUnit]: "2",
      },
      network: "Preprod",
      deploymentId: deployment.deployment.id,
    },
  };
}

function deriveLockFundsVisualState({
  deployment,
  deploymentLoading,
  canUseWallet,
  compromisedCredential,
  normalizedCredential,
  inventory,
  builtTx,
  submittedTxHash,
  flowState,
  failure,
}: {
  deployment: DeploymentResponse | null;
  deploymentLoading: boolean;
  canUseWallet: boolean;
  compromisedCredential: string;
  normalizedCredential: string;
  inventory: WalletAssetsResponse | null;
  builtTx: BuildReclaimTxResponse | null;
  submittedTxHash: string;
  flowState: FlowState;
  failure: string;
}): LockFundsVisualState {
  if (deploymentLoading) {
    return "loading-deployment";
  }
  if (!deployment?.available) {
    return "deployment-unavailable";
  }
  if (submittedTxHash || flowState === "submitted") {
    return "submitted";
  }
  if (flowState === "signing") {
    return "signing-awaiting-wallet";
  }
  if (builtTx || flowState === "built") {
    return "review-built";
  }
  if (flowState === "building") {
    return "building-transaction";
  }
  if (failure || flowState === "failed") {
    return "failed-build";
  }
  if (compromisedCredential.trim() && !isPaymentCredential(normalizedCredential)) {
    return "credential-format-warning";
  }
  if (inventory) {
    return "assets-loaded";
  }
  if (canUseWallet) {
    return "wallet-connected";
  }
  return "ready-idle";
}

function deriveLockFundsSteps({
  deployment,
  deploymentLoading,
  canUseWallet,
  walletApi,
  walletNetworkId,
  walletAddresses,
  compromisedCredential,
  normalizedCredential,
  inventory,
  builtTx,
  submittedTxHash,
  flowState,
  failure,
}: {
  deployment: DeploymentResponse | null;
  deploymentLoading: boolean;
  canUseWallet: boolean;
  walletApi: CardanoWalletApi | null;
  walletNetworkId: number | undefined;
  walletAddresses: string[];
  compromisedCredential: string;
  normalizedCredential: string;
  inventory: WalletAssetsResponse | null;
  builtTx: BuildReclaimTxResponse | null;
  submittedTxHash: string;
  flowState: FlowState;
  failure: string;
}): ReclaimShellStep[] {
  const statuses = new Map<LockStepId, { status: ReclaimShellStepStatus; label: string }>();
  const deploymentReady = deployment?.available === true;
  const credentialValid = isPaymentCredential(normalizedCredential);
  const credentialEntered = compromisedCredential.trim() !== "";

  statuses.set(
    "deployment",
    deploymentLoading
      ? { status: "active", label: "Loading deployment" }
      : deploymentReady
        ? { status: "complete", label: `${deployment.deployment.network} deployment ready` }
        : { status: "attention", label: "Needs attention" },
  );

  const walletAttention = flowState === "failed" && !walletApi;
  statuses.set(
    "wallet",
    !deploymentReady
      ? { status: "pending", label: "Pending" }
      : walletAttention
        ? { status: "attention", label: "Needs attention" }
        : canUseWallet
          ? { status: "complete", label: walletAddresses.length > 0 ? `${walletAddresses.length} CIP-30 addresses loaded` : "Ready to sign" }
          : walletApi && deploymentReady && walletNetworkId !== deployment.deployment.networkId
            ? { status: "attention", label: "Network mismatch" }
            : { status: "active", label: "Active" },
  );

  statuses.set(
    "credential",
    !canUseWallet
      ? { status: "pending", label: "Pending" }
      : credentialEntered && !credentialValid
        ? { status: "attention", label: "Needs attention" }
        : credentialValid
          ? { status: "complete", label: "Credential set" }
          : { status: "active", label: "Active" },
  );

  const assetsReady = Boolean(inventory);
  const railAssetSummary = inventory ? railAssetSummaryText(inventory) : "Active";
  statuses.set(
    "assets",
    !credentialValid
      ? { status: "pending", label: "Pending" }
      : flowState === "failed" && !builtTx
        ? { status: "active", label: assetsReady ? railAssetSummary : "Active" }
        : assetsReady
          ? { status: "complete", label: railAssetSummary }
          : { status: "active", label: "Active" },
  );

  statuses.set(
    "review",
    submittedTxHash
      ? { status: "complete", label: "Complete" }
      : flowState === "signing"
        ? { status: "complete", label: "Complete" }
        : builtTx
          ? { status: "active", label: "Ready for wallet signature" }
          : flowState === "building"
            ? { status: "active", label: "Building unsigned tx" }
            : flowState === "failed" && credentialValid
              ? { status: "attention", label: failure ? "Action failed" : "Needs attention" }
              : { status: "pending", label: "Pending" },
  );

  statuses.set(
    "submit",
    submittedTxHash
      ? { status: "complete", label: "Complete" }
      : flowState === "signing"
        ? { status: "active", label: "Awaiting wallet" }
        : flowState === "failed" && builtTx
          ? { status: "attention", label: "Needs attention" }
          : { status: "pending", label: "Pending" },
  );

  return lockFundsSteps.map((step) => {
    const next = statuses.get(step.key) ?? { status: "pending" as const, label: "Pending" };
    return {
      id: step.id,
      label: step.label,
      icon: step.icon,
      status: next.status,
      statusLabel: next.label,
    };
  });
}

function lockFundsHeading(state: LockFundsVisualState): { title: string; subtitle: string; icon?: LucideIcon } {
  if (state === "loading-deployment") {
    return {
      title: "Loading deployment",
      subtitle: "Checking the ReclaimBase deployment before wallet actions are enabled.",
      icon: Loader2,
    };
  }
  if (state === "deployment-unavailable") {
    return {
      title: "Deployment unavailable",
      subtitle: "Reclaim deployment configuration is missing, so wallet actions are disabled.",
      icon: CircleAlert,
    };
  }
  if (state === "review-built" || state === "signing-awaiting-wallet") {
    return {
      title: "Review transaction",
      subtitle: "Review the transaction details below. The funds will be locked at the reclaim contract.",
    };
  }
  if (state === "submitted") {
    return {
      title: "Funds locked",
      subtitle: "The transaction has been submitted to lock compromised-credential funds at ReclaimBase.",
      icon: Check,
    };
  }
  return {
    title: "Move funds to ReclaimBase",
    subtitle: "Backend-built Cardano transaction with inline datum.",
  };
}

function lockFundsSummaryTiles({
  deployment,
  deploymentLoading,
  canUseWallet,
  canBuild,
  walletName,
  flowState,
  requestedAssets,
  builtTx,
  submittedTxHash,
  failure,
}: {
  deployment: DeploymentResponse | null;
  deploymentLoading: boolean;
  canUseWallet: boolean;
  canBuild: boolean;
  walletName: string;
  flowState: FlowState;
  requestedAssets: AssetMap | null;
  builtTx: BuildReclaimTxResponse | null;
  submittedTxHash: string;
  failure: string;
}): ReclaimSummaryTile[] {
  const deploymentValue = deploymentLoading ? "Loading" : deployment?.available ? deployment.deployment.network : "Unavailable";
  const deploymentDetail = deployment?.available ? "Deployment ready" : deploymentLoading ? "Checking deployment" : "Missing configuration";
  const transactionValue = submittedTxHash
    ? "Submitted"
    : failure || flowState === "failed"
      ? "Needs attention"
      : flowState === "signing"
        ? "Awaiting wallet"
        : builtTx
          ? "Ready for wallet signature"
          : flowState === "building"
            ? "Building unsigned tx"
            : canBuild
              ? "Ready to build"
              : requestedAssets
                ? "Awaiting requirements"
                : "ReclaimBase";

  return [
    {
      icon: Globe2,
      label: "Network",
      value: deploymentValue,
      detail: deploymentDetail,
      emphasis: deployment?.available === true,
    },
    {
      icon: Wallet,
      label: "Wallet",
      value: canUseWallet ? "Ready to sign" : "Not connected",
      detail: canUseWallet ? walletName : "Funding wallet",
    },
    {
      icon: failure || flowState === "failed" ? CircleAlert : FileText,
      label: "Transaction",
      value: transactionValue,
      detail: submittedTxHash
        ? "Receipt available"
        : builtTx
          ? "Unsigned transaction built"
          : canBuild
            ? "All requirements met"
            : requestedAssets
              ? "Complete the remaining steps"
              : "Lock flow",
      emphasis: Boolean(builtTx || submittedTxHash),
    },
  ];
}

// Mirrors the canBuild predicate: the first unmet prerequisite becomes the
// user-facing reason the Build Transaction button is disabled.
function lockBuildBlockedReason({
  deployment,
  deploymentLoading,
  walletApi,
  walletNetworkId,
  changeAddress,
  walletAddresses,
  compromisedCredential,
  normalizedCredential,
  adaAmount,
  nativeTokens,
  requestedAssets,
}: {
  deployment: DeploymentResponse | null;
  deploymentLoading: boolean;
  walletApi: CardanoWalletApi | null;
  walletNetworkId: number | undefined;
  changeAddress: string;
  walletAddresses: string[];
  compromisedCredential: string;
  normalizedCredential: string;
  adaAmount: string;
  nativeTokens: NativeTokenRow[];
  requestedAssets: AssetMap | null;
}): string {
  if (deploymentLoading) {
    return "Waiting for the deployment check to finish.";
  }
  if (deployment?.available !== true) {
    return "Reclaim deployment is unavailable.";
  }
  if (!walletApi) {
    return "Connect the funding wallet to continue.";
  }
  if (walletNetworkId !== deployment.deployment.networkId) {
    return `Switch the wallet to the ${deployment.deployment.network} network.`;
  }
  if (changeAddress.trim() === "" || walletAddresses.length === 0) {
    return "Reconnect the wallet to load its CIP-30 addresses.";
  }
  if (compromisedCredential.trim() === "") {
    return credentialEmptyHint;
  }
  if (!isPaymentCredential(normalizedCredential)) {
    return credentialFormatHint;
  }
  if (requestedAssets === null) {
    const hasAssetInput =
      adaAmount.trim() !== "" || nativeTokens.some((token) => token.unit.trim() !== "" || token.quantity.trim() !== "");
    return hasAssetInput
      ? "Enter valid asset amounts: a positive ADA amount, and a unit plus whole-number quantity for each token."
      : "Add an ADA amount or native token to lock.";
  }
  return "";
}

function inventorySummaryText(inventory: WalletAssetsResponse | null): string {
  if (!inventory) {
    return "Not loaded";
  }
  const assetCount = Object.keys(inventory.assets).length;
  return `${inventory.utxoCount} UTxO${inventory.utxoCount === 1 ? "" : "s"}, ${assetCount} asset${assetCount === 1 ? "" : "s"}`;
}

function railAssetSummaryText(inventory: WalletAssetsResponse): string {
  const assetCount = Object.keys(inventory.assets).length;
  return `${assetCount} asset${assetCount === 1 ? "" : "s"}, ${inventory.utxoCount} UTxO${inventory.utxoCount === 1 ? "" : "s"}`;
}

function summarizeAssets(assets: AssetMap): string {
  const rows = sortAssets(assets);
  if (rows.length === 0) {
    return "No value selected";
  }
  const ada = rows.find(([unit]) => unit === LOVELACE_UNIT);
  const tokenCount = rows.filter(([unit]) => unit !== LOVELACE_UNIT).length;
  const adaText = ada ? `${formatLovelace(ada[1])} ADA` : "";
  const tokenText = tokenCount === 0 ? "" : `${tokenCount} token${tokenCount === 1 ? "" : "s"}`;
  return [adaText, tokenText].filter(Boolean).join(" + ") || `${rows.length} assets`;
}

function abbreviateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const prefix = Math.max(8, Math.floor((maxLength - 1) / 2));
  const suffix = Math.max(6, maxLength - prefix - 1);
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function walletNativeAssetOptions(inventory: WalletAssetsResponse | null): NativeAssetOption[] {
  if (!inventory) {
    return [];
  }
  return Object.entries(inventory.assets)
    .filter(([unit, quantity]) => unit !== LOVELACE_UNIT && isPositiveInteger(quantity) && BigInt(quantity) > 0n)
    .map(([unit, available]) => {
      const policyId = unit.slice(0, 56);
      const tokenNameHex = unit.slice(56);
      return {
        unit,
        label: formatNativeAssetLabel(unit),
        policyId,
        tokenNameHex,
        available,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label) || left.unit.localeCompare(right.unit));
}

function filterNativeAssetOptions(options: NativeAssetOption[], search: string): NativeAssetOption[] {
  const query = search.trim().toLowerCase();
  if (!query) {
    return options;
  }
  return options.filter((option) =>
    [option.label, option.unit, option.policyId, option.tokenNameHex].some((value) => value.toLowerCase().includes(query)),
  );
}

function formatNativeAssetLabel(unit: string): string {
  const tokenName = decodeTokenNameHex(unit.slice(56));
  return tokenName || "Policy asset";
}

function decodeTokenNameHex(tokenNameHex: string): string {
  if (!tokenNameHex || tokenNameHex.length % 2 !== 0 || !HEX_RE.test(tokenNameHex)) {
    return "";
  }
  const bytes = hexToBytes(tokenNameHex);
  const decoded = new TextDecoder().decode(bytes).trim();
  if (!decoded || /[^\x20-\x7e]/u.test(decoded)) {
    return "";
  }
  return decoded;
}

const fixtureWalletAddress = "addr_test1vqv7qlaucathxkwkc503ujw0rv9lfj2rkj96feyst2rs9eqqyas5r";
const fixtureWalletAddressHex = "6019e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const fixtureUsedWalletAddress = "addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5";
const fixtureUsedWalletAddressHex = "6022222222222222222222222222222222222222222222222222222222";
const fixtureTokenUnit = `${"a".repeat(56)}4e4654`;

function TokenPickerModal({
  assetsLoading,
  canRefreshInventory,
  filteredOptions,
  inventory,
  onAdd,
  onClose,
  onManual,
  onRefresh,
  onSearch,
  onSelect,
  onQuantityChange,
  search,
  selectedOption,
  selectedQuantity,
  tokenPickerError,
}: {
  assetsLoading: boolean;
  canRefreshInventory: boolean;
  filteredOptions: NativeAssetOption[];
  inventory: WalletAssetsResponse | null;
  onAdd: () => void;
  onClose: () => void;
  onManual: () => void;
  onRefresh: () => void;
  onSearch: (value: string) => void;
  onSelect: (unit: string) => void;
  onQuantityChange: (value: string) => void;
  search: string;
  selectedOption: NativeAssetOption | null;
  selectedQuantity: string;
  tokenPickerError: string;
}) {
  const quantityOk =
    selectedOption !== null &&
    isPositiveInteger(selectedQuantity) &&
    BigInt(selectedQuantity) <= BigInt(selectedOption.available);

  return (
    <div className="lock-token-modal-backdrop">
      <section className="lock-token-modal" role="dialog" aria-modal="true" aria-labelledby="lock-token-modal-title">
        <header className="lock-token-modal-header">
          <div>
            <h2 id="lock-token-modal-title">Add token from wallet</h2>
            <p>Choose a native asset held by the connected funding wallet.</p>
          </div>
          <button className="claim-icon-button" type="button" onClick={onClose} aria-label="Close token selector">
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className="lock-token-modal-body">
          <div className="lock-token-picker-list">
            <label className="lock-token-search">
              <span>Search policy ID or token name</span>
              <div>
                <Search size={18} aria-hidden="true" />
                <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search policy ID or token name" />
              </div>
            </label>

            {!inventory ? (
              <div className="lock-token-empty-state">
                <strong>Wallet inventory not loaded</strong>
                <p>Refresh the connected CIP-30 wallet inventory before choosing a native asset.</p>
                <button className="claim-secondary-button" type="button" onClick={onRefresh} disabled={!canRefreshInventory || assetsLoading}>
                  {assetsLoading ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <RefreshCw size={18} aria-hidden="true" />}
                  Refresh wallet inventory
                </button>
              </div>
            ) : filteredOptions.length === 0 ? (
              <div className="lock-token-empty-state">
                <strong>No matching native assets</strong>
                <p>{search.trim() ? "No wallet asset matches that search." : "This connected wallet inventory has no native tokens."}</p>
              </div>
            ) : (
              <div className="lock-token-table" aria-label="Wallet native assets">
                <div className="lock-token-table-head">
                  <span>Token</span>
                  <span>Available</span>
                  <span>Unit</span>
                  <span>Action</span>
                </div>
                {filteredOptions.map((option) => (
                  <div className={`lock-token-table-row ${selectedOption?.unit === option.unit ? "selected" : ""}`} key={option.unit}>
                    <div>
                      <strong>{option.label}</strong>
                      <small>{abbreviateMiddle(option.policyId, 18)}</small>
                    </div>
                    <strong>{option.available}</strong>
                    <code>{abbreviateMiddle(option.unit, 22)}</code>
                    <button className="claim-secondary-button" type="button" onClick={() => onSelect(option.unit)}>
                      Select
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <aside className="lock-token-selection" aria-label="Selected native asset">
            {selectedOption ? (
              <>
                <span>Selected asset</span>
                <strong>{selectedOption.label}</strong>
                <dl>
                  <div>
                    <dt>Available</dt>
                    <dd>{selectedOption.available}</dd>
                  </div>
                  <div>
                    <dt>Unit</dt>
                    <dd>
                      <code>{selectedOption.unit}</code>
                    </dd>
                  </div>
                </dl>
                <label className="lock-field">
                  <span>Amount to lock</span>
                  <input value={selectedQuantity} onChange={(event) => onQuantityChange(event.target.value)} inputMode="numeric" />
                </label>
                {tokenPickerError ? <p className="lock-token-error">{tokenPickerError}</p> : null}
                <button className="claim-primary-button" type="button" onClick={onAdd} disabled={!quantityOk}>
                  Add token
                </button>
              </>
            ) : (
              <div className="lock-token-empty-state compact">
                <strong>Select a wallet asset</strong>
                <p>Choose a token from the inventory list to fill its exact asset unit.</p>
              </div>
            )}
          </aside>
        </div>

        <footer className="lock-token-modal-footer">
          <button className="lock-token-link-button" type="button" onClick={onManual}>
            Enter unit manually
          </button>
          <button className="claim-secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </section>
    </div>
  );
}

function AssetList({ assets }: { assets: AssetMap }) {
  const rows = sortAssets(assets);
  if (rows.length === 0) {
    return <p className="claim-muted">No assets selected.</p>;
  }
  return (
    <div className="lock-asset-table">
      <div className="lock-asset-table-head">
        <span>Asset</span>
        <span>Quantity</span>
      </div>
      {rows.map(([unit, quantity]) => (
        <div className="lock-asset-table-row" key={unit}>
          <span>{formatAssetUnit(unit)}</span>
          <strong>{unit === LOVELACE_UNIT ? formatLovelace(quantity) : quantity}</strong>
        </div>
      ))}
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
    if (!unit || !isPositiveInteger(quantity)) {
      return null;
    }
    assets[unit] = ((BigInt(assets[unit] ?? "0") + BigInt(quantity))).toString();
  }
  return Object.keys(assets).length > 0 ? assets : null;
}

function isPositiveInteger(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value.trim()) && BigInt(value.trim()) > 0n;
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

function upsertTokenRow(rows: NativeTokenRow[], unit: string, quantity: string): NativeTokenRow[] {
  const existing = rows.findIndex((row) => row.unit === unit);
  if (existing >= 0) {
    return rows.map((row, index) => (index === existing ? { ...row, quantity, manual: false } : row));
  }
  return [...rows, { id: nextTokenRowId(rows), unit, quantity }];
}

function removeTokenRow(id: number, setNativeTokens: React.Dispatch<React.SetStateAction<NativeTokenRow[]>>) {
  setNativeTokens((rows) => rows.filter((row) => row.id !== id));
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
