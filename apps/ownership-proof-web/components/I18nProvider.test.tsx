import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider, Localize, localizeText } from "./I18nProvider";

describe("I18nProvider", () => {
  it("localizes visible and accessible text without changing technical values", () => {
    const hash = "4f3c9a1e2b6c8d0f91a4b7c3e0d29a6f48bd12c0";
    render(
      <I18nProvider locale="ja">
        <Localize>
          <button type="button" aria-label="Copy credential 1">
            Claim funds
          </button>
          <code>{hash}</code>
        </Localize>
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: "認証情報 1 をコピー" })).toHaveTextContent("資金を請求");
    expect(screen.getByText(hash)).toBeInTheDocument();
  });

  it("leaves the English UI unchanged", () => {
    expect(localizeText("en", "Claim funds")).toBe("Claim funds");
  });
});
