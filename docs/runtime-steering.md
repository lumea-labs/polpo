# Runtime steering

Polpo steering adds user instructions to an active Run without interrupting a
tool call. `steer` is eligible at the next safe model boundary. `follow_up` is
eligible when the current agentic work would otherwise finish.

## Policy

Agents, inline Loops, Project Loops, and Project Loop agent nodes can declare:

```json
{
  "steering": {
    "acceptance": "best_effort",
    "outcomes": {
      "rejected": {
        "action": "reply",
        "messages": { "en": "This step cannot accept instructions.", "it": "Questo passaggio non accetta istruzioni." }
      },
      "too_late": {
        "action": "return",
        "messages": { "en": "The step already finished.", "it": "Il passaggio è già terminato." }
      }
    }
  }
}
```

`accept` acknowledges only when the current agentic scope has a reservable
future model turn. `reject` declines immediately. `best_effort` is the default:
it accepts while the Run is open and later settles as `delivered` or
`too_late`.

Project Loop policy resolves from agent node, Project Loop, agent, trusted
project host setting, then the platform default. Non-agent graph steps do not
consume messages. A best-effort message remains eligible for the next agent
node until the graph finishes.

## Receipts

`POST /v1/runs/{runId}/steering` returns a receipt with separate `admission`
and `delivery` fields. Admission is `accepted`, `duplicate`, `rejected`, or
`too_late`. Delivery is `pending`, `delivered`, `too_late`, `cancelled`, or
`failed`.

Read the eventual result with:

```http
GET /v1/runs/{runId}/steering/{messageId}
```

The SDK exposes `steerRun()` and `getSteeringReceipt()`. The CLI equivalents
are:

```bash
polpo runs steer <run-id> --message "Use the existing schema" --locale it-IT
polpo runs steering get <run-id> <message-id>
polpo runs abort <run-id> --reason "Cancelled by user"
```

Message IDs are Run-scoped idempotency keys. Reusing an ID with different
content is rejected. Optional locales are normalized BCP 47 tags. Localized
outcomes resolve by exact tag, primary language, English, first configured
message, then a stable built-in English response.

The built-in registry provides single-process semantics and archives a bounded
set of receipts after a Run owner exits. Distributed hosts must implement the
same controller and registry contracts with durable, tenant-scoped admission,
delivery, and receipt storage.
