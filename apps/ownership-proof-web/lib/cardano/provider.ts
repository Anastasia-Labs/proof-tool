import type { OutRef, Provider, UTxO } from "@lucid-evolution/lucid";

const QUERY_CONCURRENCY = 4;

export async function loadAddressUtxos(provider: Provider, addresses: string[]): Promise<UTxO[][]> {
  const groups: UTxO[][] = [];
  for (let offset = 0; offset < addresses.length; offset += QUERY_CONCURRENCY) {
    groups.push(
      ...(await Promise.all(
        addresses.slice(offset, offset + QUERY_CONCURRENCY).map((address) => provider.getUtxos(address)),
      )),
    );
  }
  return groups;
}

// Blockfrost fans out once per distinct transaction hash inside this SDK call.
export async function loadOutRefUtxos(provider: Provider, outrefs: OutRef[]): Promise<UTxO[]> {
  const utxos: UTxO[] = [];
  for (let offset = 0; offset < outrefs.length; offset += QUERY_CONCURRENCY) {
    utxos.push(...(await provider.getUtxosByOutRef(outrefs.slice(offset, offset + QUERY_CONCURRENCY))));
  }
  return utxos;
}
