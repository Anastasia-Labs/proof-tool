import { afterEach, describe, expect, it } from "vitest";
import { acknowledgePairing, broadcastPairing, createRelayId, subscribeToPairing } from "./helper-pairing-relay";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  window.localStorage.clear();
});

function track(unsubscribe: () => void): () => void {
  cleanups.push(unsubscribe);
  return unsubscribe;
}

describe("helper-pairing-relay", () => {
  it("delivers a broadcast pairing to a different subscriber", async () => {
    const courier = createRelayId();
    const worker = createRelayId();
    const received: Array<{ helperUrl: string; token: string; sender: string }> = [];
    track(subscribeToPairing({ sender: worker, onPair: (pairing) => received.push(pairing) }));

    broadcastPairing({ helperUrl: "http://127.0.0.1:49152", token: "tok" }, courier);

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ helperUrl: "http://127.0.0.1:49152", token: "tok", sender: courier });
  });

  it("ignores messages authored by the same sender", async () => {
    const sender = createRelayId();
    const received: unknown[] = [];
    track(subscribeToPairing({ sender, onPair: (pairing) => received.push(pairing) }));

    broadcastPairing({ helperUrl: "http://127.0.0.1:49152", token: "tok" }, sender);

    await delay(50);
    expect(received).toHaveLength(0);
  });

  it("routes an acknowledgement back to the courier by id", async () => {
    const courier = createRelayId();
    const worker = createRelayId();
    const acks: string[] = [];
    track(subscribeToPairing({ sender: courier, onAck: (target) => acks.push(target) }));

    acknowledgePairing(courier, worker);

    await waitFor(() => acks.length === 1);
    expect(acks[0]).toBe(courier);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
