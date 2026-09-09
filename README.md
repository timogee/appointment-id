# Barberkuy Kemang — WhatsApp booking

A WhatsApp-first appointment booking system for **one** Indonesian barbershop.
Customers book by chatting; the web page is a fallback for people who would
rather click.

This is a prototype built to be upgraded to production without a rewrite. The
hard parts are real from day one — the database overlap guarantee, the
availability engine, the booking state machine, the LLM tool layer. The parts
that need someone else's account (Meta, a payment gateway, real auth) sit behind
interfaces selected in a single registry file.

> **Status: Phase 1–4 complete, not yet live.** 99 tests pass offline. The real
> LLM has never made a live call, and all business details are placeholders.
> See [What you need to check](#what-you-need-to-check) before showing this to a
> client.

---

## Setup

Requires **Node 24+** and **Docker**. Verified on Node v24.20.0, Docker Compose
v5.5.0, Postgres 16.15.

> **Image pin:** `docker-compose.yml` uses `postgres:16-bookworm`, not
> `postgres:16`. The current `postgres:16` tag is Debian 13-based and its
> `initdb` **segfaults on this host's kernel**, so a fresh volume never
> initialises. Bookworm works. If you move to another machine you can try plain
> `postgres:16` again — any official image with `btree_gist` is fine.

```bash
npm install
cp .env.example .env          # already done if .env exists
docker compose up -d --wait   # Postgres 16 on :5433 — --wait blocks until healthy
npm run db:migrate            # applies migrations, asserts the constraint exists
npm run db:seed               # staff, services, hours from src/config/business.ts
npm test                      # 99 tests, offline, no API key needed
```

Use `--wait`. On a **fresh** volume Postgres runs `initdb`, which takes several
seconds, and `db:migrate` will otherwise fail with `ECONNREFUSED :5433`. The
compose file has a healthcheck; `--wait` blocks on it.

If `db:migrate` ever fails, check `docker compose logs db` before anything else.

Then pick a surface:

```bash
npm run dev                   # http://localhost:3000  (/ public, /admin owner)
npm run repl                  # chat with the bot in your terminal
npx tsx scripts/demo-e2e.ts   # scripted walkthrough of the whole flow
```

Admin password is `ADMIN_PASSWORD` in `.env` (currently `rahasia`).

### For a live bot

`npm run repl` needs `ANTHROPIC_API_KEY` in `.env`. Without it the provider
registry falls back to a scripted model that will not hold a conversation — the
tests use that deliberately, so the suite runs offline.

### Commands

| Command                 | What it does                                              |
| ----------------------- | --------------------------------------------------------- |
| `npm run check`         | prettier + tsc + eslint — **must pass before any commit** |
| `npm test`              | vitest, serial, needs Postgres up                         |
| `npm run db:reset`      | drops the schema and re-migrates                          |
| `npm run expire-holds`  | releases timed-out holds (run on a timer in prod)         |
| `npm run dev` / `build` | Next.js                                                   |

---

## What's been done

### The database prevents double-booking. This is the product.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (staff_id WITH =, slot WITH &&)
  WHERE (status IN ('pending_payment','confirmed'));
```

`booking.slot` is a _generated_ column — `tstzrange(start_time, end_time, '[)')` —
so the range can never drift from the times, and the half-open bound makes
back-to-back bookings legal without a special case. The partial `WHERE` is why a
cancelled or no-show booking frees its slot while the row survives.

There is no application-level overlap check anywhere, on purpose: two concurrent
requests can both pass a `SELECT`-then-`INSERT` and both write. Postgres
arbitrates instead. `tests/db/overlap-constraint.test.ts` proves it with two
pooled connections in two open transactions.

### Availability is computed, never stored

`src/domain/availability.ts` is pure arithmetic — no database, no clock. It
derives slots from working hours, time off, existing bookings, service duration
and buffer, every call. There is no slot table and there must not be one.

`suggestAlternatives` is a first-class function, not a caller-side loop, because
it is the most valuable thing the bot does: when the answer is no, say what the
answer _is_.

### The LLM cannot invent a time

Three enforcement points, all code rather than prompt:

1. **Dates are resolved before the model is consulted.** `parseIndonesianDate`
   handles _besok_, _lusa_, _sabtu depan_, _jam 2 sore_, _tgl 12_ deterministically
   and hands the model the answer.
2. **Names cannot be invented** — an unknown staff name is a failed tool call.
3. **Times are checked on the way out.** `findUngroundedTimes` throws if a reply
   states a clock time no tool returned. The error says _"ini BUG, bukan masalah
   prompt."_

Escalation to the owner (complaints, price negotiation, 3 unresolved turns, 2
tool errors) is decided by regex **before** the model runs — a transcript fixture
asserts the model is called zero times. An upset customer can talk a prompt out
of its rules; they cannot talk a regex out of matching.

### Payments are manual by design, not stubbed

Bank/QRIS transfer confirmed by the owner _is_ the product at this tier. A
gateway registered under your name would route the client's revenue into your
bank account and NPWP. The system stores the customer's bukti transfer as
evidence and never verifies it — the owner presses "DP diterima".

### Everything else

- Booking state machine with one `TRANSITIONS` map; `no_show` is terminal and
  **never deleted**, because the owner needs that number.
- Every mutation writes a `booking_audit` row in the same transaction.
- 60-minute holds with an expiry job that notifies and audits.
- Walk-ins contend for the same constraint — no bypass path.
- Admin page (today's bookings, DP confirmation, flagged handoff threads) and a
  plain public booking page.
- Agent docs: `CLAUDE.md`, five skills, two agents, and a post-edit hook that
  fails loudly naming the violated rule.

### Verified

| Check                           | Result                             |
| ------------------------------- | ---------------------------------- |
| `npm run check`                 | clean                              |
| `npm test`                      | **99 passed / 10 files**, offline  |
| `npx next build`                | clean, 3 routes                    |
| `db:reset` → `migrate` → `seed` | clean, constraint asserted present |
| Doc retrieval + routing tests   | passed after two rounds of fixes   |

---

## What you need to check

Roughly in order of how badly it bites.

### 1. Every business detail is invented

`src/config/business.ts` is placeholder data I made up. Replace all of it with
the real client's:

- Business name, address, WhatsApp number
- **Staff names** — currently Maria, Clara, Bagas
- **Services, durations, prices** — 5 services, Rp 45.000–250.000
- **Opening hours** — Sel–Jum 10:00–20:00, Sab–Min 09:00–21:00, Senin libur
- **Buffer (10 min), hold (60 min), DP (flat Rp 50.000)** — all guesses. Ask the
  owner. A flat DP may be wrong for a Rp 250.000 colouring job.

Then `npm run db:seed --fresh` and re-run `npm test` — two fixtures reference
"Potong Rambut Pria" and "Cat Rambut" by name.

### 2. The bank account is fake

`PAYMENT_DETAILS` says **BCA 1234567890**. If this ships as-is, customers
transfer DP into the void. Also `public/qris.png` **does not exist** — the
directory is empty, so the QRIS reference in the payment instructions points at a 404.

### 3. The real LLM has never run

There is no `ANTHROPIC_API_KEY` in `.env`. Every test uses `ScriptedChatModel`,
which pins the _tool contract_ but says nothing about whether the real model
routes well or sounds right in Indonesian. Add a key, run `npm run repl`, and
have a conversation. That is the first real test of `src/chat/prompt.ts`.

Model defaults to `claude-opus-5` at low effort; override with `ANTHROPIC_MODEL`.

### 4. The escalation regexes are my guesses

`src/chat/escalation.ts` matches complaint and price-negotiation phrasing I
invented. Real Indonesian customers will phrase things differently, and both
failure modes are bad: a missed complaint means the bot argues with an angry
customer, a false positive means every third chat gets handed off. Test against
real messages from the owner's actual WhatsApp history before launch.

### 5. Judgement calls worth a second opinion

- **The trailing buffer may run past closing time** — the service must finish
  before close, but the 10-minute tidy-up can overrun. Deliberate; confirm the
  owner agrees.
- **`completed` is excluded from the overlap constraint**, so a past booking can
  be corrected. Deliberate.
- **A cancelled booking's slot is immediately re-bookable**, including by the
  same customer.
- **The bot answers price questions** but escalates price _negotiation_.

### 6. Not a git repository

`git init` has not been run. Nothing is under version control yet. `.gitignore`
is written and ready.

---

## What to do next

**Before showing a client:** items 1 and 2 above, then `git init`.

**Before going live:** [`docs/PRODUCTION-PATH.md`](docs/PRODUCTION-PATH.md) has
the ordered path with file paths and no code — real admin auth, the WhatsApp
Cloud API notifier and webhook, the three message templates to get approved
(Indonesian copy drafted), the number-migration checklist, optional Midtrans
**under the client's legal entity**, and backups/monitoring.

Two things there that need lead time and are easy to leave too late:

- **Template approval** takes hours to days. Submit early.
- **Number migration** — the client's number cannot run on the WhatsApp Business
  app and Cloud API simultaneously. Schedule it with the owner present, outside
  business hours. Senin is the obvious window since the shop is closed.

Also worth knowing: **general-purpose AI bots have been banned on WhatsApp since
January 2026; task-specific bots are allowed.** The six-tool ceiling is a
compliance boundary, not just a design preference. Don't add an open-chat tool.

Re-check Meta's current rules before implementing — the constraints in
`PRODUCTION-PATH.md` are as specified to me and that policy has moved repeatedly.

---

## Working on this

`CLAUDE.md` is the always-loaded brief: commands, invariants, folder map. Deeper
knowledge lives in five skills under `.claude/skills/`, loaded on demand:

| Skill                 | Load it when                                         |
| --------------------- | ---------------------------------------------------- |
| `availability-engine` | which times can be offered, the overlap constraint   |
| `booking-lifecycle`   | statuses, holds, walk-ins, audit, scheduled messages |
| `chat-tools`          | the six tools, date parsing, handoff                 |
| `provider-interfaces` | swapping a fake for a real implementation            |
| `testing`             | writing a test here                                  |

A post-edit hook runs prettier, tsc and eslint and **fails loudly naming the
violated rule**. It does not auto-fix — a silent fix leaves you generating the
wrong pattern forever, a loud failure teaches the rule once.

**The one rule that matters:** if the `booking_no_overlap` constraint ever seems
not to work, stop and say so. Do not fall back to an application-level overlap
check. That constraint is the product.
