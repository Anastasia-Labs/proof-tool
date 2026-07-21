import { describe, expect, it } from "vitest";
import { handleWorkerRequest } from "../src/worker.js";

const phrase = "eight country switch draw meat scout mystery blade tip drift useless good keep usage title";

const expected =
  "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245" +
  "d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a" +
  "23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620";

describe("ownership proof worker", () => {
  it("derives the expected 96-byte master XPrv", async () => {
    const response = await handleWorkerRequest({
      id: "req-1",
      type: "derive-master-xprv",
      seedPhrase: phrase,
    });

    expect(response.type).toBe("master-xprv");
    if (response.type !== "master-xprv") {
      throw new Error(response.message);
    }
    const bytes = new Uint8Array(response.masterXPrv);
    expect(bytes).toHaveLength(96);
    expect(bytesToHex(bytes)).toBe(expected);
  });

  it("returns a non-secret invalid mnemonic error", async () => {
    const seedPhrase = "not a real seed phrase";
    const response = await handleWorkerRequest({
      id: "req-2",
      type: "derive-master-xprv",
      seedPhrase,
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error("expected an error");
    }
    expect(response.code).toBe("invalid_mnemonic");
    expect(response.message).not.toContain(seedPhrase);
    expect(response.message).not.toMatch(/not a real/u);
  });

  it("does not echo unsupported request bodies", async () => {
    const response = await handleWorkerRequest({
      id: "req-3",
      type: "other",
      seedPhrase: phrase,
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error("expected an error");
    }
    expect(response.message).not.toContain(phrase);
  });
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
