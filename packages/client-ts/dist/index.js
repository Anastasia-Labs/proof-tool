import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
const XPRV_LENGTH = 96;
// The BIP-39 English wordlist, re-exported so UI surfaces can validate
// recovery words without adding their own @scure/bip39 dependency.
export const recoveryWordlistEnglish = wordlist;
const RECOVERY_PHRASE_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);
let recoveryWordSet;
function recoveryWords() {
    recoveryWordSet ??= new Set(wordlist);
    return recoveryWordSet;
}
export function isValidRecoveryWord(word) {
    return recoveryWords().has(word.trim().toLowerCase());
}
// Validates a full recovery phrase: word count, wordlist membership, and the
// BIP-39 checksum. Pure and side-effect free: the words are only read, never
// stored or logged.
export function validateRecoveryPhrase(words) {
    if (!RECOVERY_PHRASE_WORD_COUNTS.has(words.length)) {
        return { ok: false, reason: "length" };
    }
    const normalized = words.map((word) => word.trim().toLowerCase());
    if (!normalized.every((word) => recoveryWords().has(word))) {
        return { ok: false, reason: "word" };
    }
    if (!validateMnemonic(normalized.join(" "), wordlist)) {
        return { ok: false, reason: "checksum" };
    }
    return { ok: true };
}
export function normalizeSeedPhrase(seedPhrase) {
    return seedPhrase.trim().split(/\s+/u).join(" ");
}
export async function masterXprvFromSeedPhrase(seedPhrase, cryptoProvider = globalThis.crypto) {
    const phrase = normalizeSeedPhrase(seedPhrase);
    if (!validateMnemonic(phrase, wordlist)) {
        throw new Error("invalid BIP-39 seed phrase");
    }
    if (!cryptoProvider?.subtle) {
        throw new Error("WebCrypto subtle crypto is unavailable");
    }
    const entropy = mnemonicToEntropy(phrase, wordlist);
    const salt = new Uint8Array(entropy.length);
    salt.set(entropy);
    const key = await cryptoProvider.subtle.importKey("raw", new Uint8Array(), "PBKDF2", false, ["deriveBits"]);
    const bits = await cryptoProvider.subtle.deriveBits({
        name: "PBKDF2",
        hash: "SHA-512",
        salt,
        iterations: 4096,
    }, key, XPRV_LENGTH * 8);
    const out = new Uint8Array(bits);
    out[0] &= 0b1111_1000;
    out[31] &= 0b0001_1111;
    out[31] |= 0b0100_0000;
    return out;
}
export async function masterXprvHexFromSeedPhrase(seedPhrase, cryptoProvider) {
    return bytesToHex(await masterXprvFromSeedPhrase(seedPhrase, cryptoProvider));
}
export function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
