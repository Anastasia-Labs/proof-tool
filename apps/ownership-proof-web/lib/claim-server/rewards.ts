import type { Provider } from "@lucid-evolution/lucid";
import type { ReclaimNetwork } from "../reclaim/types";

// Public-network genesis schedules. Withdrawals can change balances within an
// epoch. Successful claims withdraw the full balance; failed submissions must
// invalidate it because their effect on chain may be ambiguous.
const EPOCH_START: Record<ReclaimNetwork, number> = {
  Mainnet: Date.parse("2017-09-23T21:44:51Z"),
  Preprod: Date.parse("2022-06-01T00:00:00Z"),
  Preview: Date.parse("2022-10-25T00:00:00Z"),
};
type RewardEntry = { expiresAt: number; balance: Promise<bigint> };
const rewardCache = new WeakMap<Provider, Map<string, RewardEntry>>();

export function invalidateClaimRewards(provider: Provider, address: string): void {
  rewardCache.get(provider)?.delete(address);
}

export function markClaimRewardsWithdrawn(provider: Provider, address: string): void {
  const cache = rewardCache.get(provider);
  const entry = cache?.get(address);
  if (cache && entry) cache.set(address, { ...entry, balance: Promise.resolve(0n) });
}

export async function getClaimRewards(provider: Provider, network: ReclaimNetwork, address: string): Promise<bigint> {
  let cache = rewardCache.get(provider);
  if (!cache) {
    cache = new Map();
    rewardCache.set(provider, cache);
  }
  const now = Date.now();
  const existing = cache.get(address);
  if (existing && now < existing.expiresAt) return existing.balance;
  const epochLength = (network === "Preview" ? 1 : 5) * 86_400_000;
  const epochStart = EPOCH_START[network] + Math.floor((now - EPOCH_START[network]) / epochLength) * epochLength;
  // Give lagging providers a short cache during the epoch transition.
  const expiresAt = now - epochStart < 120_000 ? now + 10_000 : epochStart + epochLength;
  const entry: RewardEntry = {
    expiresAt,
    balance: provider.getDelegation(address).then(({ rewards }) => {
      if (typeof rewards !== "bigint" || rewards < 0n) throw new Error("Provider returned an invalid reward balance.");
      return rewards;
    }),
  };
  cache.set(address, entry);
  try {
    return await entry.balance;
  } catch (error) {
    if (cache.get(address) === entry) cache.delete(address);
    throw error;
  }
}
