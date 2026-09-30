import type { Provider, UTxO } from "@lucid-evolution/lucid";
import type { ReclaimDeployment } from "../reclaim/types";
import { assetMapToStringMap } from "../reclaim/validation";
import { tryParseReclaimBaseDatum } from "../claim/datum";
import { assertOutRefList, outRefToString } from "../claim/validation";
import type { ClaimOutRef, IndexedReclaimUtxo, ReclaimUtxosResponse } from "../claim/types";
import { supportsAddressUtxoIndex } from "./provider";

const DEFAULT_PAGE_LIMIT = 50;
const HARD_PAGE_LIMIT = 100;
const indexCache = new WeakMap<Provider, Map<string, { expiresAt: number; result: Promise<UTxO[]> }>>();

export function loadReclaimIndex(provider: Provider, address: string): Promise<UTxO[]> {
  let cache = indexCache.get(provider);
  if (!cache) {
    cache = new Map();
    indexCache.set(provider, cache);
  }
  const cached = cache.get(address);
  if (cached && Date.now() < cached.expiresAt) return cached.result;
  const entry = {
    expiresAt: Date.now() + 30_000,
    result: provider
      .getUtxos(address)
      .then((utxos) =>
        utxos
          .filter((utxo) => utxo.address === address)
          .sort((left, right) => compareByAge(confirmationSlot(left), confirmationSlot(right), left, right)),
      ),
  };
  const result = entry.result;
  cache.set(address, entry);
  const expire = () => {
    entry.expiresAt = Date.now() + 5000;
  };
  void result.then(expire, () => {
    if (cache.get(address) === entry) cache.delete(address);
  });
  return result;
}

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
  const utxos = await loadReclaimIndex(provider, deployment.reclaimBaseAddress);

  const page = utxos.slice(cursor, cursor + limit).map((utxo) => toIndexedReclaimUtxo(utxo, deployment, pending));
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
  return compareByAge(left.confirmation.slot, right.confirmation.slot, left.outRef, right.outRef);
}

function compareByAge(
  leftSlot: number | null,
  rightSlot: number | null,
  left: ClaimOutRef,
  right: ClaimOutRef,
): number {
  if (leftSlot !== null || rightSlot !== null) {
    if (leftSlot === null) return 1;
    if (rightSlot === null) return -1;
    if (leftSlot !== rightSlot) return leftSlot - rightSlot;
  }
  if (left.txHash !== right.txHash) {
    return left.txHash < right.txHash ? -1 : 1;
  }
  return left.outputIndex - right.outputIndex;
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
