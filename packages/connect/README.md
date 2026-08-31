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

## Application capabilities

Application backends should invoke a logical capability, not select or receive a
physical Connection ID. Configure the mapping in the trusted control plane,
then call it with a project API key:

```ts
import { PolpoConnectClient } from "@polpo-ai/connect/client";

const connect = new PolpoConnectClient({
  baseUrl: "https://api.polpo.sh",
  headers: { authorization: `Bearer ${process.env.POLPO_API_KEY}` },
});

const response = await connect.requestApplicationCapability(
  process.env.POLPO_PROJECT_ID!,
  "github.repositories",
  {
    invocation: {
      user: "customer-42",
      metadata: { tenantId: "tenant-7" },
      scope: { key: "workspace-9", version: "3" },
    },
    request: { method: "GET", path: "/user/repos" },
  },
);
```

Unsafe methods require an idempotency key. Runtime request bodies never accept
a physical Connection ID or provider credential.
