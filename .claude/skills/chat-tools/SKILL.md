---
name: chat-tools
description: >-
  Use when working on HOW THE BOT REPLIES TO AN INCOMING MESSAGE: the six LLM
  tools and their arguments, the Indonesian date parser ("besok sore", "sabtu
  depan"), the system prompt, handoff and escalation to the owner, conversation
  sessions, or the transcript fixtures. Covers src/chat/*. Symptoms it owns: "bot
  invented a time", "bot resolved the wrong day", "bot argued about price instead
  of escalating", "bot kept replying after handoff", "add a tool", "add a
  transcript". NOT for computing which slots are free, which is
  availability-engine. NOT for booking statuses, audit rows, or a scheduled
  outbound message such as a reminder, which is booking-lifecycle. NOT for
  swapping the model implementation, which is provider-interfaces.
---

# Chat layer

## The LLM never computes anything

It relays tool results. Every time, price and staff name a customer sees came out
of a tool. This is enforced by code in three places, not by the prompt:

1. **Dates** are resolved before the model is consulted. `buildDateHint`
   (`src/chat/engine.ts`) runs `parseIndonesianDate` and hands the model the
   answer: `[sistem] Hari ini 2026-09-09. Tanggal yang dimaksud: 2026-09-10.`
2. **Names** cannot be invented. `resolveService`/`resolveStaff` in
   `src/chat/tools.ts` look them up and throw `NotFoundError` on a miss, so an
   unknown name is a failed tool call the model must relay.
3. **Times** are checked on the way out. `findUngroundedTimes` collects every
   literal from this turn's tool results and throws if the reply states a clock
   time none of them contained. The message says so explicitly:
   _"Ini BUG, bukan masalah prompt."_ Do not relax this check to make a test
   pass — fix the tool result instead.

`src/chat/prompt.ts` carries tone and policy only. It contains no hours, prices,
staff list or dates, because a fact in a prompt is a fact that goes stale
silently.

## The six tools

Defined once in `src/chat/tools.ts` as `TOOL_SPECS` (JSON Schema, hand-written)
with executors in `EXECUTORS`. There are exactly six and no more:

| Tool                   | Takes                                                        | Notes                                                                                 |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `checkAvailability`    | `staffName?`, `serviceName`, `dateOrRange`                   | must precede any stated time                                                          |
| `suggestAlternatives`  | `staffName`, `serviceName`, `dateOrRange`, `wantedStartIso?` | call before saying "penuh"                                                            |
| `createPendingBooking` | `staffName`, `serviceName`, `startIso`, `customerName?`      | returns `failed: 'SLOT_TAKEN'` rather than throwing, so the model offers alternatives |
| `getBookingsForPhone`  | —                                                            | scoped to the caller's phone                                                          |
| `cancelBooking`        | `bookingId`                                                  | re-checks ownership; a phone may only cancel its own                                  |
| `handoffToOwner`       | `reason`                                                     | after this, stop replying                                                             |

`dateOrRange` is `'YYYY-MM-DD'` or `'YYYY-MM-DD..YYYY-MM-DD'` — already resolved.
`startIso` must be copied verbatim from a tool result. `executeTool` never throws:
failures come back as `{ ok: false, error }` so the engine can count them.

## The date parser boundary

`src/chat/date-parser.ts` is deterministic application code, tested separately in
`tests/domain/date-parser.test.ts` with a frozen clock against Asia/Jakarta. It
handles `besok`/`bsk`, `lusa`, `hari ini`, weekday names, `sabtu depan`,
`pagi|siang|sore|malam` windows, `jam 2 sore` → `14:00`, `tgl 12`, `12 september`,
`weekend`.

Two traps it already handles — keep them handled:

- **`minggu` is both "Sunday" and "week".** `minggu depan` means next week;
  `hari minggu depan` means next Sunday. The week-range check runs _before_ the
  weekday loop for exactly this reason.
- **A bare weekday never means today** unless the customer wrote `rabu ini`.

It returns `null` when no date was mentioned. That is a feature: the engine then
says so and the bot asks, rather than the model picking a day.

## Handoff rules

`src/chat/escalation.ts` decides, deterministically, before the model is called.
The bot hands off and **stops replying** when:

| Trigger                   | Where                                          |
| ------------------------- | ---------------------------------------------- |
| complaint                 | `COMPLAINT_PATTERNS`                           |
| price negotiation         | `PRICE_NEGOTIATION_PATTERNS`                   |
| 3 turns resolving nothing | `MAX_UNRESOLVED_TURNS`, counted in `engine.ts` |
| 2 tool errors             | `MAX_TOOL_ERRORS`                              |

A price **question** ("berapaan sih potong sama clara") deliberately does NOT
escalate — answering it from a tool result is the bot's job. Only an attempt to
_change_ the price does. `tests/chat/engine.test.ts` >
`"classifies complaints and price negotiation, but not a price question"` pins this.

These are regexes rather than prompt instructions because an upset customer can
talk a prompt out of its rules and cannot talk a regex out of matching. The
complaint fixture asserts `expectModelCalls: 0` — the model is never even asked.

Once `chat_session.handed_off` is true the engine returns `reply: null` and never
reclaims the thread. The owner clears it in `/admin`.

## Adding a tool

1. Append to `TOOL_SPECS` with a hand-written JSON Schema and an Indonesian
   `description` — the description is what the model routes on.
2. Add an executor to `EXECUTORS`. It must call `src/domain/*`, never SQL, never
   date arithmetic, and must return already-formatted display values
   (`formatRupiah`, `formatInstantId`, `utcToJakartaTime`) so the model never
   formats anything.
3. Throw `NotFoundError`/`DomainError` for expected failures — `executeTool`
   turns those into friendly `{ ok: false }`. Anything else is logged as
   unexpected.
4. Add a transcript fixture (below) and run `npm test`.

Six tools is a deliberate ceiling. Prefer widening an existing tool's arguments to
adding a seventh.

## Adding a transcript fixture

Drop a `.json` file in `tests/chat/transcripts/`; it is picked up automatically by
`tests/chat/transcript-replay.test.ts`. The `Transcript` type there is the schema.

```json
{
  "name": "what this pins",
  "now": "2026-09-09T07:00:00Z",
  "phone": "628111000399",
  "setup": {
    "bookings": [
      { "staff": "Maria", "service": "Potong Rambut Pria", "startIso": "2026-09-12T03:00:00Z" }
    ]
  },
  "turns": [
    {
      "user": "batalin yang sabtu dong",
      "script": [
        { "toolCalls": [{ "name": "getBookingsForPhone", "arguments": {} }] },
        {
          "afterTool": "getBookingsForPhone",
          "toolCalls": [
            { "name": "cancelBooking", "arguments": { "bookingId": "{{booking.0.id}}" } }
          ]
        }
      ],
      "expectTools": [{ "name": "getBookingsForPhone" }, { "name": "cancelBooking" }],
      "expectHandoff": false
    }
  ]
}
```

- `script` drives `ScriptedChatModel`; steps match on `whenUserSays` and/or
  `afterTool`. Only the model's side is faked — tools, parser, escalation and
  Postgres are all real.
- `{{booking.N.id}}` resolves to the Nth id created by `setup.bookings`, because a
  fixture cannot know a generated UUID.
- `expectTools` asserts the exact sequence, each argument given, and that each
  call succeeded. `expectModelCalls: 0` proves the model was never consulted.
- `setup.fillDay` books out a staff member's afternoon so `suggestAlternatives`
  has something real to route around.

Assert on **tool calls and effects**, never on the bot's prose. The prose is the
model's; the contract is ours.
