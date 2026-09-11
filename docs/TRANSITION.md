# Transition to a server

Taking this from a laptop clone to a machine that answers a real WhatsApp
number. Written to be followed top to bottom on a fresh Ubuntu/Debian box.

`docs/PRODUCTION-PATH.md` is the companion: it says WHAT changes in the code and
why. This file says HOW to get the thing running on a server.

---

## 0. Know what you are deploying

REAL and working: the schema and its exclusion constraint, availability, the
booking state machine, hold expiry, the audit trail, the six chat tools, the web
fallback page, the owner console.

FAKE, selected in `src/providers/registry.ts`:

| Provider | Now              | Means                                            |
| -------- | ---------------- | ------------------------------------------------ |
| Notifier | `console`        | Messages print to the log. Nobody receives them. |
| Inbound  | `cli`            | No webhook. The only way in is `npm run repl`.   |
| Auth     | one env password | See §8 before real customers.                    |

NOT fake, manual by design: payments. The owner confirms a bank/QRIS transfer by
pressing a button. Do not add a payment SDK.

**The WhatsApp provider files do not exist yet.** Steps 1-6 below deploy a
working site with a chat engine you can talk to via `npm run repl`. Step 7 is
what makes a customer's WhatsApp message reach it, and it needs code that is
still to be written. Deploying first is still worth it: you need a live HTTPS
URL before Meta will let you save a webhook.

---

## 1. Server prerequisites

- Node 22 or newer (`node -v`). Node 24 is fine.
- Docker and the compose plugin, if you run Postgres in a container.
- A domain name pointing at the server, and port 80/443 open.
- Postgres 16 with the `btree_gist` extension available. The exclusion
  constraint in `0001_exclusion.sql` is the whole overlap guarantee; without
  that extension the migration fails and you must not proceed.

---

## 2. Clone and install

```bash
git clone <your-repo-url> barberkuy
cd barberkuy
npm ci
```

`npm ci` (not `npm install`) so you get exactly the locked versions.

---

## 3. Database

### Option A — Postgres in Docker (simplest)

`docker-compose.yml` as committed is a DEVELOPMENT config. Two things to change
before it faces the internet:

```yaml
ports:
  - '127.0.0.1:5433:5432' # was '5433:5432' — do not expose Postgres publicly
environment:
  POSTGRES_PASSWORD: <a real password> # was 'barberkuy'
```

The original `'5433:5432'` binds to every interface, so with an open firewall
the database is reachable from the internet with the password `barberkuy`.

```bash
docker compose up -d --wait
```

### Option B — managed Postgres

Use the provider's connection string. Confirm `btree_gist` is available
(`CREATE EXTENSION btree_gist;` must succeed). Most managed Postgres offerings
allow it; a few restrict extensions.

---

## 4. Environment

```bash
cp .env.example .env
```

Then edit `.env`:

```bash
DATABASE_URL=postgres://barberkuy:<real password>@localhost:5433/barberkuy

ADMIN_PASSWORD=<long random string>      # openssl rand -hex 24

NOTIFIER=console                         # whatsapp_cloud once step 7 is built
PAYMENT_PROVIDER=manual                  # stays manual
CHAT_MODEL=auto                          # 'auto' uses Anthropic when a key is set
INBOUND_ADAPTER=cli                      # whatsapp_webhook once step 7 is built

ANTHROPIC_API_KEY=sk-ant-...             # without this the bot is scripted, not smart
```

`CHAT_MODEL=auto` falls back to a scripted model when no API key is present.
That keeps a fresh clone runnable, but it also means **a missing key degrades the
bot silently instead of crashing.** If you expect a real LLM, set
`CHAT_MODEL=anthropic` so a missing key fails loudly at startup.

`.env` is gitignored. It holds your API key, database password and admin
password — never commit it, and keep it `chmod 600`.

---

## 5. Migrate and seed

```bash
npm run db:migrate     # applies src/db/migrations/*.sql, then verifies the constraint
npm run db:seed        # staff, services and hours from src/config/business.ts
```

`db:migrate` prints `booking_no_overlap present.` at the end. If it does not, stop
and fix that before taking bookings — that constraint is the only thing
preventing double-booking.

The seed is idempotent: re-run it any time you change `src/config/business.ts`
(prices, hours, staff) and it converges the database to the config. It updates
service prices in place and rewrites rosters and working hours, so removing a
staff member from a service in the config actually removes it here.

`npm run db:seed -- --fresh` wipes ALL data first, bookings included. Never run
`--fresh` on a server with real bookings.

Check it landed:

```bash
npm run repl           # talk to the bot in the terminal
```

---

## 6. Build and run

```bash
npm run build
npm start              # serves on :3000
```

### Keep it running — systemd

`/etc/systemd/system/barberkuy.service`:

```ini
[Unit]
Description=Barberkuy booking
After=network.target docker.service

[Service]
Type=simple
User=barberkuy
WorkingDirectory=/srv/barberkuy
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now barberkuy
sudo systemctl status barberkuy
```

### TLS and reverse proxy

Meta requires HTTPS with a publicly trusted certificate. Caddy is the shortest
path — it gets and renews a Let's Encrypt cert on its own.

`/etc/caddy/Caddyfile`:

