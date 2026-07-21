import { describe, expect, it } from "vitest";
import { translateJapanese } from "./messages-ja";

describe("Japanese messages", () => {
  it("translates static and dynamic claim-flow messages", () => {
    expect(translateJapanese("Claim funds")).toBe("資金を請求");
    expect(translateJapanese("Showing 1-10 of 18 UTxOs")).toBe("18件のUTxOのうち1〜10件を表示");
    expect(translateJapanese("18 total claims - proving in this browser")).toBe("全18件の請求をこのブラウザで証明中");
    expect(translateJapanese("2 UTxOs, 2 assets")).toBe("2件のUTxO・2件の資産");
    expect(
      translateJapanese(
        "This page is pinned to a specific deployment of the ReclaimGlobal contracts on Preprod. If you were given a deployment ID or commit hash, compare it here before continuing.",
      ),
    ).toContain("Preprod上にデプロイされた特定のReclaimGlobalコントラクト");
  });

  it("does not alter addresses, hashes, asset units, or other unknown values", () => {
    const value = "addr_test1vqv7qlaucathxkwkc503ujw0rv9lfj2rkj96feyst2rs9eqqyas5r";
    expect(translateJapanese(value)).toBe(value);
    expect(translateJapanese("a".repeat(64))).toBe("a".repeat(64));
  });
});
