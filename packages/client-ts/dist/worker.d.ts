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
export declare function handleWorkerRequest(request: unknown, cryptoProvider?: Crypto): Promise<DeriveMasterXPrvResponse>;
export declare function attachOwnershipProofWorker(scope: OwnershipProofWorkerScope): void;
