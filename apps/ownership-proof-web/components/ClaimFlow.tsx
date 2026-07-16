"use client";

import { bech32 } from "bech32";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Coins,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Github,
  Globe2,
  HelpCircle,
  KeyRound,
  Link2,
  Lock,
  LockKeyhole,
  Monitor,
  PauseCircle,
  PlaySquare,
  RefreshCw,
  Rocket,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { isValidRecoveryWord, validateRecoveryPhrase } from "@proof-zk-recovery/proof-tool-client";
import {
  CLAIM_DEFAULT_BATCH_CAP,
  CLAIM_HARD_BATCH_CAP,
  CLAIM_LEGACY_DEFAULT_BATCH_CAP,
  CLAIM_LEGACY_HARD_BATCH_CAP,
  CLAIM_LEGACY_OPTIMIZATION_BATCH_CAP,
  type ClaimBuildResponse,
  type ClaimDraftResponse,
  type ClaimProgressResponse,
  type ClaimSubmitResponse,
  type IndexedReclaimUtxo,
  type ReclaimUtxosResponse,
} from "../lib/claim/types";
import type { AssetMap, BrowserProvingDescriptor, DeploymentResponse, ReclaimApiError, ReclaimNetwork } from "../lib/reclaim/types";
import { LOVELACE_UNIT } from "../lib/reclaim/types";
import {
  ProvingCancelledError,
  checkBrowserProving,
  disposePreparedBrowserProvingSession,
  proveDestinationInBrowser,
} from "../lib/proving/browser-wasm";
import {
  downloadLastBrowserProvingDiagnostic,
  hasBrowserProvingDiagnostic,
} from "../lib/proving/diagnostic";
import {
  DesktopHelperCancelledError,
  preflightDestinationViaHelper,
  proveDestinationViaHelper,
} from "../lib/proving/desktop-helper";
import { fetchLoopback, queryLoopbackPermission } from "../lib/proving/loopback-access";
import {
  acknowledgePairing,
  broadcastPairing,
  createRelayId,
  subscribeToPairing,
} from "../lib/proving/helper-pairing-relay";
import type {
  BrowserProvingStatus,
  DestinationProofResponse,
  ProofProgressEvent,
} from "../lib/proving/types";

type ClaimScreen =
  | "deployment-review"
  | "deployment-unavailable"
  | "impacted-wallet"
  | "wrong-network"
  | "scanning-claims"
  | "no-matching-funds"
  | "available-claims-page-1"
  | "available-claims-page-2"
  | "available-claims-asset-modal"
  | "safe-wallet"
  | "safe-wallet-overlap"
  | "insufficient-ada"
  | "helper-unavailable"
  | "create-proofs-ready"
  | "create-proofs-generating"
  | "proof-failed"
  | "create-proofs-complete"
  | "current-batch"
  | "claim-funds-overview"
  | "signature-rejected"
  | "submitted-refreshing"
  | "claim-review-complete";

type StepStatus = "pending" | "active" | "complete";

type Step = {
  id: number;
  label: string;
  icon: LucideIcon;
};

type SummaryTile = {
  icon: LucideIcon;
  label: string;
  value: string;
  detail?: string;
  status?: string;
  statusTone?: "ok" | "warn" | "bad";
  statusIcon?: LucideIcon;
  emphasis?: boolean;
  actionLabel?: string;
  onAction?: () => void;
};

type ClaimRow = {
  id: number;
  tx: string;
  output: number;
  credential: string;
  ada: string;
  assets: string;
  summary: string[];
  lovelace?: string;
  assetCount?: number;
  value?: AssetMap;
  paymentCredential?: string;
  outRefId?: string;
  outRef?: {
    txHash: string;
    outputIndex: number;
  };
  confirmationSlot?: number | null;
};

type ClaimDeploymentResponse = DeploymentResponse & {
  capabilities?: unknown;
};

type CardanoWalletProvider = {
  name?: string;
  icon?: string;
  enable(): Promise<ReadOnlyWalletApi | SigningWalletApi>;
};

type ReadOnlyWalletApi = {
  getNetworkId(): Promise<number>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses?: () => Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses?: () => Promise<string[]>;
};

type SigningWalletApi = ReadOnlyWalletApi & {
  signTx(txCbor: string, partialSign?: boolean): Promise<string>;
};

type CardanoWalletApi = ReadOnlyWalletApi;

type WalletEntry = [string, CardanoWalletProvider];

type ImpactedWalletSummary = {
  walletId: string;
  walletName: string;
  networkId: number;
  addresses: string[];
  credentials: string[];
};

type SafeWalletSummary = ImpactedWalletSummary & {
  changeAddress: string;
};

type ClaimHelperState =
  | "unpaired"
  | "checking"
  | "ready"
  | "permission-prompt"
  | "permission-denied"
  | "unavailable";
type LocalProofMethod = "desktop" | "browser";
type SafeWalletSigningSessionState =
  | "not-connected"
  | "resume-reconnect-required"
  | "ready"
  | "destination-blocked";
type ClaimSubmitPhase =
  | "building-transaction"
  | "ready-to-sign"
  | "reconnect-required"
  | "reconnecting"
  | "signing-in-wallet"
  | "submitting"
  | "submitted-refreshing"
  | "failed";

type ClaimHelperDestinationProfile = {
  profile?: string;
  key_hash?: string;
  key_ready?: boolean;
  compatibility?: string;
  key_version?: string;
};

type ClaimHelperStatusResponse = {
  connected?: boolean;
  sidecar_version?: string;
  protocol_version?: string;
  capabilities?: string[];
  destination_profile?: ClaimHelperDestinationProfile;
};

type SubmittedClaimTx = {
  txHash: string;
  selectedOutrefs: string[];
  reviewHash?: string;
  valueSummary?: ClaimValueSummary;
};

type ClaimValueSummary = {
  lovelace: string;
  assetCount: number;
  utxoCount: number;
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

export type ClaimFlowProps = {
  createWorker?: () => WorkerLike;
};

const recoveryPhraseWordCounts = [12, 15, 24] as const;
type RecoveryPhraseWordCount = (typeof recoveryPhraseWordCounts)[number];

type RecoveryPhrasePasteStatus = {
  tone: "ok" | "warn" | "bad";
  message: string;
};

// C32: structured amounts carried by the backend's
// safe_wallet_lovelace_unavailable error (lovelace strings, never secrets).
type InsufficientAdaDetails = {
  availableLovelace: string;
  requiredLovelace: string;
};

type ClaimFlowResumeSnapshot = {
  version: 1;
  updatedAt: number;
  screen: ClaimScreen;
  selectedImpactedWallet: string;
  selectedSafeWallet: string;
  impactedWallet: ImpactedWalletSummary | null;
  safeWallet: SafeWalletSummary;
  claimRows: ClaimRow[];
  claimIndexerTotal: number;
  pendingOutrefs: string[];
  draft: ClaimDraftResponse;
  proofArtifacts?: Record<string, unknown>[];
  build?: ClaimBuildResponse | null;
};

type ClaimFlowRuntime = {
  deployment: ClaimDeploymentResponse | null;
  deploymentLoading: boolean;
  deploymentError: string;
  continueFromDeployment: () => void;
  wallets: WalletEntry[];
  selectedImpactedWallet: string;
  setSelectedImpactedWallet: React.Dispatch<React.SetStateAction<string>>;
  selectedSafeWallet: string;
  setSelectedSafeWallet: React.Dispatch<React.SetStateAction<string>>;
  impactedWallet: ImpactedWalletSummary | null;
  impactedWalletError: string;
  discoverClaimsForImpactedWallet: () => void;
  continueToSafeWallet: () => void;
  safeWallet: SafeWalletSummary | null;
  safeWalletError: string;
  connectSafeWallet: () => void;
  confirmSafeWalletDestination: () => void;
  chooseDifferentSafeWallet: () => void;
  claimRows: ClaimRow[];
  claimIndexerTotal: number;
  claimScanProgress: number;
  claimDiscoveryError: string;
  refreshClaimMatches: () => void;
  changeClaimsPage: (page: 1 | 2) => void;
  openClaimAssetModal: (row: ClaimRow) => void;
  sevenSlotOptInAvailable: boolean;
  sevenSlotOptIn: boolean;
  setSevenSlotOptIn: React.Dispatch<React.SetStateAction<boolean>>;
  draft: ClaimDraftResponse | null;
  draftError: string;
  insufficientAdaDetails: InsufficientAdaDetails | null;
  helperState: ClaimHelperState;
  helperStatus: ClaimHelperStatusResponse | null;
  helperError: string;
  checkHelper: () => void;
  proofArtifacts: Record<string, unknown>[];
  proofError: string;
  phraseChecksumFailed: boolean;
  clearPhraseChecksumError: () => void;
  proofMethod: LocalProofMethod | null;
  setProofMethod: React.Dispatch<React.SetStateAction<LocalProofMethod | null>>;
  browserProvingStatus: BrowserProvingStatus;
  browserProvingDetail: string;
  refreshBrowserProvingStatus: () => Promise<boolean>;
  proofProgress: ProofProgressEvent | null;
  cancelLocalProving: () => void;
  generateClaimProofs: () => void;
  build: ClaimBuildResponse | null;
  buildError: string;
  submitError: string;
  submitFailureKind: ClaimSubmitFailureKind | null;
  safeWalletSigningAvailable: boolean;
  safeWalletSigningSessionState: SafeWalletSigningSessionState;
  submitPhase: ClaimSubmitPhase;
  submittedClaims: SubmittedClaimTx[];
  progress: ClaimProgressResponse | null;
  buildOrSubmitCurrentBatch: () => void;
  refreshSubmittedProgress: () => void;
  checkSubmittedBatchStatus: () => void;
  startNextBatch: () => void;
  startAnotherRecovery: () => void;
  finishRecovery: () => void;
  goToCurrentBatch: () => void;
};

type ProofRow = {
  claim: string;
  value: string;
  proof: string;
  status: "ready" | "generating" | "waiting";
};

type TransactionRow = {
  batch: number;
  txHash: string;
  displayHash: string;
  value: string;
  ada?: string;
  tokens?: string;
  status: "Confirmed" | "Pending";
};

type ClaimSubmitFailureKind = "signature" | "post-sign-submit";

const fixtureScreens = new Set<ClaimScreen>([
  "deployment-review",
  "deployment-unavailable",
  "impacted-wallet",
  "wrong-network",
  "scanning-claims",
  "no-matching-funds",
  "available-claims-page-1",
  "available-claims-page-2",
  "available-claims-asset-modal",
  "safe-wallet",
  "safe-wallet-overlap",
  "insufficient-ada",
  "helper-unavailable",
  "create-proofs-ready",
  "create-proofs-generating",
  "proof-failed",
  "create-proofs-complete",
  "current-batch",
  "claim-funds-overview",
  "signature-rejected",
  "submitted-refreshing",
  "claim-review-complete",
]);

const steps: Step[] = [
  { id: 1, label: "Verify service", icon: Rocket },
  { id: 2, label: "Impacted wallet", icon: Wallet },
  { id: 3, label: "Available claims", icon: Coins },
  { id: 4, label: "Safe wallet", icon: ShieldCheck },
  { id: 5, label: "Create proofs", icon: KeyRound },
  { id: 6, label: "Claim funds", icon: RefreshCw },
  { id: 7, label: "Claim review", icon: FileText },
];

const screenStep: Record<ClaimScreen, number> = {
  "deployment-review": 1,
  "deployment-unavailable": 1,
  "impacted-wallet": 2,
  "wrong-network": 2,
  "scanning-claims": 3,
  "no-matching-funds": 3,
  "available-claims-page-1": 3,
  "available-claims-page-2": 3,
  "available-claims-asset-modal": 3,
  "safe-wallet": 4,
  "safe-wallet-overlap": 4,
  "insufficient-ada": 4,
  "helper-unavailable": 5,
  "create-proofs-ready": 5,
  "create-proofs-generating": 5,
  "proof-failed": 5,
  "create-proofs-complete": 5,
  "current-batch": 6,
  "claim-funds-overview": 6,
  "signature-rejected": 6,
  "submitted-refreshing": 7,
  "claim-review-complete": 7,
};

const nextScreen: Partial<Record<ClaimScreen, ClaimScreen>> = {
  "deployment-review": "impacted-wallet",
  "deployment-unavailable": "deployment-review",
  "impacted-wallet": "available-claims-page-1",
  "wrong-network": "impacted-wallet",
  "scanning-claims": "available-claims-page-1",
  "no-matching-funds": "impacted-wallet",
  "available-claims-page-1": "safe-wallet",
  "available-claims-page-2": "safe-wallet",
  "available-claims-asset-modal": "available-claims-page-2",
  "safe-wallet": "create-proofs-ready",
  "safe-wallet-overlap": "safe-wallet",
  "insufficient-ada": "safe-wallet",
  "helper-unavailable": "create-proofs-ready",
  "create-proofs-ready": "create-proofs-generating",
  "create-proofs-generating": "create-proofs-complete",
  "proof-failed": "create-proofs-ready",
  "create-proofs-complete": "current-batch",
  "current-batch": "submitted-refreshing",
  "claim-funds-overview": "submitted-refreshing",
  "signature-rejected": "current-batch",
  "submitted-refreshing": "claim-review-complete",
};

const previousScreen: Partial<Record<ClaimScreen, ClaimScreen>> = {
  "impacted-wallet": "deployment-review",
  "wrong-network": "deployment-review",
  "scanning-claims": "impacted-wallet",
  "no-matching-funds": "impacted-wallet",
  "available-claims-page-1": "impacted-wallet",
  "available-claims-page-2": "available-claims-page-1",
  "safe-wallet": "available-claims-page-1",
  "safe-wallet-overlap": "available-claims-page-1",
  "insufficient-ada": "available-claims-page-1",
  "helper-unavailable": "safe-wallet",
  "create-proofs-ready": "safe-wallet",
  "create-proofs-generating": "create-proofs-ready",
  "proof-failed": "create-proofs-ready",
  "create-proofs-complete": "create-proofs-ready",
  "current-batch": "create-proofs-complete",
  "claim-funds-overview": "create-proofs-complete",
  "signature-rejected": "current-batch",
  "submitted-refreshing": "current-batch",
  "claim-review-complete": "current-batch",
};

function claimFixtureData(): {
  allClaims: ClaimRow[];
  batchRows: ClaimRow[];
  proofQueue: ProofRow[];
  transactions: TransactionRow[];
} {
  const allClaims: ClaimRow[] = [
  { id: 1, tx: "b1e4c8d2...9af3", output: 0, credential: "cred ...6c9a", ada: "1.20 ADA", assets: "2 assets", summary: ["SECOND", "LP"], lovelace: "1200000", assetCount: 2 },
  { id: 2, tx: "b1e4c8d2...9af3", output: 1, credential: "cred ...6c9a", ada: "0.80 ADA", assets: "No tokens", summary: [], lovelace: "800000", assetCount: 0 },
  { id: 3, tx: "7f9a2d11...c4e0", output: 0, credential: "cred ...1d72", ada: "0.98 ADA", assets: "1 asset", summary: ["NFT"], lovelace: "980000", assetCount: 1 },
  { id: 4, tx: "7f9a2d11...c4e0", output: 1, credential: "cred ...1d72", ada: "0.60 ADA", assets: "17 assets", summary: ["PASS", "GOLD"], lovelace: "600000", assetCount: 17 },
  { id: 5, tx: "3c7bfa90...1d6a", output: 0, credential: "cred ...aa31", ada: "0.74 ADA", assets: "1 asset", summary: ["BADGE"], lovelace: "740000", assetCount: 1 },
  { id: 6, tx: "3c7bfa90...1d6a", output: 1, credential: "cred ...aa31", ada: "0.40 ADA", assets: "No tokens", summary: [], lovelace: "400000", assetCount: 0 },
  { id: 7, tx: "a9d431bb...7e33", output: 0, credential: "cred ...b8f4", ada: "1.05 ADA", assets: "3 assets", summary: ["XP", "MINT"], lovelace: "1050000", assetCount: 3 },
  { id: 8, tx: "d4a98b27...5b99", output: 0, credential: "cred ...90fe", ada: "0.50 ADA", assets: "2 assets", summary: ["Arena", "Boost"], lovelace: "500000", assetCount: 2 },
  { id: 9, tx: "d4a98b27...5b99", output: 1, credential: "cred ...90fe", ada: "1.10 ADA", assets: "255 assets", summary: ["SECOND", "Badge"], lovelace: "1100000", assetCount: 255 },
  { id: 10, tx: "e52f6a10...2c41", output: 0, credential: "cred ...6c9a", ada: "0.35 ADA", assets: "5 assets", summary: ["Collect"], lovelace: "350000", assetCount: 5 },
  { id: 11, tx: "e52f6a10...2c41", output: 0, credential: "cred ...6c9a", ada: "0.44 ADA", assets: "8 assets", summary: ["SECOND"], lovelace: "440000", assetCount: 8 },
  { id: 12, tx: "a0b1d448...ef22", output: 1, credential: "cred ...1d72", ada: "0.69 ADA", assets: "No tokens", summary: [], lovelace: "690000", assetCount: 0 },
  { id: 13, tx: "8dd9e7b1...7a10", output: 0, credential: "cred ...aa31", ada: "1.18 ADA", assets: "42 assets", summary: ["Gold"], lovelace: "1180000", assetCount: 42 },
  { id: 14, tx: "c6842fdd...5b7e", output: 2, credential: "cred ...90fe", ada: "0.36 ADA", assets: "1 asset", summary: ["Silver"], lovelace: "360000", assetCount: 1 },
  { id: 15, tx: "5f91ac77...e0a8", output: 5, credential: "cred ...6c9a", ada: "0.82 ADA", assets: "15 assets", summary: ["Arena"], lovelace: "820000", assetCount: 15 },
  { id: 16, tx: "9b2d14c3...3f90", output: 0, credential: "cred ...1d72", ada: "0.27 ADA", assets: "No tokens", summary: [], lovelace: "270000", assetCount: 0 },
  { id: 17, tx: "1d7e5aaf...9b61", output: 1, credential: "cred ...aa31", ada: "0.63 ADA", assets: "4 assets", summary: ["Pass"], lovelace: "630000", assetCount: 4 },
  { id: 18, tx: "7c31d9b5...2f8c", output: 2, credential: "cred ...90fe", ada: "0.31 ADA", assets: "No tokens", summary: [], lovelace: "310000", assetCount: 0 },
  ];
  const batchRows = allClaims.slice(0, 4);
  return {
    allClaims,
    batchRows,
    proofQueue: [
      { claim: "1", value: "1.20 ADA + 2 tokens", proof: "Generated", status: "ready" },
      { claim: "2", value: "0.98 ADA + 1 token", proof: "Generated", status: "ready" },
      { claim: "3", value: "0.74 ADA + 1 token", proof: "Generated", status: "ready" },
      { claim: "8", value: "0.44 ADA", proof: "Generating", status: "generating" },
      { claim: "9", value: "1.05 ADA + 3 tokens", proof: "Waiting", status: "waiting" },
    ],
    transactions: [
      { batch: 1, txHash: `${"8b4c2a".padEnd(58, "0")}91fd`, displayHash: "8b4c2a...91fd", value: "3.42 ADA + 6 tokens", ada: "3.42", tokens: "6", status: "Confirmed" },
      { batch: 2, txHash: `${"19af70".padEnd(58, "0")}a2c8`, displayHash: "19af70...a2c8", value: "4.01 ADA + 5 tokens", ada: "4.01", tokens: "5", status: "Confirmed" },
      { batch: 3, txHash: `${"ef7739".padEnd(58, "0")}c014`, displayHash: "ef7739...c014", value: "2.84 ADA + 4 tokens", ada: "2.84", tokens: "4", status: "Confirmed" },
      { batch: 4, txHash: `${"a60bd4".padEnd(58, "0")}771e`, displayHash: "a60bd4...771e", value: "3.15 ADA + 6 tokens", ada: "3.15", tokens: "6", status: "Confirmed" },
      { batch: 5, txHash: `${"d2fc91".padEnd(58, "0")}0ab7`, displayHash: "d2fc91...0ab7", value: "2.45 ADA + 2 tokens", ada: "2.45", tokens: "2", status: "Confirmed" },
    ],
  };
}

const ADDRESS_HEX_RE = /^[0-9a-f]+$/iu;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DESTINATION_PROFILE = "single-destination";
const releaseRepo = "https://github.com/Anastasia-Labs/proof-tool-release";
// Pinned release tags: `releases/latest` is unsafe because the repository also
// hosts proof-assets releases, which can become "latest" and break these URLs.
const windowsDesktopReleaseTag = "proof-helper-desktop-v0.2.1";
const linuxDesktopReleaseTag = "proof-helper-desktop-v0.2.2";
const portableReleaseTag = "proof-helper-v0.1.0";
const linuxAppImageFilename = "proof-helper_0.2.2_linux_x86_64.AppImage";
const linuxAppImageSha256 = "263592681101d7edaeed071d02758ed570a6187072939479f9d3ead763b9745c";
const windowsInstallerDownload = `${releaseRepo}/releases/download/${windowsDesktopReleaseTag}/proof-helper_0.2.1_windows_x64_setup.exe`;
const macZipDownload = `${releaseRepo}/releases/download/${portableReleaseTag}/proof-helper_0.1.0_macos_universal.zip`;
const linuxAppImageDownload = `${releaseRepo}/releases/download/${linuxDesktopReleaseTag}/${linuxAppImageFilename}`;
const linuxAppImageChecksumDownload = `${linuxAppImageDownload}.sha256`;
const linuxVerificationInstructions = `${releaseRepo}/releases/download/${linuxDesktopReleaseTag}/VERIFY-LINUX.md`;

const proofHelperDownloadChoices = [
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
    description: "Downloads the portable x86-64 AppImage.",
    action: "Download AppImage",
    href: linuxAppImageDownload,
  },
] as const;

// C26: the deployment manifest does not expose an incident name yet, so it is
// centralized here. Move this to the manifest once it carries incident
// metadata.
const INCIDENT_NAME = "SecondFi";

const claimFlowResumeStorageKey = "proof-tool.claim-flow.resume.v1";
const claimFlowResumeMaxAgeMs = 2 * 60 * 60 * 1000;
const clipboardReadTimeoutMs = 2_500;
// How long a courier tab waits for an existing tab to acknowledge the relayed
// pairing before assuming it is the only tab and pairing itself.
const courierAckTimeoutMs = 600;
// How long the courier tab shows its "paired" confirmation before closing
// itself. If the browser refuses window.close(), the message stays visible.
const courierAutoCloseDelayMs = 1500;

const defaultCreateWorker = () =>
  new Worker(new URL("../workers/ownership-proof-worker.ts", import.meta.url), {
    type: "module",
  }) as WorkerLike;

