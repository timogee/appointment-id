# Barberkuy Kemang — WhatsApp booking

One Indonesian barbershop. Not a SaaS: no multi-tenancy, no plans, one timezone.
WhatsApp chat is the primary surface; the web page is the fallback.

## Commands

    docker compose up -d --wait   Postgres 16 on :5433 (btree_gist; --wait on fresh volume)
    npm run db:migrate        apply src/db/migrations/*.sql  (--reset drops first)
    npm run db:seed           real staff/services/hours from src/config/business.ts
    npm run check             prettier --check + tsc --noEmit + eslint   <- must pass
    npm test                  vitest, offline, no API key needed
    npm run repl              talk to the bot in a terminal
    npm run dev               / = public booking, /admin = owner
    npm run expire-holds      release timed-out holds

## Invariants — true for every edit, no exceptions

1. Instants are UTC `timestamptz`. Displayed in Asia/Jakarta. Never store a naive
   local time. Convert only via `src/domain/time.ts`.
2. Money is integer rupiah (`*_rupiah` columns). Never float, decimal, or string.
   Format only via `formatRupiah` in `src/domain/money.ts`.
3. Every booking mutation writes a `booking_audit` row (actor, action, before,
   after, at) in the SAME transaction as the change.
4. The LLM never computes a time, a price, or an availability answer. It relays
   tool results. A time or staff name in an outgoing message that no tool
   returned is a BUG, not a prompt-tuning problem.
5. Overlap is prevented by the database, never by application code.

## Folder map

    src/config/business.ts   every business fact: hours, services, DP, bank details
    src/db/                  schema, migrations, pg-error translation
    src/domain/              availability, booking lifecycle, audit, time, money
    src/chat/                date parser, the 6 tools, engine, escalation
    src/providers/           Notifier | PaymentProvider | ChatModel | inbound
    src/app/                 Next App Router: / (public), /admin (owner)
    scripts/                 migrate, seed, repl, expire-holds, demo-e2e
    tests/                   mirrors src/

## Real vs fake

REAL, no shortcuts: the schema and its exclusion constraint, availability
computation, the state machine, hold expiry, the tool layer.

FAKE behind an interface: notifications, inbound, auth (one env password).
Selection happens ONLY in `src/providers/registry.ts`.

NOT fake — manual by design: payments. Bank/QRIS transfer confirmed by the owner
is the real product at this tier. Do not add a payment SDK.

## Skills

- `availability-engine` — computing offerable slots, and the DB overlap constraint
- `booking-lifecycle` — statuses, transitions, holds, walk-ins, audit
- `chat-tools` — the 6 LLM tools, date parsing, handoff rules
- `provider-interfaces` — swapping a fake for a real implementation
- `testing` — how to write a test here
