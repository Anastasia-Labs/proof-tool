import type { Metadata } from "next";
import { ReclaimFundingFlow } from "../../../components/ReclaimFundingFlow";
import { pageMetadata } from "../../../lib/i18n/metadata";

export const metadata: Metadata = pageMetadata("en", "/reclaim");

export default function ReclaimPage() {
  return <ReclaimFundingFlow />;
}
