# @polpo-ai/connect

Shared contracts and client SDK for Polpo Connect.

Polpo Connect models external service connections as scoped, revocable capabilities that can be assigned to agents without exposing raw access tokens to the model.

This package contains:

- connector provider definitions
- connection and OAuth state types
- scope normalization and validation helpers
- connector registry helpers
- a small HTTP client for Connect APIs

Server-side OAuth/token lifecycle lives in `@polpo-ai/connect-server`.
