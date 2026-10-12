# Application actions in chat suggestions

Version boundary: 0.17.0. This extends the released Loop suggestions contract;
it does not implement Channel buttons or lists.

## Product contract

An application backend can supply deterministic next actions alongside generated
next messages. The model only writes message labels/prompts. It never invents a
URL, postback value, permission grant, or platform operation.

The request adds `actions` to `polpo.capabilities.suggestions`. Each action has
`kind: "action"`, an optional `id`, a `label`, and an `action` containing either
`{ type: "open_url", url }` or `{ type: "postback", value }`. These are the same
interaction concepts used by Loop result presentations; action execution remains
the responsibility of the consuming application.

Caller actions come first, in supplied order. The configured/request `maxItems`
is the total list limit (default three, maximum five), including actions. Excess
actions are truncated in order, and model messages use only the remaining slots.
Supplying five actions with `maxItems: 5` does not call an auxiliary model.

An explicit `actions` list selects the typed output format: generated messages
include `kind: "message"`; actions have `kind: "action"`. Requests without
`actions`, including `suggestions: true`, retain the existing message-only shape.
Old history without `kind` remains a message. Public TypeScript consumers of the
new union must narrow `kind === "action"` before reading `prompt`.
This also applies when reading history written by another, newer client: omitting
`actions` from a new request does not remove actions already stored in a Session.

For example, an application server can send this request fragment:

```json
{
  "polpo": {
    "capabilities": {
      "suggestions": {
        "enabled": true,
        "maxItems": 5,
        "context": { "published": false },
        "actions": [
          {
            "kind": "action",
            "id": "publish",
            "label": "Publish the site",
            "action": { "type": "open_url", "url": "https://app.example.com/sites/123/publish" }
          },
          {
            "kind": "action",
            "id": "plan",
            "label": "View plan",
            "action": { "type": "postback", "value": "billing:open" }
          }
        ]
      }
    }
  }
}
```

The response starts with these two actions and can contain up to three generated
messages. Pass updated actions on client-tool continuations when application
state changes; actions are per-request state and are not automatically inherited
from the previous turn. An explicit empty `actions: []` requests typed messages
without adding deterministic actions.

Actions remain subject to agent opt-in, the client capability, and hosted policy.
They appear only after a successful eligible completion, never while waiting for
a tool, after failed/aborted execution, or for structured response formats.
An auxiliary inference error, timeout, or unavailable auxiliary model preserves
valid deterministic actions and the primary response.

## Trust and persistence

The authenticated caller is responsible for supplying trusted destinations.
Only absolute `https://` URLs without embedded credentials, backslashes or control
characters are accepted.
Labels, IDs, payload lengths, array size, action types and duplicate IDs are
validated before execution. URL and postback payloads are never added to the
auxiliary model prompt. Returned actions do not grant permissions: publication,
billing and all other handlers recheck the current user and application state.

Polpo returns data. It does not automatically visit a URL, invoke a tool, fetch a
postback endpoint or perform an application operation. Rendering a link or
dispatching a postback requires a user selection in the application.

The final combined array is stored on the assistant message, streamed once before
terminal events, and replayed from the durable journal. Request order and IDs are
preserved through history and replay. Missing IDs receive `action_1`, `action_2`,
etc. within that request, skipping IDs already reserved by the caller or assigned
to earlier items; they are presentation identifiers, not authorization
tokens or global identifiers. Existing JSON Session storage needs no migration.

## OSS implementation and acceptance

- Core owns the message/action union, request validation, output budget and merge.
- Server schemas expose the request/response shapes; all existing successful
  completion paths use the shared merger, including Project Loops.
- Model generation remains message-only, including when one slot remains.
- SDK and React export the shared union and preserve items on streams/history
  and tool continuation requests; no DOM side effects are added to the SDK.
- CLI and agent-directory settings remain unchanged: actions are request state.
- Tests cover mixed streaming/non-streaming/adapter results, history/replay,
  malformed/unsafe actions, count/order, opt-outs, failures/timeouts, one remaining
  model slot, all-action responses and no action payload in model input.

Release the coherent OSS package set before Cloud consumes the contract. Cloud
retains its existing runtime ceiling and auxiliary metering and verifies the
published route. Channel rendering and selection-to-message roundtrips are the
next separate delivery, not enabled by this contract alone.
