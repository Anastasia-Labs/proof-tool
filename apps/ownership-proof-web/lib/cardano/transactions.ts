import { CML } from "@lucid-evolution/lucid";

export class CardanoTransactionAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardanoTransactionAssemblyError";
  }
}

export function assembleTransactionWithWitnessSet(unsignedTxCbor: string, witnessSetCbor: string): string {
  try {
    const unsignedTx = CML.Transaction.from_cbor_hex(unsignedTxCbor);
    const walletWitnessSet = CML.TransactionWitnessSet.from_cbor_hex(witnessSetCbor);
    const witnessBuilder = CML.TransactionWitnessSetBuilder.new();
    const existingWitnessSet = unsignedTx.witness_set();
    witnessBuilder.add_existing(existingWitnessSet);
    witnessBuilder.add_existing(walletWitnessSet);

    const plutusDatums = existingWitnessSet.plutus_datums();
    if (plutusDatums) {
      for (let index = 0; index < plutusDatums.len(); index += 1) {
        witnessBuilder.add_plutus_datum(plutusDatums.get(index));
      }
    }

    const signedTx = CML.Transaction.new(
      unsignedTx.body(),
      witnessBuilder.build(),
      unsignedTx.is_valid(),
      unsignedTx.auxiliary_data(),
    );
    return signedTx.to_canonical_cbor_hex();
  } catch (error) {
    throw new CardanoTransactionAssemblyError(
      error instanceof Error ? error.message : "Unable to assemble transaction witnesses.",
    );
  }
}
