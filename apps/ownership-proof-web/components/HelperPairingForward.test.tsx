import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelperPairingForward } from "./HelperPairingForward";

const originalLocation = window.location;

function stubLocation(hash: string): ReturnType<typeof vi.fn> {
  const replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, hash, replace },
  });
  return replace;
}

describe("HelperPairingForward", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("forwards a helper pairing fragment to /claim preserving the fragment", () => {
    const replace = stubLocation("#helper=http%3A%2F%2F127.0.0.1%3A53412&pair=abc123");
    render(<HelperPairingForward />);
    expect(replace).toHaveBeenCalledWith("/claim#helper=http%3A%2F%2F127.0.0.1%3A53412&pair=abc123");
  });

  it("preserves the Japanese claim route when forwarding a pairing fragment", () => {
    const replace = stubLocation("#helper=http%3A%2F%2F127.0.0.1%3A53412&pair=abc123");
    render(<HelperPairingForward claimPath="/jp/claim" />);
    expect(replace).toHaveBeenCalledWith("/jp/claim#helper=http%3A%2F%2F127.0.0.1%3A53412&pair=abc123");
  });

  it("does nothing without a fragment", () => {
    const replace = stubLocation("");
    render(<HelperPairingForward />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does nothing when the fragment lacks the pairing token", () => {
    const replace = stubLocation("#helper=http%3A%2F%2F127.0.0.1%3A53412");
    render(<HelperPairingForward />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does nothing for unrelated fragments", () => {
    const replace = stubLocation("#section-how-it-works");
    render(<HelperPairingForward />);
    expect(replace).not.toHaveBeenCalled();
  });
});
