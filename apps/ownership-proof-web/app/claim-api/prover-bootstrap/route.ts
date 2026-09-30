import { PROVER_BOOTSTRAP_CSP, proverBootstrapSource } from "../../../lib/proving/worker-bootstrap.mjs";

export const runtime = "nodejs";

export function GET() {
  return new Response(proverBootstrapSource(), {
    headers: {
      "Content-Type": "text/javascript",
      "Content-Security-Policy": PROVER_BOOTSTRAP_CSP,
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
    },
  });
}
