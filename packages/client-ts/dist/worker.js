import { masterXprvFromSeedPhrase } from "./index.js";
export async function handleWorkerRequest(request, cryptoProvider = globalThis.crypto) {
    if (!isDeriveRequest(request)) {
        return {
            id: requestId(request),
            type: "error",
            code: "unsupported_request",
            message: "The worker request is not supported.",
        };
    }
    try {
        const bytes = await masterXprvFromSeedPhrase(request.seedPhrase, cryptoProvider);
        const masterXPrv = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(masterXPrv).set(bytes);
        bytes.fill(0);
        return {
            id: request.id,
            type: "master-xprv",
            masterXPrv,
        };
    }
    catch (error) {
        return {
            id: request.id,
            type: "error",
            code: errorCode(error),
            message: errorMessage(error),
        };
    }
}
export function attachOwnershipProofWorker(scope) {
    scope.addEventListener("message", (event) => {
        void handleWorkerRequest(event.data).then((response) => {
            if (response.type === "master-xprv") {
                scope.postMessage(response, [response.masterXPrv]);
                return;
            }
            scope.postMessage(response);
        });
    });
}
function isDeriveRequest(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    return (candidate.type === "derive-master-xprv" &&
        typeof candidate.id === "string" &&
        typeof candidate.seedPhrase === "string");
}
function requestId(value) {
    if (value && typeof value === "object" && typeof value.id === "string") {
        return value.id;
    }
    return "unknown";
}
function errorCode(error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("invalid BIP-39")) {
        return "invalid_mnemonic";
    }
    if (message.includes("WebCrypto")) {
        return "crypto_unavailable";
    }
    return "derive_failed";
}
function errorMessage(error) {
    switch (errorCode(error)) {
        case "invalid_mnemonic":
            return "The seed phrase is not a valid recovery phrase.";
        case "crypto_unavailable":
            return "Secure browser crypto is unavailable in this context.";
        default:
            return "The proof setup could not read that phrase.";
    }
}
const maybeWorkerScope = globalThis;
if (typeof maybeWorkerScope.addEventListener === "function" &&
    typeof maybeWorkerScope.postMessage === "function" &&
    typeof maybeWorkerScope.document === "undefined") {
    attachOwnershipProofWorker(maybeWorkerScope);
}
