import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CredentialProofDevPage() {
  // This legacy credential-proof surface is for local development only.
  // VERCEL_ENV remains "development" under `vercel dev`, while hosted Preview
  // and Production deployments must both return 404.
  const vercelEnvironment = process.env.VERCEL_ENV;
  const hostedOnVercel = vercelEnvironment === "preview" || vercelEnvironment === "production";
  if (process.env.NODE_ENV !== "development" || hostedOnVercel) {
    notFound();
  }

  const { ProofFlow } = await import("../../../../components/ProofFlow");

  return <ProofFlow />;
}
