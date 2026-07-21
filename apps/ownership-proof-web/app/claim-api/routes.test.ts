// @vitest-environment node
//
// Route-handler tests for the claim API surface. The lib layer beneath these
// handlers has its own deep tests (lib/claim-server/*.test.ts); here we pin
// the HTTP contract prod clients depend on: request parsing, status codes,
// error-code mapping, and that unexpected failures never leak details.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimValidationError } from "../../lib/claim/validation";
import { ReclaimValidationError } from "../../lib/reclaim/validation";

vi.mock("../../lib/reclaim-server/config", () => ({
  getReclaimDeployment: vi.fn(),
  getClaimDeployment: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock("../../lib/claim-server/build-submit", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/claim-server/build-submit")>();
  return {
    ...original,
    buildClaimTx: vi.fn(),
    submitClaimTx: vi.fn(),
  };
});

vi.mock("../../lib/claim-server/draft", () => ({
  createClaimDraft: vi.fn(),
}));

vi.mock("../../lib/claim-server/progress", () => ({
  getClaimProgress: vi.fn(),
}));

vi.mock("../../lib/claim-server/indexer", () => ({
  listReclaimUtxos: vi.fn(),
}));

import { UnsupportedClaimBuildError, buildClaimTx, submitClaimTx } from "../../lib/claim-server/build-submit";
import { createClaimDraft } from "../../lib/claim-server/draft";
import { listReclaimUtxos } from "../../lib/claim-server/indexer";
import { getClaimProgress } from "../../lib/claim-server/progress";
import { getClaimDeployment, getProvider, getReclaimDeployment } from "../../lib/reclaim-server/config";
import { POST as buildRoute } from "./build/route";
import { GET as deploymentRoute } from "./deployment/route";
import { POST as draftRoute } from "./draft/route";
import { GET as progressRoute } from "./progress/route";
import { GET as reclaimUtxosRoute } from "./reclaim-utxos/route";
import { POST as submitRoute } from "./submit/route";

const deployment = {
  id: "deployment-test",
  network: "Preprod",
  networkId: 0,
};

const provider = { name: "stub-provider" };

function postRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function configureAvailable() {
  vi.mocked(getReclaimDeployment).mockReturnValue({ available: true, deployment } as never);
  vi.mocked(getProvider).mockReturnValue({ available: true, provider } as never);
}

function configureDeploymentUnavailable() {
  vi.mocked(getReclaimDeployment).mockReturnValue({
    available: false,
    missing: ["RECLAIM_DEPLOYMENT_JSON"],
  } as never);
}

function configureProviderUnavailable() {
  vi.mocked(getReclaimDeployment).mockReturnValue({ available: true, deployment } as never);
  vi.mocked(getProvider).mockReturnValue({
    available: false,
    missing: ["RECLAIM_BLOCKFROST_PROJECT_ID"],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claim-api/deployment GET", () => {
  it("returns the claim deployment config with no-store caching", async () => {
    vi.mocked(getClaimDeployment).mockReturnValue({ available: true, deployment } as never);
    const response = deploymentRoute();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ available: true });
  });
});

describe("claim-api/build POST", () => {
  it("returns 503 with the missing keys when the deployment is not configured", async () => {
    configureDeploymentUnavailable();
    const response = await buildRoute(postRequest("/claim-api/build", {}));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "deployment_unavailable",
      missing: ["RECLAIM_DEPLOYMENT_JSON"],
    });
    expect(buildClaimTx).not.toHaveBeenCalled();
  });

  it("returns 503 when the provider is not configured", async () => {
    configureProviderUnavailable();
    const response = await buildRoute(postRequest("/claim-api/build", {}));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "provider_unavailable" });
    expect(buildClaimTx).not.toHaveBeenCalled();
  });

  it("passes the parsed body through and returns the build result", async () => {
    configureAvailable();
    vi.mocked(buildClaimTx).mockResolvedValue({ txCbor: "opaque-built-tx" } as never);
    const body = { proofArtifacts: [], destinationAddress: "opaque-destination" };
    const response = await buildRoute(postRequest("/claim-api/build", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ txCbor: "opaque-built-tx" });
    expect(buildClaimTx).toHaveBeenCalledWith(provider, deployment, body);
  });

  it("maps validation failures to 400 with the stable error code", async () => {
    configureAvailable();
    vi.mocked(buildClaimTx).mockRejectedValue(
      new ClaimValidationError("destination_mismatch", "Destination does not match the proof."),
    );
    const response = await buildRoute(postRequest("/claim-api/build", {}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "destination_mismatch" });
  });

  it("maps reclaim validation failures to 400", async () => {
    configureAvailable();
    vi.mocked(buildClaimTx).mockRejectedValue(new ReclaimValidationError("bad_outref", "Malformed outref."));
    const response = await buildRoute(postRequest("/claim-api/build", {}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "bad_outref" });
  });

  it("maps UnsupportedClaimBuildError to 501 with the preflight report", async () => {
    configureAvailable();
    vi.mocked(buildClaimTx).mockRejectedValue(new UnsupportedClaimBuildError());
    const response = await buildRoute(postRequest("/claim-api/build", {}));
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: "claim_build_unsupported",
      reason: "build_prerequisites_missing",
    });
  });

  it("hides unexpected failures behind a generic 500", async () => {
    configureAvailable();
    vi.mocked(buildClaimTx).mockRejectedValue(new Error("secret internal state: xprv1abc"));
    const response = await buildRoute(postRequest("/claim-api/build", {}));
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({
      error: "Unable to build claim transaction.",
      code: "claim_build_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("xprv1abc");
  });
});

