import type { Metadata } from "next";
import { ReclaimFundingFlow } from "../../../../components/ReclaimFundingFlow";
import { pageMetadata } from "../../../../lib/i18n/metadata";

export const metadata: Metadata = pageMetadata("ja", "/reclaim");

export default function JapaneseReclaimPage() {
  return <ReclaimFundingFlow />;
}
