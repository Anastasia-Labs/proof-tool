"use client";

import { Check, Coins, Copy, HelpCircle, LockKeyhole, Settings, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React from "react";

export type ReclaimShellStepStatus = "pending" | "active" | "complete" | "attention";

export type ReclaimShellStep = {
  id: number;
  label: string;
  icon: LucideIcon;
  status: ReclaimShellStepStatus;
  statusLabel: string;
};

export type ReclaimSummaryTile = {
  icon: LucideIcon;
  label: string;
  value: string;
  detail?: string;
  status?: string;
  emphasis?: boolean;
};

export function ReclaimAppShell({
  active,
  steps,
  state,
  children,
}: {
  active: "lock" | "claim";
  steps: ReclaimShellStep[];
  state?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="claim-shell" data-lock-funds-state={state}>
      <ReclaimSidebar steps={steps} />
      <section className="claim-workspace">
        <ReclaimTopNav active={active} />
        <div className="claim-page">{children}</div>
      </section>
    </main>
  );
}

export function ReclaimTopNav({ active }: { active: "lock" | "claim" }) {
  return (
    <header className="claim-topbar">
      <nav className="claim-primary-nav" aria-label="Main">
        <a href="/reclaim" className={`claim-nav-link ${active === "lock" ? "active" : ""}`} aria-current={active === "lock" ? "page" : undefined}>
          <LockKeyhole size={24} aria-hidden="true" />
          Lock Funds
        </a>
        <a href="/claim" className={`claim-nav-link ${active === "claim" ? "active" : ""}`} aria-current={active === "claim" ? "page" : undefined}>
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

function ReclaimSidebar({ steps }: { steps: ReclaimShellStep[] }) {
  return (
    <aside className="claim-sidebar" aria-label="Lock funds progress">
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
        {steps.map((step) => (
          <ReclaimStep key={step.id} step={step} />
        ))}
      </ol>

      <div className="claim-assurance">
        <ShieldCheck size={31} aria-hidden="true" />
        <p>Your recovery is secured by ReclaimGlobal.</p>
        <p>We never access your funds.</p>
      </div>
    </aside>
  );
}

function ReclaimStep({ step }: { step: ReclaimShellStep }) {
  const Icon = step.icon;
  return (
    <li className={`claim-step ${step.status}`}>
      <div className="claim-step-line" aria-hidden="true" />
      <div className="claim-step-token" aria-hidden="true">
        {step.status === "complete" ? <Check size={22} /> : step.id}
      </div>
      <Icon className="claim-step-icon" size={31} aria-hidden="true" />
      <div>
        <strong>
          {step.id}. {step.label}
        </strong>
        <span>{step.statusLabel}</span>
      </div>
    </li>
  );
}

export function ReclaimPageHeading({ title, subtitle, icon: Icon }: { title: string; subtitle: string; icon?: LucideIcon }) {
  if (!Icon) {
    return (
      <header className="claim-page-heading">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </header>
    );
  }
  return (
    <header className="claim-page-heading lock-hero-heading">
      <span className="lock-hero-icon" aria-hidden="true">
        <Icon size={42} />
      </span>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}

export function ReclaimSummaryTiles({ tiles }: { tiles: ReclaimSummaryTile[] }) {
  return (
    <div className={`claim-summary-tiles count-${tiles.length}`}>
      {tiles.map((tile) => (
        <ReclaimSummaryTileView key={`${tile.label}-${tile.value}`} tile={tile} />
      ))}
    </div>
  );
}

function ReclaimSummaryTileView({ tile }: { tile: ReclaimSummaryTile }) {
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
            <Check size={15} aria-hidden="true" />
            {tile.status}
          </small>
        ) : null}
      </div>
    </section>
  );
}

export function ReclaimPanel({
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

export function ReclaimNotice({
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

export function ReclaimReviewRow({
  label,
  value,
  detail,
  noCopy,
}: {
  label: string;
  value: string;
  detail?: string;
  noCopy?: boolean;
}) {
  return (
    <div className="claim-review-row">
      <span>{label}</span>
      <code>{value}</code>
      {!noCopy ? <ReclaimCopyButton label={`Copy ${label}`} /> : null}
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function ReclaimCopyButton({ label }: { label: string }) {
  return (
    <button className="claim-copy-button" type="button" aria-label={label}>
      <Copy size={15} aria-hidden="true" />
    </button>
  );
}