export function ClaimFlow({ createWorker = defaultCreateWorker }: ClaimFlowProps = {}) {
  useEffect(() => () => disposePreparedBrowserProvingSession(), []);
  const [screen, setScreen] = useState<ClaimScreen>("deployment-review");
  // Mirror of `screen` for async completions that must know where the user is
  // right now (C5/C11). Synchronously updated by changeScreen for user
  // navigation and kept in sync with renders below.
  const screenRef = useRef<ClaimScreen>("deployment-review");
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  const changeScreen = useCallback((next: ClaimScreen) => {
    screenRef.current = next;
    setScreen(next);
  }, []);
  const fixtureEnabled = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const [deployment, setDeployment] = useState<ClaimDeploymentResponse | null>(null);
  const [deploymentLoading, setDeploymentLoading] = useState(!fixtureEnabled);
  const [deploymentError, setDeploymentError] = useState("");
  const [wallets, setWallets] = useState<WalletEntry[]>([]);
  const [selectedImpactedWallet, setSelectedImpactedWallet] = useState("");
  const [selectedSafeWallet, setSelectedSafeWallet] = useState("");
  const [impactedWallet, setImpactedWallet] = useState<ImpactedWalletSummary | null>(null);
  const [impactedWalletError, setImpactedWalletError] = useState("");
  const safeWalletApiRef = useRef<SigningWalletApi | null>(null);
  const submitInFlightRef = useRef(false);
  const [safeWallet, setSafeWallet] = useState<SafeWalletSummary | null>(null);
  const [safeWalletSigningAvailable, setSafeWalletSigningAvailable] = useState(false);
  const [safeWalletSigningSessionState, setSafeWalletSigningSessionState] =
    useState<SafeWalletSigningSessionState>("not-connected");
  const [safeWalletError, setSafeWalletError] = useState("");
  const [claimRows, setClaimRows] = useState<ClaimRow[]>([]);
  const [claimIndexerTotal, setClaimIndexerTotal] = useState(0);
  const [claimDiscoveryError, setClaimDiscoveryError] = useState("");
  const [assetModalRow, setAssetModalRow] = useState<ClaimRow | null>(null);
  const [assetModalReturnScreen, setAssetModalReturnScreen] = useState<"available-claims-page-1" | "available-claims-page-2">("available-claims-page-1");
  const [pendingOutrefs, setPendingOutrefs] = useState<string[]>([]);
  const [draft, setDraft] = useState<ClaimDraftResponse | null>(null);
  const [draftError, setDraftError] = useState("");
  // C32: required/available amounts from the backend insufficient-ADA error.
  const [insufficientAdaDetails, setInsufficientAdaDetails] = useState<InsufficientAdaDetails | null>(null);
  const [helperUrl, setHelperUrl] = useState("");
  const [helperToken, setHelperToken] = useState("");
  const [helperState, setHelperState] = useState<ClaimHelperState>("unpaired");
  const [helperStatus, setHelperStatus] = useState<ClaimHelperStatusResponse | null>(null);
  const [helperError, setHelperError] = useState("");
  // Courier relay (C-pairing): "relaying" while this tab, opened by the desktop
  // app with a pairing fragment, waits for an existing tab to take the pairing;
  // "relayed" once one acknowledges. "idle" means this tab runs the flow itself.
  const [courierStatus, setCourierStatus] = useState<"idle" | "relaying" | "relayed">("idle");
  const relaySenderIdRef = useRef<string>("");
  if (relaySenderIdRef.current === "") {
    relaySenderIdRef.current = createRelayId();
  }
  const [proofArtifacts, setProofArtifacts] = useState<Record<string, unknown>[]>([]);
  const [proofError, setProofError] = useState("");
  // C28: set when the entered phrase is wordlist-valid but fails the BIP-39
  // checksum at generate time. Boolean only — never the words themselves.
  const [phraseChecksumFailed, setPhraseChecksumFailed] = useState(false);
  // Stable identity: CreateProofs re-runs word-status recomputation whenever
  // this callback changes, so a fresh closure per render would immediately
  // clear a just-set checksum failure.
  const clearPhraseChecksumError = useCallback(() => setPhraseChecksumFailed(false), []);
  const [proofMethod, setProofMethod] = useState<LocalProofMethod | null>("browser");
  const [browserProvingStatus, setBrowserProvingStatus] = useState<BrowserProvingStatus>("unknown");
  const [browserProvingDetail, setBrowserProvingDetail] = useState("");
  const [proofProgress, setProofProgress] = useState<ProofProgressEvent | null>(null);
  const proofAbortRef = useRef<AbortController | null>(null);
  // Superseded-run guard (C5): each proving run gets an id; late resolutions
  // only navigate when the run is still current and the user is still on the
  // generating screen, otherwise artifacts/errors are stashed silently.
  const proofRunIdRef = useRef(0);
  const proofRunInFlightRef = useRef(false);
  const buildInFlightRef = useRef(false);
  const scanAbortRef = useRef<AbortController | null>(null);
  const [claimScanProgress, setClaimScanProgress] = useState(0);
  const submittedRefreshInFlightRef = useRef(false);
  const [build, setBuild] = useState<ClaimBuildResponse | null>(null);
  const [buildError, setBuildError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitFailureKind, setSubmitFailureKind] = useState<ClaimSubmitFailureKind | null>(null);
  const [submitPhase, setSubmitPhase] = useState<ClaimSubmitPhase>("ready-to-sign");
  const [submittedClaims, setSubmittedClaims] = useState<SubmittedClaimTx[]>([]);
  const [progress, setProgress] = useState<ClaimProgressResponse | null>(null);
  const [resumePromptSnapshot, setResumePromptSnapshot] = useState<ClaimFlowResumeSnapshot | null>(null);
  const [sevenSlotOptIn, setSevenSlotOptIn] = useState(false);
  const sevenSlotOptInAvailable = supportsExplicitSevenSlotBatch(deployment);
  const useSevenSlotBatch = sevenSlotOptIn && sevenSlotOptInAvailable;

  const restoreResumeSnapshot = useCallback((snapshot: ClaimFlowResumeSnapshot) => {
    const resumeScreen = resumableClaimScreen(snapshot.screen);
    if (!resumeScreen) {
      return;
    }
    setScreen(resumeScreen);
    setSelectedImpactedWallet(snapshot.selectedImpactedWallet);
    setSelectedSafeWallet(snapshot.selectedSafeWallet);
    setImpactedWallet(snapshot.impactedWallet);
    setSafeWallet(snapshot.safeWallet);
    setClaimRows(snapshot.claimRows);
    setClaimIndexerTotal(snapshot.claimIndexerTotal);
    setPendingOutrefs(snapshot.pendingOutrefs);
    setDraft(snapshot.draft);
    setDraftError("");
    setProofArtifacts(snapshot.proofArtifacts ?? []);
    setProofError("");
    setBuild(snapshot.build ?? null);
    setBuildError("");
    setSubmitError("");
    setSubmitFailureKind(null);
    safeWalletApiRef.current = null;
    setSafeWalletSigningAvailable(false);
    setSafeWalletSigningSessionState("resume-reconnect-required");
    setSubmitPhase(snapshot.build ? "reconnect-required" : "ready-to-sign");
  }, []);

  useEffect(() => {
    if (!fixtureEnabled) {
      return;
    }
    const requested = new URLSearchParams(window.location.search).get("fixtureState");
    if (requested && isClaimScreen(requested)) {
      setScreen(requested);
    }
  }, [fixtureEnabled]);

  useEffect(() => {
    if (fixtureEnabled) {
      return;
    }
    let mounted = true;
    void loadDeployment({ updateScreen: true });
    return () => {
      mounted = false;
    };

    async function loadDeployment({ updateScreen }: { updateScreen: boolean }) {
      setDeploymentLoading(true);
      setDeploymentError("");
      try {
        const nextDeployment = await fetchClaimDeployment();
        if (!mounted) {
          return;
        }
        setDeployment(nextDeployment);
        if (nextDeployment.available) {
          if (updateScreen) {
            setScreen((current) => (current === "deployment-unavailable" ? "deployment-review" : current));
          }
        } else {
          setDeploymentError(deploymentUnavailableReason(nextDeployment));
          if (updateScreen) {
            setScreen((current) => (current === "deployment-review" ? "deployment-unavailable" : current));
          }
        }
      } catch (error) {
        if (!mounted) {
          return;
        }
        setDeployment(null);
        setDeploymentError(error instanceof Error ? error.message : "Unable to load claim deployment.");
        if (updateScreen) {
          setScreen((current) => (current === "deployment-review" ? "deployment-unavailable" : current));
        }
      } finally {
        if (mounted) {
          setDeploymentLoading(false);
        }
      }
    }
  }, [fixtureEnabled]);

  useEffect(() => {
    if (fixtureEnabled) {
      return;
    }
    const nextWallets = listCardanoWallets();
    setWallets(nextWallets);
    setSelectedImpactedWallet((current) => current || nextWallets[0]?.[0] || "");
    setSelectedSafeWallet((current) => current || nextWallets.find(([id]) => id !== selectedImpactedWallet)?.[0] || nextWallets[0]?.[0] || "");
  }, [fixtureEnabled]);

  // Resume-on-refresh (C9): offer the stored snapshot instead of silently
  // restarting. Runs before the pairing effect below so the pairing fragment
  // is still present in the URL when we check for it; helper pairing keeps
  // its existing auto-apply behavior.
  useEffect(() => {
    if (fixtureEnabled) {
      return;
    }
    if (readPairingFragment()) {
      return;
    }
    const snapshot = readClaimFlowResumeSnapshot();
    if (snapshot) {
      setResumePromptSnapshot(snapshot);
    }
  }, [fixtureEnabled]);

  // Apply a pairing in this tab (courier fallback, or when this is the only
  // tab). Restores any stored snapshot first so a fresh courier tab is usable.
  const pairInThisTab = useCallback(
    (pairing: { helperUrl: string; token: string }) => {
      const snapshot = readClaimFlowResumeSnapshot();
      if (snapshot) {
        restoreResumeSnapshot(snapshot);
      }
      setHelperUrl(pairing.helperUrl);
      setHelperToken(pairing.token);
      setHelperError("");
    },
    [restoreResumeSnapshot],
  );

  // Courier pairing (C-pairing): this tab was opened by the desktop app with a
  // `#helper=…&pair=…` fragment. Relay it to an existing tab that may be
  // mid-flow so it can pair in place; if none acknowledges, pair here.
  useEffect(() => {
    if (fixtureEnabled) {
      return;
    }
    const pairing = readPairingFragment();
    if (!pairing) {
      return;
    }
    // Strip the pairing secret from the URL immediately, regardless of outcome.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if ("error" in pairing) {
      setHelperState("unavailable");
      setHelperError(pairing.error);
      return;
    }

    const sender = relaySenderIdRef.current;
    let settled = false;
    let closeTimer: number | undefined;
    setCourierStatus("relaying");
    const unsubscribe = subscribeToPairing({
      sender,
      onAck: (target) => {
        if (settled || target !== sender) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        setCourierStatus("relayed");
        // This tab was opened by the desktop app and has a single history
        // entry (the landing page forwards with location.replace), so the
        // browser permits window.close(). Leave a beat so the confirmation is
        // readable; if the browser refuses, the message covers it.
        closeTimer = window.setTimeout(() => {
          window.close();
        }, courierAutoCloseDelayMs);
      },
    });
    broadcastPairing(pairing, sender);
    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      // No existing tab took the pairing: become the working tab.
      setCourierStatus("idle");
      pairInThisTab(pairing);
    }, courierAckTimeoutMs);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(closeTimer);
      unsubscribe();
    };
  }, [fixtureEnabled, pairInThisTab]);

  // Working tab: apply a pairing relayed from a courier tab in place, keeping
  // this tab's in-memory progress, and acknowledge so the courier can close.
  useEffect(() => {
    if (fixtureEnabled) {
      return;
    }
    const sender = relaySenderIdRef.current;
    return subscribeToPairing({
      sender,
      onPair: ({ helperUrl: relayedUrl, token, sender: courier }) => {
        let normalized: string;
        try {
          normalized = normalizeLoopbackHelperUrl(relayedUrl);
        } catch {
          return;
        }
        setHelperUrl(normalized);
        setHelperToken(token);
        setHelperError("");
        acknowledgePairing(courier, sender);
      },
    });
  }, [fixtureEnabled]);

  useEffect(() => {
    if (fixtureEnabled) {
      return;
    }
    const resumeScreen = resumableClaimScreen(screen);
    if (!resumeScreen || !draft || !safeWallet) {
      return;
    }
    writeClaimFlowResumeSnapshot({
      version: 1,
      updatedAt: Date.now(),
      screen: resumeScreen,
      selectedImpactedWallet,
      selectedSafeWallet,
      impactedWallet,
      safeWallet,
      claimRows,
      claimIndexerTotal,
      pendingOutrefs,
      draft,
      proofArtifacts,
      build,
    });
  }, [
    build,
    claimIndexerTotal,
    claimRows,
    draft,
    fixtureEnabled,
    impactedWallet,
    pendingOutrefs,
    proofArtifacts,
    safeWallet,
    screen,
    selectedImpactedWallet,
    selectedSafeWallet,
  ]);

  const checkHelper = useCallback(async (requestPermission = false): Promise<boolean> => {
    if (fixtureEnabled) {
      return true;
    }
    if (!helperUrl || !helperToken) {
      setHelperState("unpaired");
      setHelperStatus(null);
      setHelperError("Open Proof Helper from this page so it can pair with the claim flow.");
      return false;
    }
    const permission = await queryLoopbackPermission();
    if (permission === "denied") {
      setHelperState("permission-denied");
      setHelperStatus(null);
      setHelperError("Local device access is blocked for this site. Allow local network access in your browser site settings, then try again.");
      return false;
    }
    if (permission === "prompt" && !requestPermission) {
      setHelperState("permission-prompt");
      setHelperStatus(null);
      setHelperError("Allow this site to connect to Proof Helper on this computer. No recovery phrase is sent during this check.");
      return false;
    }
    setHelperState("checking");
    setHelperError("");
    try {
      const status = await fetchJSON<ClaimHelperStatusResponse>(`${trimSlash(helperUrl)}/status`, {
        method: "GET",
        headers: {
          "X-Proof-Tool-Token": helperToken,
        },
      }, fetchLoopback);
      setHelperStatus(status);
      const profile = status.destination_profile;
      if (!profile) {
        setHelperState("unavailable");
        setHelperError("Proof Helper did not report destination-bound proof support.");
        return false;
      }
      if (profile.profile !== DESTINATION_PROFILE) {
        setHelperState("unavailable");
        setHelperError("Proof Helper must use the single-destination proof profile.");
        return false;
      }
      if (profile.key_ready !== true || profile.compatibility !== "ready") {
        setHelperState("unavailable");
        setHelperError("Proof Helper destination key is not ready.");
        return false;
      }
      if (deployment?.available && profile.key_hash !== deployment.deployment.verifierVkHash) {
        setHelperState("unavailable");
        setHelperError("Proof Helper destination key hash does not match this claim deployment.");
        return false;
      }
      setHelperState("ready");
      return true;
    } catch (error) {
      setHelperStatus(null);
      const nextPermission = await queryLoopbackPermission();
      if (nextPermission === "denied") {
        setHelperState("permission-denied");
        setHelperError("Local device access was denied. Allow local network access in your browser site settings, then try again.");
      } else {
        setHelperState("unavailable");
        setHelperError(sanitizeRecoverableError(error, "Proof Helper is unavailable."));
      }
      return false;
    }
  }, [deployment, fixtureEnabled, helperToken, helperUrl]);

  const requestHelperAccess = useCallback(() => {
    void checkHelper(true);
  }, [checkHelper]);

  useEffect(() => {
    if (!fixtureEnabled && helperUrl && helperToken) {
      void checkHelper(false);
    }
  }, [checkHelper, fixtureEnabled, helperToken, helperUrl]);

  useEffect(() => {
    if (helperState === "ready") {
      setProofMethod((current) => current ?? "browser");
    }
  }, [helperState]);

  const browserProvingDescriptor: BrowserProvingDescriptor | null =
    deployment?.available ? deployment.deployment.proof?.browser_proving ?? null : null;

  const refreshBrowserProvingStatus = useCallback(async (): Promise<boolean> => {
    if (!deployment?.available) {
      setBrowserProvingStatus("unsupported");
      setBrowserProvingDetail("A claim deployment is required before browser proving can be checked.");
      return false;
    }
    if (!browserProvingDescriptor || !browserProvingDescriptor.enabled) {
      setBrowserProvingStatus("unsupported");
      setBrowserProvingDetail("Browser proving is not enabled for this build yet.");
      return false;
    }
    setBrowserProvingStatus("checking");
    setBrowserProvingDetail("");
    try {
      const check = await checkBrowserProving(browserProvingDescriptor, deployment.deployment.verifierVkHash);
      setBrowserProvingStatus(check.status);
      setBrowserProvingDetail(check.status === "ready" ? "" : check.capability.failures[0]?.message ?? "This browser cannot run the prover.");
      return check.status === "ready";
    } catch (error) {
      setBrowserProvingStatus("unsupported");
      setBrowserProvingDetail(sanitizeRecoverableError(error, "Browser proving support could not be checked."));
      return false;
    }
  }, [browserProvingDescriptor, deployment]);

  useEffect(() => {
    if (proofMethod === "browser" && browserProvingStatus === "unknown" && deployment?.available && !fixtureEnabled) {
      void refreshBrowserProvingStatus();
    }
  }, [browserProvingStatus, deployment, fixtureEnabled, proofMethod, refreshBrowserProvingStatus]);

  // beforeunload guard (C10): active during any proof generation (browser or
  // helper) and on the batch review screens while a built unsigned tx or
  // generated proof artifacts would be lost with the tab.
  const unloadGuardActive =
    screen === "create-proofs-generating" ||
    ((screen === "current-batch" || screen === "claim-funds-overview") && (Boolean(build) || proofArtifacts.length > 0));
  useEffect(() => {
    if (!unloadGuardActive || typeof window === "undefined") {
      return;
    }
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [unloadGuardActive]);

  const cancelLocalProving = useCallback(() => {
    proofAbortRef.current?.abort();
  }, []);

  // A11y (C37): after the user navigates between screens, move focus to the
  // new screen's H1 so assistive tech announces the step change. The initial
  // render keeps the browser's default focus.
  const initialScreenFocusRef = useRef(true);
  useEffect(() => {
    if (initialScreenFocusRef.current) {
      initialScreenFocusRef.current = false;
      return;
    }
    // The asset modal is a screen-level state but renders a dialog that
    // manages its own focus (C36) — do not steal it back to the heading.
    if (screen === "available-claims-asset-modal") {
      return;
    }
    document.querySelector<HTMLHeadingElement>(".claim-page-heading h1")?.focus();
  }, [screen]);

  const visibleScreen = screen === "available-claims-asset-modal" ? assetModalReturnScreen : screen;
  const activeStep = screenStep[screen];
  const goNext = () => {
    if (fixtureEnabled) {
      setScreen(nextScreen[screen] ?? screen);
    }
  };
  const goBack = () => {
    if (screen === "scanning-claims") {
      // Leaving the scan cancels it (C11); a completed scan must not yank the
      // user back to the results afterwards.
      scanAbortRef.current?.abort();
    }
    changeScreen(previousScreen[screen] ?? screen);
  };

  const refreshDeployment = async () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    setDeploymentLoading(true);
    setDeploymentError("");
    try {
      const nextDeployment = await fetchClaimDeployment();
      setDeployment(nextDeployment);
      if (nextDeployment.available) {
        setScreen("deployment-review");
      } else {
        setDeploymentError(deploymentUnavailableReason(nextDeployment));
        setScreen("deployment-unavailable");
      }
    } catch (error) {
      setDeployment(null);
      setDeploymentError(error instanceof Error ? error.message : "Unable to load claim deployment.");
      setScreen("deployment-unavailable");
    } finally {
      setDeploymentLoading(false);
    }
  };

  const continueFromDeployment = () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    if (deployment?.available) {
      setScreen("impacted-wallet");
      return;
    }
    void refreshDeployment();
  };

  const discoverClaimsForImpactedWallet = async () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    setImpactedWalletError("");
    setClaimDiscoveryError("");
    if (!deployment?.available) {
      setScreen("deployment-unavailable");
      return;
    }
    const provider = wallets.find(([id]) => id === selectedImpactedWallet)?.[1];
    if (!provider) {
      setImpactedWallet(null);
      setImpactedWalletError("No Cardano browser wallet was found. Install or unlock a CIP-30 compatible wallet extension, then try again.");
      return;
    }

    try {
      const api = await provider.enable();
      const networkId = await api.getNetworkId();
      if (networkId !== deployment.deployment.networkId) {
        setImpactedWallet(null);
        setImpactedWalletError(
          `Connected wallet is on ${networkIdName(networkId)}; this deployment expects ${deployment.deployment.network}.`,
        );
        setScreen("wrong-network");
        return;
      }
      const walletSummary = await readImpactedWalletSummary(api, {
        walletId: selectedImpactedWallet,
        walletName: provider.name || selectedImpactedWallet,
        networkId: deployment.deployment.networkId,
      });
      setImpactedWallet(walletSummary);
      setSafeWallet(null);
      safeWalletApiRef.current = null;
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("not-connected");
      setDraft(null);
      setProofArtifacts([]);
      setBuild(null);
      setSubmitPhase("ready-to-sign");
      setScreen("scanning-claims");
      await refreshClaimMatches(walletSummary.credentials);
    } catch (error) {
      setImpactedWallet(null);
      setImpactedWalletError(error instanceof Error ? error.message : "Unable to connect the impacted wallet.");
      setScreen("impacted-wallet");
    }
  };

  const refreshClaimMatches = async (credentials = impactedWallet?.credentials ?? []) => {
    if (!deployment?.available || credentials.length === 0) {
      return;
    }
    setDraft(null);
    setDraftError("");
    setProofArtifacts([]);
    setProofError("");
    setBuild(null);
    setBuildError("");
    setSubmitError("");
    setSubmitFailureKind(null);
    setSubmitPhase("ready-to-sign");
    setClaimDiscoveryError("");
    // Cancellable scan (C11): navigating Back from the scanning screen aborts
    // the page loop and suppresses the late completion navigation.
    scanAbortRef.current?.abort();
    const scanController = new AbortController();
    scanAbortRef.current = scanController;
    setClaimScanProgress(0);
    changeScreen("scanning-claims");
    try {
      const utxos = await fetchAllReclaimUtxos({
        signal: scanController.signal,
        onProgress: setClaimScanProgress,
      });
      if (scanController.signal.aborted || screenRef.current !== "scanning-claims") {
        return;
      }
      const credentialSet = new Set(credentials.map((credential) => credential.toLowerCase()));
      const matched = utxos.filter(
        (utxo) =>
          utxo.state === "unspent" &&
          utxo.datum.status === "valid" &&
          credentialSet.has(utxo.datum.paymentCredential.toLowerCase()),
      );
      setClaimIndexerTotal(utxos.length);
      setClaimRows(matched.map(toClaimRow));
      setScreen(matched.length > 0 ? "available-claims-page-1" : "no-matching-funds");
    } catch (error) {
      if (scanController.signal.aborted || screenRef.current !== "scanning-claims") {
        return;
      }
      setClaimRows([]);
      setClaimIndexerTotal(0);
      // Lookup failures are presented distinctly from genuinely-empty results
      // on the same screen (C31), with the sanitized error detail.
      setClaimDiscoveryError(sanitizeRecoverableError(error, "Unable to scan ReclaimBase UTxOs."));
      setScreen("no-matching-funds");
    }
  };

  const refreshClaimMatchesFromCurrentWallet = () => {
    void refreshClaimMatches();
  };

  const changeClaimsPage = (page: 1 | 2) => {
    setScreen(page === 1 ? "available-claims-page-1" : "available-claims-page-2");
  };

  const openClaimAssetModal = (row: ClaimRow) => {
    setAssetModalRow(row);
    setAssetModalReturnScreen(screen === "available-claims-page-2" ? "available-claims-page-2" : "available-claims-page-1");
    setScreen("available-claims-asset-modal");
  };

  const closeClaimAssetModal = () => {
    setAssetModalRow(null);
    setScreen(assetModalReturnScreen);
  };

  const continueToSafeWallet = () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    if (!impactedWallet || claimRows.length === 0) {
      setClaimDiscoveryError("Find matching locked funds before connecting a safe wallet.");
      setScreen(claimRows.length === 0 ? "no-matching-funds" : "available-claims-page-1");
      return;
    }
    setScreen("safe-wallet");
  };

  const createOrRefreshClaimDraft = async (
    wallet: SafeWalletSummary | null = safeWallet,
    rows: ClaimRow[] = claimRows,
    useExplicitSevenSlot = useSevenSlotBatch,
  ): Promise<ClaimDraftResponse | null> => {
    if (!deployment?.available) {
      setDraftError("Claim deployment is unavailable.");
      setScreen("deployment-unavailable");
      return null;
    }
    if (!wallet) {
      setDraftError("Connect a safe wallet before drafting a claim batch.");
      setScreen("safe-wallet");
      return null;
    }
    const selectedRows = selectClaimBatchRows(
      rows,
      pendingOutrefs,
      deployment,
      useExplicitSevenSlot ? CLAIM_HARD_BATCH_CAP : undefined,
    );
    const selectedOutrefs = selectedRows.map((row) => row.outRefId).filter((outRefId): outRefId is string => Boolean(outRefId));
    if (selectedOutrefs.length === 0) {
      setDraftError("No matching locked funds remain for the next claim batch.");
      setScreen("claim-review-complete");
      return null;
    }

    setDraftError("");
    setInsufficientAdaDetails(null);
    setProofArtifacts([]);
    setProofError("");
    setBuild(null);
    setBuildError("");
    setSubmitError("");
    setSubmitFailureKind(null);
    setSubmitPhase("ready-to-sign");
    try {
      const nextDraft = await postJSON<ClaimDraftResponse>("/claim-api/draft", {
        deploymentId: deployment.deployment.id,
        networkId: deployment.deployment.networkId,
        safeWalletChangeAddress: wallet.changeAddress,
        safeWalletAddresses: wallet.addresses,
        selectedOutrefs,
        pendingOutrefs,
        maxUtxos: selectedOutrefs.length,
      });
      setDraft(nextDraft);
      if (!nextDraft.buildSupported) {
        setDraftError("Claim build is not supported for this deployment because required reference-script artifacts are missing.");
      }
      return nextDraft;
    } catch (error) {
      setDraft(null);
      const message = sanitizeRecoverableError(error, "Unable to create a claim draft.");
      setDraftError(message);
      // Route backend insufficient-funds failures to the purpose-built
      // insufficient-ada screen instead of a generic draft error (C32),
      // carrying the required/available amounts when the backend sent them.
      if (isInsufficientSafeWalletFundsError(error, message)) {
        setInsufficientAdaDetails(insufficientAdaDetailsFromError(error));
        setScreen("insufficient-ada");
      }
      return null;
    }
  };

  const connectSafeWallet = async () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    setSafeWalletError("");
    setDraftError("");
    setProofArtifacts([]);
    setBuild(null);
    setSafeWalletSigningAvailable(false);
    setSafeWalletSigningSessionState("not-connected");
    setSubmitPhase("ready-to-sign");
    if (!deployment?.available) {
      setScreen("deployment-unavailable");
      return;
    }
    if (!impactedWallet || claimRows.length === 0) {
      setSafeWalletError("Find matching locked funds before connecting a safe wallet.");
      setScreen("available-claims-page-1");
      return;
    }
    const provider = wallets.find(([id]) => id === selectedSafeWallet)?.[1];
    if (!provider) {
      setSafeWallet(null);
      safeWalletApiRef.current = null;
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("not-connected");
      setSafeWalletError("No Cardano browser wallet is available for safe-wallet signing (a CIP-30 wallet is required).");
      return;
    }

    try {
      const api = await provider.enable();
      if (!hasSigningWalletApi(api)) {
        setSafeWallet(null);
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("not-connected");
        setSafeWalletError("This wallet cannot sign claim transactions here (it must support CIP-30 signTx).");
        return;
      }
      const networkId = await api.getNetworkId();
      if (networkId !== deployment.deployment.networkId) {
        setSafeWallet(null);
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("not-connected");
        setSafeWalletError(
          `Safe wallet is on ${networkIdName(networkId)}; this deployment expects ${deployment.deployment.network}.`,
        );
        return;
      }
      const walletSummary = await readSafeWalletSummary(api, {
        walletId: selectedSafeWallet,
        walletName: provider.name || selectedSafeWallet,
        networkId: deployment.deployment.networkId,
      });
      const impactedCredentials = new Set(impactedWallet.credentials.map((credential) => credential.toLowerCase()));
      const overlap = walletSummary.credentials.find((credential) => impactedCredentials.has(credential.toLowerCase()));
      if (overlap) {
        setSafeWallet(null);
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("destination-blocked");
        setSafeWalletError("This safe wallet shares a wallet key with the impacted wallet. Choose a different destination.");
        setScreen("safe-wallet-overlap");
        return;
      }
      safeWalletApiRef.current = api;
      setSafeWalletSigningAvailable(true);
      setSafeWalletSigningSessionState("ready");
      setSafeWallet(walletSummary);
      // Stay on the safe-wallet screen after a successful connect (C17) so the
      // user sees the populated destination panel and confirms it explicitly.
      // The draft is still created here; only the auto-advance is removed.
      await createOrRefreshClaimDraft(walletSummary);
      setScreen((current) => (current === "insufficient-ada" ? current : "safe-wallet"));
    } catch (error) {
      setSafeWallet(null);
      safeWalletApiRef.current = null;
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("not-connected");
      setSafeWalletError(sanitizeRecoverableError(error, "Unable to connect the safe wallet."));
      setScreen("safe-wallet");
    }
  };

  // Explicit confirmation beat for step 4 (C17): advancing to proofs happens
  // only when the user confirms the populated destination panel.
  const confirmSafeWalletDestination = async () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    if (!safeWallet) {
      setSafeWalletError("Connect a safe wallet before continuing.");
      return;
    }
    if (draft) {
      setScreen("create-proofs-ready");
      return;
    }
    const nextDraft = await createOrRefreshClaimDraft(safeWallet);
    if (nextDraft) {
      setScreen("create-proofs-ready");
    }
  };

  const chooseDifferentSafeWallet = () => {
    setSafeWallet(null);
    safeWalletApiRef.current = null;
    setSafeWalletSigningAvailable(false);
    setSafeWalletSigningSessionState("not-connected");
    setSafeWalletError("");
    setDraft(null);
    setDraftError("");
    setProofArtifacts([]);
    setBuild(null);
    setSubmitPhase("ready-to-sign");
    setScreen("safe-wallet");
  };

  // Late-resolution handlers for proving runs (C5): state is only applied for
  // the current run; navigation happens only while the user is still on the
  // generating screen. Otherwise the result is stashed silently so returning
  // to the proof step shows it.
  const applyProofRunSuccess = (runId: number, artifacts: Record<string, unknown>[]) => {
    if (proofRunIdRef.current !== runId) {
      return;
    }
    setProofArtifacts(artifacts);
    setProofError("");
    if (screenRef.current === "create-proofs-generating") {
      setScreen("create-proofs-complete");
    }
  };

  const applyProofRunFailure = (runId: number, message: string) => {
    if (proofRunIdRef.current !== runId) {
      return;
    }
    setProofArtifacts([]);
    setProofError(message);
    if (screenRef.current === "create-proofs-generating") {
      setScreen("proof-failed");
    }
  };

  const generateClaimProofs = async () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    // In-flight guard (C6): a second invocation while a run is active must be
    // a no-op — it would read empty phrase inputs and spawn a racing run.
    if (proofRunInFlightRef.current) {
      return;
    }
    setProofError("");
    if (!deployment?.available || !draft || !safeWallet) {
      setProofError("A current claim draft and safe-wallet destination are required before proof generation.");
      return;
    }
    if (!draft.buildSupported) {
      setProofError("This deployment is missing build artifacts, so proof generation is blocked.");
      return;
    }

    proofRunInFlightRef.current = true;
    const runId = ++proofRunIdRef.current;
    try {
      if (proofMethod === "browser") {
        await generateClaimProofsInBrowser(deployment.deployment.verifierVkHash, runId);
        return;
      }

      const helperReady = await checkHelper(true);
      if (!helperReady) {
        setScreen("helper-unavailable");
        return;
      }

      // Exercise the exact authenticated endpoint with a no-secret request.
      // This must succeed before even reading the phrase fields so browser
      // permission/CORS/helper-version failures leave the phrase untouched.
      try {
        await preflightDestinationViaHelper({ helperUrl, helperToken });
      } catch (error) {
        setProofError(sanitizeRecoverableError(error, "Proof Helper could not complete its safe preflight."));
        return;
      }
      if (!recoveryPhraseInputsPassValidation()) {
        setPhraseChecksumFailed(true);
        return;
      }
      setPhraseChecksumFailed(false);

      const seedPhrase = readAndClearRecoveryPhrase();
      changeScreen("create-proofs-generating");
      setProofProgress(null);
      let masterBytes: Uint8Array | null = null;
      const abortController = new AbortController();
      proofAbortRef.current = abortController;
      try {
        const workerResponse = await deriveMasterXPrv(seedPhrase, createWorker);
        if (workerResponse.type === "error") {
          applyProofRunFailure(runId, workerResponse.message);
          return;
        }
        masterBytes = new Uint8Array(workerResponse.masterXPrv);
        const helperResponse = await proveDestinationViaHelper({
          masterXPrv: masterBytes,
          draft,
          helperUrl,
          helperToken,
          signal: abortController.signal,
          onProgress: setProofProgress,
        });
        const artifacts = validateDestinationProofResponse(helperResponse, draft, deployment.deployment.verifierVkHash);
        applyProofRunSuccess(runId, artifacts);
      } catch (error) {
        if (error instanceof DesktopHelperCancelledError) {
          if (proofRunIdRef.current === runId) {
            setProofArtifacts([]);
            setProofError("");
            if (screenRef.current === "create-proofs-generating") {
              setScreen("create-proofs-ready");
            }
          }
          return;
        }
        applyProofRunFailure(runId, sanitizeRecoverableError(error, "The helper could not generate destination-bound proofs."));
      } finally {
        masterBytes?.fill(0);
        proofAbortRef.current = null;
        setProofProgress(null);
      }
    } finally {
      proofRunInFlightRef.current = false;
    }
  };

  // Browser provider path: runtime capability is confirmed before the phrase
  // is read. The dedicated local worker then discovers credential keys before it
  // opens the large signed proof assets; seed material never leaves the local
  // worker boundary.
  const generateClaimProofsInBrowser = async (expectedVkHash: string, runId: number) => {
    if (!draft || !browserProvingDescriptor) {
      setProofError("Browser proving is not enabled for this build yet.");
      return;
    }
    const ready = await refreshBrowserProvingStatus();
    if (!ready) {
      setProofError("This browser cannot generate proofs right now. Choose Proof Helper Desktop to continue.");
      return;
    }

    if (!recoveryPhraseInputsPassValidation()) {
      setPhraseChecksumFailed(true);
      return;
    }
    setPhraseChecksumFailed(false);

    const seedPhrase = readAndClearRecoveryPhrase();
    changeScreen("create-proofs-generating");
    setProofProgress(null);
    let masterBytes: Uint8Array | null = null;
    const abortController = new AbortController();
    proofAbortRef.current = abortController;
    try {
      const workerResponse = await deriveMasterXPrv(seedPhrase, createWorker);
      if (workerResponse.type === "error") {
        applyProofRunFailure(runId, workerResponse.message);
        return;
      }
      masterBytes = new Uint8Array(workerResponse.masterXPrv);
      const browserResponse = await proveDestinationInBrowser({
        masterXPrv: masterBytes,
        draft,
        expectedVkHash,
        browserProving: browserProvingDescriptor,
        signal: abortController.signal,
        onProgress: setProofProgress,
      });
      const artifacts = validateDestinationProofResponse(browserResponse, draft, expectedVkHash);
      applyProofRunSuccess(runId, artifacts);
    } catch (error) {
      if (error instanceof ProvingCancelledError) {
        if (proofRunIdRef.current === runId) {
          setProofArtifacts([]);
          setProofError("");
          if (screenRef.current === "create-proofs-generating") {
            setScreen("create-proofs-ready");
          }
        }
        return;
      }
      applyProofRunFailure(runId, sanitizeRecoverableError(error, "Browser proving failed. Proof Helper Desktop is still available."));
    } finally {
      masterBytes?.fill(0);
      proofAbortRef.current = null;
      setProofProgress(null);
    }
  };

  const goToCurrentBatch = () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    if (!draft || proofArtifacts.length !== draft.orderedInputs.length) {
      setProofError("Generate all proofs for the current draft before reviewing the batch.");
      setScreen("create-proofs-ready");
      return;
    }
    setScreen("current-batch");
  };

  const reconnectSafeWalletForSigning = async (): Promise<SigningWalletApi | null> => {
    if (!deployment?.available || !draft || !safeWallet) {
      setSubmitError("A current draft and safe wallet are required before reconnecting the signing wallet.");
      setSubmitPhase("reconnect-required");
      return null;
    }
    const provider = wallets.find(([id]) => id === selectedSafeWallet)?.[1];
    if (!provider) {
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("resume-reconnect-required");
      setSubmitPhase("reconnect-required");
      setSubmitError("Reconnect the selected safe wallet before signing the claim transaction.");
      return null;
    }
    setSubmitPhase("reconnecting");
    try {
      const api = await provider.enable();
      if (!hasSigningWalletApi(api)) {
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("resume-reconnect-required");
        setSubmitPhase("reconnect-required");
        setSubmitError("This wallet cannot sign claim transactions here (it must support CIP-30 signTx).");
        return null;
      }
      const networkId = await api.getNetworkId();
      if (networkId !== deployment.deployment.networkId) {
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("resume-reconnect-required");
        setSubmitPhase("reconnect-required");
        setSubmitError(`Safe wallet is on ${networkIdName(networkId)}; this deployment expects ${deployment.deployment.network}.`);
        return null;
      }
      const walletSummary = await readSafeWalletSummary(api, {
        walletId: selectedSafeWallet,
        walletName: provider.name || selectedSafeWallet,
        networkId: deployment.deployment.networkId,
      });
      const impactedCredentials = new Set((impactedWallet?.credentials ?? []).map((credential) => credential.toLowerCase()));
      const overlap = walletSummary.credentials.find((credential) => impactedCredentials.has(credential.toLowerCase()));
      if (overlap) {
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("destination-blocked");
        setSubmitPhase("failed");
        setSubmitError("The reconnected safe wallet now shares a wallet key with the impacted wallet. Choose a different destination and create a new proof batch.");
        return null;
      }
      if (!sameSafeWalletDestination(walletSummary, safeWallet)) {
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("destination-blocked");
        setSubmitPhase("failed");
        setSubmitError("The reconnected safe wallet destination changed. Create a new destination-bound proof batch before signing.");
        return null;
      }
      const draftDestinationChanged = draft.destinationOutputs.some((output) => output.address !== walletSummary.changeAddress);
      if (draftDestinationChanged) {
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("destination-blocked");
        setSubmitPhase("failed");
        setSubmitError("The current draft is bound to a different safe-wallet destination. Create a new destination-bound proof batch.");
        return null;
      }
      safeWalletApiRef.current = api;
      setSafeWallet(walletSummary);
      setSafeWalletSigningAvailable(true);
      setSafeWalletSigningSessionState("ready");
      setSubmitPhase("ready-to-sign");
      return api;
    } catch (error) {
      safeWalletApiRef.current = null;
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("resume-reconnect-required");
      setSubmitPhase("reconnect-required");
      setSubmitError(sanitizeRecoverableError(error, "Unable to reconnect the safe wallet for signing."));
      return null;
    }
  };

  const buildOrSubmitCurrentBatch = async () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    if (buildInFlightRef.current || (build && (isSubmitBusy(submitPhase) || submitInFlightRef.current))) {
      return;
    }
    if (!deployment?.available || !draft || !safeWallet) {
      setBuildError("A current draft and safe wallet are required before building the claim transaction.");
      return;
    }
    if (proofArtifacts.length !== draft.orderedInputs.length) {
      setBuildError("Generate all destination-bound proofs before building the claim transaction.");
      return;
    }
    if (!build) {
      buildInFlightRef.current = true;
      setBuildError("");
      setSubmitError("");
      setSubmitPhase("building-transaction");
      try {
        const nextBuild = await postJSON<ClaimBuildResponse>("/claim-api/build", {
          deploymentId: deployment.deployment.id,
          networkId: deployment.deployment.networkId,
          draftId: draft.draftId,
          selectedOutrefs: draft.orderedInputs.map((input) => input.outRefId),
          maxUtxos: draft.batchCap.requested,
          safeWalletChangeAddress: safeWallet.changeAddress,
          safeWalletAddresses: safeWallet.addresses,
          proofArtifacts,
        });
        setBuild(nextBuild);
        setSubmitPhase(safeWalletApiRef.current ? "ready-to-sign" : "reconnect-required");
      } catch (error) {
        setBuild(null);
        setSubmitPhase("failed");
        setBuildError(sanitizeRecoverableError(error, "Unable to build the claim transaction."));
      } finally {
        buildInFlightRef.current = false;
      }
      return;
    }

    if (safeWalletSigningAvailable && !safeWalletApiRef.current) {
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("resume-reconnect-required");
      setSubmitPhase("reconnect-required");
      setSubmitError("Reconnect the same safe wallet before signing. No transaction has been signed or submitted yet.");
      setScreen("current-batch");
      return;
    }

    submitInFlightRef.current = true;
    const signingApi = safeWalletApiRef.current ?? (await reconnectSafeWalletForSigning());
    if (!signingApi) {
      submitInFlightRef.current = false;
      setScreen("current-batch");
      return;
    }
    setSubmitError("");
    setSubmitFailureKind(null);
    // Tracked locally (not via submitPhase state) so the catch block can tell a
    // pre-sign wallet rejection apart from a post-sign submission failure (C14).
    let signedInWallet = false;
    try {
      setSubmitPhase("signing-in-wallet");
      const witnessSetCbor = await signingApi.signTx(build.txCbor, true);
      signedInWallet = true;
      setSubmitPhase("submitting");
      const submit = await postJSON<ClaimSubmitResponse>("/claim-api/submit", {
        deploymentId: deployment.deployment.id,
        selectedOutrefs: draft.orderedInputs.map((input) => input.outRefId),
        review: build.review,
        unsignedTxCbor: build.txCbor,
        witnessSetCbor,
        claimBuildReviewToken: build.reviewToken,
      });
      const selectedOutrefs = submit.selectedOutrefs.length > 0 ? submit.selectedOutrefs : draft.orderedInputs.map((input) => input.outRefId);
      const valueSummary = summarizeDraftValue(draft);
      setSubmittedClaims((current) => [
        ...current,
        {
          txHash: submit.txHash,
          selectedOutrefs,
          reviewHash: submit.reviewHash,
          valueSummary,
        },
      ]);
      setPendingOutrefs((current) => [...new Set([...current, ...selectedOutrefs])]);
      setSubmitPhase("submitted-refreshing");
      setScreen("submitted-refreshing");
      await refreshProgressAfterSubmit(selectedOutrefs, [...new Set([...pendingOutrefs, ...selectedOutrefs])], {
        prepareNextBatch: false,
      });
      submitInFlightRef.current = false;
    } catch (error) {
      submitInFlightRef.current = false;
      setSubmitPhase("failed");
      if (!signedInWallet) {
        setSubmitFailureKind("signature");
        setSubmitError(sanitizeRecoverableError(error, "Signature declined in wallet. The transaction was not submitted."));
        setScreen("signature-rejected");
        return;
      }
      // The wallet signed but submission failed afterwards: we cannot claim the
      // transaction was not submitted. Check current chain status passively
      // before the user is offered a re-sign (C14).
      setSubmitFailureKind("post-sign-submit");
      setSubmitError("Submission failed after signing — the transaction may or may not have reached the chain. Checking current status...");
      setScreen("signature-rejected");
      await checkSubmittedBatchStatus(draft.orderedInputs.map((input) => input.outRefId));
    }
  };

  // Passive on-chain status check: fetches claim progress for the given outrefs
  // without navigating, clearing the draft/build, or creating a new draft.
  const checkSubmittedBatchStatus = async (outrefs?: string[]) => {
    if (fixtureEnabled) {
      return;
    }
    const targetOutrefs = outrefs ?? draft?.orderedInputs.map((input) => input.outRefId) ?? [];
    if (targetOutrefs.length === 0) {
      return;
    }
    try {
      const params = new URLSearchParams({ outrefs: targetOutrefs.join(",") });
      const nextProgress = await fetchJSON<ClaimProgressResponse>(`/claim-api/progress?${params.toString()}`);
      setProgress(nextProgress);
      const settledCount = nextProgress.outrefs.filter(
        (entry) => entry.state === "spent_or_unknown" || entry.state === "confirmed_spent",
      ).length;
      if (settledCount === targetOutrefs.length) {
        setSubmitError(
          "Submission failed after signing, but the claim inputs are now spent on-chain — the signed transaction likely landed. Do not re-sign; refresh status instead.",
        );
      } else {
        setSubmitError(
          "Submission failed after signing — the claim inputs are still unspent, so the transaction has not been observed on-chain yet. Re-signing may double-submit if the first transaction later lands; check status again before retrying.",
        );
      }
    } catch {
      setSubmitError(
        "Submission failed after signing — the transaction may or may not have reached the chain, and the status check also failed. Check on-chain status before re-signing; re-signing may double-submit if the first transaction landed.",
      );
    }
  };

  const refreshProgressAfterSubmit = async (
    outrefs = draft?.orderedInputs.map((input) => input.outRefId) ?? [],
    pending = pendingOutrefs,
    options: { prepareNextBatch?: boolean } = {},
  ) => {
    if (outrefs.length === 0) {
      return;
    }
    const prepareNextBatch = options.prepareNextBatch ?? true;
    try {
      const params = new URLSearchParams({ outrefs: outrefs.join(",") });
      if (pending.length > 0) {
        params.set("pendingOutrefs", pending.join(","));
      }
      const nextProgress = await fetchJSON<ClaimProgressResponse>(`/claim-api/progress?${params.toString()}`);
      setProgress(nextProgress);
      const settledOutrefs = nextProgress.outrefs
        .filter((entry) => entry.state === "spent_or_unknown" || entry.state === "confirmed_spent")
        .map((entry) => entry.outRefId);
      if (settledOutrefs.length > 0) {
        setPendingOutrefs((current) => current.filter((outRefId) => !settledOutrefs.includes(outRefId)));
      }
      if (impactedWallet) {
        const utxos = await fetchAllReclaimUtxos();
        const credentialSet = new Set(impactedWallet.credentials.map((credential) => credential.toLowerCase()));
        const matched = utxos.filter(
          (utxo) =>
            utxo.state === "unspent" &&
            utxo.datum.status === "valid" &&
            credentialSet.has(utxo.datum.paymentCredential.toLowerCase()) &&
            !settledOutrefs.includes(utxo.outRefId),
        );
        const nextRows = matched.map(toClaimRow);
        setClaimIndexerTotal(utxos.length);
        setClaimRows(nextRows);
        setDraft(null);
        setProofArtifacts([]);
        setBuild(null);
        if (matched.length === 0) {
          setSubmitPhase("ready-to-sign");
          setScreen("claim-review-complete");
          return;
        }
        if (!prepareNextBatch) {
          setSubmitPhase("ready-to-sign");
          setScreen("submitted-refreshing");
          return;
        }
        setSevenSlotOptIn(false);
        const nextDraft = await createOrRefreshClaimDraft(safeWallet, nextRows, false);
        setScreen((current) =>
          nextDraft ? "create-proofs-ready" : current === "insufficient-ada" ? current : "available-claims-page-1",
        );
      }
    } catch (error) {
      setSubmitPhase("failed");
      setSubmitError(sanitizeRecoverableError(error, "Unable to refresh claim progress."));
      setScreen("submitted-refreshing");
    }
  };

  // Passive status refresh shared by the manual button and the auto-poll
  // (C3/C12). The in-flight ref pauses the poll while a refresh is running.
  const runPassiveStatusRefresh = async () => {
    if (submittedRefreshInFlightRef.current) {
      return;
    }
    submittedRefreshInFlightRef.current = true;
    try {
      const outrefs = submittedClaims.flatMap((claim) => claim.selectedOutrefs);
      await refreshProgressAfterSubmit(outrefs.length > 0 ? outrefs : undefined, pendingOutrefs, {
        prepareNextBatch: false,
      });
    } finally {
      submittedRefreshInFlightRef.current = false;
    }
  };

  // "Refresh status" is passive (C3): it refreshes progress and remaining
  // claims without creating a new draft or navigating back to Create Proofs.
  const refreshSubmittedProgress = () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    setSubmitError("");
    setSubmitFailureKind(null);
    void runPassiveStatusRefresh();
  };

  // Polite auto-poll on the submitted-refreshing screen (C12): re-checks claim
  // progress every 20 seconds while the screen is visible.
  const runPassiveStatusRefreshRef = useRef(runPassiveStatusRefresh);
  runPassiveStatusRefreshRef.current = runPassiveStatusRefresh;
  useEffect(() => {
    if (fixtureEnabled || screen !== "submitted-refreshing") {
      return;
    }
    const timer = setInterval(() => {
      void runPassiveStatusRefreshRef.current();
    }, 20_000);
    return () => clearInterval(timer);
  }, [fixtureEnabled, screen]);

  // Explicit next-batch CTA (C3): creates the next draft and returns to the
  // proof step, where the recovery phrase will be needed again.
  const startNextBatch = async () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    if (claimRows.length === 0) {
      setScreen("claim-review-complete");
      return;
    }
    const nextDraft = await createOrRefreshClaimDraft(safeWallet, claimRows);
    if (nextDraft) {
      setScreen("create-proofs-ready");
    }
  };

  // Full flow reset (C4): clears claim state and the stored resume snapshot,
  // keeping only the loaded deployment, then restarts at the impacted wallet.
  const resetClaimFlowState = () => {
    clearClaimFlowResumeSnapshot();
    setResumePromptSnapshot(null);
    setImpactedWallet(null);
    setImpactedWalletError("");
    setSafeWallet(null);
    safeWalletApiRef.current = null;
    setSafeWalletSigningAvailable(false);
    setSafeWalletSigningSessionState("not-connected");
    setSafeWalletError("");
    setClaimRows([]);
    setClaimIndexerTotal(0);
    setClaimDiscoveryError("");
    setPendingOutrefs([]);
    setDraft(null);
    setDraftError("");
    setInsufficientAdaDetails(null);
    setProofArtifacts([]);
    setProofError("");
    setPhraseChecksumFailed(false);
    setProofProgress(null);
    setBuild(null);
    setBuildError("");
    setSubmitError("");
    setSubmitFailureKind(null);
    setSubmitPhase("ready-to-sign");
    setSubmittedClaims([]);
    setProgress(null);
    submitInFlightRef.current = false;
  };

  const startAnotherRecovery = () => {
    resetClaimFlowState();
    setScreen("impacted-wallet");
  };

  // Terminal "Done" action (C1): clears all claim state plus the resume
  // snapshot and returns to the landing page.
  const finishRecovery = () => {
    resetClaimFlowState();
    if (typeof window !== "undefined") {
      window.location.assign("/");
    }
  };

  if (!fixtureEnabled && (courierStatus === "relaying" || courierStatus === "relayed")) {
    return <HelperPairingCourier status={courierStatus} />;
  }

  return (
    <main className="claim-shell" data-claim-state={screen}>
      <ClaimSidebar activeStep={activeStep} screen={screen} />
      <section className="claim-workspace">
        <ClaimTopNav />
        <div className="claim-page">
          {!fixtureEnabled && resumePromptSnapshot && screen === "deployment-review" ? (
            <div className="claim-notice info" role="status" data-testid="claim-resume-banner">
              <span className="claim-icon-circle">
                <RefreshCw size={28} aria-hidden="true" />
              </span>
              <div>
                <strong>Resume your claim in progress?</strong>
                <p>
                  Last saved {formatRelativeTime(resumePromptSnapshot.updatedAt)}. Resuming restores the saved claim
                  batch on this device; starting over discards it.
                </p>
                <div className="claim-modal-actions">
                  <button
                    className="claim-primary-button"
                    type="button"
                    onClick={() => {
                      restoreResumeSnapshot(resumePromptSnapshot);
                      setResumePromptSnapshot(null);
                    }}
                  >
                    Resume
                  </button>
                  <button
                    className="claim-secondary-button"
                    type="button"
                    onClick={() => {
                      clearClaimFlowResumeSnapshot();
                      setResumePromptSnapshot(null);
                    }}
                  >
                    Start over
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {renderScreen(visibleScreen, goNext, goBack, setScreen, {
            deployment,
            deploymentLoading,
            deploymentError,
            continueFromDeployment,
            wallets,
            selectedImpactedWallet,
            setSelectedImpactedWallet,
            selectedSafeWallet,
            setSelectedSafeWallet,
            impactedWallet,
            impactedWalletError,
            discoverClaimsForImpactedWallet,
            continueToSafeWallet,
            safeWallet,
            safeWalletError,
            connectSafeWallet,
            confirmSafeWalletDestination: () => void confirmSafeWalletDestination(),
            chooseDifferentSafeWallet,
            claimRows,
            claimIndexerTotal,
            claimScanProgress,
            claimDiscoveryError,
            refreshClaimMatches: refreshClaimMatchesFromCurrentWallet,
            changeClaimsPage,
            openClaimAssetModal,
            sevenSlotOptInAvailable,
            sevenSlotOptIn: useSevenSlotBatch,
            setSevenSlotOptIn,
            draft,
            draftError,
            insufficientAdaDetails,
            helperState,
            helperStatus,
            helperError,
            checkHelper: requestHelperAccess,
            proofArtifacts,
            proofError,
            phraseChecksumFailed,
            clearPhraseChecksumError,
            proofMethod,
            setProofMethod,
            browserProvingStatus,
            browserProvingDetail,
            refreshBrowserProvingStatus,
            proofProgress,
            cancelLocalProving,
            generateClaimProofs,
            build,
            buildError,
            submitError,
            submitFailureKind,
            safeWalletSigningAvailable,
            safeWalletSigningSessionState,
            submitPhase,
            submittedClaims,
            progress,
            buildOrSubmitCurrentBatch,
            refreshSubmittedProgress,
            checkSubmittedBatchStatus: () => void checkSubmittedBatchStatus(),
            startNextBatch: () => void startNextBatch(),
            startAnotherRecovery,
            finishRecovery,
            goToCurrentBatch,
          })}
        </div>
      </section>
      {screen === "available-claims-asset-modal" && (assetModalRow || fixtureEnabled) ? (
        <AssetModal row={assetModalRow ?? claimFixtureData().allClaims[0]} onClose={closeClaimAssetModal} />
      ) : null}
    </main>
  );
}

function renderScreen(
  screen: ClaimScreen,
  goNext: () => void,
  goBack: () => void,
  setScreen: React.Dispatch<React.SetStateAction<ClaimScreen>>,
  runtime: ClaimFlowRuntime,
) {
  switch (screen) {
    case "deployment-review":
      return (
        <DeploymentReview
          deployment={runtime.deployment}
          loading={runtime.deploymentLoading}
          error={runtime.deploymentError}
          onNext={runtime.continueFromDeployment}
          onBack={goBack}
        />
      );
    case "deployment-unavailable":
      return (
        <DeploymentReview
          unavailable
          deployment={runtime.deployment}
          loading={runtime.deploymentLoading}
          error={runtime.deploymentError}
          onNext={runtime.continueFromDeployment}
          onBack={goBack}
        />
      );
    case "impacted-wallet":
      return (
        <ImpactedWallet
          deployment={runtime.deployment}
          wallets={runtime.wallets}
          selectedWallet={runtime.selectedImpactedWallet}
          onSelectWallet={runtime.setSelectedImpactedWallet}
          impactedWallet={runtime.impactedWallet}
          error={runtime.impactedWalletError}
          onNext={runtime.discoverClaimsForImpactedWallet}
          onBack={goBack}
        />
      );
    case "wrong-network":
      return (
        <ImpactedWallet
          wrongNetwork
          deployment={runtime.deployment}
          wallets={runtime.wallets}
          selectedWallet={runtime.selectedImpactedWallet}
          onSelectWallet={runtime.setSelectedImpactedWallet}
          impactedWallet={runtime.impactedWallet}
          error={runtime.impactedWalletError}
          onNext={runtime.discoverClaimsForImpactedWallet}
          onBack={goBack}
        />
      );
    case "scanning-claims":
      return (
        <AvailableClaims
          loading
          deployment={runtime.deployment}
          impactedWallet={runtime.impactedWallet}
          rows={runtime.claimRows}
          scanProgress={runtime.claimScanProgress}
          indexerTotal={runtime.claimIndexerTotal}
          discoveryError={runtime.claimDiscoveryError}
          onRefresh={runtime.refreshClaimMatches}
          onNext={runtime.continueToSafeWallet}
          onBack={goBack}
          onPageChange={runtime.changeClaimsPage}
          onViewAsset={runtime.openClaimAssetModal}
          sevenSlotOptInAvailable={runtime.sevenSlotOptInAvailable}
          sevenSlotOptIn={runtime.sevenSlotOptIn}
          onSevenSlotOptInChange={runtime.setSevenSlotOptIn}
        />
      );
    case "no-matching-funds":
      return (
        <AvailableClaims
          empty
          deployment={runtime.deployment}
          impactedWallet={runtime.impactedWallet}
          rows={runtime.claimRows}
          indexerTotal={runtime.claimIndexerTotal}
          discoveryError={runtime.claimDiscoveryError}
          onRefresh={runtime.refreshClaimMatches}
          onNext={runtime.continueToSafeWallet}
          onBack={goBack}
          onPageChange={runtime.changeClaimsPage}
          onViewAsset={runtime.openClaimAssetModal}
          sevenSlotOptInAvailable={runtime.sevenSlotOptInAvailable}
          sevenSlotOptIn={runtime.sevenSlotOptIn}
          onSevenSlotOptInChange={runtime.setSevenSlotOptIn}
        />
      );
    case "available-claims-page-1":
      return (
        <AvailableClaims
          page={1}
          deployment={runtime.deployment}
          impactedWallet={runtime.impactedWallet}
          rows={runtime.claimRows}
          indexerTotal={runtime.claimIndexerTotal}
          discoveryError={runtime.claimDiscoveryError}
          onRefresh={runtime.refreshClaimMatches}
          onNext={runtime.continueToSafeWallet}
          onBack={goBack}
          onPageChange={runtime.changeClaimsPage}
          onViewAsset={runtime.openClaimAssetModal}
          sevenSlotOptInAvailable={runtime.sevenSlotOptInAvailable}
          sevenSlotOptIn={runtime.sevenSlotOptIn}
          onSevenSlotOptInChange={runtime.setSevenSlotOptIn}
        />
      );
    case "available-claims-page-2":
      return (
        <AvailableClaims
          page={2}
          deployment={runtime.deployment}
          impactedWallet={runtime.impactedWallet}
          rows={runtime.claimRows}
          indexerTotal={runtime.claimIndexerTotal}
          discoveryError={runtime.claimDiscoveryError}
          onRefresh={runtime.refreshClaimMatches}
          onNext={runtime.continueToSafeWallet}
          onBack={goBack}
          onPageChange={runtime.changeClaimsPage}
          onViewAsset={runtime.openClaimAssetModal}
          sevenSlotOptInAvailable={runtime.sevenSlotOptInAvailable}
          sevenSlotOptIn={runtime.sevenSlotOptIn}
          onSevenSlotOptInChange={runtime.setSevenSlotOptIn}
        />
      );
    case "safe-wallet":
      return (
        <SafeWallet
          deployment={runtime.deployment}
          wallets={runtime.wallets}
          selectedWallet={runtime.selectedSafeWallet}
          onSelectWallet={runtime.setSelectedSafeWallet}
          safeWallet={runtime.safeWallet}
          error={runtime.safeWalletError}
          draft={runtime.draft}
          draftError={runtime.draftError}
          onNext={runtime.connectSafeWallet}
          onConfirm={runtime.confirmSafeWalletDestination}
          onChooseDifferentWallet={runtime.chooseDifferentSafeWallet}
          onBack={goBack}
        />
      );
    case "safe-wallet-overlap":
      return (
        <SafeWallet
          overlap
          deployment={runtime.deployment}
          wallets={runtime.wallets}
          selectedWallet={runtime.selectedSafeWallet}
          onSelectWallet={runtime.setSelectedSafeWallet}
          safeWallet={runtime.safeWallet}
          error={runtime.safeWalletError}
          draft={runtime.draft}
          draftError={runtime.draftError}
          onNext={runtime.connectSafeWallet}
          onConfirm={runtime.confirmSafeWalletDestination}
          onChooseDifferentWallet={runtime.chooseDifferentSafeWallet}
          onBack={goBack}
        />
      );
    case "insufficient-ada":
      return (
        <SafeWallet
          insufficientAda
          insufficientAdaDetails={runtime.insufficientAdaDetails}
          deployment={runtime.deployment}
          wallets={runtime.wallets}
          selectedWallet={runtime.selectedSafeWallet}
          onSelectWallet={runtime.setSelectedSafeWallet}
          safeWallet={runtime.safeWallet}
          error={runtime.safeWalletError}
          draft={runtime.draft}
          draftError={runtime.draftError}
          onNext={runtime.connectSafeWallet}
          onConfirm={runtime.confirmSafeWalletDestination}
          onChooseDifferentWallet={runtime.chooseDifferentSafeWallet}
          onBack={goBack}
        />
      );
    case "helper-unavailable":
      return (
        <CreateProofs
          mode="helper-unavailable"
          draft={runtime.draft}
          safeWallet={runtime.safeWallet}
          helperState={runtime.helperState}
          helperError={runtime.helperError}
          onCheckHelper={runtime.checkHelper}
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          phraseChecksumFailed={runtime.phraseChecksumFailed}
          onPhraseEdited={runtime.clearPhraseChecksumError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelLocalProving}
          onNext={runtime.generateClaimProofs}
          onBack={goBack}
        />
      );
    case "create-proofs-ready":
      return (
        <CreateProofs
          mode="ready"
          draft={runtime.draft}
          safeWallet={runtime.safeWallet}
          helperState={runtime.helperState}
          helperError={runtime.helperError}
          onCheckHelper={runtime.checkHelper}
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          phraseChecksumFailed={runtime.phraseChecksumFailed}
          onPhraseEdited={runtime.clearPhraseChecksumError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelLocalProving}
          onNext={runtime.generateClaimProofs}
          onBack={goBack}
        />
      );
    case "create-proofs-generating":
      return (
        <CreateProofs
          mode="generating"
          draft={runtime.draft}
          safeWallet={runtime.safeWallet}
          helperState={runtime.helperState}
          helperError={runtime.helperError}
          onCheckHelper={runtime.checkHelper}
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          phraseChecksumFailed={runtime.phraseChecksumFailed}
          onPhraseEdited={runtime.clearPhraseChecksumError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelLocalProving}
          onNext={runtime.generateClaimProofs}
          onBack={goBack}
        />
      );
    case "proof-failed":
      return (
        <CreateProofs
          mode="failed"
          draft={runtime.draft}
          safeWallet={runtime.safeWallet}
          helperState={runtime.helperState}
          helperError={runtime.helperError}
          onCheckHelper={runtime.checkHelper}
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          phraseChecksumFailed={runtime.phraseChecksumFailed}
          onPhraseEdited={runtime.clearPhraseChecksumError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelLocalProving}
          onNext={runtime.generateClaimProofs}
          onBack={goBack}
        />
      );
    case "create-proofs-complete":
      return (
        <CreateProofs
          mode="complete"
          draft={runtime.draft}
          safeWallet={runtime.safeWallet}
          helperState={runtime.helperState}
          helperError={runtime.helperError}
          onCheckHelper={runtime.checkHelper}
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          phraseChecksumFailed={runtime.phraseChecksumFailed}
          onPhraseEdited={runtime.clearPhraseChecksumError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelLocalProving}
          onNext={runtime.goToCurrentBatch}
          onBack={goBack}
        />
      );
    case "current-batch":
      return (
        <CurrentBatch
          overview={false}
          draft={runtime.draft}
          build={runtime.build}
          buildError={runtime.buildError}
          submitError={runtime.submitError}
          submitFailureKind={runtime.submitFailureKind}
          onCheckStatus={runtime.checkSubmittedBatchStatus}
          onRescanClaims={() => setScreen("available-claims-page-1")}
          proofArtifacts={runtime.proofArtifacts}
          safeWallet={runtime.safeWallet}
          safeWalletSigningAvailable={runtime.safeWalletSigningAvailable}
          safeWalletSigningSessionState={runtime.safeWalletSigningSessionState}
          submitPhase={runtime.submitPhase}
          onNext={runtime.buildOrSubmitCurrentBatch}
          onBack={goBack}
        />
      );
    case "claim-funds-overview":
      return (
        <CurrentBatch
          overview
          draft={runtime.draft}
          build={runtime.build}
          buildError={runtime.buildError}
          submitError={runtime.submitError}
          submitFailureKind={runtime.submitFailureKind}
          onCheckStatus={runtime.checkSubmittedBatchStatus}
          onRescanClaims={() => setScreen("available-claims-page-1")}
          proofArtifacts={runtime.proofArtifacts}
          safeWallet={runtime.safeWallet}
          safeWalletSigningAvailable={runtime.safeWalletSigningAvailable}
          safeWalletSigningSessionState={runtime.safeWalletSigningSessionState}
          submitPhase={runtime.submitPhase}
          onNext={runtime.buildOrSubmitCurrentBatch}
          onBack={goBack}
        />
      );
    case "signature-rejected":
      return (
        <CurrentBatch
          rejected
          draft={runtime.draft}
          build={runtime.build}
          buildError={runtime.buildError}
          submitError={runtime.submitError}
          submitFailureKind={runtime.submitFailureKind}
          onCheckStatus={runtime.checkSubmittedBatchStatus}
          onRescanClaims={() => setScreen("available-claims-page-1")}
          proofArtifacts={runtime.proofArtifacts}
          safeWallet={runtime.safeWallet}
          safeWalletSigningAvailable={runtime.safeWalletSigningAvailable}
          safeWalletSigningSessionState={runtime.safeWalletSigningSessionState}
          submitPhase={runtime.submitPhase}
          onNext={runtime.buildOrSubmitCurrentBatch}
          onBack={goBack}
        />
      );
    case "submitted-refreshing":
      return (
        <ClaimReview
          pending
          submittedClaims={runtime.submittedClaims}
          progress={runtime.progress}
          safeWallet={runtime.safeWallet}
          submitError={runtime.submitError}
          remainingClaims={runtime.claimRows.length}
          onStartNextBatch={runtime.startNextBatch}
          explorerNetwork={runtime.deployment?.available ? runtime.deployment.deployment.network : undefined}
          onNext={runtime.refreshSubmittedProgress}
          onBack={goBack}
        />
      );
    case "claim-review-complete":
      return (
        <ClaimReview
          submittedClaims={runtime.submittedClaims}
          progress={runtime.progress}
          safeWallet={runtime.safeWallet}
          submitError={runtime.submitError}
          remainingClaims={runtime.claimRows.length}
          explorerNetwork={runtime.deployment?.available ? runtime.deployment.deployment.network : undefined}
          onNext={runtime.finishRecovery}
          onBack={runtime.startAnotherRecovery}
        />
      );
    default:
      return <DeploymentReview onNext={goNext} onBack={goBack} />;
  }
}

function ClaimTopNav() {
  return (
    <header className="claim-topbar">
      <nav className="claim-primary-nav" aria-label="Main">
        <a href="/reclaim" className="claim-nav-link">
          <LockKeyhole size={24} aria-hidden="true" />
          Lock funds
        </a>
        <a href="/claim" className="claim-nav-link active" aria-current="page">
          <Coins size={25} aria-hidden="true" />
          Claim funds
        </a>
      </nav>
      <div className="claim-top-actions">
        <a
          className="claim-ghost-action"
          href="https://github.com/Anastasia-Labs/proof-tool/tree/main/docs"
          target="_blank"
          rel="noreferrer"
        >
          <HelpCircle size={22} aria-hidden="true" />
          Help
        </a>
      </div>
    </header>
  );
}

// Standalone view for the courier tab the desktop app opens to carry a pairing
// fragment. It relays the pairing to an existing tab rather than running a
// duplicate flow here.
function HelperPairingCourier({ status }: { status: "relaying" | "relayed" }) {
  const relayed = status === "relayed";
  return (
    <main className="claim-shell" data-claim-state="helper-courier">
      <section className="claim-workspace">
        <ClaimTopNav />
        <div className="claim-page">
          <div className="claim-notice info" role="status" data-testid="helper-courier">
            <span className="claim-icon-circle">
              {relayed ? (
                <CheckCircle2 size={28} aria-hidden="true" />
              ) : (
                <RefreshCw size={28} className="spin" aria-hidden="true" />
              )}
            </span>
            <div>
              <strong>{relayed ? "Proof Helper paired" : "Connecting Proof Helper…"}</strong>
              <p>
                {relayed
                  ? "Your claim is paired in the tab you already had open. This tab will close itself — if it stays open, you can close it and continue there."
                  : "Handing the Proof Helper connection to your open claim tab. This only takes a moment."}
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function ClaimSidebar({ activeStep, screen }: { activeStep: number; screen: ClaimScreen }) {
  return (
    <aside className="claim-sidebar" aria-label="Claim progress">
      <div className="claim-brand">
        <div className="claim-brand-mark" aria-hidden="true">
          <ShieldCheck size={36} />
        </div>
        <div>
          <strong>ReclaimGlobal</strong>
          <span>Cardano ownership recovery</span>
        </div>
      </div>

      <ol className="claim-step-list">
        {steps.map((step) => {
          const status = step.id < activeStep || (screen === "claim-review-complete" && step.id === 7) ? "complete" : step.id === activeStep ? "active" : "pending";
          return <ClaimStep key={step.id} step={step} status={status} />;
        })}
      </ol>

      <div className="claim-assurance">
        <ShieldCheck size={31} aria-hidden="true" />
        <p>Secured by an on-chain smart contract — no one, including us, can move funds without the owner&apos;s proof.</p>
      </div>
    </aside>
  );
}

function ClaimStep({ step, status }: { step: Step; status: StepStatus }) {
  const Icon = step.icon;
  return (
    <li className={`claim-step ${status}`}>
      <div className="claim-step-line" aria-hidden="true" />
      <div className="claim-step-token" aria-hidden="true">
        {status === "complete" ? <Check size={22} /> : step.id}
      </div>
      <Icon className="claim-step-icon" size={31} aria-hidden="true" />
      <div>
        <strong>
          {step.id}. {step.label}
        </strong>
        <span>{status === "complete" ? "Complete" : status === "active" ? "In progress" : "Pending"}</span>
      </div>
    </li>
  );
}

function DeploymentReview({
  unavailable,
  deployment,
  loading,
  error,
  onNext,
  onBack,
}: {
  unavailable?: boolean;
  deployment?: ClaimDeploymentResponse | null;
  loading?: boolean;
  error?: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const sourceRepoUrl = "https://github.com/Anastasia-Labs/proof-tool";
  const sourceRepoLabel = "github.com/Anastasia-Labs/proof-tool";
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const liveDeployment = deployment?.available ? deployment.deployment : null;
  // C19: placeholder cryptographic values are fixture-only. In live mode with
  // no loaded deployment, render "—" so nothing fabricated looks verifiable.
  const sourceCommit = liveDeployment?.sourceCommit ?? (fixtureMode ? "4f3c9a1e2b6c8d0f91a4b7c3e0d29a6f48bd12c0" : "");
  const deploymentLabel = liveDeployment?.id ?? (fixtureMode ? "Pinned" : "—");
  const networkLabel = liveDeployment?.network ?? (fixtureMode ? "Cardano mainnet" : "—");
  const baseScript = liveDeployment?.reclaimBaseScriptHash ?? (fixtureMode ? "script1q9k9r0v6t2m313u4z8h8y2d0k5f4x7w8e5p2c3h6tx" : "—");
  const globalScript = liveDeployment?.reclaimGlobalScriptHash ?? (fixtureMode ? "script1p7c2a5j9u8x316v0m4n9w5e2k3d7z6t1y8f4p5m4da" : "—");
  const paramsUtxo = liveDeployment?.paramsUtxo
    ? `${liveDeployment.paramsUtxo.tx_hash}#${liveDeployment.paramsUtxo.output_index}`
    : fixtureMode
      ? "7b9f2c1d6e8a3b4f7c9d0a1e5b6c3d2a9f1b8c7a#0"
      : "—";
  const paramsDatum = liveDeployment?.paramsUtxo?.datum_reclaim_base_script_hash
    ? `reclaimBaseHash: ${liveDeployment.paramsUtxo.datum_reclaim_base_script_hash}`
    : fixtureMode
      ? "reclaimBaseHash: script1q9k9r0v6t2m313u4z8h8y2d0k5f4x7w8e5p2c3h6tx"
      : "—";
  const deploymentValuesReady = Boolean(liveDeployment) || fixtureMode;
  const deploymentKnownUnavailable = Boolean(unavailable || deployment?.available === false);
  return (
    <ClaimScreenFrame
      title="Verify this recovery service"
      subtitle={`This page is pinned to a specific deployment of the ReclaimGlobal contracts on ${networkLabel === "—" ? "the configured network" : networkLabel}. If you were given a deployment ID or commit hash, compare it here before continuing.`}
      // C8: step 1 has no previous screen, so the Back button is hidden.
      nextLabel={deploymentKnownUnavailable ? "Retry deployment" : "Continue"}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={Boolean(loading)}
    >
      {unavailable ? (
        <Notice tone="bad" icon={CircleAlert} title="Deployment unavailable">
          {error ||
            "The pinned claim deployment could not be loaded. Wallet connection and claim submission stay disabled until the manifest is available."}
        </Notice>
      ) : null}
      {loading ? (
        <Notice icon={RefreshCw} title="Checking deployment">
          Loading the pinned claim deployment before wallet discovery is enabled.
        </Notice>
      ) : null}

      <div className="claim-card-grid three">
        <MetricStripItem icon={Globe2} label="Network" value={networkLabel} />
        <MetricStripItem icon={Lock} label="Deployment" value={abbreviateMiddle(deploymentLabel, 24)} />
        <MetricStripItem icon={ShieldCheck} label="Claim flow" value="Single validator" />
      </div>

      <details className="claim-technical-details">
        <summary>Technical details</summary>
        <Panel icon={Code2} title="Smart contracts">
          <ReviewRow label="mkReclaimBase" value={baseScript} noCopy={!deploymentValuesReady} />
          <ReviewRow label="mkReclaimGlobal" value={globalScript} noCopy={!deploymentValuesReady} />
        </Panel>

        <Panel icon={SlidersHorizontal} title="Recovery parameters">
          <ReviewRow label="Params UTxO" value={paramsUtxo} noCopy={!deploymentValuesReady} />
          <ReviewRow label="Parsed datum" value={paramsDatum} detail="The datum binds this deployment to the ReclaimBase script." noCopy={!deploymentValuesReady} />
        </Panel>
      </details>

      <Panel icon={Github} title="Pinned source">
        <ReviewRow label="Git commit" value={sourceCommit || "—"} noCopy={!sourceCommit} />
        {sourceCommit ? (
          <a className="claim-external-link" href={`${sourceRepoUrl}/commit/${sourceCommit}`}>
            <ExternalLink size={17} aria-hidden="true" />
            View commit on GitHub
            <span>{sourceRepoLabel}/commit/{abbreviateMiddle(sourceCommit, 12)}</span>
          </a>
        ) : (
          <span className="claim-external-link" aria-disabled="true">
            <ExternalLink size={17} aria-hidden="true" />
            View commit on GitHub
            <span>Unavailable until the deployment manifest loads</span>
          </span>
        )}
      </Panel>
    </ClaimScreenFrame>
  );
}

function ImpactedWallet({
  wrongNetwork,
  deployment,
  wallets = [],
  selectedWallet = "",
  onSelectWallet,
  impactedWallet,
  error,
  onNext,
  onBack,
}: {
  wrongNetwork?: boolean;
  deployment?: ClaimDeploymentResponse | null;
  wallets?: WalletEntry[];
  selectedWallet?: string;
  onSelectWallet?: React.Dispatch<React.SetStateAction<string>>;
  impactedWallet?: ImpactedWalletSummary | null;
  error?: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const expectedNetwork = deployment?.available ? deployment.deployment.network : "the configured network";
  const hasWallets = wallets.length > 0 || !onSelectWallet;
  return (
    <ClaimScreenFrame
      title="Connect impacted wallet"
      subtitle={`Connect the wallet that held the accounts affected by the ${INCIDENT_NAME} incident.`}
      backLabel="Back"
      nextLabel={wrongNetwork ? "Try again" : "Connect impacted wallet"}
      nextIcon={Wallet}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!hasWallets}
    >
      <div className="claim-two-column">
        <div className="claim-stack">
          <Notice icon={Wallet} title={`${INCIDENT_NAME} is in maintenance mode.`}>
            If you used {INCIDENT_NAME}, import that wallet&apos;s recovery phrase into Lace or another Cardano browser
            wallet first, then connect it here.
          </Notice>
          <Notice tone={wrongNetwork ? "bad" : "info"} icon={wrongNetwork ? CircleAlert : HelpCircle} title={wrongNetwork ? "Wrong network" : undefined}>
            {wrongNetwork
              ? `This wallet is not on ${expectedNetwork}. Switch the network inside your wallet, or select a different wallet, then try again.`
              : "This step only reads public wallet addresses and wallet keys (a public fingerprint of a key in your wallet — it cannot be used to spend funds). You will not sign a transaction with the impacted wallet."}
          </Notice>
          {error ? (
            <Notice tone="bad" icon={CircleAlert} title="Impacted wallet discovery stopped">
              {error}
            </Notice>
          ) : null}
          {impactedWallet ? (
            <Notice tone="ok" icon={Check} title="Impacted wallet connected">
              Found {impactedWallet.credentials.length} wallet key{impactedWallet.credentials.length === 1 ? "" : "s"} with claimable funds across{" "}
              {impactedWallet.addresses.length} public address{impactedWallet.addresses.length === 1 ? "" : "es"}.
            </Notice>
          ) : null}
          <WalletChooser layout="list" wallets={wallets} selectedWallet={selectedWallet} onSelectWallet={onSelectWallet} />
        </div>
        <InfoPanel
          title="What happens next"
          items={[
            { icon: Search, title: "Find matching wallet keys", body: "We'll look for wallet keys from this wallet that have available funds." },
            { icon: Coins, title: "Scan locked funds", body: "We'll scan the ReclaimBase contract for funds tied to those wallet keys." },
            { icon: CalendarDays, title: "Show claimable funds", body: "You'll see the total funds available to claim before continuing." },
          ]}
          footer="Your recovery phrase and private keys never leave your device."
        />
      </div>
    </ClaimScreenFrame>
  );
}

function AvailableClaims({
  page = 1,
  loading,
  empty,
  deployment,
  impactedWallet,
  rows: realRows,
  scanProgress,
  indexerTotal,
  discoveryError,
  onRefresh,
  onNext,
  onBack,
  onPageChange,
  onViewAsset,
  sevenSlotOptInAvailable,
  sevenSlotOptIn,
  onSevenSlotOptInChange,
}: {
  page?: 1 | 2;
  loading?: boolean;
  empty?: boolean;
  deployment?: ClaimDeploymentResponse | null;
  impactedWallet?: ImpactedWalletSummary | null;
  rows?: ClaimRow[];
  scanProgress?: number;
  indexerTotal?: number;
  discoveryError?: string;
  onRefresh?: () => void;
  onNext: () => void;
  onBack: () => void;
  onPageChange: (page: 1 | 2) => void;
  onViewAsset: (row: ClaimRow) => void;
  sevenSlotOptInAvailable?: boolean;
  sevenSlotOptIn?: boolean;
  onSevenSlotOptInChange?: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const [searchQuery, setSearchQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState("All");
  const [currentPage, setCurrentPage] = useState<number>(page);
  useEffect(() => {
    setCurrentPage(page);
  }, [page]);
  // C43: an empty live row array must not defeat the fixture rows on fixture
  // screens — treat it as absent while no impacted wallet is connected. The
  // scanning/empty fixture states intentionally keep their empty row set.
  const effectiveRealRows =
    fixtureMode && !impactedWallet && !empty && !loading && (realRows?.length ?? 0) === 0 ? undefined : realRows;
  const allRows = effectiveRealRows ?? (fixtureMode ? claimFixtureData().allClaims : []);
  const pageSize = 10;
  const filteredRows = filterClaimRows(allRows, searchQuery, assetFilter);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const effectivePage = Math.min(Math.max(currentPage, 1), pageCount);
  const rows = filteredRows.slice((effectivePage - 1) * pageSize, effectivePage * pageSize);
  const changePage = (nextPage: number) => {
    const clamped = Math.min(Math.max(nextPage, 1), pageCount);
    setCurrentPage(clamped);
    // Keep the fixture screen enum in sync for the first two pages; deeper
    // pages are handled entirely by the internal page state.
    if (clamped === 1 || clamped === 2) {
      onPageChange(clamped as 1 | 2);
    }
  };
  const totalLovelace = sumLovelace(allRows);
  const totalAssets = allRows.reduce((total, row) => total + (row.assetCount ?? (row.summary.length > 0 ? row.summary.length : 0)), 0);
  const credentialCount = new Set(allRows.map((row) => row.credential)).size;
  const batchSize = sevenSlotOptIn
    ? CLAIM_HARD_BATCH_CAP
    : deployment?.available
      ? deployment.deployment.batching?.default_utxo_count ?? 4
      : 4;
  const estimatedBatches = allRows.length > 0 ? Math.ceil(allRows.length / batchSize) : 0;
  const walletLabel = impactedWallet ? abbreviateMiddle(impactedWallet.addresses[0] ?? impactedWallet.walletName, 14) : "Not connected";
  const visibleEmpty = Boolean(empty || (allRows.length === 0 && !loading));
  return (
    <ClaimScreenFrame
      title="Available claims"
      subtitle="These funds were locked for you by rescuers and match wallet keys from your impacted wallet."
      backLabel="Back"
      nextLabel="Continue to safe wallet"
      nextIcon={ShieldCheck}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={Boolean(loading || visibleEmpty)}
    >
      <SummaryTiles
        tiles={[
          { icon: Wallet, label: "Impacted wallet", value: walletLabel, status: impactedWallet ? "Connected" : fixtureMode ? "Fixture" : "Required" },
          { icon: Coins, label: "Total claimable", value: `${formatLovelace(totalLovelace)} ADA`, detail: `${totalAssets} token${totalAssets === 1 ? "" : "s"}` },
          {
            icon: KeyRound,
            label: "Matching UTxOs",
            value: String(allRows.length),
            detail: `Across ${credentialCount} wallet key${credentialCount === 1 ? "" : "s"}`,
          },
          { icon: CalendarDays, label: "Estimated batches", value: String(estimatedBatches), detail: `${batchSize} UTxOs per batch` },
        ]}
      />

      <div className="claim-content-with-aside">
        <Panel title="Funds you can claim" className="claim-table-panel">
          {sevenSlotOptInAvailable ? (
            <div className="claim-notice info">
              <span className="claim-icon-circle">
                <SlidersHorizontal size={28} aria-hidden="true" />
              </span>
              <div>
                <strong>Optional seven-UTxO batch</strong>
                <p>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(sevenSlotOptIn)}
                      onChange={(event) => onSevenSlotOptInChange?.(event.target.checked)}
                    />{" "}
                    Use seven UTxOs for the next batch
                  </label>{" "}
                  This is optional; duplicate credentials do not prevent drafting. Execution units are measured before the transaction can proceed.
                </p>
              </div>
            </div>
          ) : null}
          <div className="claim-table-tools">
            <label className="claim-search">
              <Search size={18} aria-hidden="true" />
              <input
                placeholder="Search tx, output, or credential"
                aria-label="Search claims by tx, output, or credential"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setCurrentPage(1);
                }}
              />
            </label>
            <Segmented
              options={["All", "ADA", "Tokens"]}
              value={assetFilter}
              onChange={(option) => {
                setAssetFilter(option);
                setCurrentPage(1);
              }}
              label="Filter claims by asset type"
            />
            <button className="claim-secondary-button" type="button" onClick={onRefresh} disabled={!onRefresh || loading}>
              <RefreshCw size={18} aria-hidden="true" />
              Refresh
            </button>
          </div>
          {loading ? (
            <TableEmpty
              icon={RefreshCw}
              spin
              title="Scanning locked funds"
              body={`Checking on-chain records against your wallet keys.${scanProgress ? ` Scanned ${scanProgress} UTxOs…` : ""}`}
            />
          ) : discoveryError ? (
            <div className="claim-table-empty">
              <CircleAlert size={36} aria-hidden="true" />
              <strong>We couldn&apos;t check for claims</strong>
              <p>Your funds are not affected — this was a lookup problem. Try again in a moment.</p>
              <p>{discoveryError}</p>
              <button className="claim-secondary-button" type="button" onClick={onRefresh} disabled={!onRefresh}>
                <RefreshCw size={18} aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : visibleEmpty ? (
            <TableEmpty
              icon={Search}
              title="No matching funds found"
              body={`We didn't find any locked funds matching this wallet${indexerTotal ? ` across ${indexerTotal} indexed UTxOs` : ""}. Try another wallet that held the affected accounts, or refresh later — rescuers may still be locking funds.`}
            />
          ) : filteredRows.length === 0 ? (
            <TableEmpty icon={Search} title="No claims match your search" body="Adjust the search or the All/ADA/Tokens filter to see matching UTxOs." />
          ) : (
            <ClaimsTable rows={rows} page={effectivePage} pageSize={pageSize} totalRows={filteredRows.length} onPageChange={changePage} onViewAsset={onViewAsset} />
          )}
        </Panel>
        <InfoPanel
          title="Why these match"
          compact
          items={[
            { icon: Check, title: "Your wallet key is listed", body: "Each locked fund records the wallet key it belongs to." },
            { icon: Check, title: "The key comes from your impacted wallet", body: "The wallet key matches keys derived from your impacted wallet." },
            { icon: Check, title: "Still unclaimed", body: "The funds are still locked and have not been claimed yet." },
          ]}
          footer="Learn more about the matching process"
        />
      </div>
    </ClaimScreenFrame>
  );
}

function SafeWallet({
  overlap,
  insufficientAda,
  insufficientAdaDetails,
  deployment,
  wallets,
  selectedWallet,
  onSelectWallet,
  safeWallet,
  error,
  draft,
  draftError,
  onNext,
  onConfirm,
  onChooseDifferentWallet,
  onBack,
}: {
  overlap?: boolean;
  insufficientAda?: boolean;
  insufficientAdaDetails?: InsufficientAdaDetails | null;
  deployment?: ClaimDeploymentResponse | null;
  wallets?: WalletEntry[];
  selectedWallet?: string;
  onSelectWallet?: React.Dispatch<React.SetStateAction<string>>;
  safeWallet?: SafeWalletSummary | null;
  error?: string;
  draft?: ClaimDraftResponse | null;
  draftError?: string;
  onNext: () => void;
  onConfirm?: () => void;
  onChooseDifferentWallet?: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const hasWallets = fixtureMode || wallets === undefined || wallets.length > 0;
  const expectedNetwork = deployment?.available ? deployment.deployment.network : "the configured network";
  // C32: prefer the backend-provided amounts; the fixture demonstrates the
  // real layout with example amounts. Older payloads without details keep the
  // qualitative copy.
  const effectiveInsufficientAdaDetails =
    insufficientAdaDetails ??
    (fixtureMode && insufficientAda ? { availableLovelace: "2450000", requiredLovelace: "5000000" } : null);
  // Confirmation beat (C17): connecting populates the destination panel and
  // keeps the user here; an explicit confirm advances to proof creation.
  const connected = Boolean(safeWallet);
  return (
    <ClaimScreenFrame
      title="Connect safe wallet"
      subtitle="Connect a wallet you know is safe. Claimed funds will be sent to this wallet."
      backLabel="Back"
      nextLabel={connected ? "Confirm destination and continue" : overlap ? "Choose another wallet" : "Connect safe wallet"}
      nextIcon={ShieldCheck}
      onBack={onBack}
      onNext={connected && onConfirm ? onConfirm : onNext}
      nextDisabled={!hasWallets}
    >
      <div className="claim-two-column">
        <div className="claim-stack">
          <Notice icon={ShieldCheck} title="Use a clean destination">
            Do not connect the impacted wallet here. Choose a wallet whose recovery phrase and devices were not exposed
            during the {INCIDENT_NAME} incident.
          </Notice>
          <Notice icon={HelpCircle} title="Why this comes before proofs">
            Claim proofs are destination-bound, so we need the safe wallet address before proofs are created.
          </Notice>
          {error ? (
            <Notice tone="bad" icon={CircleAlert} title="Safe wallet blocked">
              {error}
            </Notice>
          ) : null}
          {draftError ? (
            <Notice tone="bad" icon={CircleAlert} title="Claim draft blocked">
              {draftError}
            </Notice>
          ) : null}
          <WalletChooser layout="grid" wallets={wallets} selectedWallet={selectedWallet} onSelectWallet={onSelectWallet} />
        </div>
        <Panel icon={Wallet} title="Funds will arrive here" className={overlap || insufficientAda ? "claim-panel-alert" : undefined}>
          {overlap ? (
            <Notice tone="bad" icon={CircleAlert} title="Shared wallet key">
              This safe wallet shares a wallet key with the impacted wallet. Choose a different destination.
            </Notice>
          ) : null}
          {insufficientAda ? (
            <Notice tone="bad" icon={CircleAlert} title="More ADA needed">
              {effectiveInsufficientAdaDetails
                ? `Your safe wallet has ${formatLovelace(effectiveInsufficientAdaDetails.availableLovelace)} ADA — at least ${formatLovelace(effectiveInsufficientAdaDetails.requiredLovelace)} ADA is needed for fees, collateral, and min-ADA. Recovered funds will not be reduced for fees.`
                : "The safe wallet needs more ADA for fees, collateral, and min-ADA. Recovered funds will not be reduced for fees."}
            </Notice>
          ) : null}
          {safeWallet ? (
            <Notice tone="ok" icon={Check} title="Safe wallet connected">
              Connected on {expectedNetwork} with {safeWallet.credentials.length} wallet key{safeWallet.credentials.length === 1 ? "" : "s"}.
              {" "}Check the address below, then confirm the destination to continue.
            </Notice>
          ) : null}
          {safeWallet && onChooseDifferentWallet ? (
            <button className="claim-secondary-button" type="button" onClick={onChooseDifferentWallet}>
              <Wallet size={18} aria-hidden="true" />
              Choose a different wallet
            </button>
          ) : null}
          <ReviewRow label="Safe wallet" value={safeWallet?.walletName ?? "Not connected yet"} noCopy />
          <ReviewRow
            label="Receive address"
            value={safeWallet ? safeWallet.changeAddress : "Connect wallet to preview"}
            breakValue={Boolean(safeWallet)}
            noCopy={!safeWallet}
            detail={safeWallet ? "Confirm this matches the receive address shown in your safe wallet." : undefined}
          />
          <ReviewRow label="Fees paid by" value="Safe wallet" icon={ShieldCheck} noCopy />
          <ReviewRow label="Impacted wallet signature" value="Not required" noCopy />
          {draft ? (
            <>
              <ReviewRow label="Current draft" value={abbreviateMiddle(draft.draftId, 24)} noCopy />
              <ReviewRow label="Draft inputs" value={`${draft.orderedInputs.length} UTxO${draft.orderedInputs.length === 1 ? "" : "s"}`} noCopy />
            </>
          ) : null}
          <Notice icon={Lock} title={undefined}>
            This address will be embedded in your claim proofs to ensure funds can only be sent here.
          </Notice>
        </Panel>
      </div>
    </ClaimScreenFrame>
  );
}

function CreateProofs({
  mode,
  draft,
  safeWallet,
  helperState,
  helperError,
  onCheckHelper,
  proofError,
  draftError,
  phraseChecksumFailed,
  onPhraseEdited,
  proofArtifacts,
  proofMethod,
  onSelectProofMethod,
  browserProvingStatus,
  browserProvingDetail,
  onRecheckBrowserProving,
  proofProgress,
  onCancelProving,
  onNext,
  onBack,
}: {
  mode: "ready" | "generating" | "complete" | "helper-unavailable" | "failed";
  draft?: ClaimDraftResponse | null;
  safeWallet?: SafeWalletSummary | null;
  helperState?: ClaimHelperState;
  helperError?: string;
  onCheckHelper?: () => void;
  proofError?: string;
  draftError?: string;
  phraseChecksumFailed?: boolean;
  onPhraseEdited?: () => void;
  proofArtifacts?: Record<string, unknown>[];
  proofMethod: LocalProofMethod | null;
  onSelectProofMethod: (method: LocalProofMethod | null) => void;
  browserProvingStatus: BrowserProvingStatus;
  browserProvingDetail: string;
  onRecheckBrowserProving: () => Promise<boolean>;
  proofProgress?: ProofProgressEvent | null;
  onCancelProving?: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const setProofMethod = onSelectProofMethod;
  const [proofMethodDialogOpen, setProofMethodDialogOpen] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [recoveryPhraseWordCount, setRecoveryPhraseWordCount] = useState<RecoveryPhraseWordCount>(24);
  const [showRecoveryWords, setShowRecoveryWords] = useState(false);
  const [pasteStatus, setPasteStatus] = useState<RecoveryPhrasePasteStatus | null>(null);
  const [pastePending, setPastePending] = useState(false);
  const [pendingRecoveryPhraseWords, setPendingRecoveryPhraseWords] = useState<string[] | null>(null);
  // C28: per-word validation against the real BIP-39 English wordlist
  // (re-exported by @proof-zk-recovery/proof-tool-client), so typos like
  // "recieve" are flagged as the user types. The full-phrase checksum is
  // additionally validated at generate time (and again in the derivation
  // worker) before any proving starts. Only word statuses are kept in React
  // state — never the words themselves.
  const [wordStatuses, setWordStatuses] = useState<RecoveryWordStatus[]>([]);
  const recomputeWordStatuses = useCallback(() => {
    setWordStatuses(recoveryWordInputs().map((input) => recoveryWordStatus(input.value)));
    // Any grid change invalidates a previous checksum failure notice.
    onPhraseEdited?.();
  }, [onPhraseEdited]);
  useEffect(() => {
    recomputeWordStatuses();
  }, [mode, recoveryPhraseWordCount, recomputeWordStatuses]);
  const invalidWordNumbers = wordStatuses.flatMap((status, index) => (status === "invalid" ? [index + 1] : []));
  const phraseComplete =
    wordStatuses.length === recoveryPhraseWordCount && wordStatuses.every((status) => status === "valid");

  // C27: clipboard hygiene after a successful paste — best-effort overwrite of
  // the clipboard so the phrase does not linger there.
  const finalizeRecoveryPhrasePaste = useCallback(async (wordCount: number) => {
    let cleared = false;
    try {
      if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText("");
        cleared = true;
      }
    } catch {
      cleared = false;
    }
    setPasteStatus({
      tone: "ok",
      message: cleared
        ? `Pasted ${wordCount} words. We cleared your clipboard.`
        : `Pasted ${wordCount} words. Clear your clipboard now — copy anything else to overwrite it.`,
    });
  }, []);

  const applyRecoveryPhraseWords = useCallback((words: string[]) => {
    const wordCount = recoveryPhraseWordCountFromLength(words.length);
    if (!wordCount) {
      setPasteStatus({
        tone: "bad",
        message:
          words.length === 0
            ? "Clipboard does not contain a 12-, 15-, or 24-word recovery phrase."
            : `Clipboard has ${words.length} words. Paste a 12-, 15-, or 24-word recovery phrase.`,
      });
      return false;
    }

    if (wordCount !== recoveryPhraseWordCount) {
      setPendingRecoveryPhraseWords(words);
      setRecoveryPhraseWordCount(wordCount);
      return true;
    }

    writeRecoveryPhraseWords(words);
    recomputeWordStatuses();
    void finalizeRecoveryPhrasePaste(words.length);
    return true;
  }, [finalizeRecoveryPhrasePaste, recomputeWordStatuses, recoveryPhraseWordCount]);

  useEffect(() => {
    if (!pendingRecoveryPhraseWords || pendingRecoveryPhraseWords.length !== recoveryPhraseWordCount) {
      return;
    }
    writeRecoveryPhraseWords(pendingRecoveryPhraseWords);
    recomputeWordStatuses();
    void finalizeRecoveryPhrasePaste(pendingRecoveryPhraseWords.length);
    setPendingRecoveryPhraseWords(null);
  }, [finalizeRecoveryPhrasePaste, pendingRecoveryPhraseWords, recomputeWordStatuses, recoveryPhraseWordCount]);

  const pasteRecoveryPhrase = useCallback(async () => {
    setPendingRecoveryPhraseWords(null);
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.readText !== "function") {
      focusFirstRecoveryWordInput();
      setPasteStatus({
        tone: "warn",
        message: "Clipboard access is not available here. Press Ctrl+V or Command+V in the first word field.",
      });
      return;
    }

    setPastePending(true);
    setPasteStatus({
      tone: "warn",
      message: "Reading clipboard...",
    });
    try {
      const clipboardText = await readClipboardTextWithTimeout(navigator.clipboard.readText.bind(navigator.clipboard));
      const words = recoveryPhraseWordsFromText(clipboardText);
      applyRecoveryPhraseWords(words);
    } catch {
      focusFirstRecoveryWordInput();
      setPasteStatus({
        tone: "warn",
        message: "Browser clipboard access was blocked. Press Ctrl+V or Command+V in the first word field.",
      });
    } finally {
      setPastePending(false);
    }
  }, [applyRecoveryPhraseWords]);

  const pasteRecoveryPhraseFromField = useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    const words = recoveryPhraseWordsFromText(event.clipboardData.getData("text"));
    if (words.length <= 1) {
      return;
    }
    event.preventDefault();
    setPendingRecoveryPhraseWords(null);
    applyRecoveryPhraseWords(words);
  }, [applyRecoveryPhraseWords]);

  if (mode === "generating") {
    return (
      <CreateProofsGenerating
        draft={draft}
        safeWallet={safeWallet}
        proofMethod={proofMethod}
        proofProgress={proofProgress}
        onCancelProving={onCancelProving}
        onNext={onNext}
        onBack={onBack}
      />
    );
  }
  if (mode === "complete") {
    return <CreateProofsComplete draft={draft} safeWallet={safeWallet} proofArtifacts={proofArtifacts} onNext={onNext} onBack={onBack} />;
  }
  const effectiveHelperState: ClaimHelperState = fixtureMode && mode !== "helper-unavailable" ? "ready" : (helperState ?? "unpaired");
  const helperReady = effectiveHelperState === "ready";
  const helperChecking = effectiveHelperState === "checking";
  const helperPermissionPrompt = effectiveHelperState === "permission-prompt";
  const helperPermissionDenied = effectiveHelperState === "permission-denied";
  const helperUnavailable = !helperReady && !helperChecking;
  const helperBad = mode === "helper-unavailable" || (!fixtureMode && helperUnavailable);
  const failed = mode === "failed";
  const browserSelected = proofMethod === "browser";
  const methodMissing = proofMethod === null;
  const browserReady = browserProvingStatus === "ready";
  const browserChecking = browserProvingStatus === "checking";
  const browserBlockedReason = browserChecking
    ? "Checking whether this browser can generate proofs..."
    : browserProvingDetail ||
      "Browser proving is not enabled for this build yet. Choose Proof Helper Desktop to generate proofs now.";
  const proofsNeeded = draft?.orderedInputs.length ?? (fixtureMode ? 18 : 0);
  const generated = proofArtifacts?.length ?? 0;
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Not connected";
  const proofSetupBlocked =
    methodMissing ||
    (browserSelected && !browserReady) ||
    (!fixtureMode && (!draft || !safeWallet || (!browserSelected && helperBad) || draft.buildSupported === false));
  // C28: the recovery phrase grid must be complete (and shape-valid) before
  // Generate/Retry is enabled — including after a failure cleared the grid.
  // An incomplete grid is a normal state, so it disables the button without
  // turning the setup notice red.
  const proofBlocked = proofSetupBlocked || !phraseComplete;
  const activeError = proofError || (browserSelected ? "" : helperError) || draftError;
  const methodValue = browserSelected ? "Prove in browser" : proofMethod === "desktop" && helperReady ? "Proof Helper Desktop" : "Not selected";
  const methodStatus = methodMissing
    ? "Choose method"
    : browserSelected
      ? browserReady
        ? "Ready"
        : browserChecking
          ? "Checking support"
          : "Unavailable"
    : helperReady
      ? "Ready"
      : helperChecking
        ? "Checking status"
        : "Choose method";
  const methodStatusTone = methodMissing
    ? "bad"
    : browserSelected
      ? browserReady
        ? "ok"
        : browserChecking
          ? "warn"
          : "bad"
      : helperReady
        ? "ok"
        : helperChecking
          ? "warn"
          : "bad";
  const methodStatusIcon = methodMissing
    ? XCircle
    : browserSelected
      ? browserReady
        ? CheckCircle2
        : browserChecking
          ? RefreshCw
          : XCircle
      : helperReady
        ? CheckCircle2
        : helperChecking
          ? RefreshCw
          : XCircle;
  const blockedReason = fixtureMode
    ? methodMissing
      ? "Choose a local proof method before generating proofs."
      : browserSelected && !browserReady
        ? browserBlockedReason
        : ""
    : !draft
      ? "No active claim draft. Connect a safe wallet before generating proofs."
      : !safeWallet
        ? "Connect a safe wallet before generating proofs."
        : methodMissing
          ? "Choose a local proof method before generating proofs."
        : browserSelected && !browserReady
          ? browserBlockedReason
        : draft.buildSupported === false
          ? "This deployment is missing build artifacts, so proof generation is blocked."
          : "";
  return (
    <ClaimScreenFrame
      title="Create proofs"
      subtitle="Generate local proofs for the wallet keys in this batch."
      backLabel="Back"
      nextLabel={failed ? "Retry proofs" : "Generate proofs"}
      nextIcon={KeyRound}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={proofBlocked}
    >
      <SummaryTiles
        tiles={[
          {
            icon: Monitor,
            label: "Local proof method",
            value: methodValue,
            status: methodStatus,
            statusTone: methodStatusTone,
            statusIcon: methodStatusIcon,
            actionLabel: "Choose method",
            onAction: () => setProofMethodDialogOpen(true),
          },
          { icon: ShieldCheck, label: "Safe wallet", value: safeWalletLabel, status: safeWallet ? "Connected" : undefined },
          ...(proofsNeeded > 0
            ? [
                { icon: FileText, label: "Proofs needed", value: String(proofsNeeded) },
                { icon: KeyRound, label: "Generated", value: `${generated} of ${proofsNeeded}` },
              ]
            : []),
        ]}
      />
      <Notice tone={proofSetupBlocked || failed ? "bad" : "info"} icon={proofSetupBlocked || failed ? CircleAlert : Lock} title={!browserSelected && helperBad ? "Proof Helper is not connected" : failed ? "Proof generation stopped" : blockedReason ? "Proof generation blocked" : undefined}>
        {failed
          ? `${
              activeError ||
              (browserSelected
                ? "Browser proving reported an error. Your recovery phrase was not uploaded. Proof Helper Desktop is still available."
                : "The helper reported an error. Your recovery phrase was not uploaded.")
            } For your security your recovery phrase was cleared — re-enter it before retrying.`
          : activeError
            ? activeError
          : blockedReason
            ? blockedReason
          : !browserSelected && helperBad
            ? "Choose Proof Helper Desktop to install or open the desktop app before entering the recovery phrase."
            : browserSelected
              ? "Proofs will be generated in this browser. Expect about 2 minutes per proof on a fast machine; your recovery phrase stays on this device."
              : "Your recovery phrase stays on this device."}
      </Notice>
      {browserSelected && hasBrowserProvingDiagnostic() ? (
        <button
          className="claim-secondary-button"
          type="button"
          onClick={downloadLastBrowserProvingDiagnostic}
        >
          <Download size={18} aria-hidden="true" />
          Download performance diagnostic
        </button>
      ) : null}
      {onCheckHelper && !browserSelected && (helperBad || helperChecking) ? (
        <button
          className="claim-secondary-button"
          type="button"
          onClick={onCheckHelper}
          disabled={helperChecking}
        >
          <RefreshCw size={18} aria-hidden="true" className={helperChecking ? "spin" : undefined} />
          {helperChecking
            ? "Checking helper..."
            : helperPermissionPrompt
              ? "Allow desktop connection"
              : helperPermissionDenied
                ? "Check permission again"
                : "Check helper again"}
        </button>
      ) : null}
      {proofMethodDialogOpen ? (
        <LocalProofMethodDialog
          selectedMethod={proofMethod}
          browserProvingStatus={browserProvingStatus}
          browserProvingDetail={browserProvingDetail}
          onClose={() => setProofMethodDialogOpen(false)}
          onSelect={(method) => {
            setProofMethod(method);
            if (method === "browser" && !fixtureMode) {
              void onRecheckBrowserProving();
            }
          }}
          onContinue={(method) => {
            setProofMethod(method);
            setProofMethodDialogOpen(false);
            if (method === "desktop") {
              setInstallDialogOpen(true);
            }
          }}
        />
      ) : null}
      {installDialogOpen ? <ProofHelperInstallDialog onClose={() => setInstallDialogOpen(false)} /> : null}
      <div className="claim-content-with-aside">
        <Panel title="Impacted wallet recovery phrase" className="claim-phrase-panel">
          <div className="claim-panel-toolbar claim-phrase-settings">
            <span>Enter the recovery phrase (seed phrase) for the impacted wallet, not the safe wallet.</span>
            <div className="claim-phrase-actions">
              <div className="claim-phrase-length" aria-label="Recovery phrase length">
                <span>Recovery phrase</span>
                <div className="claim-segmented claim-phrase-segmented">
                  {recoveryPhraseWordCounts.map((wordCount) => (
                    <button
                      key={wordCount}
                      className={wordCount === recoveryPhraseWordCount ? "active" : undefined}
                      type="button"
                      aria-pressed={wordCount === recoveryPhraseWordCount}
                      onClick={() => {
                        setRecoveryPhraseWordCount(wordCount);
                        setPendingRecoveryPhraseWords(null);
                        setPasteStatus(null);
                      }}
                    >
                      {wordCount} words
                    </button>
                  ))}
                </div>
              </div>
              <label className="claim-toggle">
                Show words{" "}
                <input
                  type="checkbox"
                  aria-label="Show words"
                  checked={showRecoveryWords}
                  onChange={(event) => setShowRecoveryWords(event.target.checked)}
                />
              </label>
              <button className="claim-secondary-button" type="button" onClick={pasteRecoveryPhrase} disabled={pastePending}>
                <Copy size={18} aria-hidden="true" />
                {pastePending ? "Reading..." : "Paste phrase"}
              </button>
            </div>
          </div>
          {pasteStatus ? (
            <small className={`claim-status-line claim-phrase-status ${pasteStatus.tone}`} role={pasteStatus.tone === "bad" ? "alert" : "status"}>
              {pasteStatus.message}
            </small>
          ) : null}
          <div className="claim-phrase-grid">
            {Array.from({ length: recoveryPhraseWordCount }, (_, index) => (
              <input
                key={index}
                aria-label={`Recovery word ${index + 1}`}
                data-claim-recovery-word="true"
                placeholder={`${index + 1}  word ${index + 1}`}
                type={showRecoveryWords ? "text" : "password"}
                autoComplete="off"
                className={wordStatuses[index] === "invalid" ? "invalid" : undefined}
                aria-invalid={wordStatuses[index] === "invalid" || undefined}
                onPaste={pasteRecoveryPhraseFromField}
                onChange={recomputeWordStatuses}
                onBlur={recomputeWordStatuses}
              />
            ))}
          </div>
          {invalidWordNumbers.length > 0 ? (
            <small className="claim-status-line claim-phrase-status bad" role="status">
              Word{invalidWordNumbers.length === 1 ? "" : "s"} {invalidWordNumbers.join(", ")}{" "}
              {invalidWordNumbers.length === 1 ? "is" : "are"} not a recovery word — check the spelling against the
              standard recovery word list.
            </small>
          ) : null}
          {phraseChecksumFailed && invalidWordNumbers.length === 0 ? (
            <small className="claim-status-line claim-phrase-status bad" role="alert">
              These words are valid, but the phrase checksum doesn&apos;t match — double-check word order and spelling.
            </small>
          ) : null}
          <p className="claim-muted">These words are never saved. Leaving this step clears them.</p>
        </Panel>
        <Panel title="Proof plan">
          <ProofPlan draft={draft} safeWallet={safeWallet} />
        </Panel>
      </div>
    </ClaimScreenFrame>
  );
}

function CreateProofsGenerating({
  draft,
  safeWallet,
  proofMethod,
  proofProgress,
  onCancelProving,
  onNext,
  onBack,
}: {
  draft?: ClaimDraftResponse | null;
  safeWallet?: SafeWalletSummary | null;
  proofMethod: LocalProofMethod | null;
  proofProgress?: ProofProgressEvent | null;
  onCancelProving?: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const total = draft?.orderedInputs.length ?? (fixtureMode ? 18 : 0);
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Not connected";
  const queueRows = draft ? proofGenerationRows(draft) : fixtureMode ? claimFixtureData().proofQueue : [];
  const browserMode = proofMethod === "browser";
  const current = proofProgress?.current ?? 0;
  const completed = browserMode ? (current > 0 ? current - 1 : 0) : current;
  const stageLabel = proofProgress ? formatProofStage(proofProgress.stage) : "Starting";
  const stagePercent = proofProgress?.frac !== undefined ? Math.round(clampFraction(proofProgress.frac) * 100) : null;
  const discovery = proofProgress?.discovery;
  const engineLabel = browserMode ? "Proving in this browser" : "The helper is running locally.";
  // Overall ETA (C35): the browser path is estimated at ~2 minutes per proof.
  const remainingMinutes =
    browserMode && total > 0 && !discovery
      ? Math.max(1, Math.ceil((total - completed - (stagePercent ?? 0) / 100) * 2))
      : null;
  // Elapsed time remains useful for old published helpers that return one JSON
  // response and do not implement the opt-in progress stream.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (browserMode) {
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [browserMode]);
  const ringPercentKnown = stagePercent !== null;
  return (
    <ClaimScreenFrame
      title="Create proofs"
      subtitle={
        browserMode
          ? "Proof generation is running in this browser. Keep this tab open."
          : "Proof generation is running locally. Keep this tab and the Proof Helper open."
      }
      backLabel="Cancel"
      nextLabel="Generating proofs"
      nextIcon={RefreshCw}
      onBack={onCancelProving ?? onBack}
      onNext={onNext}
      nextDisabled
    >
      <SummaryTiles
        tiles={[
          {
            icon: Monitor,
            label: browserMode ? "Browser prover" : "Local helper",
            value: "Generating",
            status: "Running",
          },
          { icon: ShieldCheck, label: "Safe wallet", value: safeWalletLabel, status: safeWallet ? "Connected" : undefined },
          ...(total > 0
            ? [
                {
                  icon: KeyRound,
                  label: "Proofs",
                  value: `${completed} of ${total}`,
                  detail: browserMode ? "Running in browser" : "Running locally",
                },
              ]
            : []),
        ]}
      />
      <div className="claim-content-with-aside">
        <div className="claim-stack">
          <Panel title="Generating destination-bound proofs">
            <div className="claim-progress-card">
              <div
                className={`claim-progress-ring${ringPercentKnown ? "" : " indeterminate"}`}
                style={ringPercentKnown ? ({ "--claim-progress": `${stagePercent}%` } as React.CSSProperties) : undefined}
                role="img"
                aria-label={ringPercentKnown ? `Current proof ${stagePercent}% complete` : "Proof generation in progress"}
              >
                {ringPercentKnown ? <strong>{stagePercent}%</strong> : <RefreshCw className="spin" size={34} aria-hidden="true" />}
              </div>
              <div>
                <h3>Generating {total} destination-bound proof{total === 1 ? "" : "s"}</h3>
                <p>{engineLabel}</p>
                <p className="claim-muted" role="status" aria-live="polite">
                  {proofProgress
                    ? browserMode
                      ? current > 0
                        ? `Proof ${current} of ${total}`
                        : "Preparing proof assets"
                      : current > 0
                        ? `${current} of ${total} proofs complete`
                        : "Preparing local proof work"
                    : browserMode
                      ? "Preparing proof assets"
                      : `Running for ${formatElapsedTime(elapsedSeconds)}`} -{" "}
                  <span title={proofProgress?.stage}>{stageLabel}</span>
                  {stagePercent !== null ? ` (${stagePercent}%)` : ""}
                  {remainingMinutes !== null ? ` · ~${remainingMinutes} min remaining` : ""}
                </p>
                {discovery ? (
                  <p className="claim-muted">
                    Checked {Math.round(discovery.candidatesScanned).toLocaleString()} of{" "}
                    {Math.round(discovery.candidatesTotal).toLocaleString()} possible credentials
                    {discovery.candidatesPerSecond > 0
                      ? ` · ${Math.round(discovery.candidatesPerSecond).toLocaleString()}/sec`
                      : ""}
                    {discovery.etaSeconds > 0 ? ` · ${formatDiscoveryETA(discovery.etaSeconds)} remaining` : ""}
                  </p>
                ) : null}
                <p className="claim-muted">
                  {browserMode
                    ? "Keep this tab open - refreshing will restart proof generation."
                    : proofProgress
                      ? "Progress is streaming from Proof Helper on this device."
                      : "This Proof Helper version does not report detailed progress; the request is still running locally."}
                </p>
                {onCancelProving ? (
                  <button className="claim-secondary-button" type="button" onClick={onCancelProving}>
                    <X size={16} aria-hidden="true" /> Cancel proof generation
                  </button>
                ) : null}
                <div className="claim-chip-row">
                  <span>Local only</span>
                  <span>Destination bound</span>
                  <span>No server upload</span>
                </div>
              </div>
            </div>
          </Panel>
          <Panel title="Proof queue">
            {queueRows.length > 0 ? (
              <>
                <ProofQueue rows={queueRows} totalCount={total} />
                <p className="claim-table-note">
                  {total} total claim{total === 1 ? "" : "s"} - {browserMode ? "proving in this browser" : "helper request in progress"}
                </p>
              </>
            ) : (
              <TableEmpty icon={FileText} title="No active claim draft" body="Create a real claim draft before proof generation." />
            )}
          </Panel>
        </div>
        <InfoPanel
          title="During proof generation"
          items={[
            browserMode
              ? { icon: PlaySquare, title: "Keep this tab open", body: "Browser proving runs here; closing or refreshing the tab restarts it." }
              : { icon: PlaySquare, title: "Keep the helper running", body: "The helper must stay open until all proofs are generated." },
            { icon: RefreshCw, title: "Do not refresh this page", body: "Refreshing may interrupt the proof generation process." },
            { icon: ShieldCheck, title: "Recovery phrase stays local", body: "Your recovery phrase never leaves your device and is never shared." },
            browserMode
              ? { icon: PauseCircle, title: "You can cancel if needed", body: "Cancel to stop proving and return to the previous step." }
              : { icon: PauseCircle, title: "You can cancel if needed", body: "Cancel closes the local request and stops key discovery or proving cooperatively." },
            { icon: Shield, title: "Proofs are destination-bound", body: "They can only be used to reclaim funds to your connected safe wallet." },
          ]}
        />
      </div>
    </ClaimScreenFrame>
  );
}

// C25: map internal prover stage ids to user language. Callers keep the raw
// stage string available in a title attribute for support conversations.
function formatProofStage(stage: string): string {
  const labels: Record<string, string> = {
    parse: "Preparing proving data",
    "decode-inputs": "Preparing proving data",
    "open-keys": "Preparing proving data",
    "open-ccs": "Preparing proving data",
    "find-path": "Locating your keys",
    "locating-keys": "Locating your keys",
    probe: "Locating your keys",
    prove: "Generating proof",
    verify: "Double-checking proof",
    done: "Done",
  };
  if (labels[stage]) {
    return labels[stage];
  }
  if (stage.startsWith("prove")) {
    return "Generating proof";
  }
  return "Working";
}

function formatDiscoveryETA(seconds: number): string {
  const rounded = Math.max(1, Math.round(seconds));
  if (rounded < 60) {
    return `about ${rounded} sec`;
  }
  return `about ${Math.ceil(rounded / 60)} min`;
}

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function CreateProofsComplete({
  draft,
  safeWallet,
  proofArtifacts,
  onNext,
  onBack,
}: {
  draft?: ClaimDraftResponse | null;
  safeWallet?: SafeWalletSummary | null;
  proofArtifacts?: Record<string, unknown>[];
  onNext: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const total = draft?.orderedInputs.length ?? proofArtifacts?.length ?? (fixtureMode ? 18 : 0);
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Not connected";
  const batchSummary = draft ? draftBatchSummary(draft) : null;
  const transactionCount = batchSummary ? Math.ceil(batchSummary.utxoCount / Math.max(draft?.batchCap.default ?? draft?.batchCap.requested ?? 1, 1)) : 0;
  const fixtureFirstBatchValue = fixtureMode ? "3.42 ADA, 6 tokens" : "";
  const totalBatches = transactionCount || (fixtureMode ? 5 : 0);
  return (
    <ClaimScreenFrame
      title="Proofs ready"
      subtitle="All destination-bound proofs have been created locally for your available claims."
      backLabel="Back"
      nextLabel="Continue to current batch"
      nextIcon={ArrowRight}
      onBack={onBack}
      onNext={onNext}
    >
      <SummaryTiles
        tiles={[
          { icon: Monitor, label: "Local helper", value: "Complete", detail: "Your proofs were created locally on this device." },
          { icon: ShieldCheck, label: "Safe wallet", value: safeWalletLabel, detail: safeWallet ? "Destination for all recovered funds." : undefined },
          ...(total > 0
            ? [{ icon: KeyRound, label: "Proofs generated", value: `${proofArtifacts?.length ?? total} of ${total}`, detail: "All proofs are ready." }]
            : []),
          {
            icon: ArrowRight,
            label: "Next step",
            value: totalBatches > 0 ? `Batch 1 of ${totalBatches}` : "Next claim batch",
            detail: "Review and submit your first transaction.",
          },
        ]}
      />
      <Notice icon={Check} title="Ready to claim">
        Your proofs are bound to the safe wallet address. They can only be used to send recovered funds there.
      </Notice>
      {hasBrowserProvingDiagnostic() ? (
        <button
          className="claim-secondary-button"
          type="button"
          onClick={downloadLastBrowserProvingDiagnostic}
        >
          <Download size={18} aria-hidden="true" />
          Download performance diagnostic
        </button>
      ) : null}
      <div className="claim-content-with-aside">
        <Panel title="Claim plan">
          {batchSummary || fixtureMode ? (
            <>
              <div className="claim-summary-strip">
                <MetricText label="Total claims" value={`${batchSummary?.utxoCount ?? 18} UTxO${(batchSummary?.utxoCount ?? 18) === 1 ? "" : "s"}`} />
                <MetricText label="Batch size" value={`${draft?.batchCap.default ?? draft?.batchCap.requested ?? 4} UTxO${(draft?.batchCap.default ?? draft?.batchCap.requested ?? 4) === 1 ? "" : "s"}`} />
                <MetricText label="Transactions needed" value={String(transactionCount || (fixtureMode ? 5 : 0))} />
                <MetricText
                  label="Current batch"
                  value={`${batchSummary?.utxoCount ?? 4} UTxO${(batchSummary?.utxoCount ?? 4) === 1 ? "" : "s"}`}
                  detail={batchSummary ? formatValueSummary(batchSummary) : fixtureFirstBatchValue}
                />
              </div>
              <BatchProofTable draft={draft} safeWallet={safeWallet} />
            </>
          ) : (
            <TableEmpty icon={FileText} title="No active claim draft" body="Create a real claim draft before reviewing generated proofs." />
          )}
        </Panel>
        <InfoPanel
          title="Before you claim"
          compact
          items={[
            { icon: Check, title: "Safe wallet connected", body: "Your safe wallet is connected and set as the destination." },
            { icon: Check, title: "Enough ADA for fees", body: "Ensure your safe wallet has enough ADA to cover transaction fees." },
            { icon: Check, title: "Impacted wallet will not sign", body: "Claim transactions are signed by your safe wallet." },
            { icon: Check, title: "Review each batch before submitting", body: "You'll review all details for each batch before submitting on-chain." },
          ]}
        />
      </div>
    </ClaimScreenFrame>
  );
}

function CurrentBatch({
  overview,
  rejected,
  draft,
  build,
  buildError,
  submitError,
  submitFailureKind,
  onCheckStatus,
  onRescanClaims,
  proofArtifacts,
  safeWallet,
  safeWalletSigningAvailable,
  safeWalletSigningSessionState,
  submitPhase,
  onNext,
  onBack,
}: {
  overview?: boolean;
  rejected?: boolean;
  draft?: ClaimDraftResponse | null;
  build?: ClaimBuildResponse | null;
  buildError?: string;
  submitError?: string;
  submitFailureKind?: ClaimSubmitFailureKind | null;
  onCheckStatus?: () => void;
  onRescanClaims?: () => void;
  proofArtifacts?: Record<string, unknown>[];
  safeWallet?: SafeWalletSummary | null;
  safeWalletSigningAvailable?: boolean;
  safeWalletSigningSessionState?: SafeWalletSigningSessionState;
  submitPhase?: ClaimSubmitPhase;
  onNext: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const fixtureRows = fixtureMode ? claimFixtureData().batchRows : [];
  const rows = draft?.orderedInputs ?? fixtureRows;
  const summary = draft ? draftBatchSummary(draft) : summarizeClaimRows(fixtureRows);
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Not connected";
  const needsSignerReconnect = Boolean(build && !fixtureMode && !safeWalletSigningAvailable);
  const busy = isSubmitBusy(submitPhase);
  const nextLabel = submitButtonLabel({
    rejected,
    buildReady: Boolean(build),
    needsSignerReconnect,
    submitPhase,
    submitFailureKind,
  });
  const postSignFailure = Boolean(rejected && submitFailureKind === "post-sign-submit");
  const proofCount = proofArtifacts?.length || (fixtureMode && !draft ? rows.length : 0);
  const hasRealDraft = Boolean(draft);
  // Two-phase CTA made explicit (C18): the subtitle explains the stages and a
  // step indicator near the action bar says which stage the button performs.
  const nextHint = rejected || busy ? undefined : build ? "Step 2 of 2 — your safe wallet will ask you to approve" : "Step 1 of 2 — nothing is signed yet";
  return (
    <ClaimScreenFrame
      title="Claim funds"
      subtitle="Claiming happens in two stages: first build the transaction and review it, then sign and submit it with your safe wallet."
      backLabel="Go back"
      nextLabel={nextLabel}
      nextHint={nextHint}
      nextIcon={busy ? RefreshCw : Wallet}
      nextIconSpinning={busy}
      onBack={onBack}
      onNext={onNext}
      backDisabled={busy}
      nextDisabled={!fixtureMode && (!draft || proofCount < rows.length || busy)}
    >
      {!draft && !fixtureMode ? (
        <Notice tone="bad" icon={CircleAlert} title="No active claim draft">
          Create a real claim draft before reviewing or submitting a batch.
        </Notice>
      ) : null}
      {needsSignerReconnect ? (
        <Notice tone="info" icon={Wallet} title="Reconnect safe wallet to sign">
          This resumed tab has the destination summary but not the live CIP-30 signing API. No transaction has been signed or submitted yet.
          Reconnect the same safe wallet to submit this batch.
        </Notice>
      ) : null}
      {busy ? (
        <Notice tone="info" icon={RefreshCw} iconSpinning announce title={submitPhaseTitle(submitPhase)}>
          {submitPhaseBody(submitPhase)}
        </Notice>
      ) : null}
      {rejected ? (
        postSignFailure ? (
          <>
            <Notice tone="bad" icon={CircleAlert} title="Submission failed after signing">
              {submitError ||
                "Submission failed after signing — the transaction may or may not have reached the chain. Checking current status..."}
            </Notice>
            {onCheckStatus ? (
              <button className="claim-secondary-button" type="button" onClick={onCheckStatus}>
                <RefreshCw size={18} aria-hidden="true" />
                Check on-chain status
              </button>
            ) : null}
          </>
        ) : (
          <Notice tone="bad" icon={CircleAlert} title="Safe-wallet signature rejected">
            {submitError || "Signature declined in wallet. The transaction was not submitted. Review the batch and ask the safe wallet to sign again."}
          </Notice>
        )
      ) : null}
      {buildError ? (
        <Notice tone="bad" icon={CircleAlert} title="Claim build stopped">
          {buildError}
        </Notice>
      ) : null}
      {submitError && !rejected ? (
        <Notice tone="bad" icon={CircleAlert} title="Claim submit stopped">
          {submitError}
        </Notice>
      ) : null}
      <SummaryTiles
        tiles={[
          { icon: Wallet, label: "Claim draft", value: hasRealDraft ? abbreviateMiddle(draft?.draftId ?? "", 18) : fixtureMode ? "Fixture" : "Missing", status: hasRealDraft || fixtureMode ? "Ready" : "Blocked" },
          ...(rows.length > 0
            ? [
                {
                  icon: Coins,
                  label: overview ? "Matching funds" : "Available claims",
                  value: `${formatLovelace(summary.lovelace)} ADA`,
                  detail: `${summary.assetCount} token${summary.assetCount === 1 ? "" : "s"} - ${rows.length} UTxO${rows.length === 1 ? "" : "s"}`,
                  status: hasRealDraft || fixtureMode ? "Found" : "Blocked",
                },
                {
                  icon: KeyRound,
                  label: overview ? "Proof Helper" : "Create proofs",
                  value: overview ? "Helper service" : proofCount >= rows.length ? "Proofs ready" : "Proofs pending",
                  detail: overview ? "Connected" : `${proofCount} of ${rows.length}`,
                  status: proofCount >= rows.length || overview ? "Complete" : undefined,
                },
              ]
            : []),
          {
            icon: ShieldCheck,
            label: "Safe wallet",
            value: safeWalletLabel,
            status: safeWallet ? safeWalletSigningStatusLabel(safeWalletSigningSessionState, safeWalletSigningAvailable) : undefined,
            statusTone: safeWalletSigningAvailable ? "ok" : needsSignerReconnect ? "warn" : undefined,
          },
          ...(rows.length > 0
            ? [
                {
                  icon: RefreshCw,
                  label: "Next claim batch",
                  value: `${rows.length} UTxO${rows.length === 1 ? "" : "s"} ready`,
                  detail: `${formatLovelace(summary.lovelace)} ADA - ${summary.assetCount} token${summary.assetCount === 1 ? "" : "s"}`,
                  emphasis: true,
                },
              ]
            : []),
        ]}
      />
      <Panel>
        <div className="claim-summary-strip">
          <MetricText label="Recovery summary" value="" />
          <MetricText label="Total ADA" value={`${formatLovelace(summary.lovelace)} ADA`} />
          <MetricText label="Total tokens" value={String(summary.assetCount)} />
          <MetricText label="Matching UTxOs" value={String(rows.length)} />
          <MetricText label="Pending (not claimed)" value={`${formatLovelace(summary.lovelace)} ADA`} detail={`${summary.assetCount} tokens`} />
          <MetricText label="Ready to claim" value={`${formatLovelace(summary.lovelace)} ADA`} detail={`${summary.assetCount} tokens`} />
        </div>
      </Panel>
      <Panel title="Next claim batch" className="claim-table-panel">
        <div className="claim-panel-toolbar">
          <span className="claim-soft-badge">{rows.length} UTxOs ready</span>
          {onRescanClaims ? (
            <button className="claim-table-action" type="button" onClick={onRescanClaims}>
              Need to rescan? Go back to Available claims.
            </button>
          ) : null}
        </div>
        <BatchTable draft={draft} />
      </Panel>
      {build ? (
        <Panel title="Claim review" className="claim-table-panel">
          <ReviewRow label="Transaction hash" value={build.txHash} />
          <ReviewRow label="Review hash" value={build.reviewHash} />
          <ReviewRow label="Destination start index" value={String(build.review.destinationOutputStartIndex)} noCopy />
          <ReviewRow label="Params reference input" value={build.review.paramsReferenceInput.outRefId} />
          <ReviewRow label="Reference scripts" value={String(build.review.referenceScriptInputs.length)} noCopy />
          <ReviewRow label="Proof digests" value={String(build.review.proofDigests.length)} noCopy />
          <ReviewRow
            label="Evaluation"
            value={`${build.evaluation.memoryPercent ?? "n/a"}% mem / ${build.evaluation.cpuPercent ?? "n/a"}% CPU`}
            noCopy
          />
        </Panel>
      ) : null}
      <Panel className="claim-review-strip">
        <Assurance icon={ShieldCheck} title="Funds will go to your safe wallet" body="Your recovered funds will be sent to your safe wallet." />
        <Assurance icon={Coins} title="Fees paid by safe wallet" body="Transaction fees for claiming are paid from your safe wallet." />
        <Assurance icon={KeyRound} title="No signature needed from impacted wallet" body="Claims are authorized by ReclaimGlobal." />
        <div className="claim-review-mini">
          <strong>Review</strong>
          <ReviewRow
            label="Safe wallet (destination)"
            value={safeWallet ? safeWallet.changeAddress : "Not connected"}
            breakValue={Boolean(safeWallet)}
            noCopy={!safeWallet}
            detail={safeWallet ? "Confirm this matches the receive address shown in your safe wallet before signing." : undefined}
          />
          {/* C16: the build response does not include a fee amount, so the row
              states honestly where the fee will be shown instead of implying a
              number exists somewhere in the review. */}
          <ReviewRow
            label="Estimated fee (paid by safe wallet)"
            value="Shown in your wallet before you approve signing"
            detail="Paid from your safe wallet, not from recovered funds."
            noCopy
          />
          <details>
            <summary>Technical details</summary>
            <p>DestinationAddressV1 and proof order are recomputed by the backend before signing.</p>
          </details>
        </div>
      </Panel>
    </ClaimScreenFrame>
  );
}

function ClaimReview({
  pending,
  submittedClaims,
  progress,
  safeWallet,
  submitError,
  remainingClaims = 0,
  onStartNextBatch,
  explorerNetwork,
  onNext,
  onBack,
}: {
  pending?: boolean;
  submittedClaims?: SubmittedClaimTx[];
  progress?: ClaimProgressResponse | null;
  safeWallet?: SafeWalletSummary | null;
  submitError?: string;
  remainingClaims?: number;
  onStartNextBatch?: () => void;
  explorerNetwork?: ReclaimNetwork;
  onNext: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const fixtureTransactions = fixtureMode ? claimFixtureData().transactions : [];
  const [summaryCopyState, setSummaryCopyState] = useState<"idle" | "copied">("idle");
  const rows: TransactionRow[] =
    submittedClaims && submittedClaims.length > 0
      ? submittedClaims.map((tx, index) => ({
          batch: index + 1,
          txHash: tx.txHash,
          displayHash: abbreviateMiddle(tx.txHash, 14),
          value: tx.valueSummary ? formatValueSummary(tx.valueSummary) : `${tx.selectedOutrefs.length} UTxO${tx.selectedOutrefs.length === 1 ? "" : "s"}`,
          ada: tx.valueSummary ? formatLovelace(tx.valueSummary.lovelace) : undefined,
          tokens: tx.valueSummary ? String(tx.valueSummary.assetCount) : undefined,
          status: pending ? ("Pending" as const) : ("Confirmed" as const),
        }))
      : fixtureMode
        ? pending
          ? fixtureTransactions.map((tx, index) => (index === fixtureTransactions.length - 1 ? { ...tx, status: "Pending" as const } : tx))
          : fixtureTransactions
        : [];
  const downloadReceiptCsv = () => {
    if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return;
    }
    const header = ["batch", "tx_hash", "explorer_url", "recovered_ada", "tokens", "status"];
    const lines = [
      header.join(","),
      ...rows.map((row) =>
        [String(row.batch), row.txHash, cexplorerTxUrl(row.txHash, explorerNetwork), row.ada ?? "", row.tokens ?? "", row.status]
          .map(csvField)
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "claim-recovery-receipt.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };
  const copyReceiptSummary = async () => {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }
    const summaryForCopy = summarizeSubmittedClaims(submittedClaims ?? []);
    const text = [
      "Claim recovery summary",
      safeWallet ? `Funds sent to safe wallet: ${safeWallet.changeAddress}` : null,
      ...rows.map((row) => `Batch ${row.batch}: ${row.value} - ${row.status} - ${cexplorerTxUrl(row.txHash, explorerNetwork)}`),
      summaryForCopy ? `Total recovered: ${formatValueSummary(summaryForCopy)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setSummaryCopyState("copied");
  };
  const recoveredSummary = summarizeSubmittedClaims(submittedClaims ?? []);
  const claimedCount = progress?.outrefs.filter((entry) => entry.state === "spent_or_unknown" || entry.state === "confirmed_spent").length;
  const totalCount = progress?.outrefs.length || submittedClaims?.reduce((total, tx) => total + tx.selectedOutrefs.length, 0) || (fixtureMode ? 18 : 0);
  const remainingCount = remainingClaims > 0 ? remainingClaims : progress?.nextBatch.count ?? (fixtureMode && pending ? 2 : 0);
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Not connected";
  const recoveredTile = recoveredSummary
    ? { value: `${formatLovelace(recoveredSummary.lovelace)} ADA`, detail: `${recoveredSummary.assetCount} token${recoveredSummary.assetCount === 1 ? "" : "s"}` }
    : fixtureMode
      ? { value: pending ? "13.42 ADA" : "15.87 ADA", detail: pending ? "21 tokens confirmed" : "23 tokens" }
      : null;
  return (
    <ClaimScreenFrame
      title="Claim review"
      subtitle={pending ? "Your latest claim transaction is submitted and waiting for confirmation." : "Review the funds recovered to your safe wallet and the on-chain transactions that claimed them."}
      backLabel={pending ? undefined : "Start another recovery"}
      nextLabel={pending ? "Refresh status" : "Done"}
      nextIcon={pending ? RefreshCw : CheckCircle2}
      onBack={onBack}
      onNext={onNext}
    >
      {submitError ? (
        <Notice tone="bad" icon={CircleAlert} title="Status refresh failed">
          {submitError}
        </Notice>
      ) : null}
      <Notice icon={pending ? RefreshCw : Check} title={pending ? "Claim submitted" : "Recovery complete"}>
        {pending
          ? "The selected batch is pending. Confirmed spends will be removed from remaining funds. Checks automatically every 20 seconds."
          : "All available claims for the impacted wallet have been submitted."}
      </Notice>
      {pending && remainingClaims > 0 && onStartNextBatch ? (
        <div className="claim-notice info" role="status">
          <span className="claim-icon-circle">
            <KeyRound size={28} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {remainingClaims} claim{remainingClaims === 1 ? "" : "s"} still waiting
            </strong>
            <p>You&apos;ll create new proofs for the next batch — your recovery phrase will be needed again.</p>
            <div className="claim-modal-actions">
              <button className="claim-primary-button" type="button" onClick={onStartNextBatch}>
                Start next batch ({remainingClaims} claim{remainingClaims === 1 ? "" : "s"} remaining)
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <SummaryTiles
        tiles={[
          ...(recoveredTile ? [{ icon: Coins, label: "Recovered", value: recoveredTile.value, detail: recoveredTile.detail }] : []),
          ...(totalCount > 0
            ? [{ icon: Coins, label: "Claimed UTxOs", value: `${claimedCount ?? (fixtureMode && pending ? 16 : totalCount)} of ${totalCount}` }]
            : []),
          { icon: FileText, label: "Claim transactions", value: String(rows.length) },
          { icon: CheckCircle2, label: "Remaining claims", value: String(remainingCount) },
          {
            icon: ShieldCheck,
            label: "Funds sent to safe wallet",
            value: safeWalletLabel,
            status: safeWallet ? "Destination verified" : undefined,
          },
        ]}
      />
      <div className="claim-content-with-aside">
        <Panel title="Claim transactions" className="claim-table-panel">
          {rows.length > 0 ? (
            <TransactionTable
              rows={rows}
              explorerNetwork={explorerNetwork}
              totalRecovered={recoveredSummary ? formatValueSummary(recoveredSummary) : fixtureMode ? "15.87 ADA + 23 tokens" : undefined}
            />
          ) : (
            <TableEmpty icon={FileText} title="No submitted claim transactions" body="Submit a real claim batch before a receipt is available." />
          )}
        </Panel>
        <Panel title="Receipt" className="claim-receipt-panel">
          <FileText size={56} aria-hidden="true" />
          <p>Download or share a summary of your recovery and transactions.</p>
          <button className="claim-secondary-button wide" type="button" onClick={downloadReceiptCsv} disabled={rows.length === 0}>
            <Download size={18} aria-hidden="true" />
            Download CSV
          </button>
          <button className="claim-secondary-button wide" type="button" onClick={() => void copyReceiptSummary()} disabled={rows.length === 0}>
            {summaryCopyState === "copied" ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
            {summaryCopyState === "copied" ? "Copied" : "Copy summary"}
          </button>
        </Panel>
      </div>
    </ClaimScreenFrame>
  );
}

function ClaimScreenFrame({
  title,
  subtitle,
  children,
  backLabel,
  nextLabel,
  nextHint,
  nextIcon: NextIcon = ArrowRight,
  nextIconSpinning,
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  backLabel?: string;
  nextLabel: string;
  nextHint?: string;
  nextIcon?: LucideIcon;
  nextIconSpinning?: boolean;
  onBack: () => void;
  onNext: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
}) {
  return (
    <>
      <header className="claim-page-heading">
        <h1 tabIndex={-1}>{title}</h1>
        <p>{subtitle}</p>
      </header>
      <div className="claim-page-body">{children}</div>
      <footer className="claim-action-bar">
        {backLabel ? (
          <button className="claim-secondary-button" type="button" onClick={onBack} disabled={backDisabled}>
            <ArrowLeft size={21} aria-hidden="true" />
            {backLabel}
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          {nextHint ? <small className="claim-muted">{nextHint}</small> : null}
          <button className="claim-primary-button" type="button" onClick={onNext} disabled={nextDisabled}>
            <NextIcon className={nextIconSpinning ? "spin" : undefined} size={24} aria-hidden="true" />
            {nextLabel}
          </button>
        </div>
      </footer>
    </>
  );
}

function SummaryTiles({ tiles }: { tiles: SummaryTile[] }) {
  return (
    <div className={`claim-summary-tiles count-${tiles.length}`}>
      {tiles.map((tile) => (
        <SummaryTileView key={`${tile.label}-${tile.value}`} tile={tile} />
      ))}
    </div>
  );
}

function isSubmitBusy(phase?: ClaimSubmitPhase): boolean {
  return (
    phase === "building-transaction" ||
    phase === "reconnecting" ||
    phase === "signing-in-wallet" ||
    phase === "submitting" ||
    phase === "submitted-refreshing"
  );
}

function submitButtonLabel({
  rejected,
  buildReady,
  needsSignerReconnect,
  submitPhase,
  submitFailureKind,
}: {
  rejected?: boolean;
  buildReady: boolean;
  needsSignerReconnect: boolean;
  submitPhase?: ClaimSubmitPhase;
  submitFailureKind?: ClaimSubmitFailureKind | null;
}): string {
  switch (submitPhase) {
    case "building-transaction":
      return "Building transaction";
    case "reconnecting":
      return "Reconnecting safe wallet";
    case "signing-in-wallet":
      return "Signing in wallet";
    case "submitting":
      return "Submitting claim";
    case "submitted-refreshing":
      return "Refreshing status";
    default:
      if (rejected) {
        return submitFailureKind === "post-sign-submit" ? "Re-sign claim (may double-submit)" : "Retry signature";
      }
      if (!buildReady) {
        return "Build transaction for review";
      }
      return needsSignerReconnect ? "Reconnect and submit claim" : "Sign and submit claim";
  }
}

function submitPhaseTitle(phase?: ClaimSubmitPhase): string {
  switch (phase) {
    case "building-transaction":
      return "Building transaction";
    case "reconnecting":
      return "Reconnecting safe wallet";
    case "signing-in-wallet":
      return "Signing in wallet";
    case "submitting":
      return "Submitting claim";
    case "submitted-refreshing":
      return "Claim submitted";
    default:
      return "Claim submit in progress";
  }
}

function submitPhaseBody(phase?: ClaimSubmitPhase): string {
  switch (phase) {
    case "building-transaction":
      return "Refreshing current chain data, constructing the reclaim transaction, and measuring its execution budget.";
    case "reconnecting":
      return "Checking that the same safe wallet is live before any signing request is made.";
    case "signing-in-wallet":
      return "Confirm the transaction in your safe wallet. The claim has not been submitted yet.";
    case "submitting":
      return "The safe-wallet witness was accepted locally and the claim is being submitted to the backend.";
    case "submitted-refreshing":
      return "The backend returned a transaction hash. Refreshing claim progress now.";
    default:
      return "The current claim action is still running.";
  }
}

function safeWalletSigningStatusLabel(
  state?: SafeWalletSigningSessionState,
  signingAvailable?: boolean,
): string {
  if (signingAvailable || state === "ready") {
    return "Signing ready";
  }
  if (state === "resume-reconnect-required") {
    return "Reconnect required";
  }
  if (state === "destination-blocked") {
    return "Destination blocked";
  }
  return "Destination selected";
}

function SummaryTileView({ tile }: { tile: SummaryTile }) {
  const Icon = tile.icon;
  const StatusIcon = tile.statusIcon ?? CheckCircle2;
  return (
    <section className={`claim-summary-tile ${tile.emphasis ? "emphasis" : ""}`}>
      <Icon size={31} aria-hidden="true" />
      <div>
        <span>{tile.label}</span>
        <strong>{tile.value}</strong>
        {tile.detail ? <small>{tile.detail}</small> : null}
        {tile.status ? (
          <small className={`claim-status-line ${tile.statusTone ?? "ok"}`}>
            <StatusIcon size={15} aria-hidden="true" />
            {tile.status}
          </small>
        ) : null}
        {tile.actionLabel && tile.onAction ? (
          <button className="claim-tile-action" type="button" onClick={tile.onAction}>
            {tile.actionLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}

// Shared dialog focus management (C36): moves initial focus into the dialog,
// traps Tab/Shift+Tab, closes on Escape, and restores focus to the opener
// when the dialog unmounts.
function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      opener?.focus();
    };
  }, []);
  return dialogRef;
}

function LocalProofMethodDialog({
  selectedMethod,
  browserProvingStatus,
  browserProvingDetail,
  onClose,
  onSelect,
  onContinue,
}: {
  selectedMethod: LocalProofMethod | null;
  browserProvingStatus: BrowserProvingStatus;
  browserProvingDetail: string;
  onClose: () => void;
  onSelect: (method: LocalProofMethod) => void;
  onContinue: (method: LocalProofMethod) => void;
}) {
  const activeMethod = selectedMethod ?? "browser";
  const browserSelected = activeMethod === "browser";
  const browserReady = browserProvingStatus === "ready";
  const browserChecking = browserProvingStatus === "checking";
  const browserContinueBlocked = browserSelected && !browserReady;
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);

  return (
    <div className="claim-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="claim-proof-method-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proof-method-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="claim-proof-method-header">
          <div>
            <h2 id="proof-method-dialog-title">Choose how to create proofs</h2>
            <p>Proofs are created locally on this device before you claim funds.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close proof method chooser">
            <X size={20} />
          </button>
        </header>

        <div className="claim-proof-method-options" role="radiogroup" aria-label="Local proof method">
          <button
            className={`claim-proof-method-option ${activeMethod === "desktop" ? "selected" : ""}`}
            type="button"
            role="radio"
            aria-checked={activeMethod === "desktop"}
            onClick={() => onSelect("desktop")}
          >
            <span className="claim-proof-method-radio" aria-hidden="true" />
            <span className="claim-proof-method-icon">
              <Monitor size={28} aria-hidden="true" />
            </span>
            <span className="claim-proof-method-copy">
              <span className="claim-proof-method-title">
                Proof Helper Desktop
                <span className="claim-pill">Recommended for speed</span>
              </span>
              <span>Install or open the desktop app. Best for large batches and older browsers.</span>
              <small>
                <Download size={15} aria-hidden="true" />
                Opens the installer chooser for Windows, macOS, or Linux if needed.
              </small>
            </span>
            <span className="claim-proof-method-state">Install available</span>
          </button>

          <button
            className={`claim-proof-method-option ${browserSelected ? "selected" : ""}`}
            type="button"
            role="radio"
            aria-checked={browserSelected}
            onClick={() => onSelect("browser")}
          >
            <span className="claim-proof-method-radio" aria-hidden="true" />
            <span className="claim-proof-method-icon">
              <Globe2 size={28} aria-hidden="true" />
            </span>
            <span className="claim-proof-method-copy">
              <span className="claim-proof-method-title">
                Prove in this browser
                <span className="claim-pill">No download</span>
              </span>
              <span>No app install required. About 2 minutes per proof on a fast machine; needs a supported browser.</span>
              <small>
                <Clock3 size={15} aria-hidden="true" />
                Keep this tab open while proofs are generated.
              </small>
            </span>
            <span className="claim-proof-method-state">
              {browserReady ? "Ready" : browserChecking ? "Checking" : "Unavailable"}
            </span>
          </button>
        </div>

        {browserSelected ? (
          <section className="claim-browser-readiness" aria-label="Browser proving readiness">
            <div>
              <strong>
                {browserReady
                  ? "This browser can generate proofs"
                  : browserChecking
                    ? "Checking browser support..."
                    : "This browser cannot generate proofs yet"}
              </strong>
              <small role={browserContinueBlocked && !browserChecking ? "alert" : "status"}>
                {browserReady
                  ? "Cross-origin isolation, memory, and pinned proof assets all verified."
                  : browserChecking
                    ? "Verifying WebAssembly, workers, isolation, and proof assets."
                    : browserProvingDetail || "Browser proving is not enabled for this build yet."}
              </small>
            </div>
            <span>
              {browserReady ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />} Cross-origin isolated
            </span>
            <span><Clock3 size={15} aria-hidden="true" /> ~2 min per proof</span>
            <span><Check size={15} aria-hidden="true" /> Keep this tab open</span>
          </section>
        ) : null}

        <footer className="claim-proof-method-footer">
          <p>
            <Lock size={17} aria-hidden="true" />
            Your recovery phrase stays local and is read only after you choose a method.
          </p>
          <div className="claim-modal-actions">
            <button className="claim-secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="claim-primary-button"
              type="button"
              onClick={() => onContinue(activeMethod)}
              disabled={browserContinueBlocked}
            >
              {activeMethod === "desktop" ? "Continue to desktop app" : browserChecking ? "Checking support..." : "Continue"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ProofHelperInstallDialog({ onClose }: { onClose: () => void }) {
  const startCommand = windowsProofHelperStartCommand();
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const copyStartCommand = async () => {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }
    await navigator.clipboard.writeText(startCommand);
    setCopyState("copied");
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
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
          {proofHelperDownloadChoices.map((choice) => (
            <a className="platform-choice" key={choice.platform} href={choice.href} target="_blank" rel="noreferrer" onClick={onClose}>
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
        <div className="helper-start-command">
          <div>
            <strong>Verify the Linux AppImage</strong>
            <p>Compare the download against the published SHA-256 before running it.</p>
          </div>
          <code>{linuxAppImageSha256}</code>
          <code>{`sha256sum -c ${linuxAppImageFilename}.sha256`}</code>
          <a className="claim-external-link" href={linuxAppImageChecksumDownload} target="_blank" rel="noreferrer">
            Download checksum
            <ExternalLink size={16} aria-hidden="true" />
          </a>
          <a className="claim-external-link" href={linuxVerificationInstructions} target="_blank" rel="noreferrer">
            Verification and launch instructions
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        </div>
        <div className="helper-start-command">
          <div>
            <strong>Windows zip start command</strong>
            <p>After extracting the zip, open Command Prompt in that folder and run this command so Proof Helper pairs back to this claim page.</p>
          </div>
          <code>{startCommand}</code>
          <button className="claim-secondary-button" type="button" onClick={copyStartCommand}>
            {copyState === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copyState === "copied" ? "Copied" : "Copy command"}
          </button>
        </div>
      </div>
    </div>
  );
}

function currentClaimPageUrl(): string {
  if (typeof window === "undefined") {
    return "/claim";
  }
  const url = new URL(window.location.href);
  url.hash = "";
  return url.toString();
}

function windowsProofHelperStartCommand(): string {
  return `".\\Start Proof Helper.bat" "${currentClaimPageUrl()}"`;
}

function Panel({
  title,
  icon: Icon,
  children,
  className,
}: {
  title?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`claim-panel ${className ?? ""}`}>
      {title ? (
        <header className="claim-panel-header">
          {Icon ? (
            <span className="claim-icon-circle">
              <Icon size={24} aria-hidden="true" />
            </span>
          ) : null}
          <h2>{title}</h2>
        </header>
      ) : null}
      <div className="claim-panel-body">{children}</div>
    </section>
  );
}

function Notice({
  icon: Icon,
  iconSpinning = false,
  announce = false,
  title,
  children,
  tone = "info",
}: {
  icon: LucideIcon;
  iconSpinning?: boolean;
  announce?: boolean;
  title?: string;
  children: React.ReactNode;
  tone?: "info" | "bad" | "ok" | "warn";
}) {
  // A11y (C37): errors are announced assertively, warnings politely.
  const role = tone === "bad" ? "alert" : tone === "warn" || announce ? "status" : undefined;
  return (
    <div className={`claim-notice ${tone}`} role={role}>
      <span className="claim-icon-circle">
        <Icon className={iconSpinning ? "spin" : undefined} size={28} aria-hidden="true" />
      </span>
      <div>
        {title ? <strong>{title}</strong> : null}
        <p>{children}</p>
      </div>
    </div>
  );
}

function InfoPanel({
  title,
  items,
  footer,
  compact,
}: {
  title: string;
  items: Array<{ icon: LucideIcon; title: string; body: string }>;
  footer?: string;
  compact?: boolean;
}) {
  return (
    <aside className={`claim-info-panel ${compact ? "compact" : ""}`}>
      <h2>{title}</h2>
      <div className="claim-info-list">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <section key={item.title} className="claim-info-item">
              <span className="claim-icon-circle">
                <Icon size={26} aria-hidden="true" />
              </span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </div>
            </section>
          );
        })}
      </div>
      {footer ? <p className="claim-info-footer">{footer}</p> : null}
    </aside>
  );
}

function MetricStripItem({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <section className="claim-metric-strip-item">
      <Icon size={36} aria-hidden="true" />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </section>
  );
}

function MetricText({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="claim-metric-text">
      <span>{label}</span>
      {value ? <strong>{value}</strong> : null}
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function ReviewRow({
  label,
  value,
  detail,
  icon: Icon,
  noCopy,
  copyValue,
  breakValue,
}: {
  label: string;
  value: string;
  detail?: string;
  icon?: LucideIcon;
  noCopy?: boolean;
  copyValue?: string;
  breakValue?: boolean;
}) {
  return (
    <div className="claim-review-row">
      <span>{label}</span>
      <code style={breakValue ? { overflowWrap: "anywhere", wordBreak: "break-all", whiteSpace: "normal" } : undefined}>{value}</code>
      {Icon ? <Icon size={18} aria-hidden="true" /> : null}
      {!noCopy ? <CopyButton label={`Copy ${label}`} value={copyValue ?? value} /> : null}
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );
  const copyToClipboard = async () => {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      className="claim-copy-button"
      type="button"
      aria-label={copied ? `${label} — copied` : label}
      title={copied ? "Copied" : label}
      onClick={() => void copyToClipboard()}
    >
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    </button>
  );
}

function WalletChooser({
  layout,
  wallets,
  selectedWallet,
  onSelectWallet,
}: {
  layout: "list" | "grid";
  wallets?: WalletEntry[];
  selectedWallet?: string;
  onSelectWallet?: React.Dispatch<React.SetStateAction<string>>;
}) {
  const fixtureWallets = [
    { name: "Lace", detail: "The simplest and most secure way to connect.", recommended: true },
    { name: "Eternl", detail: "A feature-rich wallet for Cardano." },
    { name: "Yoroi", detail: "Lightweight and easy to use." },
  ];
  const walletOptions = wallets
    ? wallets.map(([id, provider], index) => ({
        id,
        name: provider.name || id,
        detail: index === 0 ? "Detected browser wallet extension." : "Available browser wallet extension.",
        recommended: index === 0,
      }))
    : fixtureWallets.map((wallet) => ({
        ...wallet,
        id: wallet.name.toLowerCase(),
      }));
  return (
    <section className={`claim-wallet-chooser ${layout}`}>
      <h2>Choose a Cardano browser wallet</h2>
      <p>Works with CIP-30 wallets such as Lace, Eternl, and Yoroi.</p>
      {layout === "grid" ? <p>Use a different wallet than the impacted wallet.</p> : null}
      <div>
        {walletOptions.length === 0 ? (
          <button className="claim-wallet-option claim-wallet-empty" type="button" disabled>
            <span className="claim-wallet-logo">?</span>
            <strong>No wallet found</strong>
            <span>Install or unlock a Cardano browser wallet, then refresh this page.</span>
          </button>
        ) : null}
        {walletOptions.map((wallet) => (
          <button
            key={wallet.id}
            className="claim-wallet-option"
            type="button"
            onClick={() => onSelectWallet?.(wallet.id)}
            aria-pressed={selectedWallet === wallet.id}
          >
            <span className={`claim-wallet-logo ${wallet.name.toLowerCase()}`}>{wallet.name[0]}</span>
            <strong>
              {wallet.name}
              {wallet.recommended ? <small>Recommended</small> : null}
            </strong>
            {layout === "list" ? <span>{wallet.detail}</span> : null}
            {layout === "list" ? <ChevronRight size={25} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function Segmented({
  options,
  value,
  onChange,
  label = "Filter",
}: {
  options: string[];
  value: string;
  onChange: (option: string) => void;
  label?: string;
}) {
  return (
    <div className="claim-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          className={option === value ? "active" : ""}
          type="button"
          role="radio"
          aria-checked={option === value}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function ClaimsTable({
  rows,
  page,
  pageSize,
  totalRows,
  onPageChange,
  onViewAsset,
}: {
  rows: ClaimRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
  onViewAsset: (row: ClaimRow) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const firstRow = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, totalRows);
  return (
    <>
      <div className="claim-table-wrap">
        <table className="claim-table">
          <thead>
            <tr>
              <th>Tx id</th>
              <th>Output #</th>
              <th>Credential</th>
              <th>ADA</th>
              <th>Tokens</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.tx}-${row.output}-${row.id}`}>
                <td>{row.tx}</td>
                <td>{row.output}</td>
                <td>
                  {row.credential} <CopyButton label={`Copy credential ${row.id}`} value={row.paymentCredential ?? row.credential} />
                </td>
                <td>{row.ada}</td>
                <td>
                  {row.assetCount != null
                    ? row.assetCount > 0
                      ? `${row.assetCount} token${row.assetCount === 1 ? "" : "s"}`
                      : "—"
                    : row.assets}
                </td>
                <td>
                  <button className="claim-table-action" type="button" onClick={() => onViewAsset(row)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="claim-table-footer">
        <span>
          <HelpCircle size={16} aria-hidden="true" /> Use View to inspect every asset and quantity inside a UTxO.
        </span>
        <span>Showing {firstRow}-{lastRow} of {totalRows} UTxOs</span>
        <nav className="claim-pagination" aria-label="Claims pages">
          <button disabled={page <= 1} type="button" onClick={() => onPageChange(page - 1)}>Previous</button>
          {paginationItems(page, pageCount).map((item, index) =>
            item === "ellipsis" ? (
              <span key={`ellipsis-${index}`} aria-hidden="true">…</span>
            ) : (
              <button
                key={item}
                className={page === item ? "active" : ""}
                type="button"
                aria-current={page === item ? "page" : undefined}
                onClick={() => onPageChange(item)}
              >
                {item}
              </button>
            ),
          )}
          <button disabled={page >= pageCount} type="button" onClick={() => onPageChange(page + 1)}>Next</button>
        </nav>
      </div>
    </>
  );
}

// Windowed page-number list: all pages when 7 or fewer, otherwise the first,
// last, and current page with neighbors, separated by ellipses.
function paginationItems(page: number, pageCount: number): Array<number | "ellipsis"> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const anchors = [...new Set([1, page - 1, page, page + 1, pageCount])]
    .filter((candidate) => candidate >= 1 && candidate <= pageCount)
    .sort((left, right) => left - right);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const candidate of anchors) {
    if (previous > 0 && candidate - previous > 1) {
      items.push("ellipsis");
    }
    items.push(candidate);
    previous = candidate;
  }
  return items;
}

function TableEmpty({ icon: Icon, title, body, spin }: { icon: LucideIcon; title: string; body: string; spin?: boolean }) {
  return (
    <div className="claim-table-empty">
      <Icon size={36} aria-hidden="true" className={spin ? "spin" : undefined} />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function AssetModal({ row, onClose }: { row: ClaimRow; onClose: () => void }) {
  const outRefId = row.outRefId ?? `${row.tx}#${row.output}`;
  const credential = row.paymentCredential ?? row.credential;
  const assetDetails = claimAssetRows(row.value);
  const [assetSearch, setAssetSearch] = useState("");
  const [txCopyState, setTxCopyState] = useState<"idle" | "copied">("idle");
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const searchNeedle = assetSearch.trim().toLowerCase();
  const visibleAssets = searchNeedle
    ? assetDetails.filter(
        (asset) =>
          asset.policyId.toLowerCase().includes(searchNeedle) ||
          asset.assetName.toLowerCase().includes(searchNeedle) ||
          asset.unit.toLowerCase().includes(searchNeedle),
      )
    : assetDetails;
  const copyTxReference = async () => {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }
    try {
      await navigator.clipboard.writeText(outRefId);
    } catch {
      return;
    }
    setTxCopyState("copied");
  };
  return (
    <div className="claim-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="claim-asset-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="claim-modal-header">
          <div>
            <h2 id="asset-modal-title">UTxO assets</h2>
            <p>{outRefId}</p>
          </div>
          <button className="claim-icon-button" type="button" onClick={onClose} aria-label="Close asset modal">
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div className="claim-card-grid four compact">
          <MetricText label="Credential" value={abbreviateMiddle(credential, 18)} />
          <MetricText label="ADA" value={row.ada} />
          <MetricText label="Unique assets" value={String(assetDetails.length)} />
          <MetricText label="Claim status" value="Ready" />
        </div>
        <Notice icon={ShieldCheck} title={undefined}>Review the asset list before continuing. Claiming this UTxO sends all listed value to your safe wallet.</Notice>
        <div className="claim-table-tools">
          <label className="claim-search">
            <Search size={18} aria-hidden="true" />
            <input
              placeholder="Search policy id or asset name"
              aria-label="Search assets by policy id or asset name"
              value={assetSearch}
              onChange={(event) => setAssetSearch(event.target.value)}
            />
          </label>
          <button className="claim-secondary-button" type="button" onClick={() => void copyTxReference()}>
            {txCopyState === "copied" ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
            {txCopyState === "copied" ? "Copied" : "Copy tx reference"}
          </button>
        </div>
        <div className="claim-asset-table-wrap">
          <table className="claim-table">
            <thead>
              <tr>
                <th>Policy id</th>
                <th>Asset name</th>
                <th>Quantity</th>
              </tr>
            </thead>
            <tbody>
              {visibleAssets.length > 0 ? (
                visibleAssets.map((asset) => (
                  <tr key={asset.unit}>
                    <td>
                      {abbreviateMiddle(asset.policyId, 18)} <CopyButton label={`Copy policy ${asset.policyId}`} value={asset.policyId} />
                    </td>
                    <td>{asset.assetName}</td>
                    <td>{asset.quantity}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3}>{assetDetails.length === 0 ? "No native assets in this UTxO." : "No assets match this search."}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <footer className="claim-modal-footer">
          <span>
            {visibleAssets.length > 0
              ? `Showing 1-${visibleAssets.length} of ${assetDetails.length} asset${assetDetails.length === 1 ? "" : "s"}`
              : "Showing 0 assets"}
          </span>
          <span>{visibleAssets.length > 12 ? "Scroll to view more assets" : "All matching assets shown"}</span>
        </footer>
        <div className="claim-modal-actions">
          <button className="claim-primary-button" type="button" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}

function ProofPlan({ draft, safeWallet }: { draft?: ClaimDraftResponse | null; safeWallet?: SafeWalletSummary | null }) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const proofCount = draft?.orderedInputs.length ?? (fixtureMode ? 18 : 0);
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Not connected";
  const batchSize = draft?.batchCap.requested ?? (fixtureMode ? 4 : 0);
  const transactionCount = proofCount > 0 ? Math.ceil(proofCount / Math.max(batchSize, 1)) : 0;
  return (
    <div className="claim-proof-plan">
      <MetricStripItem icon={Coins} label="Available claims" value={`${proofCount} UTxO${proofCount === 1 ? "" : "s"}`} />
      <MetricStripItem icon={ShieldCheck} label="Destination bound to" value={safeWalletLabel} />
      <MetricStripItem icon={Code2} label="Default batch size" value={`${batchSize} UTxO${batchSize === 1 ? "" : "s"}`} />
      <MetricStripItem icon={FileText} label="Estimated claim transactions" value={String(transactionCount)} />
    </div>
  );
}

function ProofQueue({ rows, totalCount }: { rows: ProofRow[]; totalCount?: number }) {
  const hiddenCount = totalCount !== undefined ? Math.max(totalCount - rows.length, 0) : 0;
  return (
    <table className="claim-table">
      <thead>
        <tr>
          <th>Claim</th>
          <th>Value</th>
          <th>Proof</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.claim}>
            <td>{row.claim}</td>
            <td>{row.value}</td>
            <td><span className={`claim-badge ${row.status}`}>{row.proof}</span></td>
            <td>
              {row.status === "ready" ? (
                <CheckCircle2 size={20} aria-hidden="true" />
              ) : row.status === "generating" ? (
                <RefreshCw className="spin" size={20} aria-hidden="true" />
              ) : (
                <span className="claim-waiting-dot" aria-hidden="true" />
              )}
              <span className="visually-hidden">
                {row.status === "ready" ? "Generated" : row.status === "generating" ? "Generating" : "Waiting"}
              </span>
            </td>
          </tr>
        ))}
        {hiddenCount > 0 ? (
          <tr>
            <td colSpan={4}>…and {hiddenCount} more claim{hiddenCount === 1 ? "" : "s"}</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function BatchProofTable({ draft, safeWallet }: { draft?: ClaimDraftResponse | null; safeWallet?: SafeWalletSummary | null }) {
  const rows = draft?.orderedInputs ?? [];
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Not connected";
  if (rows.length === 0) {
    return <TableEmpty icon={FileText} title="No active draft" body="Connect a safe wallet to create the next claim draft." />;
  }
  return (
    <table className="claim-table">
      <thead>
        <tr>
          <th>Claim</th>
          <th>Proofs</th>
          <th>Destination</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((input, index) => (
          <tr key={input.outRefId}>
            <td>{abbreviateMiddle(input.outRefId, 18)}</td>
            <td>{index + 1}</td>
            <td>
              {safeWalletLabel}{" "}
              {safeWallet ? <CopyButton label={`Copy claim ${index + 1} destination`} value={safeWallet.changeAddress} /> : null}
            </td>
            <td><span className="claim-badge ready">Ready</span></td>
          </tr>
        ))}
        <tr>
          <td><strong>Total</strong></td>
          <td><strong>{rows.length}</strong></td>
          <td>-</td>
          <td>-</td>
        </tr>
      </tbody>
    </table>
  );
}

function BatchTable({ draft }: { draft?: ClaimDraftResponse | null }) {
  if (!draft) {
    const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
    if (!fixtureMode) {
      return (
        <div className="claim-table-wrap">
          <TableEmpty icon={FileText} title="No active claim draft" body="Create a real claim draft before reviewing batch rows." />
        </div>
      );
    }
    const batchRows = claimFixtureData().batchRows;
    const summary = summarizeClaimRows(batchRows);
    return (
      <table className="claim-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Tx reference</th>
            <th>ADA</th>
            <th>Assets (tokens)</th>
            <th>Asset summary</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {batchRows.map((row, index) => {
            const rowAssetCount = row.assetCount ?? row.summary.length;
            return (
            <tr key={row.id}>
              <td>{index + 1}</td>
              <td>{row.tx} <CopyButton label={`Copy tx reference ${row.id}`} value={row.outRefId ?? `${row.tx}#${row.output}`} /></td>
              <td>{row.ada.replace(" ADA", "")}</td>
              <td>{rowAssetCount > 0 ? rowAssetCount : "—"}</td>
              <td><AssetDots labels={row.summary} assetCount={rowAssetCount} /></td>
              <td><span className="claim-badge ready">Ready</span></td>
            </tr>
            );
          })}
          <tr>
            <td><strong>Total</strong></td>
            <td />
            <td><strong>{formatLovelace(summary.lovelace)}</strong></td>
            <td><strong>{summary.assetCount}</strong></td>
            <td />
            <td />
          </tr>
        </tbody>
      </table>
    );
  }
  const totalAssets = sumAssetMaps(draft.orderedInputs.map((input) => input.value));
  return (
    <table className="claim-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Tx reference</th>
          <th>ADA</th>
          <th>Assets (tokens)</th>
          <th>Asset summary</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {draft.orderedInputs.map((input, index) => {
          const lovelace = lovelaceFromAssets(input.value);
          const assetCount = assetCountFrom(input.value);
          const labels = assetLabels(input.value);
          return (
          <tr key={input.outRefId}>
            <td>{index + 1}</td>
            <td>{abbreviateMiddle(input.outRefId, 18)} <CopyButton label={`Copy tx reference ${index + 1}`} value={input.outRefId} /></td>
            <td>{formatLovelace(lovelace)}</td>
            <td>{assetCount || "—"}</td>
            <td><AssetDots labels={labels} assetCount={assetCount} /></td>
            <td><span className="claim-badge ready">Ready</span></td>
          </tr>
          );
        })}
        <tr>
          <td><strong>Total</strong></td>
          <td />
          <td><strong>{formatLovelace(lovelaceFromAssets(totalAssets))}</strong></td>
          <td><strong>{assetCountFrom(totalAssets)}</strong></td>
          <td />
          <td />
        </tr>
      </tbody>
    </table>
  );
}

function AssetDots({ labels, assetCount }: { labels: string[]; assetCount?: number }) {
  if (labels.length === 0) {
    return <span>No tokens</span>;
  }
  const shown = labels.slice(0, 2);
  // Prefer the true asset count from the row: `labels` is often pre-sliced by
  // callers, so labels.length alone under-reports the remainder (C46).
  const remainder = Math.max((assetCount ?? labels.length) - shown.length, 0);
  return (
    <span className="claim-asset-dots">
      {shown.map((label) => (
        <span key={label}>{label.slice(0, 1)}</span>
      ))}
      {remainder > 0 ? `+ ${remainder} more` : null}
    </span>
  );
}

function TransactionTable({
  rows,
  explorerNetwork,
  totalRecovered,
}: {
  rows: TransactionRow[];
  explorerNetwork?: ReclaimNetwork;
  totalRecovered?: string;
}) {
  const explorerHost = cexplorerHost(explorerNetwork);
  return (
    <table className="claim-table">
      <thead>
        <tr>
          <th>Batch</th>
          <th>Tx hash</th>
          <th>Recovered value</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.txHash}>
            <td>{row.batch}</td>
            <td>
              <a className="claim-tx-link" href={cexplorerTxUrl(row.txHash, explorerNetwork)} title={row.txHash}>
                {row.displayHash} <ExternalLink size={14} aria-hidden="true" />
              </a>
              <small>{explorerHost}/tx/{row.displayHash}</small>
            </td>
            <td>{row.value}</td>
            <td><span className={`claim-badge ${row.status === "Confirmed" ? "ready" : "generating"}`}>{row.status}</span></td>
          </tr>
        ))}
        {totalRecovered ? (
          <tr>
            <td><strong>Total recovered</strong></td>
            <td />
            <td><strong>{totalRecovered}</strong></td>
            <td />
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function cexplorerTxUrl(txHash: string, network?: ReclaimNetwork): string {
  return `https://${cexplorerHost(network)}/tx/${txHash}`;
}

function cexplorerHost(network?: ReclaimNetwork): string {
  if (network === "Preprod") {
    return "preprod.cexplorer.io";
  }
  if (network === "Preview") {
    return "preview.cexplorer.io";
  }
  return "cexplorer.io";
}

function Assurance({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <section className="claim-assurance-item">
      <span className="claim-icon-circle">
        <Icon size={25} aria-hidden="true" />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </section>
  );
}

async function fetchClaimDeployment(): Promise<ClaimDeploymentResponse> {
  return fetchJSON<ClaimDeploymentResponse>("/claim-api/deployment");
}

async function fetchAllReclaimUtxos(
  options: { signal?: AbortSignal; onProgress?: (scannedUtxos: number) => void } = {},
): Promise<IndexedReclaimUtxo[]> {
  const utxos: IndexedReclaimUtxo[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    if (options.signal?.aborted) {
      throw new Error("Reclaim UTxO scan was cancelled.");
    }
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await fetchJSON<ReclaimUtxosResponse>(`/claim-api/reclaim-utxos?${params.toString()}`, {
      signal: options.signal,
    });
    if (!response.available) {
      throw new Error(response.reason || "Reclaim UTxO index is unavailable.");
    }
    utxos.push(...response.utxos);
    options.onProgress?.(utxos.length);
    if (!response.page.nextCursor) {
      return utxos;
    }
    if (seenCursors.has(response.page.nextCursor)) {
      throw new Error("Reclaim UTxO index pagination did not advance.");
    }
    seenCursors.add(response.page.nextCursor);
    cursor = response.page.nextCursor;
  }
  throw new Error("Reclaim UTxO index pagination exceeded the client safety limit.");
}

// Error thrown by fetchJSON that preserves the backend error code (and any
// structured details payload) so callers can branch on machine-readable
// failures (e.g. insufficient safe-wallet ADA) without string-matching alone.
class ClaimApiError extends Error {
  code?: string;
  details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ClaimApiError";
    this.code = code;
    this.details = details;
  }
}

async function fetchJSON<T>(
  url: string,
  init?: RequestInit,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<T> {
  const response = await fetcher(url, init);
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = payload as Partial<ReclaimApiError> & { reason?: string; code?: string; details?: unknown };
    const details =
      error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : undefined;
    throw new ClaimApiError(
      error.error || error.reason || "Request failed.",
      typeof error.code === "string" ? error.code : undefined,
      details,
    );
  }
  return payload as T;
}

// C32: backend draft failures caused by an underfunded safe wallet route to
// the purpose-built insufficient-ada screen. Prefer the machine-readable code;
// fall back to case-insensitive message matching.
function isInsufficientSafeWalletFundsError(error: unknown, sanitizedMessage: string): boolean {
  if (error instanceof ClaimApiError && error.code === "safe_wallet_lovelace_unavailable") {
    return true;
  }
  return /insufficient|not enough|enough ada|min[\s-]?ada|collateral/iu.test(sanitizedMessage);
}

// C32: pulls the structured available/required lovelace amounts from the
// backend error payload when present; older payloads without details fall
// back to qualitative copy.
function insufficientAdaDetailsFromError(error: unknown): InsufficientAdaDetails | null {
  if (!(error instanceof ClaimApiError) || !error.details) {
    return null;
  }
  const { availableLovelace, requiredLovelace } = error.details;
  if (typeof availableLovelace === "string" && typeof requiredLovelace === "string") {
    return { availableLovelace, requiredLovelace };
  }
  return null;
}

// C33: translate CIP-30 numeric network ids into user-facing network names.
function networkIdName(networkId: number): string {
  if (networkId === 1) {
    return "Mainnet";
  }
  if (networkId === 0) {
    return "Preprod";
  }
  return `network id ${networkId}`;
}

async function postJSON<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  return fetchJSON<T>(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export function selectClaimBatchRows(
  rows: ClaimRow[],
  pendingOutrefs: string[],
  deployment: ClaimDeploymentResponse,
  requestedCap?: number,
): ClaimRow[] {
  if (!deployment.available) {
    return [];
  }
  const pending = new Set(pendingOutrefs);
  const statementBoundV2 = deployment.deployment.reclaimGlobalProofSlotEncoding === "full-proof-plus-public-input-digest-v2";
  const defaultCap = statementBoundV2
    ? CLAIM_DEFAULT_BATCH_CAP
    : (deployment.deployment.batching?.default_utxo_count ?? CLAIM_LEGACY_DEFAULT_BATCH_CAP);
  const configuredHardCap = deployment.deployment.batching?.hard_max_utxo_count ??
    (statementBoundV2 ? CLAIM_HARD_BATCH_CAP : CLAIM_LEGACY_OPTIMIZATION_BATCH_CAP);
  const hardCap = Math.min(
    configuredHardCap,
    statementBoundV2 ? CLAIM_HARD_BATCH_CAP : CLAIM_LEGACY_HARD_BATCH_CAP,
  );
  const selectedCap =
    statementBoundV2 && requestedCap === CLAIM_HARD_BATCH_CAP && supportsExplicitSevenSlotBatch(deployment)
      ? CLAIM_HARD_BATCH_CAP
      : defaultCap;
  return rows
    .filter((row) => row.outRefId && !pending.has(row.outRefId))
    .sort(compareClaimRows)
    .slice(0, Math.min(selectedCap, hardCap));
}

function supportsExplicitSevenSlotBatch(deployment: ClaimDeploymentResponse | null | undefined): boolean {
  if (!deployment?.available || deployment.deployment.reclaimGlobalProofSlotEncoding !== "full-proof-plus-public-input-digest-v2") {
    return false;
  }
  const batching = deployment.deployment.batching;
  const optIn = batching?.distinct_7_opt_in;
  return (
    batching?.hard_max_utxo_count === CLAIM_HARD_BATCH_CAP &&
    optIn?.request_parameter === "maxUtxos" &&
    optIn.request_value === CLAIM_HARD_BATCH_CAP &&
    optIn.require_explicit_request === true &&
    optIn.require_measured_execution_units === true
  );
}

function compareClaimRows(left: ClaimRow, right: ClaimRow): number {
  const leftSlot = left.confirmationSlot ?? Number.MAX_SAFE_INTEGER;
  const rightSlot = right.confirmationSlot ?? Number.MAX_SAFE_INTEGER;
  if (leftSlot !== rightSlot) {
    return leftSlot - rightSlot;
  }
  const leftOutRef = left.outRefId ?? "";
  const rightOutRef = right.outRefId ?? "";
  return leftOutRef.localeCompare(rightOutRef);
}

function hasSigningWalletApi(api: ReadOnlyWalletApi | SigningWalletApi): api is SigningWalletApi {
  return (
    typeof api.getNetworkId === "function" &&
    typeof api.getChangeAddress === "function" &&
    typeof api.getUsedAddresses === "function" &&
    typeof (api as Partial<SigningWalletApi>).signTx === "function"
  );
}

async function readSafeWalletSummary(
  api: SigningWalletApi,
  wallet: { walletId: string; walletName: string; networkId: 0 | 1 },
): Promise<SafeWalletSummary> {
  const summary = await readImpactedWalletSummary(api, wallet);
  const changeAddress = await api.getChangeAddress();
  const normalizedChangeAddress = cip30PaymentAddressToBech32(changeAddress, wallet.networkId);
  const normalizedAddresses = [
    ...new Set([normalizedChangeAddress, ...summary.addresses.map((address) => cip30PaymentAddressToBech32(address, wallet.networkId))]),
  ];
  return {
    ...summary,
    addresses: normalizedAddresses,
    changeAddress: normalizedChangeAddress,
  };
}

function sameSafeWalletDestination(next: SafeWalletSummary, restored: SafeWalletSummary): boolean {
  if (next.changeAddress.toLowerCase() !== restored.changeAddress.toLowerCase()) {
    return false;
  }
  return sameAddressSet(next.addresses, restored.addresses);
}

function sameAddressSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left.map((address) => address.toLowerCase()));
  const rightSet = new Set(right.map((address) => address.toLowerCase()));
  if (leftSet.size !== rightSet.size) {
    return false;
  }
  for (const address of leftSet) {
    if (!rightSet.has(address)) {
      return false;
    }
  }
  return true;
}

function recoveryPhraseWordsFromText(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean);
}

function recoveryPhraseWordCountFromLength(length: number): RecoveryPhraseWordCount | null {
  return recoveryPhraseWordCounts.find((wordCount) => wordCount === length) ?? null;
}

type RecoveryWordStatus = "empty" | "invalid" | "valid";

// C28: real BIP-39 English wordlist membership (case/whitespace tolerant) via
// the client package, so typos like "recieve" are flagged per word. The
// full-phrase checksum is validated separately at generate time.
function recoveryWordStatus(value: string): RecoveryWordStatus {
  const trimmed = value.trim();
  if (!trimmed) {
    return "empty";
  }
  return isValidRecoveryWord(trimmed) ? "valid" : "invalid";
}

function recoveryWordInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("[data-claim-recovery-word='true']"));
}

function focusFirstRecoveryWordInput(): void {
  recoveryWordInputs()[0]?.focus();
}

function writeRecoveryPhraseWords(words: string[]): void {
  const inputs = recoveryWordInputs();
  for (const [index, input] of inputs.entries()) {
    input.value = words[index] ?? "";
  }
  inputs[0]?.focus();
}

async function readClipboardTextWithTimeout(readText: () => Promise<string>): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readText(),
      new Promise<string>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Clipboard read timed out.")), clipboardReadTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// C28: reads the words from the same DOM inputs readAndClearRecoveryPhrase
// uses and validates them (word count, wordlist, BIP-39 checksum) WITHOUT
// clearing the grid. Only the boolean verdict escapes; the words stay local
// to this function.
function recoveryPhraseInputsPassValidation(): boolean {
  const words = recoveryWordInputs()
    .map((input) => input.value.trim())
    .filter(Boolean);
  return validateRecoveryPhrase(words).ok;
}

function readAndClearRecoveryPhrase(): string {
  const inputs = recoveryWordInputs();
  const words = inputs.map((input) => input.value.trim()).filter(Boolean);
  for (const input of inputs) {
    input.value = "";
  }
  return words.join(" ");
}

async function deriveMasterXPrv(seedPhrase: string, createWorker: () => WorkerLike): Promise<WorkerResponse> {
  const worker = createWorker();
  const id = randomId();
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

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `claim-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function validateDestinationProofResponse(
  response: DestinationProofResponse,
  draft: ClaimDraftResponse,
  expectedVkHash: string,
): Record<string, unknown>[] {
  if (response.profile !== draft.proofProfile || !Array.isArray(response.artifacts)) {
    throw new Error("Proof Helper returned a malformed destination proof response.");
  }
  const pathMetadata = findPathMetadata(response);
  if (pathMetadata) {
    throw new Error("Proof Helper returned derivation path metadata. Backend submission is blocked.");
  }
  if (response.artifacts.length !== draft.proofRequests.length) {
    throw new Error("Proof Helper artifact count does not match the current draft.");
  }
  return response.artifacts.map((item, index) => {
    const request = draft.proofRequests[index];
    const artifact = item.artifact;
    if (!request || item.out_ref !== request.out_ref || !artifact) {
      throw new Error("Proof Helper artifacts must preserve draft order.");
    }
    if (artifact.vk_hash !== expectedVkHash) {
      throw new Error("Proof Helper verifier key hash does not match the claim deployment.");
    }
    if (artifact.target_credential !== request.target_credential) {
      throw new Error("Proof Helper artifact target credential does not match the draft.");
    }
    if (
      artifact.destination_address_encoding !== request.destination_address_encoding ||
      artifact.destination_address !== request.destination_address
    ) {
      throw new Error("Proof Helper artifact destination does not match the draft.");
    }
    if (findPathMetadata(artifact)) {
      throw new Error("Proof Helper artifact includes derivation path metadata.");
    }
    return artifact;
  });
}

function findPathMetadata(value: unknown): string | null {
  return findPathMetadataAt(value, "$");
}

function findPathMetadataAt(value: unknown, location: string): string | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = findPathMetadataAt(child, `${location}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "path" || key === "paths") {
      return `${location}.${key}`;
    }
    const found = findPathMetadataAt(child, `${location}.${key}`);
    if (found) {
      return found;
    }
  }
  return null;
}

function writeClaimFlowResumeSnapshot(snapshot: ClaimFlowResumeSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(claimFlowResumeStorageKey, JSON.stringify(snapshot));
  } catch {
    // Local resume is best-effort; proof generation must not depend on browser storage.
  }
}

function clearClaimFlowResumeSnapshot(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(claimFlowResumeStorageKey);
  } catch {
    // Local resume is best-effort; clearing must never block the flow.
  }
}

