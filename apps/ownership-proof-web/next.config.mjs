/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    "@anastasia-labs/cardano-multiplatform-lib-nodejs",
    "@lucid-evolution/lucid",
    "@lucid-evolution/provider",
  ],
  async headers() {
    return [
      {
        // Cross-origin isolation for browser WASM proving (SharedArrayBuffer).
        // Applied site-wide: isolation is fixed per-document at load time, so a
        // client-side navigation from a non-isolated page onto /claim would not
        // isolate the claim document if these were scoped to /claim alone. The
        // app has no cross-origin subresources, so blanket require-corp is safe.
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        source: "/proof-runtime/:path*",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/proof-assets/:path*",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
  async rewrites() {
    const devVerifierURL = process.env.PROOF_VERIFIER_DEV_URL?.replace(/\/+$/u, "");
    if (!devVerifierURL) {
      return [];
    }
    return [
      {
        source: "/api/:path*",
        destination: `${devVerifierURL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
