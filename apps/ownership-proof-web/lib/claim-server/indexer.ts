import type { Provider, UTxO } from "@lucid-evolution/lucid";
import type { ReclaimDeployment } from "../reclaim/types";
import { assetMapToStringMap } from "../reclaim/validation";
import { tryParseReclaimBaseDatum } from "../claim/datum";
import { assertOutRefList, outRefToString } from "../claim/validation";
import type { ClaimOutRef, IndexedReclaimUtxo, ReclaimUtxosResponse } from "../claim/types";
import { supportsAddressUtxoIndex } from "./provider";

const DEFAULT_PAGE_LIMIT = 50;
const HARD_PAGE_LIMIT = 100;

export async function listReclaimUtxos(
  provider: Provider,
  deployment: ReclaimDeployment,
  input: { cursor?: string | null; limit?: number | null; pendingOutrefs?: unknown } = {},
): Promise<ReclaimUtxosResponse> {
  if (!supportsAddressUtxoIndex(provider)) {
    return {
      available: false,
      deploymentId: deployment.id,
      network: deployment.network,
      indexer: {
        providerBacked: false,
        status: "disabled",
      },
      code: "provider_index_unavailable",
      reason: "Configured Cardano provider cannot query address UTxOs.",
    };
  }

  const pending = new Set(assertOutRefList(input.pendingOutrefs, "pendingOutrefs").map(outRefToString));
  const cursor = parseCursor(input.cursor);
  const limit = parseLimit(input.limit);
  const utxos = (await provider.getUtxos(deployment.reclaimBaseAddress))
    .filter((utxo) => utxo.address === deployment.reclaimBaseAddress)
    .map((utxo) => toIndexedReclaimUtxo(utxo, deployment, pending))
    .sort(compareIndexedUtxos);

  const page = utxos.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < utxos.length ? String(cursor + limit) : null;

  return {
    available: true,
    deploymentId: deployment.id,
    network: deployment.network,
    indexer: {
      providerBacked: true,
      status: "available",
    },
    page: {
      limit,
      cursor: cursor === 0 ? null : String(cursor),
      nextCursor,
      total: utxos.length,
    },
    utxos: page,
  };
}

export function toIndexedReclaimUtxo(
  utxo: UTxO,
  deployment: ReclaimDeployment,
  pendingOutrefs: ReadonlySet<string> = new Set(),
): IndexedReclaimUtxo {
  const outRef: ClaimOutRef = { txHash: utxo.txHash, outputIndex: utxo.outputIndex };
  const outRefId = outRefToString(outRef);
  const datumCbor = typeof utxo.datum === "string" && utxo.datum.trim() !== "" ? utxo.datum.trim().toLowerCase() : null;

  return {
    outRef,
    outRefId,
    address: utxo.address,
    value: assetMapToStringMap(utxo.assets),
    datum: tryParseReclaimBaseDatum(datumCbor),
    datumCbor,
    state: pendingOutrefs.has(outRefId) ? "pending" : "unspent",
    deploymentId: deployment.id,
    confirmation: {
      slot: confirmationSlot(utxo),
    },
  };
}

export function compareIndexedUtxos(left: IndexedReclaimUtxo, right: IndexedReclaimUtxo): number {
  const leftSlot = left.confirmation.slot;
  const rightSlot = right.confirmation.slot;
  if (leftSlot !== null || rightSlot !== null) {
    if (leftSlot === null) return 1;
    if (rightSlot === null) return -1;
    if (leftSlot !== rightSlot) return leftSlot - rightSlot;
  }
  if (left.outRef.txHash !== right.outRef.txHash) {
    return left.outRef.txHash < right.outRef.txHash ? -1 : 1;
  }
  return left.outRef.outputIndex - right.outRef.outputIndex;
}

export function confirmationSlot(utxo: UTxO): number | null {
  const record = utxo as UTxO & {
    slot?: unknown;
    blockSlot?: unknown;
    confirmedAtSlot?: unknown;
    blockHeight?: unknown;
  };
  const candidates = [record.confirmedAtSlot, record.blockSlot, record.slot, record.blockHeight];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && (candidate as number) >= 0 && Number.isSafeInteger(candidate)) {
      return candidate as number;
    }
  }
  return null;
}

function parseCursor(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    return 0;
  }
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function parseLimit(value: number | null | undefined): number {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(value, HARD_PAGE_LIMIT);
}
