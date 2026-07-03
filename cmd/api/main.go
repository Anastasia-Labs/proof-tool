package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/verifier"
)

func main() {
	proofVerifier, err := verifier.LoadPinnedVerifier()
	if err != nil {
		log.Fatalf("load verifier: %v", err)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           newHandler(proofVerifier),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("proof verifier listening on :%s", port)
	log.Printf("circuit_id: %s", ownership.CircuitID)
	log.Printf("vk_hash: %s", proofVerifier.VKHash())
	log.Fatal(server.ListenAndServe())
}

func newHandler(proofVerifier verifier.ProofVerifier) http.Handler {
	return verifier.NewServer(proofVerifier, nil).Handler()
}
