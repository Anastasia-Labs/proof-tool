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
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClaimBuildResponse,
  ClaimDraftResponse,
  ClaimProgressResponse,
  ClaimSubmitResponse,
  IndexedReclaimUtxo,
  ReclaimUtxosResponse,
} from "../lib/claim/types";
import type { AssetMap, BrowserProvingDescriptor, DeploymentResponse, ReclaimApiError, ReclaimNetwork } from "../lib/reclaim/types";
import { LOVELACE_UNIT } from "../lib/reclaim/types";
import { ProvingCancelledError, checkBrowserProving, proveDestinationInBrowser } from "../lib/proving/browser-wasm";
import { proveDestinationViaHelper } from "../lib/proving/desktop-helper";
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

type ClaimHelperState = "unpaired" | "checking" | "ready" | "unavailable";
type LocalProofMethod = "desktop" | "browser";
type SafeWalletSigningSessionState =
  | "not-connected"
  | "resume-reconnect-required"
  | "ready"
  | "destination-blocked";
type ClaimSubmitPhase =
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
  claimRows: ClaimRow[];
  claimIndexerTotal: number;
  claimDiscoveryError: string;
  refreshClaimMatches: () => void;
  changeClaimsPage: (page: 1 | 2) => void;
  openClaimAssetModal: (row: ClaimRow) => void;
  draft: ClaimDraftResponse | null;
  draftError: string;
  helperState: ClaimHelperState;
  helperStatus: ClaimHelperStatusResponse | null;
  helperError: string;
  checkHelper: () => void;
  proofArtifacts: Record<string, unknown>[];
  proofError: string;
  proofMethod: LocalProofMethod | null;
  setProofMethod: React.Dispatch<React.SetStateAction<LocalProofMethod | null>>;
  browserProvingStatus: BrowserProvingStatus;
  browserProvingDetail: string;
  refreshBrowserProvingStatus: () => Promise<boolean>;
  proofProgress: ProofProgressEvent | null;
  cancelBrowserProving: () => void;
  generateClaimProofs: () => void;
  build: ClaimBuildResponse | null;
  buildError: string;
  submitError: string;
  safeWalletSigningAvailable: boolean;
  safeWalletSigningSessionState: SafeWalletSigningSessionState;
  submitPhase: ClaimSubmitPhase;
  submittedClaims: SubmittedClaimTx[];
  progress: ClaimProgressResponse | null;
  buildOrSubmitCurrentBatch: () => void;
  refreshSubmittedProgress: () => void;
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
  status: "Confirmed" | "Pending";
};

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
  { id: 1, label: "Deployment", icon: Rocket },
  { id: 2, label: "Impacted Wallet", icon: Wallet },
  { id: 3, label: "Available Claims", icon: Coins },
  { id: 4, label: "Safe Wallet", icon: ShieldCheck },
  { id: 5, label: "Create Proofs", icon: KeyRound },
  { id: 6, label: "Current Batch", icon: RefreshCw },
  { id: 7, label: "Claim Review", icon: FileText },
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
  { id: 1, tx: "b1e4c8d2...9af3", output: 0, credential: "cred ...6c9a", ada: "1.20 ADA", assets: "2 assets", summary: ["SECOND", "LP"] },
  { id: 2, tx: "b1e4c8d2...9af3", output: 1, credential: "cred ...6c9a", ada: "0.80 ADA", assets: "No tokens", summary: [] },
  { id: 3, tx: "7f9a2d11...c4e0", output: 0, credential: "cred ...1d72", ada: "0.98 ADA", assets: "1 asset", summary: ["NFT"] },
  { id: 4, tx: "7f9a2d11...c4e0", output: 1, credential: "cred ...1d72", ada: "0.60 ADA", assets: "17 assets", summary: ["PASS", "GOLD"] },
  { id: 5, tx: "3c7bfa90...1d6a", output: 0, credential: "cred ...aa31", ada: "0.74 ADA", assets: "1 asset", summary: ["BADGE"] },
  { id: 6, tx: "3c7bfa90...1d6a", output: 1, credential: "cred ...aa31", ada: "0.40 ADA", assets: "No tokens", summary: [] },
  { id: 7, tx: "a9d431bb...7e33", output: 0, credential: "cred ...b8f4", ada: "1.05 ADA", assets: "3 assets", summary: ["XP", "MINT"] },
  { id: 8, tx: "d4a98b27...5b99", output: 0, credential: "cred ...90fe", ada: "0.50 ADA", assets: "2 assets", summary: ["Arena", "Boost"] },
  { id: 9, tx: "d4a98b27...5b99", output: 1, credential: "cred ...90fe", ada: "1.10 ADA", assets: "255 assets", summary: ["SECOND", "Badge"] },
  { id: 10, tx: "e52f6a10...2c41", output: 0, credential: "cred ...6c9a", ada: "0.35 ADA", assets: "5 assets", summary: ["Collect"] },
  { id: 11, tx: "e52f6a10...2c41", output: 0, credential: "cred ...6c9a", ada: "0.44 ADA", assets: "8 assets", summary: ["SECOND"] },
  { id: 12, tx: "a0b1d448...ef22", output: 1, credential: "cred ...1d72", ada: "0.69 ADA", assets: "No tokens", summary: [] },
  { id: 13, tx: "8dd9e7b1...7a10", output: 0, credential: "cred ...aa31", ada: "1.18 ADA", assets: "42 assets", summary: ["Gold"] },
  { id: 14, tx: "c6842fdd...5b7e", output: 2, credential: "cred ...90fe", ada: "0.36 ADA", assets: "1 asset", summary: ["Silver"] },
  { id: 15, tx: "5f91ac77...e0a8", output: 5, credential: "cred ...6c9a", ada: "0.82 ADA", assets: "15 assets", summary: ["Arena"] },
  { id: 16, tx: "9b2d14c3...3f90", output: 0, credential: "cred ...1d72", ada: "0.27 ADA", assets: "No tokens", summary: [] },
  { id: 17, tx: "1d7e5aaf...9b61", output: 1, credential: "cred ...aa31", ada: "0.63 ADA", assets: "4 assets", summary: ["Pass"] },
  { id: 18, tx: "7c31d9b5...2f8c", output: 2, credential: "cred ...90fe", ada: "0.31 ADA", assets: "No tokens", summary: [] },
  ];
  const batchRows = allClaims.slice(0, 4);
  return {
    allClaims,
    batchRows,
    proofQueue: [
      { claim: "1", value: "1.20 ADA + 2 tokens", proof: "Ready", status: "ready" },
      { claim: "2", value: "0.98 ADA + 1 token", proof: "Ready", status: "ready" },
      { claim: "3", value: "0.74 ADA + 1 token", proof: "Ready", status: "ready" },
      { claim: "8", value: "0.44 ADA", proof: "Generating", status: "generating" },
      { claim: "9", value: "1.05 ADA + 3 tokens", proof: "Waiting", status: "waiting" },
    ],
    transactions: [
      { batch: 1, txHash: `${"8b4c2a".padEnd(58, "0")}91fd`, displayHash: "8b4c2a...91fd", value: "3.42 ADA + 6 tokens", status: "Confirmed" },
      { batch: 2, txHash: `${"19af70".padEnd(58, "0")}a2c8`, displayHash: "19af70...a2c8", value: "4.01 ADA + 5 tokens", status: "Confirmed" },
      { batch: 3, txHash: `${"ef7739".padEnd(58, "0")}c014`, displayHash: "ef7739...c014", value: "2.84 ADA + 4 tokens", status: "Confirmed" },
      { batch: 4, txHash: `${"a60bd4".padEnd(58, "0")}771e`, displayHash: "a60bd4...771e", value: "3.15 ADA + 6 tokens", status: "Confirmed" },
      { batch: 5, txHash: `${"d2fc91".padEnd(58, "0")}0ab7`, displayHash: "d2fc91...0ab7", value: "2.45 ADA + 2 tokens", status: "Confirmed" },
    ],
  };
}

