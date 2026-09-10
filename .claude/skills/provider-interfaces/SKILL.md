---
name: provider-interfaces
description: >-
  Use when SWAPPING A FAKE FOR A REAL IMPLEMENTATION or adding any external
  integration: sending real WhatsApp messages, receiving a Meta webhook,
  switching the LLM, adding a payment gateway, or replacing the env-password
  admin auth. Owns HOW a message is delivered — the Notifier interface, template
  vs free-form, the 24-hour window — including a send that was attempted and
  silently failed or was rejected. If no send was ever attempted, the trigger is
  at fault: load booking-lifecycle. Covers src/providers/registry.ts and the Notifier,
  PaymentProvider, ChatModel and InboundAdapter interfaces. Symptoms it owns:
  "how do I add real WhatsApp sending", "wire up the webhook", "use a different
  model", "add Midtrans", "provider not found", "message needs an approved
  template". NOT for the bot's tools or conversation logic, which is chat-tools.
  NOT for booking rules or scheduling a message, which is booking-lifecycle.
---

# Provider interfaces

This skill is what makes the prototype upgradeable. The rule it exists to protect:

> Swapping a fake for a real implementation costs exactly two things — one new
> file implementing the interface, and one branch in `src/providers/registry.ts`.
> If it ever costs more, the abstraction is wrong. Fix the abstraction; do not
> work around it at the call site.

## The registry is the only place implementations are chosen

`src/providers/registry.ts` reads env and returns `Providers`:

```ts
{
  (notifier, payments, chatModel, inbound);
}
```

Env keys and their values are documented in `.env.example`: `NOTIFIER`,
`PAYMENT_PROVIDER`, `CHAT_MODEL`, `INBOUND_ADAPTER`, `ANTHROPIC_API_KEY`.

Call sites use `getProviders()`. They never construct an implementation, never
branch on which one is active, and never read those env vars. If you find
yourself writing `if (notifier instanceof …)`, that is the smell.

`setProviders()` / `resetProviders()` exist for tests only. An unknown env value
throws rather than silently falling back — except `CHAT_MODEL=auto`, which
deliberately falls back to `ScriptedChatModel` when there is no API key so a
fresh clone runs offline. `CHAT_MODEL=anthropic` with no key throws.
Pinned by `tests/providers/registry.test.ts`.

## The four interfaces

### `Notifier` — `src/providers/notifier/types.ts`

```ts
sendText(toPhone, body): Promise<void>
sendTemplate(toPhone, templateName, params): Promise<void>
```

Ships `ConsoleNotifier`, which logs and records to `.sent` for assertions.

`sendTemplate` is in the interface from day one even though the console fake
treats it like text. WhatsApp requires a pre-approved template outside the 24-hour
customer-service window; if callers were allowed to assume plain text always
works, adding the real notifier later would mean touching every call site. That is
the rewrite this design prevents.

### `PaymentProvider` — `src/providers/payment/types.ts`

```ts
createDpRequest(bookingId, amountRupiah): Promise<DpRequest>
getStatus(reference): Promise<'pending' | 'paid' | 'expired'>
```

Ships `ManualTransferProvider`. **This is not a stub.** Manual bank/QRIS transfer
confirmed by the owner is the real product at this tier. `createDpRequest` returns
the business's own account details from `src/config/business.ts` plus the exact
rupiah amount and a `DP-XXXXXXXX` reference. Status changes only when the owner
presses "DP diterima".

Why the rule in `CLAUDE.md` exists: a gateway registered under the
developer's name routes the client's revenue into the developer's bank account and
NPWP. A `MidtransProvider` may be added later **under the client's legal entity** —
see `docs/PRODUCTION-PATH.md`.

### `ChatModel` — `src/providers/chat-model/types.ts`

```ts
complete(messages, tools, system): Promise<{ text, toolCalls }>
```

Ships `AnthropicChatModel` (real; `claude-opus-5` by default, override with `ANTHROPIC_MODEL`) and `ScriptedChatModel`
(deterministic, offline, used by every transcript test). The message shape is
provider-neutral; `toAnthropicMessages` does the translation, including merging
consecutive tool results into one user message as that API requires. A second
provider implements the same three-argument `complete` and translates its own way.

### `InboundAdapter` — `src/providers/inbound/types.ts`

```ts
start(handler: (msg: { fromPhone, body, receivedAt }) => Promise<void>): Promise<void>
```

Ships `CliInboundAdapter` (terminal, `npm run repl`). The engine cannot tell a
terminal message from a webhook message, which is the entire point:
`handleInbound` takes the normalised shape and nothing else.

## Adding a real implementation

Worked example — real WhatsApp sending:

Neither file below exists yet — you are creating them.

1. Create `src/providers/notifier/whatsapp-cloud.ts` exporting
   `class WhatsAppCloudNotifier implements Notifier`. Read credentials from env
   inside its constructor and throw there if one is missing, so a
   misconfiguration fails at startup rather than at the first message.
2. Add one branch in `registry.ts`, replacing the commented placeholder that is
   already in `buildNotifier()`:
   ```ts
   case 'whatsapp_cloud': {
     const token = process.env.WHATSAPP_TOKEN;
     const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
     if (!token || !phoneId) {
       throw new Error('NOTIFIER=whatsapp_cloud needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.');
     }
     return new WhatsAppCloudNotifier(token, phoneId);
   }
   ```
   There is no `requireEnv` helper in this repo — read `process.env` and throw,
   the way `buildChatModel()` already does for `ANTHROPIC_API_KEY`.
3. Document the new env keys in `.env.example`.
4. Flip `NOTIFIER=whatsapp_cloud`.

**Zero changes to calling code.** `src/domain/booking-service.ts`,
`src/domain/hold-expiry.ts` and `src/chat/engine.ts` call
`getProviders().notifier.sendText(...)` and stay untouched.

The inbound webhook is the same shape, plus a route: create
`src/providers/inbound/whatsapp-webhook.ts`, add
`src/app/api/whatsapp/route.ts` (Next App Router — export `GET` for Meta's
verification handshake and `POST` for messages) that normalises the payload and
calls `handleInbound` from `src/chat/engine.ts`, add one registry branch, then set
`INBOUND_ADAPTER=whatsapp_webhook`. Signature verification, the challenge
handshake, retries and rate limits all live inside that implementation — see
"What must never leak into calling code" below, and `docs/PRODUCTION-PATH.md` for
Meta's platform constraints.

## What must never leak into calling code

- Provider names, env var names, or `instanceof` checks.
- SDK types in a domain signature. If `Anthropic.MessageParam` appears outside
  `src/providers/chat-model/anthropic.ts`, the boundary has broken.
- Transport concerns — retries, rate limits, the WhatsApp 24-hour window, template
  approval — all belong inside the implementation.
- Auth. Admin auth is currently one env password in `src/app/admin/auth.ts`.
  `booking_audit.actor_id` already carries an actor string, so real auth is purely
  additive: see `booking-lifecycle` for the audit shape.
