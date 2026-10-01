import { type NextRequest, NextResponse } from "next/server";
import { withRequestSignal } from "./request-signal";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_QUERY_BYTES = 24 * 1024;
const bodies = new WeakMap<Request, unknown>();
let active = 0;
let activeBuilds = 0;
let tokens = 120;
let updatedAt = Date.now();

class AdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Instance-wide budgets don't depend on spoofable client/IP headers. A hosting
// firewall must enforce fleet-wide limits when functions scale horizontally.
export function withApiLimits(
  handler: (request: NextRequest) => Promise<Response>,
  { build = false }: { build?: boolean } = {},
) {
  return async (request: NextRequest): Promise<Response> => {
    const now = Date.now();
    tokens = Math.min(120, tokens + Math.max(0, now - updatedAt) / 500);
    updatedAt = now;
    const cost = build ? 10 : 1;
    if (active >= 8 || (build && activeBuilds >= 1) || tokens < cost) {
      return NextResponse.json(
        { error: "Too many requests. Retry shortly.", code: "api_busy" },
        { status: 429, headers: { "Retry-After": "5" } },
      );
    }
    tokens -= cost;
    active += 1;
    if (build) activeBuilds += 1;
    const controller = new AbortController();
    const timeout = new AdmissionError(
      408,
      "request_timeout",
      "Request timed out. Check transaction status before retrying a submission.",
    );
    const abort = () => controller.abort(timeout);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const deadline = setTimeout(abort, build ? 120_000 : 30_000);
    let rejectAborted: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      if (request.url.length > MAX_QUERY_BYTES) {
        throw new AdmissionError(413, "request_too_large", "Request URL is too large.");
      }
      if (request.method === "POST") bodies.set(request, await readBoundedJson(request));
      controller.signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        rejectAborted = () => reject(timeout);
        controller.signal.addEventListener("abort", rejectAborted, { once: true });
      });
      return await Promise.race([withRequestSignal(controller.signal, () => handler(request)), aborted]);
    } catch (error) {
      if (!(error instanceof AdmissionError)) throw error;
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    } finally {
      clearTimeout(deadline);
      request.signal.removeEventListener("abort", abort);
      if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
      bodies.delete(request);
      active -= 1;
      if (build) activeBuilds -= 1;
    }
  };
}

export async function readApiJson(request: Request): Promise<unknown> {
  if (!bodies.has(request)) throw new Error("API request must pass admission before parsing.");
  return bodies.get(request);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new AdmissionError(413, "request_too_large", "Request body is too large.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AdmissionError(400, "invalid_json", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const cancel = () => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(cancel, 10_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AdmissionError(413, "request_too_large", "Request body is too large.");
      }
      chunks.push(part.value);
    }
    if (timedOut) throw new AdmissionError(408, "request_timeout", "Request body timed out.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AdmissionError(400, "invalid_json", "Request body must be valid JSON.");
    }
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
