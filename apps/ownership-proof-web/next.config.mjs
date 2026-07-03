/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
