"use client";

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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

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
  emphasis?: boolean;
};

type ClaimRow = {
  id: number;
  tx: string;
  output: number;
  credential: string;
  ada: string;
  assets: string;
  summary: string[];
};

type ProofRow = {
  claim: string;
  value: string;
  proof: string;
  status: "ready" | "generating" | "waiting";
};

type TransactionRow = {
  batch: number;
  hash: string;
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

const assetRows = [
  ["policy1v9...4ad2", "SECOND", "12,500"],
  ["policy1v9...4ad2", "LP-Token-42", "1"],
  ["policy8k3...7b91", "4d494e54", "84"],
  ["policy8k3...7b91", "MINT", "10"],
  ["policy9af...c2e1", "54494bEE1", "25"],
  ["policy1y2...9fd4", "Badge Gold", "1"],
  ["policy1y2...9fd4", "Badge Silver", "3"],
  ["policy3z7...1a88", "COLLECTIBLE-001", "1"],
  ["policy3z7...1a88", "COLLECTIBLE-002", "1"],
  ["policy3z7...1a88", "COLLECTIBLE-003", "1"],
  ["policy5m1...6c3f", "Arena Pass", "2"],
  ["policy5m1...6c3f", "Season XP Booster", "5"],
];

const proofQueue: ProofRow[] = [
  { claim: "1", value: "1.20 ADA + 2 tokens", proof: "Ready", status: "ready" },
  { claim: "2", value: "0.98 ADA + 1 token", proof: "Ready", status: "ready" },
  { claim: "3", value: "0.74 ADA + 1 token", proof: "Ready", status: "ready" },
  { claim: "8", value: "0.44 ADA", proof: "Generating", status: "generating" },
  { claim: "9", value: "1.05 ADA + 3 tokens", proof: "Waiting", status: "waiting" },
];

const transactions: TransactionRow[] = [
  { batch: 1, hash: "8b4c2a...91fd", value: "3.42 ADA + 6 tokens", status: "Confirmed" },
  { batch: 2, hash: "19af70...a2c8", value: "4.01 ADA + 5 tokens", status: "Confirmed" },
  { batch: 3, hash: "ef7739...c014", value: "2.84 ADA + 4 tokens", status: "Confirmed" },
  { batch: 4, hash: "a60bd4...771e", value: "3.15 ADA + 6 tokens", status: "Confirmed" },
  { batch: 5, hash: "d2fc91...0ab7", value: "2.45 ADA + 2 tokens", status: "Confirmed" },
];

export function ClaimFlow() {
  const [screen, setScreen] = useState<ClaimScreen>("deployment-review");
  const fixtureEnabled = process.env.NEXT_PUBLIC_CLAIM_UI_FIXTURE === "1";

  useEffect(() => {
    if (!fixtureEnabled) {
      return;
    }
    const requested = new URLSearchParams(window.location.search).get("fixtureState");
    if (requested && isClaimScreen(requested)) {
      setScreen(requested);
    }
  }, [fixtureEnabled]);

  const visibleScreen = screen === "available-claims-asset-modal" ? "available-claims-page-2" : screen;
  const activeStep = screenStep[screen];
  const goNext = () => setScreen(nextScreen[screen] ?? screen);
  const goBack = () => setScreen(previousScreen[screen] ?? screen);

  return (
    <main className="claim-shell" data-claim-state={screen}>
      <ClaimSidebar activeStep={activeStep} screen={screen} />
      <section className="claim-workspace">
        <ClaimTopNav />
        <div className="claim-page">{renderScreen(visibleScreen, goNext, goBack, setScreen)}</div>
      </section>
      {screen === "available-claims-asset-modal" ? <AssetModal onClose={() => setScreen("available-claims-page-2")} /> : null}
    </main>
  );
}

function renderScreen(
  screen: ClaimScreen,
  goNext: () => void,
  goBack: () => void,
  setScreen: React.Dispatch<React.SetStateAction<ClaimScreen>>,
) {
  switch (screen) {
    case "deployment-review":
      return <DeploymentReview onNext={goNext} onBack={goBack} />;
    case "deployment-unavailable":
      return <DeploymentReview unavailable onNext={goNext} onBack={goBack} />;
    case "impacted-wallet":
      return <ImpactedWallet onNext={goNext} onBack={goBack} />;
    case "wrong-network":
      return <ImpactedWallet wrongNetwork onNext={goNext} onBack={goBack} />;
    case "scanning-claims":
      return <AvailableClaims loading onNext={goNext} onBack={goBack} onViewAsset={() => setScreen("available-claims-asset-modal")} />;
    case "no-matching-funds":
      return <AvailableClaims empty onNext={goNext} onBack={goBack} onViewAsset={() => setScreen("available-claims-asset-modal")} />;
    case "available-claims-page-1":
      return <AvailableClaims page={1} onNext={goNext} onBack={goBack} onViewAsset={() => setScreen("available-claims-asset-modal")} />;
    case "available-claims-page-2":
      return <AvailableClaims page={2} onNext={goNext} onBack={goBack} onViewAsset={() => setScreen("available-claims-asset-modal")} />;
    case "safe-wallet":
      return <SafeWallet onNext={goNext} onBack={goBack} />;
    case "safe-wallet-overlap":
      return <SafeWallet overlap onNext={goNext} onBack={goBack} />;
    case "insufficient-ada":
      return <SafeWallet insufficientAda onNext={goNext} onBack={goBack} />;
    case "helper-unavailable":
      return <CreateProofs mode="helper-unavailable" onNext={goNext} onBack={goBack} />;
    case "create-proofs-ready":
      return <CreateProofs mode="ready" onNext={goNext} onBack={goBack} />;
    case "create-proofs-generating":
      return <CreateProofs mode="generating" onNext={goNext} onBack={goBack} />;
    case "proof-failed":
      return <CreateProofs mode="failed" onNext={goNext} onBack={goBack} />;
    case "create-proofs-complete":
      return <CreateProofs mode="complete" onNext={goNext} onBack={goBack} />;
    case "current-batch":
      return <CurrentBatch overview={false} onNext={goNext} onBack={goBack} />;
    case "claim-funds-overview":
      return <CurrentBatch overview onNext={goNext} onBack={goBack} />;
    case "signature-rejected":
      return <CurrentBatch rejected onNext={goNext} onBack={goBack} />;
    case "submitted-refreshing":
      return <ClaimReview pending onNext={goNext} onBack={goBack} />;
    case "claim-review-complete":
      return <ClaimReview onNext={goNext} onBack={goBack} />;
    default:
      return <DeploymentReview onNext={goNext} onBack={goBack} />;
  }
}

function ClaimTopNav() {
  return (
    <header className="claim-topbar">
      <nav className="claim-primary-nav" aria-label="Main">
        <a href="/" className="claim-nav-link">
          <KeyRound size={24} aria-hidden="true" />
          Proof
        </a>
        <a href="/reclaim" className="claim-nav-link">
          <Shield size={24} aria-hidden="true" />
          Fund recovery
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

function DeploymentReview({ unavailable, onNext, onBack }: { unavailable?: boolean; onNext: () => void; onBack: () => void }) {
  return (
    <ClaimScreenFrame
      title="Review deployment"
      subtitle="Confirm the deployed contracts and recovery parameters before connecting a wallet."
      backLabel="Back"
      nextLabel={unavailable ? "Retry deployment" : "I reviewed deployment"}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={false}
    >
      {unavailable ? (
        <Notice tone="bad" icon={CircleAlert} title="Deployment unavailable">
          The pinned claim deployment could not be loaded. Wallet connection and claim submission stay disabled until the
          manifest is available.
        </Notice>
      ) : null}

      <div className="claim-card-grid three">
        <MetricStripItem icon={Globe2} label="Network" value="Cardano mainnet" />
        <MetricStripItem icon={Lock} label="Deployment" value="Pinned" />
        <MetricStripItem icon={ShieldCheck} label="Claim flow" value="Single validator" />
      </div>

      <Panel icon={Code2} title="Smart contracts">
        <ReviewRow label="mkReclaimBase" value="script1q9k9r0v6t2m313u4z8h8y2d0k5f4x7w8e5p2c3h6tx" />
        <ReviewRow label="mkReclaimGlobal" value="script1p7c2a5j9u8x316v0m4n9w5e2k3d7z6t1y8f4p5m4da" />
      </Panel>

      <Panel icon={SlidersHorizontal} title="Recovery parameters">
        <ReviewRow label="Params UTxO" value="7b9f2c1d6e8a3b4f7c9d0a1e5b6c3d2a9f1b8c7a#0" />
        <ReviewRow label="Parsed datum" value="reclaimBaseHash: script1q9k9r0v6t2m313u4z8h8y2d0k5f4x7w8e5p2c3h6tx" detail="The datum binds this deployment to the ReclaimBase script." />
      </Panel>

      <Panel icon={Github} title="Pinned source">
        <ReviewRow label="Git commit" value="4f3c9a1e2b6c8d0f91a4b7c3e0d29a6f48bd12c0" />
        <a className="claim-external-link" href="https://github.com/reclaim-global/proof-zk-recovery/commit/4f3c9a1e2b6c8d0f91a4b7c3e0d29a6f48bd12c0">
          <ExternalLink size={17} aria-hidden="true" />
          View commit on GitHub
          <span>github.com/reclaim-global/proof-zk-recovery/commit/4f3c9a1e...</span>
        </a>
      </Panel>
    </ClaimScreenFrame>
  );
}

function ImpactedWallet({ wrongNetwork, onNext, onBack }: { wrongNetwork?: boolean; onNext: () => void; onBack: () => void }) {
  return (
    <ClaimScreenFrame
      title="Connect impacted wallet"
      subtitle="Connect the wallet that held credentials affected by the SecondFi incident."
      backLabel="Back"
      nextLabel={wrongNetwork ? "Choose another wallet" : "Connect impacted wallet"}
      nextIcon={Wallet}
      onBack={onBack}
      onNext={onNext}
    >
      <div className="claim-two-column">
        <div className="claim-stack">
          <Notice icon={Wallet} title="SecondFi is in maintenance mode.">
            If you used SecondFi, import that wallet's recovery phrase into Lace or another CIP-30 wallet first, then
            connect it here.
          </Notice>
          <Notice tone={wrongNetwork ? "bad" : "info"} icon={wrongNetwork ? CircleAlert : HelpCircle} title={wrongNetwork ? "Wrong network" : undefined}>
            {wrongNetwork
              ? "This wallet is not on Cardano mainnet. Switch network before scanning claims."
              : "This step only reads addresses and payment credentials. You will not sign a transaction with the impacted wallet."}
          </Notice>
          <WalletChooser layout="list" />
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
  onNext,
  onBack,
  onViewAsset,
}: {
  page?: 1 | 2;
  loading?: boolean;
  empty?: boolean;
  onNext: () => void;
  onBack: () => void;
  onViewAsset: () => void;
}) {
  const rows = page === 1 ? allClaims.slice(0, 10) : allClaims.slice(10, 18);
  return (
    <ClaimScreenFrame
      title="Available claims"
      subtitle="These funds are locked at ReclaimBase with datum matching credentials from your impacted wallet."
      backLabel="Back"
      nextLabel="Continue to safe wallet"
      nextIcon={ShieldCheck}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={Boolean(loading || empty)}
    >
      <SummaryTiles
        tiles={[
          { icon: Wallet, label: "Impacted wallet", value: "addr1q...f3k7l2", status: "Connected" },
          { icon: Coins, label: "Total claimable", value: "15.87 ADA", detail: "23 token bundles" },
          { icon: KeyRound, label: "Matching UTxOs", value: "18", detail: "Across 4 credentials" },
          { icon: CalendarDays, label: "Estimated batches", value: "5", detail: "4 UTxOs per batch" },
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
            <button className="claim-secondary-button" type="button">
              <RefreshCw size={18} aria-hidden="true" />
              Refresh
            </button>
          </div>
          {loading ? (
            <TableEmpty icon={RefreshCw} title="Scanning ReclaimBase" body="Checking public UTxOs against your local impacted credentials." />
          ) : empty ? (
            <TableEmpty icon={Search} title="No matching funds found" body="No unclaimed ReclaimBase UTxOs matched this wallet's payment credentials." />
          ) : (
            <ClaimsTable rows={rows} page={page} onViewAsset={onViewAsset} />
          )}
        </Panel>
        <InfoPanel
          title="Why these match"
          compact
          items={[
            { icon: Check, title: "Credential in datum", body: "Each UTxO's datum includes a payment key hash." },
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
  onNext,
  onBack,
}: {
  overlap?: boolean;
  insufficientAda?: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <ClaimScreenFrame
      title="Connect safe wallet"
      subtitle="Connect a wallet you know is safe. Claimed funds will be sent to this wallet."
      backLabel="Back"
      nextLabel={overlap ? "Choose another wallet" : "Connect safe wallet"}
      nextIcon={ShieldCheck}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={Boolean(overlap)}
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
          <WalletChooser layout="grid" />
        </div>
        <Panel icon={Wallet} title="Funds will arrive here" className={overlap || insufficientAda ? "claim-panel-alert" : undefined}>
          {overlap ? (
            <Notice tone="bad" icon={CircleAlert} title="Impacted credential reused">
              This safe wallet overlaps the impacted wallet credentials. Choose a different destination.
            </Notice>
          ) : null}
          {insufficientAda ? (
            <Notice tone="bad" icon={CircleAlert} title="More ADA needed">
              The safe wallet needs more ADA for fees, collateral, and min-ADA. Recovered funds will not be reduced for fees.
            </Notice>
          ) : null}
          <ReviewRow label="Safe wallet" value="Not connected yet" noCopy />
          <ReviewRow label="Receive address" value="Connect wallet to preview" noCopy />
          <ReviewRow label="Fees paid by" value="Safe wallet" icon={ShieldCheck} noCopy />
          <ReviewRow label="Impacted wallet signature" value="Not required" noCopy />
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
  onNext,
  onBack,
}: {
  mode: "ready" | "generating" | "complete" | "helper-unavailable" | "failed";
  onNext: () => void;
  onBack: () => void;
}) {
  if (mode === "generating") {
    return <CreateProofsGenerating onNext={onNext} onBack={onBack} />;
  }
  if (mode === "complete") {
    return <CreateProofsComplete onNext={onNext} onBack={onBack} />;
  }
  const helperBad = mode === "helper-unavailable";
  const failed = mode === "failed";
  return (
    <ClaimScreenFrame
      title="Create proofs"
      subtitle="Generate local proofs that show the impacted wallet owns the credentials for these claims."
      backLabel="Back"
      nextLabel={failed ? "Retry proofs" : "Generate proofs"}
      nextIcon={KeyRound}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={helperBad}
    >
      <SummaryTiles
        tiles={[
          { icon: Monitor, label: "Local helper", value: helperBad ? "Unavailable" : "Connected", status: helperBad ? "Action needed" : "Connected" },
          { icon: ShieldCheck, label: "Safe wallet", value: "addr1qx...7m9v4a" },
          { icon: FileText, label: "Proofs needed", value: "18" },
          { icon: KeyRound, label: "Generated", value: "0 of 18" },
        ]}
      />
      <Notice tone={helperBad || failed ? "bad" : "info"} icon={helperBad || failed ? CircleAlert : Lock} title={helperBad ? "Proof Helper is not connected" : failed ? "Proof generation stopped" : undefined}>
        {helperBad
          ? "Open the local Proof Helper before entering the recovery phrase."
          : failed
            ? "The local helper reported an error. Your recovery phrase was not uploaded."
            : "Your recovery phrase is sent only to the Proof Helper running locally on this computer. It is never sent to ReclaimGlobal servers."}
      </Notice>
      <div className="claim-content-with-aside">
        <Panel title="Impacted wallet recovery phrase" className="claim-phrase-panel">
          <div className="claim-panel-toolbar">
            <span>Use the phrase for the impacted wallet, not the safe wallet.</span>
            <label className="claim-toggle">
              Show words <input type="checkbox" aria-label="Show words" />
            </label>
            <button className="claim-secondary-button" type="button">
              <Copy size={18} aria-hidden="true" />
              Paste phrase
            </button>
          </div>
          <div className="claim-phrase-grid">
            {Array.from({ length: 24 }, (_, index) => (
              <input key={index} aria-label={`Recovery word ${index + 1}`} placeholder={`${index + 1}  word ${index + 1}`} type="password" autoComplete="off" />
            ))}
          </div>
        </Panel>
        <Panel title="Proof plan">
          <ProofPlan />
        </Panel>
      </div>
    </ClaimScreenFrame>
  );
}

function CreateProofsGenerating({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <ClaimScreenFrame
      title="Create proofs"
      subtitle="Proof generation is running locally. Keep this tab and the Proof Helper open."
      backLabel="Pause"
      nextLabel="Generating proofs"
      nextIcon={RefreshCw}
      onBack={onBack}
      onNext={onNext}
    >
      <SummaryTiles
        tiles={[
          { icon: Monitor, label: "Local helper", value: "Generating", status: "Running" },
          { icon: ShieldCheck, label: "Safe wallet", value: "addr1qx...7m9v4a", status: "Connected" },
          { icon: KeyRound, label: "Proofs generated", value: "7 of 18", detail: "39% complete" },
          { icon: Clock3, label: "Remaining", value: "11 proofs", detail: "To generate" },
        ]}
      />
      <div className="claim-content-with-aside">
        <div className="claim-stack">
          <Panel title="Generating destination-bound proofs">
            <div className="claim-progress-card">
              <div className="claim-progress-ring" style={{ "--claim-progress": "39%" } as React.CSSProperties}>
                <strong>39%</strong>
              </div>
              <div>
                <h3>7 of 18 proofs complete</h3>
                <p>Current claim: b1e4c8d2...9af3 <CopyButton label="Copy current claim" /></p>
                <p className="claim-muted">About 8 minutes remaining</p>
                <div className="claim-chip-row">
                  <span>Local only</span>
                  <span>Destination bound</span>
                  <span>No server upload</span>
                </div>
              </div>
            </div>
          </Panel>
          <Panel title="Proof queue">
            <ProofQueue rows={proofQueue} />
            <p className="claim-table-note">18 total claims - 7 complete - 1 generating - 10 waiting</p>
          </Panel>
        </div>
        <InfoPanel
          title="During proof generation"
          items={[
            { icon: PlaySquare, title: "Keep the helper running", body: "The local helper must stay open until all proofs are generated." },
            { icon: RefreshCw, title: "Do not refresh this page", body: "Refreshing may interrupt the proof generation process." },
            { icon: ShieldCheck, title: "Seed phrase stays local", body: "Your seed phrase never leaves your device and is never shared." },
            { icon: PauseCircle, title: "You can pause if needed", body: "Pause proof generation and resume from here." },
            { icon: Shield, title: "Proofs are destination-bound", body: "They can only be used to reclaim funds to your connected safe wallet." },
          ]}
        />
      </div>
    </ClaimScreenFrame>
  );
}

function CreateProofsComplete({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
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
          { icon: ShieldCheck, label: "Safe wallet", value: "addr1qx...7m9v4a", detail: "Destination for all recovered funds." },
          { icon: KeyRound, label: "Proofs generated", value: "18 of 18", detail: "All proofs are ready." },
          { icon: ArrowRight, label: "Next step", value: "Claim batch 1", detail: "Review and submit your first transaction." },
        ]}
      />
      <Notice icon={Check} title="Ready to claim">
        Your proofs are bound to the safe wallet address. They can only be used to send recovered funds there.
      </Notice>
      <div className="claim-content-with-aside">
        <Panel title="Claim plan">
          <div className="claim-summary-strip">
            <MetricText label="Total claims" value="18 UTxOs" />
            <MetricText label="Batch size" value="4 UTxOs" />
            <MetricText label="Transactions needed" value="5" />
            <MetricText label="First batch" value="4 UTxOs" detail="3.42 ADA, 6 tokens" />
          </div>
          <BatchProofTable />
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
  onNext,
  onBack,
}: {
  overview?: boolean;
  rejected?: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <ClaimScreenFrame
      title="Claim funds"
      subtitle="You're ready to claim the next batch of funds. Review the batch details below and continue."
      backLabel="Go back"
      nextLabel={rejected ? "Retry signature" : "Claim next batch"}
      nextIcon={Wallet}
      onBack={onBack}
      onNext={onNext}
    >
      {rejected ? (
        <Notice tone="bad" icon={CircleAlert} title="Safe-wallet signature rejected">
          The transaction was not submitted. Review the batch and ask the safe wallet to sign again.
        </Notice>
      ) : null}
      <SummaryTiles
        tiles={[
          { icon: Wallet, label: "Impacted Wallet", value: "addr1q...f3k7l2", status: "Connected" },
          { icon: Coins, label: overview ? "Matching funds" : "Available Claims", value: "15.87 ADA", detail: "23 tokens - 18 UTxOs", status: "Found" },
          { icon: KeyRound, label: overview ? "Proof Helper" : "Create Proofs", value: overview ? "Helper service" : "Proofs ready", detail: overview ? "Connected" : "4 of 4", status: "Complete" },
          { icon: ShieldCheck, label: "Safe wallet", value: "addr1qx...7m9v4a", status: "Connected" },
          { icon: RefreshCw, label: "Next claim batch", value: "4 UTxOs ready", detail: "3.42 ADA - 6 tokens", emphasis: true },
        ]}
      />
      <Panel>
        <div className="claim-summary-strip">
          <MetricText label="Recovery summary" value="" />
          <MetricText label="Total ADA" value="15.87 ADA" />
          <MetricText label="Total tokens" value="23" />
          <MetricText label="Matching UTxOs" value="18" />
          <MetricText label="Pending (not claimed)" value="14.27 ADA" detail="17 tokens" />
          <MetricText label="Ready to claim" value="3.42 ADA" detail="6 tokens" />
        </div>
      </Panel>
      <Panel title="Next claim batch" className="claim-table-panel">
        <div className="claim-panel-toolbar">
          <span className="claim-soft-badge">4 UTxOs ready</span>
          <button className="claim-secondary-button" type="button">
            <RefreshCw size={18} aria-hidden="true" />
            Refresh funds
          </button>
        </div>
        <BatchTable />
      </Panel>
      <Panel className="claim-review-strip">
        <Assurance icon={ShieldCheck} title="Funds will go to your safe wallet" body="Your recovered funds will be sent to your safe wallet." />
        <Assurance icon={Coins} title="Fees paid by safe wallet" body="Transaction fees for claiming are paid from your safe wallet." />
        <Assurance icon={KeyRound} title="No signature needed from impacted wallet" body="Claims are authorized by ReclaimGlobal." />
        <div className="claim-review-mini">
          <strong>Review</strong>
          <ReviewRow label="Safe wallet (destination)" value="addr1qx...7m9v4a" />
          <ReviewRow label="Estimated fee (paid by safe wallet)" value="0.17 ADA" noCopy />
          <details>
            <summary>Technical details</summary>
            <p>DestinationAddressV1 and proof order are recomputed by the backend before signing.</p>
          </details>
        </div>
      </Panel>
    </ClaimScreenFrame>
  );
}

function ClaimReview({ pending, onNext, onBack }: { pending?: boolean; onNext: () => void; onBack: () => void }) {
  const rows = pending ? transactions.map((tx, index) => (index === 4 ? { ...tx, status: "Pending" as const } : tx)) : transactions;
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
          { icon: Coins, label: "Recovered", value: pending ? "13.42 ADA" : "15.87 ADA", detail: pending ? "21 tokens confirmed" : "23 tokens" },
          { icon: Coins, label: "Claimed UTxOs", value: pending ? "16 of 18" : "18 of 18" },
          { icon: FileText, label: "Claim transactions", value: "5" },
          { icon: CheckCircle2, label: "Remaining claims", value: pending ? "2" : "0" },
          { icon: ShieldCheck, label: "Funds sent to safe wallet", value: "addr1qx...7m9v4a", status: "Destination verified" },
        ]}
      />
      <div className="claim-content-with-aside">
        <Panel title="Claim transactions" className="claim-table-panel">
          <TransactionTable rows={rows} />
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

function SummaryTileView({ tile }: { tile: SummaryTile }) {
  const Icon = tile.icon;
  return (
    <section className={`claim-summary-tile ${tile.emphasis ? "emphasis" : ""}`}>
      <Icon size={31} aria-hidden="true" />
      <div>
        <span>{tile.label}</span>
        <strong>{tile.value}</strong>
        {tile.detail ? <small>{tile.detail}</small> : null}
        {tile.status ? (
          <small className="claim-status-line">
            <CheckCircle2 size={15} aria-hidden="true" />
            {tile.status}
          </small>
        ) : null}
      </div>
    </section>
  );
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

function WalletChooser({ layout }: { layout: "list" | "grid" }) {
  const wallets = [
    { name: "Lace", detail: "The simplest and most secure way to connect.", recommended: true },
    { name: "Eternl", detail: "A feature-rich wallet for Cardano." },
    { name: "Yoroi", detail: "Lightweight and easy to use." },
  ];
  return (
    <section className={`claim-wallet-chooser ${layout}`}>
      <h2>Choose a CIP-30 wallet</h2>
      {layout === "grid" ? <p>Use a different wallet than the impacted wallet.</p> : null}
      <div>
        {wallets.map((wallet) => (
          <button key={wallet.name} className="claim-wallet-option" type="button">
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

function ClaimsTable({ rows, page, onViewAsset }: { rows: ClaimRow[]; page: 1 | 2; onViewAsset: () => void }) {
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
                  <button className="claim-table-action" type="button" onClick={onViewAsset}>
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
        <span>Showing {page === 1 ? "1-10" : "11-18"} of 18 UTxOs</span>
        <div className="claim-pagination">
          <button disabled={page === 1} type="button">Previous</button>
          <button className={page === 1 ? "active" : ""} type="button">1</button>
          <button className={page === 2 ? "active" : ""} type="button">2</button>
          <button disabled={page === 2} type="button">Next</button>
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

function AssetModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="claim-modal-backdrop" role="presentation">
      <section className="claim-asset-modal" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title">
        <header className="claim-modal-header">
          <div>
            <h2 id="asset-modal-title">UTxO assets</h2>
            <p>d4a98b27...5b99#1</p>
          </div>
          <button className="claim-icon-button" type="button" onClick={onClose} aria-label="Close asset modal">
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div className="claim-card-grid four compact">
          <MetricText label="Credential" value="cred ...90fe" />
          <MetricText label="ADA" value="1.10 ADA" />
          <MetricText label="Unique assets" value="255" />
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
              {assetRows.map(([policy, name, quantity]) => (
                <tr key={`${policy}-${name}`}>
                  <td>
                    {policy} <CopyButton label={`Copy policy ${policy}`} />
                  </td>
                  <td>{name}</td>
                  <td>{quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="claim-modal-footer">
          <span>Showing 1-12 of 255 assets</span>
          <span>Scroll to view more assets</span>
        </footer>
        <div className="claim-modal-actions">
          <button className="claim-secondary-button" type="button" onClick={onClose}>Close</button>
          <button className="claim-primary-button" type="button" onClick={onClose}>Done reviewing</button>
        </div>
      </section>
    </div>
  );
}

function ProofPlan() {
  return (
    <div className="claim-proof-plan">
      <MetricStripItem icon={Coins} label="Available claims" value="18 UTxOs" />
      <MetricStripItem icon={ShieldCheck} label="Destination bound to" value="addr1qx...7m9v4a" />
      <MetricStripItem icon={Code2} label="Default batch size" value="4 UTxOs" />
      <MetricStripItem icon={FileText} label="Estimated claim transactions" value="5" />
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

function BatchProofTable() {
  return (
    <table className="claim-table">
      <thead>
        <tr>
          <th>Claims</th>
          <th>Proofs</th>
          <th>Destination</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {[1, 2, 3, 4, 5].map((batch) => (
          <tr key={batch}>
            <td>Batch {batch}</td>
            <td>{batch === 5 ? 2 : 4}</td>
            <td>addr1qx...7m9v4a <CopyButton label={`Copy batch ${batch} destination`} /></td>
            <td><span className="claim-badge ready">Ready</span></td>
          </tr>
        ))}
        <tr>
          <td><strong>Total</strong></td>
          <td><strong>18</strong></td>
          <td>-</td>
          <td>-</td>
        </tr>
      </tbody>
    </table>
  );
}

function BatchTable() {
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
          <td><strong>3.42</strong></td>
          <td><strong>6</strong></td>
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

function TransactionTable({ rows }: { rows: TransactionRow[] }) {
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
          <tr key={row.hash}>
            <td>{row.batch}</td>
            <td>
              <a className="claim-tx-link" href={`https://cexplorer.io/tx/${row.hash}`}>
                {row.hash} <ExternalLink size={14} aria-hidden="true" />
              </a>
              <small>cexplorer.io/tx/{row.hash}</small>
            </td>
            <td>{row.value}</td>
            <td><span className={`claim-badge ${row.status === "Confirmed" ? "ready" : "generating"}`}>{row.status}</span></td>
          </tr>
        ))}
        <tr>
          <td><strong>Total recovered</strong></td>
          <td />
          <td><strong>15.87 ADA + 23 tokens</strong></td>
          <td />
        </tr>
      </tbody>
    </table>
  );
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

function isClaimScreen(value: string): value is ClaimScreen {
  return fixtureScreens.has(value as ClaimScreen);
}
