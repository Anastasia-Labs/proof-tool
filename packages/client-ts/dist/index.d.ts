export declare const recoveryWordlistEnglish: readonly string[];
export declare function isValidRecoveryWord(word: string): boolean;
export type RecoveryPhraseValidation = {
    ok: boolean;
    reason?: "length" | "word" | "checksum";
};
export declare function validateRecoveryPhrase(words: string[]): RecoveryPhraseValidation;
export declare function normalizeSeedPhrase(seedPhrase: string): string;
export declare function masterXprvFromSeedPhrase(seedPhrase: string, cryptoProvider?: Crypto): Promise<Uint8Array>;
export declare function masterXprvHexFromSeedPhrase(seedPhrase: string, cryptoProvider?: Crypto): Promise<string>;
export declare function bytesToHex(bytes: Uint8Array): string;
