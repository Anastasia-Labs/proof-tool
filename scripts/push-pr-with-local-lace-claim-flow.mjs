#!/usr/bin/env node
import { main } from "../apps/ownership-proof-web/e2e/preprod/push-pr-with-local-claim-flow.mjs";

await main(process.argv.slice(2));
