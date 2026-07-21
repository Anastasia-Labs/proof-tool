import { describe, expect, it } from "vitest";
import { masterXprvHexFromSeedPhrase, normalizeSeedPhrase } from "../src/index.js";

const phrase = "eight country switch draw meat scout mystery blade tip drift useless good keep usage title";

const expected =
  "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245" +
  "d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a" +
  "23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620";

describe("masterXprvFromSeedPhrase", () => {
  it("normalizes seed phrase whitespace", () => {
    expect(normalizeSeedPhrase(`  ${phrase.replaceAll(" ", "   ")}  `)).toBe(phrase);
  });

  it("matches the CIP-3 Icarus golden vector", async () => {
    await expect(masterXprvHexFromSeedPhrase(phrase)).resolves.toBe(expected);
  });

  it("rejects invalid phrases", async () => {
    await expect(masterXprvHexFromSeedPhrase("not a real seed phrase")).rejects.toThrow(/invalid BIP-39 seed phrase/);
  });
});
