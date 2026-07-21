"use client";

import { useEffect } from "react";

// The desktop helper only knows the site origin, so it opens the site ROOT
// with a `#helper=…&pair=…` fragment. All pairing logic (courier relay,
// fragment validation) lives in the claim flow, so forward the fragment
// there. `location.replace` keeps the landing page out of history, and the
// fragment never leaves the browser.
export function HelperPairingForward({ claimPath = "/claim" }: { claimPath?: "/claim" | "/jp/claim" }) {
  useEffect(() => {
    const { hash } = window.location;
    if (/[#&]helper=/u.test(hash) && /[#&]pair=/u.test(hash)) {
      window.location.replace(`${claimPath}${hash}`);
    }
  }, [claimPath]);
  return null;
}
