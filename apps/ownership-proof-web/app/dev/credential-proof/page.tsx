import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CredentialProofDevPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const { ProofFlow } = await import("../../../components/ProofFlow");

  return <ProofFlow />;
}
