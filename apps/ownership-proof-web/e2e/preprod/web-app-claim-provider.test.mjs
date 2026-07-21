import { describe, expect, it, vi } from "vitest";
import { waitForSafeDestinationOutput } from "./web-app-claim-provider.mjs";

const transactionHash = "a".repeat(64);
const safeAddress = "addr_test1safe";

describe("web-app claim provider confirmation", () => {
  it("confirms the exact reviewed output by transaction hash, index, address, and value", async () => {
    const provider = {
      getUtxos: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            txHash: transactionHash,
            outputIndex: 0,
            address: safeAddress,
            assets: { lovelace: 2_000_000n, [`${"b".repeat(56)}01`]: 3n },
          },
        ]),
    };
    const result = await waitForSafeDestinationOutput({
      build: reviewedBuild({ lovelace: "2000000", [`${"b".repeat(56)}01`]: "3" }),
      provider,
      safeAddress,
      sleep: vi.fn(async () => undefined),
      transactionHash,
    });

    expect(result).toEqual({
      outputIndex: 0,
      transactionHash,
      value: { lovelace: "2000000", [`${"b".repeat(56)}01`]: "3" },
    });
    expect(provider.getUtxos).toHaveBeenCalledWith(safeAddress);
  });

  it("fails when the provider-visible output differs from the reviewed value", async () => {
    const provider = {
      getUtxos: vi.fn(async () => [
        {
          txHash: transactionHash,
          outputIndex: 0,
          address: safeAddress,
          assets: { lovelace: 1_999_999n },
        },
      ]),
    };

    await expect(
      waitForSafeDestinationOutput({
        build: reviewedBuild({ lovelace: "2000000" }),
        provider,
        safeAddress,
        transactionHash,
      }),
    ).rejects.toMatchObject({ code: "provider_destination_mismatch" });
  });
});

function reviewedBuild(value) {
  return {
    review: {
      destinationOutputStartIndex: 0,
      destinationOutputs: [{ address: safeAddress, value }],
    },
  };
}
