import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLoopback, queryLoopbackPermission } from "./loopback-access";

afterEach(() => vi.unstubAllGlobals());

describe("loopback access", () => {
  it("reports the fine-grained loopback permission", async () => {
    const query = vi.fn(async () => ({ state: "denied" as PermissionState }));
    vi.stubGlobal("navigator", { permissions: { query } });
    await expect(queryLoopbackPermission()).resolves.toBe("denied");
    expect(query).toHaveBeenCalledWith({ name: "loopback-network" });
  });

  it("falls back when the Permissions API does not expose LNA", async () => {
    vi.stubGlobal("navigator", {});
    await expect(queryLoopbackPermission()).resolves.toBe("unsupported");
  });

  it("annotates fetches with the loopback target address space", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await fetchLoopback("http://127.0.0.1:3001/status", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/status",
      expect.objectContaining({ method: "GET", targetAddressSpace: "loopback" }),
    );
  });
});
