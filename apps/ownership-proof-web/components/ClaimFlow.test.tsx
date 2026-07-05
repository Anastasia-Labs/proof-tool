import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimFlow } from "./ClaimFlow";

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

describe("ClaimFlow", () => {
  it("uses the gated fixture state from the query string", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(screen.getByText(/Your recovery phrase is sent only to the Proof Helper/i)).toBeInTheDocument();
  });

  it("ignores fixture state query strings when fixture mode is disabled", async () => {
    window.history.replaceState(null, "", "/claim?fixtureState=claim-review-complete");

    render(<ClaimFlow />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Review deployment" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Claim review" })).not.toBeInTheDocument();
  });

  it("keeps Proof Helper out of the canonical progress rail", () => {
    render(<ClaimFlow />);

    const rail = screen.getByLabelText("Claim progress");
    expect(rail).toHaveTextContent("1. Deployment");
    expect(rail).toHaveTextContent("4. Safe Wallet");
    expect(rail).toHaveTextContent("5. Create Proofs");
    expect(rail).not.toHaveTextContent("Proof Helper");
  });

  it("shows impacted wallet as discovery-only", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=impacted-wallet");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Connect impacted wallet" })).toBeInTheDocument();
    expect(screen.getByText(/will not sign a transaction with the impacted wallet/i)).toBeInTheDocument();
    expect(screen.queryByText("signTx")).not.toBeInTheDocument();
  });

  it("renders and closes the UTxO asset modal fixture", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=available-claims-asset-modal");

    render(<ClaimFlow />);

    expect(await screen.findByRole("dialog", { name: "UTxO assets" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done reviewing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "UTxO assets" })).not.toBeInTheDocument());
  });
});
