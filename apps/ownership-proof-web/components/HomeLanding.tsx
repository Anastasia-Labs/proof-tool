import {
  ArrowRight,
  Check,
  Fingerprint,
  HeartHandshake,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React from "react";

type TrustPoint = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const trustPoints: TrustPoint[] = [
  {
    icon: ShieldCheck,
    title: "Master key stays local",
    body: "Never sent to any server",
  },
  {
    icon: KeyRound,
    title: "28-byte payment credential",
    body: "Cardano payment key hash",
  },
  {
    icon: ShieldCheck,
    title: "Mainnet proof path",
    body: "Built for Cardano mainnet",
  },
];

export function HomeLanding() {
  return (
    <main className="landing-page">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <p className="landing-brand">Ownership Recovery</p>
          <div className="landing-pill">
            <Sparkles size={22} aria-hidden="true" />
            <span>Most users start here</span>
          </div>
          <div className="landing-title-block">
            <h1 id="landing-title">Claim swept funds</h1>
            <p>
              Prove original ownership locally, then claim funds locked for the owner of the compromised payment
              credential.
            </p>
          </div>

          <div className="landing-actions" aria-label="Recovery paths">
            <a className="landing-action primary" href="/claim">
              <ShieldCheck size={39} aria-hidden="true" />
              <span>Claim funds</span>
              <ArrowRight size={33} aria-hidden="true" />
            </a>
            <a className="landing-action secondary" href="/reclaim">
              <HeartHandshake size={34} aria-hidden="true" />
              <span>Lock or donate funds</span>
              <ArrowRight size={31} aria-hidden="true" />
            </a>
            <p className="landing-action-note">For rescuers, white-hats, and donors</p>
          </div>

          <div className="landing-trust-row" aria-label="Recovery guarantees">
            {trustPoints.map((point) => (
              <section className="landing-trust-point" key={point.title}>
                <span className="landing-trust-icon" aria-hidden="true">
                  <point.icon size={31} />
                </span>
                <span>
                  <strong>{point.title}</strong>
                  <small>{point.body}</small>
                </span>
              </section>
            ))}
          </div>
        </div>

        <div className="landing-hero-visual" aria-hidden="true">
          <img src="/landing-recovery-hero.png" alt="" />
        </div>
      </section>

      <section className="landing-support" aria-labelledby="landing-support-title">
        <div className="landing-support-visual" aria-hidden="true">
          <span className="landing-mini-node muted">
            <Check size={22} />
          </span>
          <span className="landing-mini-node warm">
            <HeartHandshake size={24} />
          </span>
          <span className="landing-mini-lock">
            <LockKeyhole size={39} />
          </span>
          <span className="landing-mini-node ok">
            <Check size={27} />
          </span>
        </div>
        <div className="landing-support-copy">
          <h2 id="landing-support-title">Lock / Donate creates an original-owner-only UTxO</h2>
          <p>
            Use it after sweeping from compromised credentials, or to donate in a way the attacker cannot claim without
            the master-derived proof.
          </p>
          <a className="landing-inline-link" href="/reclaim">
            Open lock / donate flow
            <ArrowRight size={19} aria-hidden="true" />
          </a>
        </div>
      </section>

      <section className="landing-proof-band" aria-labelledby="landing-proof-title">
        <div>
          <Fingerprint size={34} aria-hidden="true" />
          <h2 id="landing-proof-title">Proofs stay narrow</h2>
        </div>
        <p>
          The proof establishes derivability of the compromised 28-byte payment key credential. It does not ask you to
          trust a hosted server with your recovery phrase or master private key.
        </p>
      </section>
    </main>
  );
}