const ADDRESS_HEX_RE = /^[0-9a-f]+$/iu;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DESTINATION_PROFILE = "single-destination";
const releaseRepo = "https://github.com/Anastasia-Labs/proof-tool-release";
const windowsZipDownload = `${releaseRepo}/releases/latest/download/proof-helper_0.1.0_windows_x64.zip`;
const macZipDownload = `${releaseRepo}/releases/latest/download/proof-helper_0.1.0_macos_universal.zip`;
const linuxDebDownload = `${releaseRepo}/releases/latest/download/proof-helper_0.1.0_amd64.deb`;

const proofHelperDownloadChoices = [
  {
    platform: "windows",
    label: "Windows",
    description: "Downloads the Windows helper package.",
    action: "Download .zip",
    href: windowsZipDownload,
  },
  {
    platform: "mac",
    label: "macOS",
    description: "Downloads the universal macOS helper package.",
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

const claimFlowResumeStorageKey = "proof-tool.claim-flow.resume.v1";
const claimFlowResumeMaxAgeMs = 2 * 60 * 60 * 1000;
const clipboardReadTimeoutMs = 2_500;

const defaultCreateWorker = () =>
  new Worker(new URL("../workers/ownership-proof-worker.ts", import.meta.url), {
    type: "module",
  }) as WorkerLike;

export function ClaimFlow({ createWorker = defaultCreateWorker }: ClaimFlowProps = {}) {
  const [screen, setScreen] = useState<ClaimScreen>("deployment-review");
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
  const [helperUrl, setHelperUrl] = useState("");
  const [helperToken, setHelperToken] = useState("");
  const [helperState, setHelperState] = useState<ClaimHelperState>("unpaired");
  const [helperStatus, setHelperStatus] = useState<ClaimHelperStatusResponse | null>(null);
  const [helperError, setHelperError] = useState("");
  const [proofArtifacts, setProofArtifacts] = useState<Record<string, unknown>[]>([]);
  const [proofError, setProofError] = useState("");
  const [proofMethod, setProofMethod] = useState<LocalProofMethod | null>("browser");
  const [browserProvingStatus, setBrowserProvingStatus] = useState<BrowserProvingStatus>("unknown");
  const [browserProvingDetail, setBrowserProvingDetail] = useState("");
  const [proofProgress, setProofProgress] = useState<ProofProgressEvent | null>(null);
  const proofAbortRef = useRef<AbortController | null>(null);
  const [build, setBuild] = useState<ClaimBuildResponse | null>(null);
  const [buildError, setBuildError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitPhase, setSubmitPhase] = useState<ClaimSubmitPhase>("ready-to-sign");
  const [submittedClaims, setSubmittedClaims] = useState<SubmittedClaimTx[]>([]);
  const [progress, setProgress] = useState<ClaimProgressResponse | null>(null);

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

  useEffect(() => {
    if (fixtureEnabled) {
      return;
    }
    const pairing = readPairingFragment();
    if (!pairing) {
      return;
    }
    if ("error" in pairing) {
      setHelperState("unavailable");
      setHelperError(pairing.error);
    } else {
      const snapshot = readClaimFlowResumeSnapshot();
      if (snapshot) {
        restoreResumeSnapshot(snapshot);
      }
      setHelperUrl(pairing.helperUrl);
      setHelperToken(pairing.token);
      setHelperError("");
    }
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [fixtureEnabled, restoreResumeSnapshot]);

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

  const checkHelper = useCallback(async (): Promise<boolean> => {
    if (fixtureEnabled) {
      return true;
    }
    if (!helperUrl || !helperToken) {
      setHelperState("unpaired");
      setHelperStatus(null);
      setHelperError("Open Proof Helper from this page so it can pair with the claim flow.");
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
      });
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
      setHelperState("unavailable");
      setHelperError(sanitizeRecoverableError(error, "Proof Helper is unavailable."));
      return false;
    }
  }, [deployment, fixtureEnabled, helperToken, helperUrl]);

  useEffect(() => {
    if (!fixtureEnabled && helperUrl && helperToken) {
      void checkHelper();
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

  const browserProofRunning = screen === "create-proofs-generating" && proofMethod === "browser";
  useEffect(() => {
    if (!browserProofRunning || typeof window === "undefined") {
      return;
    }
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [browserProofRunning]);

  const cancelBrowserProving = useCallback(() => {
    proofAbortRef.current?.abort();
  }, []);

  const visibleScreen = screen === "available-claims-asset-modal" ? assetModalReturnScreen : screen;
  const activeStep = screenStep[screen];
  const goNext = () => {
    if (fixtureEnabled) {
      setScreen(nextScreen[screen] ?? screen);
    }
  };
  const goBack = () => setScreen(previousScreen[screen] ?? screen);

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
      setImpactedWalletError("No CIP-30 wallet is available for impacted credential discovery.");
      return;
    }

    try {
      const api = await provider.enable();
      const networkId = await api.getNetworkId();
      if (networkId !== deployment.deployment.networkId) {
        setImpactedWallet(null);
        setImpactedWalletError(
          `Connected wallet is on network id ${networkId}; this deployment expects ${deployment.deployment.networkId}.`,
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
    setSubmitPhase("ready-to-sign");
    setClaimDiscoveryError("");
    setScreen("scanning-claims");
    try {
      const utxos = await fetchAllReclaimUtxos();
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
      setClaimRows([]);
      setClaimIndexerTotal(0);
      setClaimDiscoveryError(error instanceof Error ? error.message : "Unable to scan ReclaimBase UTxOs.");
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
      setClaimDiscoveryError("Find locally matching reclaim funds before connecting a safe wallet.");
      setScreen(claimRows.length === 0 ? "no-matching-funds" : "available-claims-page-1");
      return;
    }
    setScreen("safe-wallet");
  };

  const createOrRefreshClaimDraft = async (
    wallet: SafeWalletSummary | null = safeWallet,
    rows: ClaimRow[] = claimRows,
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
    const selectedRows = selectClaimBatchRows(rows, pendingOutrefs, deployment);
    const selectedOutrefs = selectedRows.map((row) => row.outRefId).filter((outRefId): outRefId is string => Boolean(outRefId));
    if (selectedOutrefs.length === 0) {
      setDraftError("No locally matched reclaim UTxOs remain for the next claim batch.");
      setScreen("claim-review-complete");
      return null;
    }

    setDraftError("");
    setProofArtifacts([]);
    setProofError("");
    setBuild(null);
    setBuildError("");
    setSubmitError("");
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
      setDraftError(sanitizeRecoverableError(error, "Unable to create a claim draft."));
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
      setSafeWalletError("Find locally matching impacted-wallet funds before connecting a safe wallet.");
      setScreen("available-claims-page-1");
      return;
    }
    const provider = wallets.find(([id]) => id === selectedSafeWallet)?.[1];
    if (!provider) {
      setSafeWallet(null);
      safeWalletApiRef.current = null;
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("not-connected");
      setSafeWalletError("No CIP-30 wallet is available for safe-wallet signing.");
      return;
    }

    try {
      const api = await provider.enable();
      if (!hasSigningWalletApi(api)) {
        setSafeWallet(null);
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("not-connected");
        setSafeWalletError("The safe wallet must support CIP-30 signTx.");
        return;
      }
      const networkId = await api.getNetworkId();
      if (networkId !== deployment.deployment.networkId) {
        setSafeWallet(null);
        safeWalletApiRef.current = null;
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("not-connected");
        setSafeWalletError(
          `Safe wallet is on network id ${networkId}; this deployment expects ${deployment.deployment.networkId}.`,
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
        setSafeWalletError("This safe wallet shares a claimable wallet credential hash with the impacted wallet. Choose a different destination.");
        setScreen("safe-wallet-overlap");
        return;
      }
      safeWalletApiRef.current = api;
      setSafeWalletSigningAvailable(true);
      setSafeWalletSigningSessionState("ready");
      setSafeWallet(walletSummary);
      const nextDraft = await createOrRefreshClaimDraft(walletSummary);
      setScreen(nextDraft ? "create-proofs-ready" : "safe-wallet");
    } catch (error) {
      setSafeWallet(null);
      safeWalletApiRef.current = null;
      setSafeWalletSigningAvailable(false);
      setSafeWalletSigningSessionState("not-connected");
      setSafeWalletError(sanitizeRecoverableError(error, "Unable to connect the safe wallet."));
      setScreen("safe-wallet");
    }
  };

  const generateClaimProofs = async () => {
    if (fixtureEnabled) {
      goNext();
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

    if (proofMethod === "browser") {
      await generateClaimProofsInBrowser(deployment.deployment.verifierVkHash);
      return;
    }

    const helperReady = await checkHelper();
    if (!helperReady) {
      setScreen("helper-unavailable");
      return;
    }

    const seedPhrase = readAndClearRecoveryPhrase();
    setScreen("create-proofs-generating");
    let masterBytes: Uint8Array | null = null;
    try {
      const workerResponse = await deriveMasterXPrv(seedPhrase, createWorker);
      if (workerResponse.type === "error") {
        setProofError(workerResponse.message);
        setScreen(workerResponse.code === "path_not_found" ? "proof-failed" : "proof-failed");
        return;
      }
      masterBytes = new Uint8Array(workerResponse.masterXPrv);
      const helperResponse = await proveDestinationViaHelper({
        masterXPrv: masterBytes,
        draft,
        helperUrl,
        helperToken,
      });
      const artifacts = validateDestinationProofResponse(helperResponse, draft, deployment.deployment.verifierVkHash);
      setProofArtifacts(artifacts);
      setScreen("create-proofs-complete");
    } catch (error) {
      setProofArtifacts([]);
      setProofError(sanitizeRecoverableError(error, "The local helper could not generate destination-bound proofs."));
      setScreen("proof-failed");
    } finally {
      masterBytes?.fill(0);
    }
  };

  // Browser provider path: capability + asset preflight re-runs and must pass
  // BEFORE the phrase is read from the DOM — if this browser cannot prove, no
  // seed material may exist in page memory.
  const generateClaimProofsInBrowser = async (expectedVkHash: string) => {
    if (!draft || !browserProvingDescriptor) {
      setProofError("Browser proving is not enabled for this build yet.");
      return;
    }
    const ready = await refreshBrowserProvingStatus();
    if (!ready) {
      setProofError("This browser cannot generate proofs right now. Choose Proof Helper Desktop to continue.");
      return;
    }

    const seedPhrase = readAndClearRecoveryPhrase();
    setScreen("create-proofs-generating");
    setProofProgress(null);
    let masterBytes: Uint8Array | null = null;
    const abortController = new AbortController();
    proofAbortRef.current = abortController;
    try {
      const workerResponse = await deriveMasterXPrv(seedPhrase, createWorker);
      if (workerResponse.type === "error") {
        setProofError(workerResponse.message);
        setScreen("proof-failed");
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
      setProofArtifacts(artifacts);
      setScreen("create-proofs-complete");
    } catch (error) {
      setProofArtifacts([]);
      if (error instanceof ProvingCancelledError) {
        setProofError("");
        setScreen("create-proofs-ready");
        return;
      }
      setProofError(sanitizeRecoverableError(error, "Browser proving failed. Proof Helper Desktop is still available."));
      setScreen("proof-failed");
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
        setSubmitError("The safe wallet must support CIP-30 signTx before the claim can be signed.");
        return null;
      }
      const networkId = await api.getNetworkId();
      if (networkId !== deployment.deployment.networkId) {
        setSafeWalletSigningAvailable(false);
        setSafeWalletSigningSessionState("resume-reconnect-required");
        setSubmitPhase("reconnect-required");
        setSubmitError(`Safe wallet is on network id ${networkId}; this deployment expects ${deployment.deployment.networkId}.`);
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
        setSubmitError("The reconnected safe wallet now overlaps with an impacted credential. Choose a different destination and create a new proof batch.");
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
    if (build && (isSubmitBusy(submitPhase) || submitInFlightRef.current)) {
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
      setBuildError("");
      setSubmitError("");
      try {
        const nextBuild = await postJSON<ClaimBuildResponse>("/claim-api/build", {
          deploymentId: deployment.deployment.id,
          networkId: deployment.deployment.networkId,
          draftId: draft.draftId,
          selectedOutrefs: draft.orderedInputs.map((input) => input.outRefId),
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
    try {
      setSubmitPhase("signing-in-wallet");
      const witnessSetCbor = await signingApi.signTx(build.txCbor, true);
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
      setSubmitError(sanitizeRecoverableError(error, "Claim transaction was not submitted."));
      setScreen("signature-rejected");
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
        const nextDraft = await createOrRefreshClaimDraft(safeWallet, nextRows);
        setScreen(nextDraft ? "create-proofs-ready" : "available-claims-page-1");
      }
    } catch (error) {
      setSubmitPhase("failed");
      setSubmitError(sanitizeRecoverableError(error, "Unable to refresh claim progress."));
      setScreen("submitted-refreshing");
    }
  };

  const refreshSubmittedProgress = () => {
    if (fixtureEnabled) {
      goNext();
      return;
    }
    const outrefs = submittedClaims.flatMap((claim) => claim.selectedOutrefs);
    void refreshProgressAfterSubmit(outrefs.length > 0 ? outrefs : undefined, pendingOutrefs);
  };

  return (
    <main className="claim-shell" data-claim-state={screen}>
      <ClaimSidebar activeStep={activeStep} screen={screen} />
      <section className="claim-workspace">
        <ClaimTopNav />
        <div className="claim-page">
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
            claimRows,
            claimIndexerTotal,
            claimDiscoveryError,
            refreshClaimMatches: refreshClaimMatchesFromCurrentWallet,
            changeClaimsPage,
            openClaimAssetModal,
            draft,
            draftError,
            helperState,
            helperStatus,
            helperError,
            checkHelper,
            proofArtifacts,
            proofError,
            proofMethod,
            setProofMethod,
            browserProvingStatus,
            browserProvingDetail,
            refreshBrowserProvingStatus,
            proofProgress,
            cancelBrowserProving,
            generateClaimProofs,
            build,
            buildError,
            submitError,
            safeWalletSigningAvailable,
            safeWalletSigningSessionState,
            submitPhase,
            submittedClaims,
            progress,
            buildOrSubmitCurrentBatch,
            refreshSubmittedProgress,
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
          indexerTotal={runtime.claimIndexerTotal}
          discoveryError={runtime.claimDiscoveryError}
          onRefresh={runtime.refreshClaimMatches}
          onNext={runtime.continueToSafeWallet}
          onBack={goBack}
          onPageChange={runtime.changeClaimsPage}
          onViewAsset={runtime.openClaimAssetModal}
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
          onBack={goBack}
        />
      );
    case "insufficient-ada":
      return (
        <SafeWallet
          insufficientAda
          deployment={runtime.deployment}
          wallets={runtime.wallets}
          selectedWallet={runtime.selectedSafeWallet}
          onSelectWallet={runtime.setSelectedSafeWallet}
          safeWallet={runtime.safeWallet}
          error={runtime.safeWalletError}
          draft={runtime.draft}
          draftError={runtime.draftError}
          onNext={runtime.connectSafeWallet}
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
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelBrowserProving}
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
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelBrowserProving}
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
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelBrowserProving}
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
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelBrowserProving}
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
          proofError={runtime.proofError}
          draftError={runtime.draftError}
          proofArtifacts={runtime.proofArtifacts}
          proofMethod={runtime.proofMethod}
          onSelectProofMethod={runtime.setProofMethod}
          browserProvingStatus={runtime.browserProvingStatus}
          browserProvingDetail={runtime.browserProvingDetail}
          onRecheckBrowserProving={runtime.refreshBrowserProvingStatus}
          proofProgress={runtime.proofProgress}
          onCancelProving={runtime.cancelBrowserProving}
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
          explorerNetwork={runtime.deployment?.available ? runtime.deployment.deployment.network : undefined}
          onNext={goNext}
          onBack={goBack}
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
          Lock Funds
        </a>
        <a href="/claim" className="claim-nav-link active" aria-current="page">
          <Coins size={25} aria-hidden="true" />
          Claim funds
        </a>
      </nav>
      <div className="claim-top-actions">
        <button className="claim-ghost-action" type="button">
          <HelpCircle size={22} aria-hidden="true" />
          Help
        </button>
        <button className="claim-ghost-action" type="button">
          <Settings size={23} aria-hidden="true" />
          Settings
        </button>
      </div>
    </header>
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
          <span>Cardano Recovery</span>
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
        <p>Your recovery is secured by ReclaimGlobal.</p>
        <p>We never access your funds.</p>
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
  const liveDeployment = deployment?.available ? deployment.deployment : null;
  const sourceCommit = liveDeployment?.sourceCommit ?? "4f3c9a1e2b6c8d0f91a4b7c3e0d29a6f48bd12c0";
  const deploymentLabel = liveDeployment?.id ?? "Pinned";
  const networkLabel = liveDeployment?.network ?? "Cardano mainnet";
  const baseScript = liveDeployment?.reclaimBaseScriptHash ?? "script1q9k9r0v6t2m313u4z8h8y2d0k5f4x7w8e5p2c3h6tx";
  const globalScript = liveDeployment?.reclaimGlobalScriptHash ?? "script1p7c2a5j9u8x316v0m4n9w5e2k3d7z6t1y8f4p5m4da";
  const paramsUtxo = liveDeployment?.paramsUtxo
    ? `${liveDeployment.paramsUtxo.tx_hash}#${liveDeployment.paramsUtxo.output_index}`
    : "7b9f2c1d6e8a3b4f7c9d0a1e5b6c3d2a9f1b8c7a#0";
  const paramsDatum = liveDeployment?.paramsUtxo?.datum_reclaim_base_script_hash
    ? `reclaimBaseHash: ${liveDeployment.paramsUtxo.datum_reclaim_base_script_hash}`
    : "reclaimBaseHash: script1q9k9r0v6t2m313u4z8h8y2d0k5f4x7w8e5p2c3h6tx";
  const deploymentKnownUnavailable = Boolean(unavailable || deployment?.available === false);
  return (
    <ClaimScreenFrame
      title="Review deployment"
      subtitle="Confirm the deployed contracts and recovery parameters before connecting a wallet."
      backLabel="Back"
      nextLabel={deploymentKnownUnavailable ? "Retry deployment" : "I reviewed deployment"}
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

      <Panel icon={Code2} title="Smart contracts">
        <ReviewRow label="mkReclaimBase" value={baseScript} />
        <ReviewRow label="mkReclaimGlobal" value={globalScript} />
      </Panel>

      <Panel icon={SlidersHorizontal} title="Recovery parameters">
        <ReviewRow label="Params UTxO" value={paramsUtxo} />
        <ReviewRow label="Parsed datum" value={paramsDatum} detail="The datum binds this deployment to the ReclaimBase script." />
      </Panel>

      <Panel icon={Github} title="Pinned source">
        <ReviewRow label="Git commit" value={sourceCommit} />
        <a className="claim-external-link" href={`${sourceRepoUrl}/commit/${sourceCommit}`}>
          <ExternalLink size={17} aria-hidden="true" />
          View commit on GitHub
          <span>{sourceRepoLabel}/commit/{abbreviateMiddle(sourceCommit, 12)}</span>
        </a>
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
      subtitle="Connect the wallet that held credentials affected by the SecondFi incident."
      backLabel="Back"
      nextLabel={wrongNetwork ? "Choose another wallet" : "Connect impacted wallet"}
      nextIcon={Wallet}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!hasWallets}
    >
      <div className="claim-two-column">
        <div className="claim-stack">
          <Notice icon={Wallet} title="SecondFi is in maintenance mode.">
            If you used SecondFi, import that wallet's recovery phrase into Lace or another CIP-30 wallet first, then
            connect it here.
          </Notice>
          <Notice tone={wrongNetwork ? "bad" : "info"} icon={wrongNetwork ? CircleAlert : HelpCircle} title={wrongNetwork ? "Wrong network" : undefined}>
            {wrongNetwork
              ? `This wallet is not on ${expectedNetwork}. Switch network before scanning claims.`
              : "This step only reads public wallet addresses and claimable wallet credential hashes. You will not sign a transaction with the impacted wallet."}
          </Notice>
          {error ? (
            <Notice tone="bad" icon={CircleAlert} title="Impacted wallet discovery stopped">
              {error}
            </Notice>
          ) : null}
          {impactedWallet ? (
            <Notice tone="ok" icon={Check} title="Impacted wallet connected">
              Found {impactedWallet.credentials.length} claimable wallet credential hash{impactedWallet.credentials.length === 1 ? "" : "es"} from{" "}
              {impactedWallet.addresses.length} public wallet address{impactedWallet.addresses.length === 1 ? "" : "es"}.
            </Notice>
          ) : null}
          <WalletChooser layout="list" wallets={wallets} selectedWallet={selectedWallet} onSelectWallet={onSelectWallet} />
        </div>
        <InfoPanel
          title="What happens next"
          items={[
            { icon: Search, title: "Find matching credentials", body: "We'll look for credentials derived from this wallet that have available funds." },
            { icon: Coins, title: "Scan ReclaimBase UTxOs", body: "We'll scan the ReclaimBase contract for funds tied to those credentials." },
            { icon: CalendarDays, title: "Show claimable funds", body: "You'll see the total funds available to reclaim before continuing." },
          ]}
          footer="Your seed phrase and private keys never leave your device."
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
  indexerTotal,
  discoveryError,
  onRefresh,
  onNext,
  onBack,
  onPageChange,
  onViewAsset,
}: {
  page?: 1 | 2;
  loading?: boolean;
  empty?: boolean;
  deployment?: ClaimDeploymentResponse | null;
  impactedWallet?: ImpactedWalletSummary | null;
  rows?: ClaimRow[];
  indexerTotal?: number;
  discoveryError?: string;
  onRefresh?: () => void;
  onNext: () => void;
  onBack: () => void;
  onPageChange: (page: 1 | 2) => void;
  onViewAsset: (row: ClaimRow) => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const allRows = realRows ?? (fixtureMode ? claimFixtureData().allClaims : []);
  const pageSize = 10;
  const hasSecondPage = allRows.length > pageSize;
  const effectivePage = page === 2 && hasSecondPage ? 2 : 1;
  const rows = effectivePage === 1 ? allRows.slice(0, pageSize) : allRows.slice(pageSize, pageSize * 2);
  const totalLovelace = sumLovelace(allRows);
  const totalAssets = allRows.reduce((total, row) => total + (row.assetCount ?? (row.summary.length > 0 ? row.summary.length : 0)), 0);
  const credentialCount = new Set(allRows.map((row) => row.credential)).size;
  const batchSize = deployment?.available ? deployment.deployment.batching?.default_utxo_count ?? 4 : 4;
  const estimatedBatches = allRows.length > 0 ? Math.ceil(allRows.length / batchSize) : 0;
  const walletLabel = impactedWallet ? abbreviateMiddle(impactedWallet.addresses[0] ?? impactedWallet.walletName, 14) : "Connect wallet";
  const visibleEmpty = Boolean(empty || (allRows.length === 0 && !loading));
  return (
    <ClaimScreenFrame
      title="Available claims"
      subtitle="These funds are locked at ReclaimBase with datum matching credentials from your impacted wallet."
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
          { icon: Coins, label: "Total claimable", value: `${formatLovelace(totalLovelace)} ADA`, detail: `${totalAssets} token bundle${totalAssets === 1 ? "" : "s"}` },
          {
            icon: KeyRound,
            label: "Matching UTxOs",
            value: String(allRows.length),
            detail: `Across ${credentialCount} credential${credentialCount === 1 ? "" : "s"}`,
          },
          { icon: CalendarDays, label: "Estimated batches", value: String(estimatedBatches), detail: `${batchSize} UTxOs per batch` },
        ]}
      />

      <div className="claim-content-with-aside">
        <Panel title="Funds you can reclaim" className="claim-table-panel">
          <div className="claim-table-tools">
            <label className="claim-search">
              <Search size={18} aria-hidden="true" />
              <input placeholder="Search tx, output, or credential" />
            </label>
            <Segmented options={["All", "ADA", "Tokens"]} />
            <button className="claim-secondary-button" type="button" onClick={onRefresh} disabled={!onRefresh || loading}>
              <RefreshCw size={18} aria-hidden="true" />
              Refresh
            </button>
          </div>
          {loading ? (
            <TableEmpty icon={RefreshCw} title="Scanning ReclaimBase" body="Checking public UTxOs against your local impacted credentials." />
          ) : discoveryError ? (
            <TableEmpty icon={CircleAlert} title="Claim scan unavailable" body={discoveryError} />
          ) : visibleEmpty ? (
            <TableEmpty
              icon={Search}
              title="No matching funds found"
              body={`No unclaimed ReclaimBase UTxOs matched this wallet's claimable wallet credential hashes${indexerTotal ? ` across ${indexerTotal} indexed UTxOs` : ""}.`}
            />
          ) : (
            <ClaimsTable rows={rows} page={effectivePage} totalRows={allRows.length} onPageChange={onPageChange} onViewAsset={onViewAsset} />
          )}
        </Panel>
        <InfoPanel
          title="Why these match"
          compact
          items={[
            { icon: Check, title: "Credential in datum", body: "Each UTxO's datum includes a claimable credential hash." },
            { icon: Check, title: "Credential belongs to impacted wallet", body: "The credential matches keys derived from your impacted wallet." },
            { icon: Check, title: "Unclaimed at ReclaimBase", body: "The funds are still locked and have not been claimed yet." },
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
  deployment,
  wallets,
  selectedWallet,
  onSelectWallet,
  safeWallet,
  error,
  draft,
  draftError,
  onNext,
  onBack,
}: {
  overlap?: boolean;
  insufficientAda?: boolean;
  deployment?: ClaimDeploymentResponse | null;
  wallets?: WalletEntry[];
  selectedWallet?: string;
  onSelectWallet?: React.Dispatch<React.SetStateAction<string>>;
  safeWallet?: SafeWalletSummary | null;
  error?: string;
  draft?: ClaimDraftResponse | null;
  draftError?: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const hasWallets = fixtureMode || wallets === undefined || wallets.length > 0;
  const expectedNetwork = deployment?.available ? deployment.deployment.network : "the configured network";
  return (
    <ClaimScreenFrame
      title="Connect safe wallet"
      subtitle="Connect a wallet you know is safe. Claimed funds will be sent to this wallet."
      backLabel="Back"
      nextLabel={safeWallet && draft ? "Refresh claim draft" : overlap ? "Choose another wallet" : "Connect safe wallet"}
      nextIcon={ShieldCheck}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!hasWallets}
    >
      <div className="claim-two-column">
        <div className="claim-stack">
          <Notice icon={ShieldCheck} title="Use a clean destination">
            Do not connect the impacted wallet here. Choose a wallet whose seed phrase and devices were not exposed
            during the SecondFi incident.
          </Notice>
          <Notice icon={HelpCircle} title="Why this comes before proofs">
            Reclaim proofs are destination-bound, so we need the safe wallet address before proofs are created.
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
            <Notice tone="bad" icon={CircleAlert} title="Shared wallet credential">
              This safe wallet shares a claimable wallet credential hash with the impacted wallet. Choose a different destination.
            </Notice>
          ) : null}
          {insufficientAda ? (
            <Notice tone="bad" icon={CircleAlert} title="More ADA needed">
              The safe wallet needs more ADA for fees, collateral, and min-ADA. Recovered funds will not be reduced for fees.
            </Notice>
          ) : null}
          {safeWallet ? (
            <Notice tone="ok" icon={Check} title="Safe wallet connected">
              Connected on {expectedNetwork} with {safeWallet.credentials.length} claimable wallet credential hash{safeWallet.credentials.length === 1 ? "" : "es"}.
            </Notice>
          ) : null}
          <ReviewRow label="Safe wallet" value={safeWallet?.walletName ?? "Not connected yet"} noCopy />
          <ReviewRow label="Receive address" value={safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 32) : "Connect wallet to preview"} noCopy />
          <ReviewRow label="Fees paid by" value="Safe wallet" icon={ShieldCheck} noCopy />
          <ReviewRow label="Impacted wallet signature" value="Not required" noCopy />
          {draft ? (
            <>
              <ReviewRow label="Current draft" value={abbreviateMiddle(draft.draftId, 24)} noCopy />
              <ReviewRow label="Draft inputs" value={`${draft.orderedInputs.length} UTxO${draft.orderedInputs.length === 1 ? "" : "s"}`} noCopy />
            </>
          ) : null}
          <Notice icon={Lock} title={undefined}>
            This address will be embedded in your reclaim proofs to ensure funds can only be sent here.
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
  proofError,
  draftError,
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
  proofError?: string;
  draftError?: string;
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
    setPasteStatus({
      tone: "ok",
      message: `Pasted ${words.length} recovery words into this device only.`,
    });
    return true;
  }, [recoveryPhraseWordCount]);

  useEffect(() => {
    if (!pendingRecoveryPhraseWords || pendingRecoveryPhraseWords.length !== recoveryPhraseWordCount) {
      return;
    }
    writeRecoveryPhraseWords(pendingRecoveryPhraseWords);
    setPasteStatus({
      tone: "ok",
      message: `Pasted ${pendingRecoveryPhraseWords.length} recovery words into this device only.`,
    });
    setPendingRecoveryPhraseWords(null);
  }, [pendingRecoveryPhraseWords, recoveryPhraseWordCount]);

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
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Connect safe wallet";
  const proofBlocked =
    methodMissing ||
    (browserSelected && !browserReady) ||
    (!fixtureMode && (!draft || !safeWallet || (!browserSelected && helperBad) || draft.buildSupported === false));
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
      subtitle="Generate local proofs for the claimable wallet credential hashes in this batch."
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
          { icon: ShieldCheck, label: "Safe wallet", value: safeWalletLabel },
          { icon: FileText, label: "Proofs needed", value: String(proofsNeeded) },
          { icon: KeyRound, label: "Generated", value: `${generated} of ${proofsNeeded}` },
        ]}
      />
      <Notice tone={proofBlocked || failed ? "bad" : "info"} icon={proofBlocked || failed ? CircleAlert : Lock} title={!browserSelected && helperBad ? "Proof Helper is not connected" : failed ? "Proof generation stopped" : blockedReason ? "Proof generation blocked" : undefined}>
        {activeError
          ? activeError
          : blockedReason
            ? blockedReason
          : !browserSelected && helperBad
            ? "Choose Proof Helper Desktop to install or open the desktop app before entering the recovery phrase."
          : failed
            ? browserSelected
              ? "Browser proving reported an error. Your recovery phrase was not uploaded. Proof Helper Desktop is still available."
              : "The local helper reported an error. Your recovery phrase was not uploaded."
            : browserSelected
              ? "Proofs will be generated in this browser. Expect about 2 minutes per proof on a fast machine; your recovery phrase stays on this device."
              : "Choose a local proof method before entering the recovery phrase. Your recovery phrase stays on this device."}
      </Notice>
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
            <span>Use the phrase for the impacted wallet, not the safe wallet.</span>
            <div className="claim-phrase-actions">
              <div className="claim-phrase-length" aria-label="Seed phrase length">
                <span>Seed phrase</span>
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
                onPaste={pasteRecoveryPhraseFromField}
              />
            ))}
          </div>
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
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Connect safe wallet";
  const queueRows = draft ? proofGenerationRows(draft) : fixtureMode ? claimFixtureData().proofQueue : [];
  const browserMode = proofMethod === "browser";
  const current = proofProgress?.current ?? 0;
  const completed = current > 0 ? current - 1 : 0;
  const stageLabel = proofProgress ? formatProofStage(proofProgress.stage) : "Starting";
  const stagePercent = proofProgress?.frac !== undefined ? Math.round(clampFraction(proofProgress.frac) * 100) : null;
  const engineLabel = browserMode ? "Proving in this browser" : "Proof Helper is running locally.";
  return (
    <ClaimScreenFrame
      title="Create proofs"
      subtitle={
        browserMode
          ? "Proof generation is running in this browser. Keep this tab open."
          : "Proof generation is running locally. Keep this tab and the Proof Helper open."
      }
      backLabel={browserMode ? "Cancel" : "Pause"}
      nextLabel="Generating proofs"
      nextIcon={RefreshCw}
      onBack={browserMode && onCancelProving ? onCancelProving : onBack}
      onNext={onNext}
    >
      <SummaryTiles
        tiles={[
          {
            icon: Monitor,
            label: browserMode ? "Browser prover" : "Local helper",
            value: "Generating",
            status: "Running",
          },
          { icon: ShieldCheck, label: "Safe wallet", value: safeWalletLabel, status: "Connected" },
          {
            icon: KeyRound,
            label: "Proofs generated",
            value: `${completed} of ${total}`,
            detail: browserMode ? "Running in browser" : "Running locally",
          },
          { icon: Clock3, label: "Remaining", value: `${Math.max(total - completed, 0)} proofs`, detail: "To generate" },
        ]}
      />
      <div className="claim-content-with-aside">
        <div className="claim-stack">
          <Panel title="Generating destination-bound proofs">
            <div className="claim-progress-card">
              <div
                className={`claim-progress-ring${browserMode && stagePercent !== null ? "" : " indeterminate"}`}
                aria-label="Proof generation in progress"
              >
                <RefreshCw className="spin" size={34} aria-hidden="true" />
              </div>
              <div>
                <h3>Generating {total} destination-bound proof{total === 1 ? "" : "s"}</h3>
                <p>{engineLabel}</p>
                {browserMode ? (
                  <>
                    <p className="claim-muted" role="status" aria-live="polite">
                      {current > 0 ? `Proof ${current} of ${total}` : "Preparing proof assets"} - {stageLabel}
                      {stagePercent !== null ? ` (${stagePercent}%)` : ""}
                    </p>
                    <p className="claim-muted">Keep this tab open - refreshing will restart proof generation.</p>
                    {onCancelProving ? (
                      <button className="claim-secondary-button" type="button" onClick={onCancelProving}>
                        <X size={16} aria-hidden="true" /> Cancel proof generation
                      </button>
                    ) : null}
                  </>
                ) : (
                  <p className="claim-muted">Per-proof progress will appear here when the helper exposes a streaming status channel.</p>
                )}
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
                <ProofQueue rows={queueRows} />
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
              : { icon: PlaySquare, title: "Keep the helper running", body: "The local helper must stay open until all proofs are generated." },
            { icon: RefreshCw, title: "Do not refresh this page", body: "Refreshing may interrupt the proof generation process." },
            { icon: ShieldCheck, title: "Seed phrase stays local", body: "Your seed phrase never leaves your device and is never shared." },
            browserMode
              ? { icon: PauseCircle, title: "You can cancel if needed", body: "Cancel to stop proving and return to the previous step." }
              : { icon: PauseCircle, title: "You can pause if needed", body: "Pause proof generation and resume from here." },
            { icon: Shield, title: "Proofs are destination-bound", body: "They can only be used to reclaim funds to your connected safe wallet." },
          ]}
        />
      </div>
    </ClaimScreenFrame>
  );
}