describe("claim-api/submit POST", () => {
  it("returns 503 when the deployment is not configured", async () => {
    configureDeploymentUnavailable();
    const response = await submitRoute(postRequest("/claim-api/submit", {}));
    expect(response.status).toBe(503);
    expect(submitClaimTx).not.toHaveBeenCalled();
  });

  it("submits the reviewed signed tx and returns the provider response", async () => {
    configureAvailable();
    vi.mocked(submitClaimTx).mockResolvedValue({ txHash: "opaque-tx-hash" } as never);
    const body = { signedTxCbor: "opaque-signed-tx", reviewToken: "opaque-review-token" };
    const response = await submitRoute(postRequest("/claim-api/submit", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ txHash: "opaque-tx-hash" });
    expect(submitClaimTx).toHaveBeenCalledWith(provider, deployment, body);
  });

  it("maps validation failures to 400", async () => {
    configureAvailable();
    vi.mocked(submitClaimTx).mockRejectedValue(new ClaimValidationError("review_token_invalid", "Bad review token."));
    const response = await submitRoute(postRequest("/claim-api/submit", {}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "review_token_invalid" });
  });

  it("hides unexpected submit failures behind a generic 500", async () => {
    configureAvailable();
    vi.mocked(submitClaimTx).mockRejectedValue(new Error("provider exploded: project_id=abc123"));
    const response = await submitRoute(postRequest("/claim-api/submit", {}));
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({
      error: "Unable to submit claim transaction.",
      code: "claim_submit_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("abc123");
  });
});

describe("claim-api/draft POST", () => {
  it("returns the draft and forwards the parsed body", async () => {
    configureAvailable();
    vi.mocked(createClaimDraft).mockResolvedValue({ draftId: "d1" } as never);
    const body = { credential: "abcd" };
    const response = await draftRoute(postRequest("/claim-api/draft", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ draftId: "d1" });
    expect(createClaimDraft).toHaveBeenCalledWith(provider, deployment, body);
  });

  it("includes user-safe details on validation failures", async () => {
    configureAvailable();
    vi.mocked(createClaimDraft).mockRejectedValue(
      new ClaimValidationError("insufficient_funds", "Not enough lovelace.", {
        requiredLovelace: "2000000",
        availableLovelace: "1000000",
      }),
    );
    const response = await draftRoute(postRequest("/claim-api/draft", {}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "insufficient_funds",
      details: { requiredLovelace: "2000000" },
    });
  });

  it("maps unexpected draft failures to 502 without detail", async () => {
    configureAvailable();
    vi.mocked(createClaimDraft).mockRejectedValue(new Error("boom"));
    const response = await draftRoute(postRequest("/claim-api/draft", {}));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Unable to create claim draft.",
      code: "claim_draft_failed",
    });
  });
});

describe("claim-api/progress GET", () => {
  it("parses outref query params and returns progress", async () => {
    configureAvailable();
    vi.mocked(getClaimProgress).mockResolvedValue({ outrefs: [] } as never);
    const request = new NextRequest("http://localhost/claim-api/progress?outrefs=aa%230,bb%231&pending=cc%230");
    const response = await progressRoute(request);
    expect(response.status).toBe(200);
    expect(getClaimProgress).toHaveBeenCalledWith(provider, deployment, {
      outrefs: ["aa#0", "bb#1"],
      pendingOutrefs: ["cc#0"],
    });
  });

  it("still answers with progress shape at 503 when the deployment is missing", async () => {
    configureDeploymentUnavailable();
    vi.mocked(getClaimProgress).mockResolvedValue({ outrefs: [] } as never);
    const response = await progressRoute(new NextRequest("http://localhost/claim-api/progress"));
    expect(response.status).toBe(503);
    expect(getClaimProgress).toHaveBeenCalledWith(null, null, { outrefs: [], pendingOutrefs: [] });
  });
});

describe("claim-api/reclaim-utxos GET", () => {
  it("returns a disabled indexer body at 503 when the provider is missing", async () => {
    configureProviderUnavailable();
    const response = await reclaimUtxosRoute(new NextRequest("http://localhost/claim-api/reclaim-utxos"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      available: false,
      code: "provider_unavailable",
      indexer: { status: "disabled" },
    });
    expect(listReclaimUtxos).not.toHaveBeenCalled();
  });

  it("passes cursor, integer limit, and pending outrefs through", async () => {
    configureAvailable();
    vi.mocked(listReclaimUtxos).mockResolvedValue({ utxos: [] } as never);
    const request = new NextRequest("http://localhost/claim-api/reclaim-utxos?cursor=abc&limit=25&pending=dd%230");
    const response = await reclaimUtxosRoute(request);
    expect(response.status).toBe(200);
    expect(listReclaimUtxos).toHaveBeenCalledWith(provider, deployment, {
      cursor: "abc",
      limit: 25,
      pendingOutrefs: ["dd#0"],
    });
  });

  it("rejects a non-integer limit by passing null", async () => {
    configureAvailable();
    vi.mocked(listReclaimUtxos).mockResolvedValue({ utxos: [] } as never);
    await reclaimUtxosRoute(new NextRequest("http://localhost/claim-api/reclaim-utxos?limit=2.5"));
    expect(listReclaimUtxos).toHaveBeenCalledWith(provider, deployment, {
      cursor: null,
      limit: null,
      pendingOutrefs: [],
    });
  });
});
