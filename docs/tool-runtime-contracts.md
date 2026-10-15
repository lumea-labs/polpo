# Tool and structured-output runtime contracts

Polpo admits one immutable contract for every tool before execution. The
contract contains the exact input schema, behavioral annotations, execution
origin, strictness policy, and stable fingerprints. Provider-facing schemas
are derived from that contract; they never replace the schema used by the
local execution validator.

## Tool definitions

Custom and built-in tools can declare behavioral facts and provider strictness:

```ts
{
  name: "account_lookup",
  description: "Read one account",
  parameters: {
    type: "object",
    properties: { id: { type: "string", pattern: "^[a-z0-9_-]+$" } },
    required: ["id"],
    additionalProperties: false
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
    resultStability: "stable"
  },
  strictness: "provider-preferred"
}
```

`strictness` has three values:

- `execution` validates locally immediately before every execution;
- `provider-preferred` also requests provider-native strict generation when
  the concrete provider, model, adapter, and endpoint declare support;
- `provider-required` rejects the turn before provider I/O unless that support
  is proven.

Local validation is always enabled. It covers nested objects, arrays, tuples,
unions, references, string formats and patterns, numeric constraints,
`additionalProperties`, unsafe object keys, malformed schemas, and bounded
schema/input size and depth. Unknown tools and invalid arguments never reach an
executor. Middleware-mutated arguments are validated again.

## Operational and terminal phases

A turn with operational tools and a strict terminal result is split into two
phases by default:

1. the operational phase exposes the exact active tools and executes admitted
   calls;
2. the terminal-output phase freezes the transcript and receipts, exposes no
   operational tools, and generates the requested result.

Strict terminal output is buffered until it passes schema validation and any
output policy mutation passes a second validation. An adapter can combine tools
and output in one provider request only when its concrete route is marked
`conformant` by a wire-level test.

The effective plan is created before provider I/O. It records the phase,
visible and active tool inventory, schema fingerprints, tool choice, output
presence, runtime capabilities, and warnings. `required` with no visible tool,
`none` with visible tools, or a forced hidden tool fails before inference.

## Progressive loading

Large catalogs use `polpo_tool_list`, `polpo_tool_search`, and
`polpo_tool_load`. Loading changes the exact visible inventory for the next
model turn. A loaded tool is then called directly with its full schema. There
is no generic `args: any` executor for hidden tools.

## Receipts and repeated calls

Every server-executed call can carry a stable call ID. A receipt binds that ID
to the tool definition fingerprint and the canonical argument fingerprint.
A completed call replays its stored result; an in-flight or uncertain outcome
returns `tool_outcome_unknown`; changed arguments or a changed tool contract
returns `resume_contract_mismatch`. Resumable hosts should inject a durable,
atomic receipt store into the Run scope.

Polpo reuses results only for tools explicitly marked read-only, idempotent,
and stable. Four identical observations without progress stop the loop with
`tool_loop_stalled`. Writes, volatile reads, and unannotated tools are never
deduplicated.

## Runtime capability behavior

Direct OpenAI, Google, and xAI adapters in the released SDK declare native
strict-tool support. The installed Anthropic adapter uses emulated structured
output and does not declare strict-tool support. Groq, Mistral, Vercel AI
Gateway, and custom compatible endpoints remain `unknown` until the concrete
host supplies tested capability evidence. On an unproved route,
`provider-preferred` emits a warning and local validation remains authoritative.

Provider warnings are returned by the model-turn primitive and surfaced in
runtime telemetry. Unsupported mandatory capability requests fail before the
provider or executor is called.

## Diagnostics

Polpo Cloud exposes sanitized, read-only Run diagnostics through:

```bash
polpo runtime inspect <run-id>
polpo runtime inspect <run-id> --json
polpo runtime export-replay <run-id> --output replay.json
```

Diagnostics contain fingerprints, tool names, bounded warnings, receipt
states, progress decisions, and terminal outcomes. They exclude credentials
and full sensitive arguments. The replay export is created by the host's
sanitizer and cannot be used to fabricate a completed receipt.

Stable runtime codes include `tool_capability_unsupported`,
`tool_choice_invalid`, `tool_outcome_unknown`, `tool_loop_stalled`,
`output_capability_unsupported`, `loop_agent_output_invalid`, and
`resume_contract_mismatch`.
