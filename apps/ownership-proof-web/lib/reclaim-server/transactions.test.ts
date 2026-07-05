import { describe, expect, it } from "vitest";
import { makeCompromisedCredentialDatum } from "./transactions";

describe("reclaim transaction helpers", () => {
  it("encodes the compromised credential as ReclaimBaseDatum constructor 0", () => {
    const credential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";

    expect(makeCompromisedCredentialDatum(credential)).toBe(
      "d8799f581c19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4ff",
    );
  });
});
