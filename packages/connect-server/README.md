# @polpo-ai/connect-server

Server-side primitives for Polpo Connect.

This package implements the backend lifecycle for API-key and OAuth2 connections:

- API-key connection creation
- OAuth authorization URL generation
- OAuth callback and token exchange
- access token retrieval
- refresh token handling
- policy checks before token release
- revocation and secret deletion

It is intentionally framework-agnostic. Cloud/OSS servers can mount it through Hono, Express, Workers, or another transport without coupling the core lifecycle to HTTP routes.
