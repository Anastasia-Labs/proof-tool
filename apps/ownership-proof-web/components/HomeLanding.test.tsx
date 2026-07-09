import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { HomeLanding } from "./HomeLanding";

describe("HomeLanding", () => {
  it("routes public users to claim and lock/donate flows", () => {
    render(<HomeLanding />);

    expect(screen.getByRole("heading", { name: /claim swept funds/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /claim funds/i })).toHaveAttribute("href", "/claim");
    expect(screen.getByRole("link", { name: /lock or donate funds/i })).toHaveAttribute("href", "/reclaim");
    expect(screen.queryByRole("heading", { name: /credential proof/i })).not.toBeInTheDocument();
  });
});