function formatRelativeTime(timestamp: number): string {
  const elapsedMinutes = Math.round(Math.max(Date.now() - timestamp, 0) / 60_000);
  if (elapsedMinutes < 1) {
    return "moments ago";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
}

function filterClaimRows(rows: ClaimRow[], query: string, assetFilter: string): ClaimRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    const assetCount = row.assetCount ?? row.summary.length;
    if (assetFilter === "ADA" && assetCount > 0) {
      return false;
    }
    if (assetFilter === "Tokens" && assetCount === 0) {
      return false;
    }
    if (!needle) {
      return true;
    }
    const haystack = [
      row.tx,
      `${row.tx}#${row.output}`,
      row.outRefId ?? "",
      row.outRef?.txHash ?? "",
      row.credential,
      row.paymentCredential ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function csvField(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function readClaimFlowResumeSnapshot(): ClaimFlowResumeSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(claimFlowResumeStorageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ClaimFlowResumeSnapshot>;
    if (
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "number" ||
      Date.now() - parsed.updatedAt > claimFlowResumeMaxAgeMs ||
      typeof parsed.screen !== "string" ||
      !isClaimScreen(parsed.screen) ||
      !resumableClaimScreen(parsed.screen) ||
      typeof parsed.selectedImpactedWallet !== "string" ||
      typeof parsed.selectedSafeWallet !== "string" ||
      !parsed.safeWallet ||
      !parsed.draft ||
      !Array.isArray(parsed.claimRows) ||
      !Array.isArray(parsed.pendingOutrefs) ||
      typeof parsed.claimIndexerTotal !== "number"
    ) {
      return null;
    }
    return parsed as ClaimFlowResumeSnapshot;
  } catch {
    return null;
  }
}

function resumableClaimScreen(screen: ClaimScreen): ClaimScreen | null {
  switch (screen) {
    case "helper-unavailable":
    case "create-proofs-generating":
    case "create-proofs-complete":
      return "create-proofs-ready";
    case "create-proofs-ready":
    case "proof-failed":
    case "current-batch":
    case "claim-funds-overview":
    case "signature-rejected":
      return screen;
    default:
      return null;
  }
}

function readPairingFragment(): { helperUrl: string; token: string } | { error: string } | null {
  if (typeof window === "undefined" || window.location.hash.length <= 1) {
    return null;
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const helper = params.get("helper");
  const token = params.get("pair");
  if (!helper || !token) {
    return null;
  }
  try {
    return {
      helperUrl: normalizeLoopbackHelperUrl(helper),
      token,
    };
  } catch (error) {
    return {
      error: sanitizeRecoverableError(error, "Proof Helper pairing URL must be loopback."),
    };
  }
}

function normalizeLoopbackHelperUrl(value: string): string {
  const trimmed = value.trim();
  const rawUrl = /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Proof Helper URL must use HTTP over loopback.");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("Proof Helper URL must point to localhost or 127.0.0.1.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return trimSlash(parsed.toString());
}

function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function sanitizeRecoverableError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/\b(addr(?:_test)?1[0-9a-z]{20,})\b/giu, "[address-redacted]")
    .replace(/\b(stake(?:_test)?1[0-9a-z]{20,})\b/giu, "[address-redacted]")
    .replace(/\b[0-9a-f]{96,}\b/giu, "[hex-redacted]")
    .replace(/\b[A-Za-z0-9_-]{96,}\b/gu, "[token-redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 360);
}

function listCardanoWallets(): WalletEntry[] {
  const cardano = ((window as Window & { cardano?: Record<string, unknown> }).cardano ?? {}) as Record<string, unknown>;
  return Object.entries(cardano).filter((entry): entry is WalletEntry => {
    const wallet = entry[1] as CardanoWalletProvider | undefined;
    return typeof wallet?.enable === "function";
  });
}

async function readImpactedWalletSummary(
  api: CardanoWalletApi,
  wallet: { walletId: string; walletName: string; networkId: 0 | 1 },
): Promise<ImpactedWalletSummary> {
  if (typeof api.getNetworkId !== "function" || typeof api.getChangeAddress !== "function" || typeof api.getUsedAddresses !== "function") {
    throw new Error("Connected wallet is missing required CIP-30 public address methods.");
  }

  let rawChangeAddress = "";
  let rawUsedAddresses: string[] = [];
  let rawUnusedAddresses: string[] = [];
  let rawRewardAddresses: string[] = [];
  try {
    const unusedAddresses = typeof api.getUnusedAddresses === "function" ? api.getUnusedAddresses() : Promise.resolve([]);
    const rewardAddresses = typeof api.getRewardAddresses === "function" ? api.getRewardAddresses() : Promise.resolve([]);
    [rawChangeAddress, rawUsedAddresses, rawUnusedAddresses, rawRewardAddresses] = await Promise.all([
      api.getChangeAddress(),
      api.getUsedAddresses(),
      unusedAddresses,
      rewardAddresses,
    ]);
  } catch {
    throw new Error("Connected wallet did not provide usable CIP-30 wallet addresses.");
  }

  if (
    typeof rawChangeAddress !== "string" ||
    !Array.isArray(rawUsedAddresses) ||
    !Array.isArray(rawUnusedAddresses) ||
    !Array.isArray(rawRewardAddresses) ||
    rawUsedAddresses.some((address) => typeof address !== "string") ||
    rawUnusedAddresses.some((address) => typeof address !== "string") ||
    rawRewardAddresses.some((address) => typeof address !== "string")
  ) {
    throw new Error("Connected wallet returned malformed CIP-30 address data.");
  }

  const addresses = [...new Set([rawChangeAddress, ...rawUsedAddresses, ...rawUnusedAddresses].map((address) => address.trim()).filter(Boolean))];
  const rewardAddresses = [...new Set(rawRewardAddresses.map((address) => address.trim()).filter(Boolean))];
  const credentials = new Set<string>();
  for (const address of [...addresses, ...rewardAddresses]) {
    for (const credential of extractCip30ClaimableKeyHashes(address, wallet.networkId)) {
      credentials.add(credential);
    }
  }
  if (credentials.size === 0) {
    throw new Error("Connected wallet did not expose any wallet keys.");
  }

  return {
    walletId: wallet.walletId,
    walletName: wallet.walletName,
    networkId: wallet.networkId,
    addresses,
    credentials: [...credentials],
  };
}

function extractCip30ClaimableKeyHashes(rawAddress: string, expectedNetworkId: 0 | 1): string[] {
  const bytes = cip30AddressBytes(rawAddress);
  if (bytes.length < 29) {
    throw new Error("Wallet address must be a Shelley wallet address.");
  }
  const header = bytes[0];
  const networkId = header & 0x0f;
  if (networkId !== expectedNetworkId) {
    throw new Error("Wallet address network does not match the claim deployment.");
  }
  const addressKind = header >> 4;
  if (addressKind === 1 || addressKind === 3 || addressKind === 5 || addressKind === 7 || addressKind === 15) {
    throw new Error("Only key credentials can prove reclaim ownership.");
  }

  if (addressKind === 0) {
    if (bytes.length < 57) {
      throw new Error("Wallet base address is missing a stake key credential.");
    }
    return [bytesToHex(bytes.slice(1, 29)), bytesToHex(bytes.slice(29, 57))];
  }

  if (addressKind === 2) {
    throw new Error("Only key credentials can prove reclaim ownership.");
  }

  if (addressKind === 4 || addressKind === 6) {
    return [bytesToHex(bytes.slice(1, 29))];
  }

  if (addressKind === 14) {
    return [bytesToHex(bytes.slice(1, 29))];
  }

  throw new Error("Wallet address does not contain a claimable wallet key.");
}

function cip30AddressBytes(rawAddress: string): Uint8Array {
  const value = rawAddress.trim();
  if (!value) {
    throw new Error("Wallet address is empty.");
  }
  if (value.startsWith("addr") || value.startsWith("stake")) {
    try {
      const decoded = bech32.decode(value, 1000);
      return Uint8Array.from(bech32.fromWords(decoded.words));
    } catch {
      throw new Error("Wallet address must be a valid Shelley bech32 address.");
    }
  }
  if (value.length % 2 !== 0 || !ADDRESS_HEX_RE.test(value)) {
    throw new Error("Wallet address must be bech32 or CIP-30 hex.");
  }
  return hexToBytes(value);
}

function cip30PaymentAddressToBech32(rawAddress: string, expectedNetworkId: 0 | 1): string {
  const value = rawAddress.trim();
  const bytes = cip30AddressBytes(value);
  assertCip30PaymentAddressBytes(bytes, expectedNetworkId);
  if (value.startsWith("addr")) {
    return value;
  }
  const prefix = expectedNetworkId === 1 ? "addr" : "addr_test";
  return bech32.encode(prefix, bech32.toWords(bytes), 1000);
}

function assertCip30PaymentAddressBytes(bytes: Uint8Array, expectedNetworkId: 0 | 1): void {
  if (bytes.length < 29) {
    throw new Error("Wallet address must be a Shelley payment address.");
  }
  const header = bytes[0];
  const networkId = header & 0x0f;
  if (networkId !== expectedNetworkId) {
    throw new Error("Wallet address network does not match the claim deployment.");
  }
  const addressKind = header >> 4;
  if (addressKind !== 0 && addressKind !== 2 && addressKind !== 4 && addressKind !== 6) {
    throw new Error("Wallet address must use a payment key credential.");
  }
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deploymentUnavailableReason(deployment: ClaimDeploymentResponse): string {
  if (deployment.available) {
    return "";
  }
  if (deployment.errors?.length) {
    return deployment.errors.map((error) => error.message).join(" ");
  }
  if (deployment.missing?.length) {
    return `Missing claim deployment configuration: ${deployment.missing.join(", ")}.`;
  }
  return "The pinned claim deployment could not be loaded.";
}

function toClaimRow(utxo: IndexedReclaimUtxo, index: number): ClaimRow {
  const lovelace = lovelaceFromAssets(utxo.value);
  const assetCount = assetCountFrom(utxo.value);
  const paymentCredential = utxo.datum.status === "valid" ? utxo.datum.paymentCredential : undefined;
  return {
    id: index + 1,
    tx: abbreviateMiddle(utxo.outRef.txHash, 16),
    output: utxo.outRef.outputIndex,
    credential: paymentCredential ? `cred ...${paymentCredential.slice(-4)}` : "invalid datum",
    ada: `${formatLovelace(lovelace)} ADA`,
    assets: assetCount === 0 ? "No tokens" : `${assetCount} asset${assetCount === 1 ? "" : "s"}`,
    summary: assetLabels(utxo.value),
    lovelace,
    assetCount,
    value: utxo.value,
    paymentCredential,
    outRefId: utxo.outRefId,
    outRef: utxo.outRef,
    confirmationSlot: utxo.confirmation.slot,
  };
}

function lovelaceFromAssets(assets: AssetMap): string {
  return assets[LOVELACE_UNIT] ?? "0";
}

function assetCountFrom(assets: AssetMap): number {
  return Object.entries(assets).filter(([unit, quantity]) => unit !== LOVELACE_UNIT && positiveQuantity(quantity)).length;
}

function assetLabels(assets: AssetMap): string[] {
  return Object.entries(assets)
    .filter(([unit, quantity]) => unit !== LOVELACE_UNIT && positiveQuantity(quantity))
    .map(([unit]) => assetLabel(unit))
    .slice(0, 3);
}

function claimAssetRows(assets?: AssetMap): Array<{ unit: string; policyId: string; assetName: string; quantity: string }> {
  if (!assets) {
    return [];
  }
  return Object.entries(assets)
    .filter(([unit, quantity]) => unit !== LOVELACE_UNIT && positiveQuantity(quantity))
    .map(([unit, quantity]) => {
      const policyId = unit.slice(0, 56);
      const assetNameHex = unit.slice(56);
      return {
        unit,
        policyId,
        assetName: assetNameHex ? assetNameFromHex(assetNameHex) : "(empty asset name)",
        quantity,
      };
    })
    .sort((left, right) => left.policyId.localeCompare(right.policyId) || left.assetName.localeCompare(right.assetName));
}

function draftBatchSummary(draft: ClaimDraftResponse): ClaimValueSummary {
  const totals = sumAssetMaps(draft.orderedInputs.map((input) => input.value));
  return {
    lovelace: lovelaceFromAssets(totals),
    assetCount: assetCountFrom(totals),
    utxoCount: draft.orderedInputs.length,
  };
}

function summarizeDraftValue(draft: ClaimDraftResponse): ClaimValueSummary {
  return draftBatchSummary(draft);
}

function summarizeClaimRows(rows: ClaimRow[]): ClaimValueSummary {
  return {
    lovelace: sumLovelace(rows),
    assetCount: rows.reduce((total, row) => total + (row.assetCount ?? row.summary.length), 0),
    utxoCount: rows.length,
  };
}

function summarizeSubmittedClaims(claims: SubmittedClaimTx[]): ClaimValueSummary | null {
  const summaries = claims.map((claim) => claim.valueSummary).filter((summary): summary is ClaimValueSummary => Boolean(summary));
  if (summaries.length === 0) {
    return null;
  }
  return {
    lovelace: summaries.reduce((total, summary) => total + BigInt(summary.lovelace), 0n).toString(),
    assetCount: summaries.reduce((total, summary) => total + summary.assetCount, 0),
    utxoCount: summaries.reduce((total, summary) => total + summary.utxoCount, 0),
  };
}

function formatValueSummary(summary: ClaimValueSummary): string {
  const tokenLabel = `${summary.assetCount} token${summary.assetCount === 1 ? "" : "s"}`;
  return `${formatLovelace(summary.lovelace)} ADA + ${tokenLabel}`;
}

function proofGenerationRows(draft: ClaimDraftResponse): ProofRow[] {
  return draft.proofRequests.map((request, index) => {
    const input = draft.orderedInputs[index];
    const value = input ? summarizeAssetMap(input.value) : "Value unavailable";
    return {
      claim: abbreviateMiddle(request.out_ref, 18),
      value,
      proof: index === 0 ? "Generating" : "Waiting",
      status: index === 0 ? "generating" : "waiting",
    };
  });
}

function summarizeAssetMap(assets: AssetMap): string {
  const lovelace = lovelaceFromAssets(assets);
  const assetCount = assetCountFrom(assets);
  return assetCount > 0
    ? `${formatLovelace(lovelace)} ADA + ${assetCount} token${assetCount === 1 ? "" : "s"}`
    : `${formatLovelace(lovelace)} ADA`;
}

function assetLabel(unit: string): string {
  const tokenNameHex = unit.length > 56 ? unit.slice(56) : "";
  if (tokenNameHex && /^[0-9a-f]+$/iu.test(tokenNameHex) && tokenNameHex.length % 2 === 0) {
    const decoded = decodeHexText(tokenNameHex);
    if (decoded) {
      return decoded;
    }
  }
  return abbreviateMiddle(unit, 10);
}

function assetNameFromHex(value: string): string {
  if (/^[0-9a-f]+$/iu.test(value) && value.length % 2 === 0) {
    const decoded = decodeHexText(value);
    if (decoded) {
      return decoded;
    }
  }
  return value;
}

function decodeHexText(value: string): string {
  const chars: string[] = [];
  for (let index = 0; index < value.length; index += 2) {
    const charCode = Number.parseInt(value.slice(index, index + 2), 16);
    if (charCode < 32 || charCode > 126) {
      return "";
    }
    chars.push(String.fromCharCode(charCode));
  }
  return chars.join("");
}

function positiveQuantity(quantity: string): boolean {
  try {
    return BigInt(quantity) > 0n;
  } catch {
    return false;
  }
}

function sumLovelace(rows: ClaimRow[]): string {
  return rows.reduce((total, row) => total + BigInt(row.lovelace ?? "0"), 0n).toString();
}

function sumAssetMaps(assetMaps: AssetMap[]): AssetMap {
  const totals = new Map<string, bigint>();
  for (const assets of assetMaps) {
    for (const [unit, quantity] of Object.entries(assets)) {
      if (!positiveQuantity(quantity)) {
        continue;
      }
      totals.set(unit, (totals.get(unit) ?? 0n) + BigInt(quantity));
    }
  }
  return Object.fromEntries([...totals.entries()].map(([unit, quantity]) => [unit, quantity.toString()]));
}

function formatLovelace(value: string): string {
  let lovelace: bigint;
  try {
    lovelace = BigInt(value);
  } catch {
    return "0";
  }
  const whole = lovelace / 1_000_000n;
  const fractional = (lovelace % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fractional ? `${whole.toString()}.${fractional}` : whole.toString();
}

function abbreviateMiddle(value: string, visible = 18): string {
  if (value.length <= visible) {
    return value;
  }
  const edge = Math.max(4, Math.floor((visible - 3) / 2));
  return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function isClaimScreen(value: string): value is ClaimScreen {
  return fixtureScreens.has(value as ClaimScreen);
}
