export type LoopbackPermissionState = PermissionState | "unsupported";

const permissionNames = ["loopback-network", "local-network-access"] as const;

export async function queryLoopbackPermission(): Promise<LoopbackPermissionState> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return "unsupported";
  }
  for (const name of permissionNames) {
    try {
      const result = await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
      return result.state;
    } catch {
      // Try the Chromium compatibility alias, then fall back to normal fetch
      // behavior for browsers that do not expose LNA through Permissions API.
    }
  }
  return "unsupported";
}

export function fetchLoopback(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const loopbackInit = {
    ...init,
    targetAddressSpace: "loopback",
  } as RequestInit & { targetAddressSpace: "loopback" };
  return fetch(input, loopbackInit);
}
