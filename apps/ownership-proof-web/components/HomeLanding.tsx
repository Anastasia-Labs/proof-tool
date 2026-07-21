import {
  ArrowRight,
  Check,
  Fingerprint,
  Github,
  HeartHandshake,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Localize } from "./I18nProvider";
import type { AppLocale } from "../lib/i18n/locales";
import { alternateLocale, languageSwitchPath, localizedPath } from "../lib/i18n/locales";

const ICON = { sm: 16, md: 20, lg: 24, xl: 32 } as const;

const GITHUB_REPO_URL = "https://github.com/Anastasia-Labs/proof-tool";
const DOCS_URL = "https://github.com/Anastasia-Labs/proof-tool/tree/main/docs";

type TrustPoint = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const trustPoints: TrustPoint[] = [
  {
    icon: LockKeyhole,
    title: "Your recovery phrase stays on your device",
    body: "Proofs are generated locally, nothing is uploaded",
  },
  {
    icon: Wallet,
    title: "No account or signup",
    body: "Connect a wallet, prove, claim",
  },
  {
    icon: Github,
    title: "Open source",
    body: "Contracts and prover are public on GitHub",
  },
];

type HowItWorksStep = {
  title: string;
  body: string;
};

const howItWorksSteps: HowItWorksStep[] = [
  {
    title: "Connect the affected wallet",
    body: "Read-only — used to find funds locked for you",
  },
  {
    title: "Prove ownership locally",
    body: "Your recovery phrase is used only on your device",
  },
  {
    title: "Claim to a safe wallet",
    body: "Funds are released to a wallet you control",
  },
];

export function HomeLanding({ locale = "en" }: { locale?: AppLocale }) {
  const homePath = localizedPath(locale, "/");
  const claimPath = localizedPath(locale, "/claim");
  const reclaimPath = localizedPath(locale, "/reclaim");
  const nextLocale = alternateLocale(locale);
  const languageLabel = nextLocale === "ja" ? "日本語" : "English";
  return (
    <Localize>
      <main className="landing-page">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <header className="landing-header">
              <a className="landing-brand" href={homePath}>
                <strong>ReclaimGlobal</strong>
                <span>Cardano ownership recovery</span>
              </a>
            </header>
            <div className="landing-title-block">
              <h1 id="landing-title">Recover funds from a compromised Cardano wallet</h1>
              <p>
                If your wallet was compromised, your funds may have been rescued and locked for you. Prove you&rsquo;re
                the original owner — on your own device — and claim them. Your recovery phrase never leaves your device.
              </p>
            </div>

            <div className="landing-actions" role="group" aria-label="Recovery paths">
              <a className="landing-action primary" href={claimPath}>
                <ShieldCheck size={ICON.xl} aria-hidden="true" />
                <span className="landing-action-copy">
                  <span className="landing-action-badge">
                    <Sparkles size={ICON.sm} aria-hidden="true" />
                    Funds were taken from me
                  </span>
                  <span className="landing-action-label">Claim funds</span>
                  <small>Funds were taken from me — prove ownership and claim what was locked for you</small>
                </span>
                <ArrowRight size={ICON.lg} aria-hidden="true" />
              </a>
              <a className="landing-action secondary" href={reclaimPath}>
                <HeartHandshake size={ICON.xl} aria-hidden="true" />
                <span className="landing-action-copy">
                  <span className="landing-action-label">Lock / Donate funds</span>
                  <small>I&rsquo;m a rescuer or donor — lock funds only the original owner can claim</small>
                </span>
                <ArrowRight size={ICON.lg} aria-hidden="true" />
              </a>
            </div>

            <ul className="landing-trust-row" aria-label="Recovery guarantees">
              {trustPoints.map((point) => (
                <li className="landing-trust-point" key={point.title}>
                  <span className="landing-trust-icon" aria-hidden="true">
                    <point.icon size={ICON.lg} />
                  </span>
                  <span>
                    <strong>{point.title}</strong>
                    <small>{point.body}</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="landing-hero-visual" aria-hidden="true">
            <img
              src="/landing-recovery-hero.png"
              alt=""
              width={746}
              height={606}
              loading="eager"
              fetchPriority="high"
            />
          </div>
        </section>

        <section className="landing-how" aria-labelledby="landing-how-title">
          <h2 id="landing-how-title">How it works</h2>
          <ol className="landing-how-steps">
            {howItWorksSteps.map((step, index) => (
              <li className="landing-how-step" key={step.title}>
                <span className="landing-how-num" aria-hidden="true">
                  {index + 1}
                </span>
                <span>
                  <strong>{step.title}</strong>
                  <small>{step.body}</small>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-support" aria-labelledby="landing-support-title">
          <div className="landing-support-visual" aria-hidden="true">
            <span className="landing-mini-node muted">
              <Check size={ICON.md} />
            </span>
            <span className="landing-mini-node warm">
              <HeartHandshake size={ICON.lg} />
            </span>
            <span className="landing-mini-lock">
              <LockKeyhole size={ICON.xl} />
            </span>
            <span className="landing-mini-node ok">
              <Check size={ICON.lg} />
            </span>
          </div>
          <div className="landing-support-copy">
            <h2 id="landing-support-title">Lock / Donate creates funds only the original owner can claim</h2>
            <p>
              Locking places funds in an owner-bound UTxO on Cardano. Use it after sweeping from compromised
              credentials, or to donate in a way an attacker cannot claim without the original owner&rsquo;s proof.
            </p>
            <a className="landing-inline-link" href={reclaimPath}>
              Open lock / donate flow
              <ArrowRight size={ICON.sm} aria-hidden="true" />
            </a>
          </div>
        </section>

        <section className="landing-proof-band" aria-labelledby="landing-proof-title">
          <div>
            <Fingerprint size={ICON.xl} aria-hidden="true" />
            <h2 id="landing-proof-title">The proof reveals nothing about your keys</h2>
          </div>
          <p>
            You&rsquo;ll need the recovery phrase for the affected wallet. It is used only on your device to prove the
            compromised payment credential can be derived from your key — the phrase itself is never uploaded, and the
            proof cannot be used to spend from your wallet.
          </p>
        </section>
      </main>

      <footer className="landing-footer">
        <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
          <Github size={ICON.sm} aria-hidden="true" />
          View source on GitHub
        </a>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          Documentation
        </a>
        <a href={languageSwitchPath(nextLocale, localizedPath(nextLocale, "/"))} hrefLang={nextLocale}>
          {languageLabel}
        </a>
        <span className="landing-footer-network">Built for Cardano mainnet</span>
      </footer>
    </Localize>
  );
}
