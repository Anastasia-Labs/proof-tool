import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeLanding } from "./HomeLanding";
import { I18nProvider } from "./I18nProvider";

describe("HomeLanding", () => {
  it("routes public users to claim and lock/donate flows", () => {
    render(<HomeLanding />);

    expect(
      screen.getByRole("heading", { name: /recover funds from a compromised cardano wallet/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /claim funds/i })).toHaveAttribute("href", "/claim");
    expect(screen.getByRole("link", { name: /lock \/ donate funds/i })).toHaveAttribute("href", "/reclaim");
    expect(screen.queryByRole("heading", { name: /credential proof/i })).not.toBeInTheDocument();
  });

  it("keeps the proof claim narrow and the recovery phrase local", () => {
    render(<HomeLanding />);

    expect(screen.getByRole("heading", { name: /the proof reveals nothing about your keys/i })).toBeInTheDocument();
    expect(screen.getByText(/the phrase itself is never uploaded/i)).toBeInTheDocument();
  });

  it("links to the public source and docs in the footer", () => {
    render(<HomeLanding />);

    expect(screen.getByRole("link", { name: /view source on github/i })).toHaveAttribute(
      "href",
      "https://github.com/Anastasia-Labs/proof-tool",
    );
    expect(screen.getByRole("link", { name: /documentation/i })).toHaveAttribute(
      "href",
      "https://github.com/Anastasia-Labs/proof-tool/tree/main/docs",
    );
    expect(screen.getByText(/built for cardano mainnet/i)).toBeInTheDocument();
  });

  it("renders Japanese copy and locale-preserving routes at /jp", () => {
    render(
      <I18nProvider locale="ja">
        <HomeLanding locale="ja" />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "侵害されたCardanoウォレットから資金を取り戻す" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /資金を奪われた方.*資金を請求/u })).toHaveAttribute("href", "/jp/claim");
    expect(screen.getByRole("link", { name: /資金をロック・寄付.*救出者/u })).toHaveAttribute("href", "/jp/reclaim");
    expect(screen.getByRole("link", { name: "English" })).toHaveAttribute("href", "/language?locale=en&returnTo=%2F");
  });
});
