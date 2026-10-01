import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialToRewardAddress, scriptHashToCredential, type Provider } from "@lucid-evolution/lucid";
import deployment from "../../public/proof-assets/reclaim-deployment.json";
import { getClaimRewards, invalidateClaimRewards, markClaimRewardsWithdrawn } from "./rewards";

const address = credentialToRewardAddress("Preprod", scriptHashToCredential(deployment.reclaim_global.script_hash));
afterEach(() => vi.useRealTimers());

describe("claim reward cache", () => {
  it("keeps a successful full withdrawal cached as zero until the epoch boundary", async () => {
    vi.useFakeTimers();
    const boundary = Date.parse("2022-06-06T00:00:00Z");
    vi.setSystemTime(boundary - 1);
    const getDelegation = vi.fn().mockResolvedValue({ poolId: null, rewards: 2_000_000n });
    const provider = { getDelegation } as unknown as Provider;
    await getClaimRewards(provider, "Preprod", address);
    markClaimRewardsWithdrawn(provider, address);
    expect(await getClaimRewards(provider, "Preprod", address)).toBe(0n);
    expect(getDelegation).toHaveBeenCalledTimes(1);
    vi.setSystemTime(boundary);
    expect(await getClaimRewards(provider, "Preprod", address)).toBe(2_000_000n);
    expect(getDelegation).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent reads, caches within an epoch, and refreshes after invalidation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    const getDelegation = vi.fn().mockResolvedValue({ poolId: null, rewards: 2_000_000n });
    const provider = { getDelegation } as unknown as Provider;
    expect(
      await Promise.all([getClaimRewards(provider, "Preprod", address), getClaimRewards(provider, "Preprod", address)]),
    ).toEqual([2_000_000n, 2_000_000n]);
    await getClaimRewards(provider, "Preprod", address);
    expect(getDelegation).toHaveBeenCalledTimes(1);
    invalidateClaimRewards(provider, address);
    getDelegation.mockResolvedValue({ poolId: null, rewards: 0n });
    expect(await getClaimRewards(provider, "Preprod", address)).toBe(0n);
    expect(getDelegation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Mainnet", "2017-09-28T21:44:51Z"],
    ["Preprod", "2022-06-06T00:00:00Z"],
    ["Preview", "2022-10-26T00:00:00Z"],
  ] as const)("expires at the %s epoch boundary", async (network, boundary) => {
    vi.useFakeTimers();
    const getDelegation = vi.fn().mockResolvedValue({ poolId: null, rewards: 0n });
    const provider = { getDelegation } as unknown as Provider;
    vi.setSystemTime(Date.parse(boundary) - 1);
    await getClaimRewards(provider, network, address);
    vi.setSystemTime(Date.parse(boundary));
    await getClaimRewards(provider, network, address);
    expect(getDelegation).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.parse(boundary) + 10_001);
    await getClaimRewards(provider, network, address);
    expect(getDelegation).toHaveBeenCalledTimes(3);
  });

  it("does not cache provider failures or invalid balances", async () => {
    const getDelegation = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ rewards: -1n })
      .mockResolvedValueOnce({ rewards: 0n });
    const provider = { getDelegation } as unknown as Provider;
    await expect(getClaimRewards(provider, "Preprod", address)).rejects.toThrow("offline");
    await expect(getClaimRewards(provider, "Preprod", address)).rejects.toThrow("invalid reward balance");
    expect(await getClaimRewards(provider, "Preprod", address)).toBe(0n);
    expect(getDelegation).toHaveBeenCalledTimes(3);
  });
});
