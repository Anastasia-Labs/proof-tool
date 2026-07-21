import type { Metadata } from "next";
import { ClaimFlow } from "../../../components/ClaimFlow";
import { pageMetadata } from "../../../lib/i18n/metadata";

export const metadata: Metadata = pageMetadata("en", "/claim");

export default function ClaimPage() {
  return <ClaimFlow />;
}