```
booking.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Confirm from another machine, not from the server itself:

```bash
curl -I https://booking.yourdomain.com
```

### Release expired holds on a timer

Nothing releases a lapsed hold unless this runs. Without it, abandoned bookings
keep blocking slots forever.

```bash
crontab -e
```

```cron
*/5 * * * * cd /srv/barberkuy && /usr/bin/npm run expire-holds >> /var/log/barberkuy-holds.log 2>&1
```

---

## 7. WhatsApp Cloud API

Account work first — approvals take days and gate everything else.

### 7a. Accounts and the number

1. Meta Business account at business.facebook.com; complete business
   verification (needs company documents — this is the slow gate).
2. developers.facebook.com → create an app → add the WhatsApp product.
3. Register the shop's number as the sender. **It must not be active on the
   regular WhatsApp or WhatsApp Business app** — registering on the Cloud API
   takes the number over. If that is your live shop line, do the migration after
   closing hours.
4. Attach a billing method even at zero spend. Cloud API numbers require one.

### 7b. Webhook

The callback URL is your deployed route:

```
https://booking.yourdomain.com/api/whatsapp
```

The **verify token is a string you invent** — Meta does not issue it. Generate
one, paste it into the Meta form, and put the identical value in `.env`:

```bash
openssl rand -hex 32
```

```
WHATSAPP_VERIFY_TOKEN=<that string>
WHATSAPP_TOKEN=<permanent access token>
WHATSAPP_PHONE_NUMBER_ID=<from the app dashboard>
WHATSAPP_APP_SECRET=<App settings -> Basic -> App secret>
```

When you press "Verify and save", Meta sends one GET with `hub.mode`,
`hub.verify_token` and `hub.challenge`. Your route compares the token and echoes
`hub.challenge` back as plain text, 200. That endpoint must already be live —
Meta verifies at save time, so deploy before you configure.

Subscribe to the **`messages`** webhook field. Skip the client certificate
option; that is mutual TLS and you do not need it.

The verify token secures only that one-time handshake. Every incoming POST is
authenticated separately by checking `X-Hub-Signature-256` against
`WHATSAPP_APP_SECRET`.

### 7c. Publish the app

While the app is unpublished, only the dashboard's "Test" button delivers
webhooks. **Real customer messages do not arrive until the app is published.**
Plan testing around that: handshake → dashboard test payloads → publish → real
conversation.

### 7d. Templates

Three utility templates, submitted in Meta Business Manager. Copy is written out
in `docs/PRODUCTION-PATH.md` §3 — paste it verbatim:

- `booking_confirmed`
- `booking_reminder_h1`
- `hold_expiring_warning`

Submit these on day one. Approval takes hours to days.

Free-form replies only deliver within 24 hours of the customer's last message.
Anything the system sends on its own schedule — a reminder, a hold warning — is
outside that window by definition and must be a template.

### 7e. Flip the switches

Once `src/providers/notifier/whatsapp-cloud.ts`,
`src/providers/inbound/whatsapp-webhook.ts` and `src/app/api/whatsapp/route.ts`
exist and `registry.ts` has its two branches:

```
NOTIFIER=whatsapp_cloud
INBOUND_ADAPTER=whatsapp_webhook
```

No calling code changes. That is the whole point of the provider design.

---

## 8. Before real customers — security

These are known gaps, not surprises. Decide on each deliberately.

**The admin cookie is the password.** `src/app/admin/auth.ts` stores
`ADMIN_PASSWORD` itself as the session cookie value and does not set `secure`.
So the password travels on every admin request, and without `secure` a single
plain-HTTP request leaks it. Minimum: force HTTPS (Caddy does, above) and add
`secure: true` to the cookie. Properly: replace it with real sessions —
`docs/PRODUCTION-PATH.md` §1, and it is additive because `booking_audit` already
records an actor.

**There is no login rate limit.** A single env password with unlimited attempts
is brute-forceable. Rate-limit the admin route, or put the console behind your
reverse proxy's basic auth or an IP allowlist as a stopgap.

**Compliance.** Meta has banned general-purpose AI bots since January 2026;
task-specific ones are allowed. The six-tool ceiling is what keeps this on the
legal side. Do not add a general-knowledge or open-chat tool — that is a
compliance boundary, not a design preference.

---

## 9. Routine operations

```bash
# Deploy a change
git pull
npm ci
npm run db:migrate        # no-op when there is nothing new
npm run build
sudo systemctl restart barberkuy

# Business facts changed (prices, hours, staff)
# edit src/config/business.ts, then:
npm run db:seed
sudo systemctl restart barberkuy

# Logs
journalctl -u barberkuy -f

# Backup — do this before every deploy, and on a schedule
docker exec barberkuy-db pg_dump -U barberkuy barberkuy > backup-$(date +%F).sql
```

There is no automated backup here. A booking system with no backup is one bad
migration away from losing the calendar. Set up a nightly `pg_dump` to somewhere
off this machine.

---

## 10. Troubleshooting

| Symptom                                   | Cause                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Migration fails on `0001_exclusion.sql`   | `btree_gist` unavailable. Fix this; do not skip the migration.                 |
| Bot replies but sounds scripted           | No `ANTHROPIC_API_KEY`, so `CHAT_MODEL=auto` fell back. Set the key.           |
| Meta will not save the webhook            | Endpoint not deployed, not HTTPS, self-signed cert, or token mismatch.         |
| Handshake fine, no customer messages      | App still unpublished, or not subscribed to the `messages` field.              |
| Slots stay blocked after customers vanish | The `expire-holds` cron is not running.                                        |
| Owner marks DP received, nothing sends    | `NOTIFIER=console` still. Messages are going to the log.                       |
| Double bookings                           | Should be impossible. Check `booking_no_overlap` exists — that is a red alert. |
