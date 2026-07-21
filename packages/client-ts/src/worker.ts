import { masterXprvFromSeedPhrase } from "./index.js";

export type DeriveMasterXPrvRequest = {
  id: string;
  type: "derive-master-xprv";
  seedPhrase: string;
};

export type DeriveMasterXPrvSuccess = {
  id: string;
  type: "master-xprv";
  masterXPrv: ArrayBuffer;
};

export type DeriveMasterXPrvFailure = {
  id: string;
  type: "error";
  code: "invalid_mnemonic" | "crypto_unavailable" | "unsupported_request" | "derive_failed";
  message: string;
};

export type DeriveMasterXPrvResponse = DeriveMasterXPrvSuccess | DeriveMasterXPrvFailure;

export type OwnershipProofWorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: DeriveMasterXPrvResponse, transfer?: Transferable[]): void;
};

export async function handleWorkerRequest(
  request: unknown,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<DeriveMasterXPrvResponse> {
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
  } catch (error) {
    return {
      id: request.id,
      type: "error",
      code: errorCode(error),
      message: errorMessage(error),
    };
  }
}

export function attachOwnershipProofWorker(scope: OwnershipProofWorkerScope): void {
  scope.addEventListener("message", (event: MessageEvent<unknown>) => {
    void handleWorkerRequest(event.data).then((response) => {
      if (response.type === "master-xprv") {
        scope.postMessage(response, [response.masterXPrv]);
        return;
      }
      scope.postMessage(response);
    });
  });
}

function isDeriveRequest(value: unknown): value is DeriveMasterXPrvRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DeriveMasterXPrvRequest>;
  return (
    candidate.type === "derive-master-xprv" &&
    typeof candidate.id === "string" &&
    typeof candidate.seedPhrase === "string"
  );
}

function requestId(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return "unknown";
}

function errorCode(error: unknown): DeriveMasterXPrvFailure["code"] {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invalid BIP-39")) {
    return "invalid_mnemonic";
  }
  if (message.includes("WebCrypto")) {
    return "crypto_unavailable";
  }
  return "derive_failed";
}

function errorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case "invalid_mnemonic":
      return "The seed phrase is not a valid recovery phrase.";
    case "crypto_unavailable":
      return "Secure browser crypto is unavailable in this context.";
    default:
      return "The proof setup could not read that phrase.";
  }
}

const maybeWorkerScope = globalThis as Partial<OwnershipProofWorkerScope> & { document?: unknown };

if (
  typeof maybeWorkerScope.addEventListener === "function" &&
  typeof maybeWorkerScope.postMessage === "function" &&
  typeof maybeWorkerScope.document === "undefined"
) {
  attachOwnershipProofWorker(maybeWorkerScope as OwnershipProofWorkerScope);
}
