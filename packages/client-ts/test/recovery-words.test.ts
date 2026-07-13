import { describe, expect, it } from "vitest";
import {
  isValidRecoveryWord,
  recoveryWordlistEnglish,
  validateRecoveryPhrase,
} from "../src/index.js";

const validPhrase =
  "eight country switch draw meat scout mystery blade tip drift useless good keep usage title";

describe("recoveryWordlistEnglish", () => {
  it("re-exports the full BIP-39 English wordlist", () => {
    expect(recoveryWordlistEnglish).toHaveLength(2048);
    expect(recoveryWordlistEnglish).toContain("abandon");
    expect(recoveryWordlistEnglish).toContain("zoo");
  });
});

describe("isValidRecoveryWord", () => {
  it("accepts wordlist words with surrounding whitespace and mixed case", () => {
    expect(isValidRecoveryWord("receive")).toBe(true);
    expect(isValidRecoveryWord("  Receive ")).toBe(true);
    expect(isValidRecoveryWord("ZOO")).toBe(true);
  });

  it("rejects typos and non-words", () => {
    expect(isValidRecoveryWord("recieve")).toBe(false);
    expect(isValidRecoveryWord("")).toBe(false);
    expect(isValidRecoveryWord("word1")).toBe(false);
  });
});

describe("validateRecoveryPhrase", () => {
  it("accepts a checksum-valid phrase", () => {
    expect(validateRecoveryPhrase(validPhrase.split(" "))).toEqual({ ok: true });
  });

  it("normalizes case and whitespace before validating", () => {
    const words = validPhrase
      .split(" ")
      .map((word, index) => (index === 0 ? ` ${word.toUpperCase()} ` : word));
    expect(validateRecoveryPhrase(words)).toEqual({ ok: true });
  });

  it("rejects unsupported word counts", () => {
    expect(validateRecoveryPhrase(validPhrase.split(" ").slice(0, 11))).toEqual({
      ok: false,
      reason: "length",
    });
    expect(validateRecoveryPhrase([])).toEqual({ ok: false, reason: "length" });
  });

  it("rejects phrases containing non-wordlist words", () => {
    const words = validPhrase.split(" ");
    words[3] = "recieve";
    expect(validateRecoveryPhrase(words)).toEqual({ ok: false, reason: "word" });
  });

  it("rejects wordlist-valid phrases with a bad checksum", () => {
    expect(validateRecoveryPhrase(Array.from({ length: 24 }, () => "abandon"))).toEqual({
      ok: false,
      reason: "checksum",
    });
    const swapped = validPhrase.split(" ");
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(validateRecoveryPhrase(swapped)).toEqual({ ok: false, reason: "checksum" });
  });
});