function formatProofStage(stage: string): string {
  const labels: Record<string, string> = {
    parse: "Parsing request",
    "decode-inputs": "Decoding inputs",
    "open-keys": "Opening proving key",
    "open-ccs": "Opening constraint system",
    "find-path": "Finding key path",
    probe: "Probing",
    prove: "Proving",
    verify: "Verifying",
    done: "Done",
  };
  if (labels[stage]) {
    return labels[stage];
  }
  if (stage.startsWith("prove")) {
    return "Proving";
  }
  return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : "Working";
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
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Connect safe wallet";
  const batchSummary = draft ? draftBatchSummary(draft) : null;
  const transactionCount = batchSummary ? Math.ceil(batchSummary.utxoCount / Math.max(draft?.batchCap.default ?? draft?.batchCap.requested ?? 1, 1)) : 0;
  const fixtureFirstBatchValue = fixtureMode ? "3.42 ADA, 6 tokens" : "";
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
          { icon: ShieldCheck, label: "Safe wallet", value: safeWalletLabel, detail: "Destination for all recovered funds." },
          { icon: KeyRound, label: "Proofs generated", value: `${proofArtifacts?.length ?? total} of ${total}`, detail: "All proofs are ready." },
          { icon: ArrowRight, label: "Next step", value: "Claim batch 1", detail: "Review and submit your first transaction." },
        ]}
      />
      <Notice icon={Check} title="Ready to claim">
        Your proofs are bound to the safe wallet address. They can only be used to send recovered funds there.
      </Notice>
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
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Connect safe wallet";
  const needsSignerReconnect = Boolean(build && !fixtureMode && !safeWalletSigningAvailable);
  const busy = isSubmitBusy(submitPhase);
  const nextLabel = submitButtonLabel({
    rejected,
    buildReady: Boolean(build),
    needsSignerReconnect,
    submitPhase,
  });
  const proofCount = proofArtifacts?.length ?? (fixtureMode ? rows.length : 0);
  const hasRealDraft = Boolean(draft);
  return (
    <ClaimScreenFrame
      title="Claim funds"
      subtitle="You're ready to claim the next batch of funds. Review the batch details below and continue."
      backLabel="Go back"
      nextLabel={nextLabel}
      nextIcon={Wallet}
      onBack={onBack}
      onNext={onNext}
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
        <Notice tone="info" icon={RefreshCw} title={submitPhaseTitle(submitPhase)}>
          {submitPhaseBody(submitPhase)}
        </Notice>
      ) : null}
      {rejected ? (
        <Notice tone="bad" icon={CircleAlert} title="Safe-wallet signature rejected">
          {submitError || "The transaction was not submitted. Review the batch and ask the safe wallet to sign again."}
        </Notice>
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
          {
            icon: Coins,
            label: overview ? "Matching funds" : "Available Claims",
            value: `${formatLovelace(summary.lovelace)} ADA`,
            detail: `${summary.assetCount} token${summary.assetCount === 1 ? "" : "s"} - ${rows.length} UTxO${rows.length === 1 ? "" : "s"}`,
            status: hasRealDraft || fixtureMode ? "Found" : "Blocked",
          },
          {
            icon: KeyRound,
            label: overview ? "Proof Helper" : "Create Proofs",
            value: overview ? "Helper service" : "Proofs ready",
            detail: overview ? "Connected" : `${proofCount} of ${rows.length}`,
            status: "Complete",
          },
          {
            icon: ShieldCheck,
            label: "Safe wallet",
            value: safeWalletLabel,
            status: safeWalletSigningStatusLabel(safeWalletSigningSessionState, safeWalletSigningAvailable),
            statusTone: safeWalletSigningAvailable ? "ok" : needsSignerReconnect ? "warn" : undefined,
          },
          {
            icon: RefreshCw,
            label: "Next claim batch",
            value: `${rows.length} UTxO${rows.length === 1 ? "" : "s"} ready`,
            detail: `${formatLovelace(summary.lovelace)} ADA - ${summary.assetCount} token${summary.assetCount === 1 ? "" : "s"}`,
            emphasis: true,
          },
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
          <button className="claim-secondary-button" type="button" disabled title="Return to available claims to rescan from the indexer.">
            <RefreshCw size={18} aria-hidden="true" />
            Rescan unavailable
          </button>
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
          <ReviewRow label="Safe wallet (destination)" value={safeWalletLabel} />
          <ReviewRow label="Estimated fee (paid by safe wallet)" value={build?.review ? "Included in build review" : "Build review required"} noCopy />
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
  explorerNetwork,
  onNext,
  onBack,
}: {
  pending?: boolean;
  submittedClaims?: SubmittedClaimTx[];
  progress?: ClaimProgressResponse | null;
  safeWallet?: SafeWalletSummary | null;
  explorerNetwork?: ReclaimNetwork;
  onNext: () => void;
  onBack: () => void;
}) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const fixtureTransactions = fixtureMode ? claimFixtureData().transactions : [];
  const rows =
    submittedClaims && submittedClaims.length > 0
      ? submittedClaims.map((tx, index) => ({
          batch: index + 1,
          txHash: tx.txHash,
          displayHash: abbreviateMiddle(tx.txHash, 14),
          value: tx.valueSummary ? formatValueSummary(tx.valueSummary) : `${tx.selectedOutrefs.length} UTxO${tx.selectedOutrefs.length === 1 ? "" : "s"}`,
          status: pending ? ("Pending" as const) : ("Confirmed" as const),
        }))
      : fixtureMode
        ? pending
          ? fixtureTransactions.map((tx, index) => (index === fixtureTransactions.length - 1 ? { ...tx, status: "Pending" as const } : tx))
          : fixtureTransactions
        : [];
  const recoveredSummary = summarizeSubmittedClaims(submittedClaims ?? []);
  const claimedCount = progress?.outrefs.filter((entry) => entry.state === "spent_or_unknown" || entry.state === "confirmed_spent").length;
  const totalCount = progress?.outrefs.length || submittedClaims?.reduce((total, tx) => total + tx.selectedOutrefs.length, 0) || (fixtureMode ? 18 : 0);
  const remainingCount = progress?.nextBatch.count ?? (fixtureMode && pending ? 2 : 0);
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Connect safe wallet";
  const recoveredTile = recoveredSummary
    ? { value: `${formatLovelace(recoveredSummary.lovelace)} ADA`, detail: `${recoveredSummary.assetCount} token${recoveredSummary.assetCount === 1 ? "" : "s"}` }
    : fixtureMode
      ? { value: pending ? "13.42 ADA" : "15.87 ADA", detail: pending ? "21 tokens confirmed" : "23 tokens" }
      : { value: `${totalCount} UTxO${totalCount === 1 ? "" : "s"}`, detail: "Submitted batch value unavailable" };
  return (
    <ClaimScreenFrame
      title="Claim review"
      subtitle={pending ? "Your latest claim transaction is submitted and waiting for confirmation." : "Review the funds recovered to your safe wallet and the on-chain transactions that claimed them."}
      backLabel="Start another recovery"
      nextLabel={pending ? "Refresh status" : "Done"}
      nextIcon={pending ? RefreshCw : CheckCircle2}
      onBack={onBack}
      onNext={onNext}
    >
      <Notice icon={pending ? RefreshCw : Check} title={pending ? "Claim submitted" : "Recovery complete"}>
        {pending ? "The selected batch is pending. Confirmed spends will be removed from remaining funds." : "All available claims for the impacted wallet have been submitted."}
      </Notice>
      <SummaryTiles
        tiles={[
          { icon: Coins, label: "Recovered", value: recoveredTile.value, detail: recoveredTile.detail },
          { icon: Coins, label: "Claimed UTxOs", value: `${claimedCount ?? (fixtureMode && pending ? 16 : totalCount)} of ${totalCount}` },
          { icon: FileText, label: "Claim transactions", value: String(rows.length) },
          { icon: CheckCircle2, label: "Remaining claims", value: String(remainingCount) },
          { icon: ShieldCheck, label: "Funds sent to safe wallet", value: safeWalletLabel, status: "Destination verified" },
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
          <button className="claim-secondary-button wide" type="button">
            <Download size={18} aria-hidden="true" />
            Download CSV
          </button>
          <button className="claim-secondary-button wide" type="button">
            <Copy size={18} aria-hidden="true" />
            Copy summary
          </button>
          <button className="claim-secondary-button wide" type="button">
            <ExternalLink size={18} aria-hidden="true" />
            Open safe wallet
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
  nextIcon: NextIcon = ArrowRight,
  onBack,
  onNext,
  nextDisabled,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  backLabel: string;
  nextLabel: string;
  nextIcon?: LucideIcon;
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <>
      <header className="claim-page-heading">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </header>
      <div className="claim-page-body">{children}</div>
      <footer className="claim-action-bar">
        <button className="claim-secondary-button" type="button" onClick={onBack}>
          <ArrowLeft size={21} aria-hidden="true" />
          {backLabel}
        </button>
        <button className="claim-primary-button" type="button" onClick={onNext} disabled={nextDisabled}>
          <NextIcon size={24} aria-hidden="true" />
          {nextLabel}
        </button>
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
  return phase === "reconnecting" || phase === "signing-in-wallet" || phase === "submitting" || phase === "submitted-refreshing";
}

function submitButtonLabel({
  rejected,
  buildReady,
  needsSignerReconnect,
  submitPhase,
}: {
  rejected?: boolean;
  buildReady: boolean;
  needsSignerReconnect: boolean;
  submitPhase?: ClaimSubmitPhase;
}): string {
  switch (submitPhase) {
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
        return "Retry signature";
      }
      if (!buildReady) {
        return "Build claim review";
      }
      return needsSignerReconnect ? "Reconnect and submit claim" : "Sign and submit claim";
  }
}

function submitPhaseTitle(phase?: ClaimSubmitPhase): string {
  switch (phase) {
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

  return (
    <div className="claim-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
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
            Seed phrase stays local and is read only after you choose a method.
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
  title,
  children,
  tone = "info",
}: {
  icon: LucideIcon;
  title?: string;
  children: React.ReactNode;
  tone?: "info" | "bad" | "ok";
}) {
  return (
    <div className={`claim-notice ${tone}`}>
      <span className="claim-icon-circle">
        <Icon size={28} aria-hidden="true" />
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

function ReviewRow({ label, value, detail, icon: Icon, noCopy }: { label: string; value: string; detail?: string; icon?: LucideIcon; noCopy?: boolean }) {
  return (
    <div className="claim-review-row">
      <span>{label}</span>
      <code>{value}</code>
      {Icon ? <Icon size={18} aria-hidden="true" /> : null}
      {!noCopy ? <CopyButton label={`Copy ${label}`} /> : null}
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function CopyButton({ label }: { label: string }) {
  return (
    <button className="claim-copy-button" type="button" aria-label={label}>
      <Copy size={15} aria-hidden="true" />
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
        detail: index === 0 ? "Detected CIP-30 wallet extension." : "Available CIP-30 wallet extension.",
        recommended: index === 0,
      }))
    : fixtureWallets.map((wallet) => ({
        ...wallet,
        id: wallet.name.toLowerCase(),
      }));
  return (
    <section className={`claim-wallet-chooser ${layout}`}>
      <h2>Choose a CIP-30 wallet</h2>
      {layout === "grid" ? <p>Use a different wallet than the impacted wallet.</p> : null}
      <div>
        {walletOptions.length === 0 ? (
          <button className="claim-wallet-option" type="button" disabled>
            <span className="claim-wallet-logo">?</span>
            <strong>No wallet found</strong>
            {layout === "list" ? <span>Install or unlock a CIP-30 wallet, then refresh this page.</span> : null}
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

function Segmented({ options }: { options: string[] }) {
  return (
    <div className="claim-segmented" role="tablist" aria-label="Filter">
      {options.map((option, index) => (
        <button key={option} className={index === 0 ? "active" : ""} type="button" role="tab" aria-selected={index === 0}>
          {option}
        </button>
      ))}
    </div>
  );
}

function ClaimsTable({
  rows,
  page,
  totalRows,
  onPageChange,
  onViewAsset,
}: {
  rows: ClaimRow[];
  page: 1 | 2;
  totalRows: number;
  onPageChange: (page: 1 | 2) => void;
  onViewAsset: (row: ClaimRow) => void;
}) {
  const pageSize = 10;
  const firstRow = totalRows === 0 ? 0 : page === 1 ? 1 : pageSize + 1;
  const lastRow = page === 1 ? Math.min(pageSize, totalRows) : Math.min(pageSize * 2, totalRows);
  const hasSecondPage = totalRows > pageSize;
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
              <th>Assets</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.tx}-${row.output}-${row.id}`}>
                <td>{row.tx}</td>
                <td>{row.output}</td>
                <td>
                  {row.credential} <CopyButton label={`Copy credential ${row.id}`} />
                </td>
                <td>{row.ada}</td>
                <td>{row.assets}</td>
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
        <div className="claim-pagination">
          <button disabled={page === 1} type="button" onClick={() => onPageChange(1)}>Previous</button>
          <button className={page === 1 ? "active" : ""} type="button" onClick={() => onPageChange(1)}>1</button>
          <button className={page === 2 ? "active" : ""} type="button" disabled={!hasSecondPage} onClick={() => onPageChange(2)}>2</button>
          <button disabled={page === 2 || !hasSecondPage} type="button" onClick={() => onPageChange(2)}>Next</button>
        </div>
      </div>
    </>
  );
}

function TableEmpty({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="claim-table-empty">
      <Icon size={36} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function AssetModal({ row, onClose }: { row: ClaimRow; onClose: () => void }) {
  const outRefId = row.outRefId ?? `${row.tx}#${row.output}`;
  const credential = row.paymentCredential ?? row.credential;
  const assetDetails = claimAssetRows(row.value);
  return (
    <div className="claim-modal-backdrop" role="presentation">
      <section className="claim-asset-modal" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title">
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
            <input placeholder="Search policy id or asset name" />
          </label>
          <Segmented options={["All", "Tokens", "NFTs"]} />
          <button className="claim-secondary-button" type="button">
            <Copy size={18} aria-hidden="true" />
            Copy tx reference
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
              {assetDetails.length > 0 ? (
                assetDetails.map((asset) => (
                  <tr key={asset.unit}>
                    <td>
                      {abbreviateMiddle(asset.policyId, 18)} <CopyButton label={`Copy policy ${asset.policyId}`} />
                    </td>
                    <td>{asset.assetName}</td>
                    <td>{asset.quantity}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3}>No native assets in this UTxO.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <footer className="claim-modal-footer">
          <span>{assetDetails.length > 0 ? `Showing 1-${assetDetails.length} of ${assetDetails.length} assets` : "Showing 0 assets"}</span>
          <span>{assetDetails.length > 12 ? "Scroll to view more assets" : "All assets shown"}</span>
        </footer>
        <div className="claim-modal-actions">
          <button className="claim-secondary-button" type="button" onClick={onClose}>Close</button>
          <button className="claim-primary-button" type="button" onClick={onClose}>Done reviewing</button>
        </div>
      </section>
    </div>
  );
}

function ProofPlan({ draft, safeWallet }: { draft?: ClaimDraftResponse | null; safeWallet?: SafeWalletSummary | null }) {
  const fixtureMode = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";
  const proofCount = draft?.orderedInputs.length ?? (fixtureMode ? 18 : 0);
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Connect safe wallet";
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

function ProofQueue({ rows }: { rows: ProofRow[] }) {
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
            <td>{row.status === "ready" ? <CheckCircle2 size={20} /> : row.status === "generating" ? <RefreshCw className="spin" size={20} /> : <span className="claim-waiting-dot" />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BatchProofTable({ draft, safeWallet }: { draft?: ClaimDraftResponse | null; safeWallet?: SafeWalletSummary | null }) {
  const rows = draft?.orderedInputs ?? [];
  const safeWalletLabel = safeWallet ? abbreviateMiddle(safeWallet.changeAddress, 18) : "Connect safe wallet";
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
            <td>{safeWalletLabel} <CopyButton label={`Copy claim ${index + 1} destination`} /></td>
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
          {batchRows.map((row, index) => (
            <tr key={row.id}>
              <td>{index + 1}</td>
              <td>{row.tx} <CopyButton label={`Copy tx reference ${row.id}`} /></td>
              <td>{row.ada.replace(" ADA", "")}</td>
              <td>{row.summary.length || "No"}</td>
              <td><AssetDots labels={row.summary} /></td>
              <td><span className="claim-badge ready">Ready</span></td>
            </tr>
          ))}
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
            <td>{abbreviateMiddle(input.outRefId, 18)} <CopyButton label={`Copy tx reference ${index + 1}`} /></td>
            <td>{formatLovelace(lovelace)}</td>
            <td>{assetCount || "No"}</td>
            <td><AssetDots labels={labels} /></td>
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

function AssetDots({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return <span>No tokens</span>;
  }
  return (
    <span className="claim-asset-dots">
      {labels.slice(0, 2).map((label) => (
        <span key={label}>{label.slice(0, 1)}</span>
      ))}
      {labels.length > 1 ? `+ ${labels.length} more` : "+ 1 more"}
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

async function fetchAllReclaimUtxos(): Promise<IndexedReclaimUtxo[]> {
  const utxos: IndexedReclaimUtxo[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await fetchJSON<ReclaimUtxosResponse>(`/claim-api/reclaim-utxos?${params.toString()}`);
    if (!response.available) {
      throw new Error(response.reason || "Reclaim UTxO index is unavailable.");
    }
    utxos.push(...response.utxos);
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

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = payload as Partial<ReclaimApiError> & { reason?: string };
    throw new Error(error.error || error.reason || "Request failed.");
  }
  return payload as T;
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

function selectClaimBatchRows(rows: ClaimRow[], pendingOutrefs: string[], deployment: ClaimDeploymentResponse): ClaimRow[] {
  if (!deployment.available) {
    return [];
  }
  const pending = new Set(pendingOutrefs);
  const defaultCap = deployment.deployment.batching?.default_utxo_count ?? 4;
  const hardCap = deployment.deployment.batching?.hard_max_utxo_count ?? 5;
  return rows
    .filter((row) => row.outRefId && !pending.has(row.outRefId))
    .sort(compareClaimRows)
    .slice(0, Math.min(defaultCap, hardCap));
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
    throw new Error("Connected wallet did not expose any claimable wallet credential hashes.");
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

  throw new Error("Wallet address does not contain a claimable wallet credential hash.");
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
