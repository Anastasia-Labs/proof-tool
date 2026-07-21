import { HelperPairingForward } from "../../../components/HelperPairingForward";
import { HomeLanding } from "../../../components/HomeLanding";

export default function JapanesePage() {
  return (
    <>
      <HelperPairingForward claimPath="/jp/claim" />
      <HomeLanding locale="ja" />
    </>
  );
}
