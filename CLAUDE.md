# Property Agent — project instructions

Work-order management and invoicing for John Macrae's 60-property Colchester rental portfolio (managed via Rentopia).

**Read `NEXT.md` first for current state, `BUGS.md` for known defects.** This file holds only durable facts — things that stay true between sessions.

**This repo is public.** `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html` and `agent/JJP_Property_List.md` are gitignored because they map portfolio addresses to live maintenance issues. They exist locally at `/volume1/docker/property-agent/`. Do not commit them, and keep addresses and postcodes out of anything that is committed.

---

## Architecture — know this before proposing changes

**Two agents, two different LLMs, two different runtimes.**

| | `property-agent` (this folder) | `property_invoicing` (`../property_invoicing/`) |
|---|---|---|
| LLM | OpenRouter, primary model + fallback chain in `.env` (`AGENT_MODEL`/`AGENT_MODEL_FALLBACK`, not hardcoded — see `NEXT.md`) | **Claude**, via `claude --print` |
| Runtime | `agent/agent-runner.js` — custom tool loop | Claude Code CLI, `--max-budget-usd 0.50` |
| Tools | Registered tools only — **no Bash, no MCP client** | Bash (allowlisted) + Claude account connectors |
| Schedule | morning 05:00, property-check 07:00–15:00 /2h, weekdays | 06:00 Mon–Fri, single shot |

`property-agent` **has no Bash and no MCP client** — Claude Code was removed from its image on 2026-07-18 and the `~/.claude` mounts dropped. It cannot be told to "run a script". Anything new it must do has to be a registered tool in `agent/agent-runner.js` (`gcal_*`, `store_*`, `wo_lookup`, `telegram_send`, …).

Consequence: any new Gmail-touching capability must be Node, not a Python subprocess — no Python interpreter exists in this image. As of 2026-08-25, work-order capture (`agent/gmail.js` + `agent/wo-gmail-scan.js`) does this natively: raw-fetch OAuth against a mounted `gmail-mcp` token file (`/gmail-config/token.json`), mirroring `gcal.js`'s existing Calendar-OAuth pattern — not a `gmail_client.py` bind-mount/subprocess (that pattern is Python-only, used by `mail-reader`/`EICR`/`BL_Audit`, and has no working precedent for a Node caller). Gmail access is still not exposed to the LLM as a tool — WO capture is deterministic, scheduler-owned, and runs before the LLM session even starts (see the pipeline below).

`isWorkday()` (`agent/scheduler.js:75`) gates the schedule on weekday + UK bank holidays. Gaps at weekends are expected, not faults.

## The pipeline

```
Rentopia email  →  agent/wo-gmail-scan.js (in-process, scheduled)  →  inbox item (store.addInboxItem)
                →  property-agent session  →  Maintenance calendar event (+ WO PDF)
                →  property-agent invoice-run (06:00)  →  FreeAgent draft (complete → billable lines, or 1hr minimum)
                →  invoice-run (≥24h)  →  FreeAgent email to jramacrae@gmail.com
```

As of 2026-08-25, WO capture is native to property-agent (`agent/gmail.js` + `agent/wo-gmail-scan.js`, scheduled 05:30/07:45.../17:45 in `scheduler.js`) — no separate container, no cross-compose HTTP hop. `mail-reader`'s `work-order-processor` container (the old Python path, same schedule) is still running in **parallel** for verification; both are dedup-safe (same `order_number` uniqueness) and safe to run together. Once a few days of clean agreement are confirmed, `work-order-processor` gets retired — see `NEXT.md` for status. `mail-reader`'s `gmail-processor` service (Rentopia statement parsing / Paperless filing — unrelated) is untouched either way.

`property_invoicing` morning create is disabled; do not re-enable without removing property-agent invoice-run.

## Standing decisions — do not re-litigate

- **Maintenance calendar only** for invoicing. The Property Calendar carries Rentr lettings viewings which must **never** be invoiced. (Decided 2026-07-29.) IDs are in `agent/gcal.js:12-14`.
- **The local `ob1` container is not a dependency.** `OPEN_BRAIN_MCP_URL=http://ob1:8000` in `../property_invoicing/.env` is read by no code, and the container is not on a reachable network. Starting it changes nothing — do not propose it. The real Open Brain is a Supabase Edge Function; see BUG-014.
- **`property-agent` was deliberately decoupled from Open Brain / OB1** (`agent-system-prompt.md:10`, `:196` — *"NEVER Open Brain"*). Its replacement ledger is `store_invoice_check` / `store_invoice_mark` → the `invoices` table (`agent/store.js:255-272`). Use that, not thoughts.
- **`DATABASE_URL` is correct.** `ECONNREFUSED 172.18.0.4:5432` at boot is a one-shot startup race (`agent/scheduler.js:837-845`), caught and harmless — property-agent and property-docs are separate compose projects so `depends_on` is impossible. `Scheduler running (standalone — no OB1)` (`:847`) is an unconditional literal, **not** a degraded-mode signal.
- **Gmail re-auth:** `gmail-mcp/get_token.py` run from John's laptop with `py -3`, writing straight to `W:\gmail-mcp\config\<account>\token.json`. Launchers: `reauth.bat`, `reauth-kk4oyj.bat`. Do not propose the container-based `gmail-auth-helper`.
- **Job completion is recorded as free text** in Maintenance event descriptions ("Done", "Done 1hr", "Completed — 1.5 hours"). Unstructured, but it is there — do not conclude completion is untracked.

## Safety rules

- **Never create, amend or delete a FreeAgent invoice without explicit approval** outside the automated `invoice-run` path. Manual `freeagent.js create-invoice` writes to live accounts. Read-only inspection is fine — use `tools/fa_list.js`.
- **Automated invoicing** (`agent/invoice-run.js`, morning + `POST /invoice-run`): drafts a FreeAgent invoice when a Maintenance event description has `done`/`complete`/`completed` at line/sentence start. Notes that parse to ≥1 billable line (hours or £) are billed as written; notes with none fall back to a 1-hour minimum charge (`allowMinimum: true`, changed 2026-09-04 — previously these were skipped and reported as "no billable lines in notes"). No category skips. Cancelled jobs are not invoiced. Drafts are emailed to `jramacrae@gmail.com` only after **24 hours** in ledger status `draft`.
- Dedup is by calendar `event_id` in the `invoices` ledger. Same WO on two events can still double-bill (BUG-020).
- Invoice numbering is sequential — check continuity before manual creates.
- Do not change Docker ports, Tailscale, DNS or firewall without explicit authorisation.

## Conventions

- Properties are identified by **shortcode** (`122NG`, `24HC`, `8AM`). Canonical list: `../property_details/JJP_Property_List.md`; street aliases: `property-aliases.json`; rates: `rates.json`.
- Shortcode resolution is punctuation-sensitive and silently drops work orders when it fails (BUG-011). Prefer postcode matching.
- Work orders are `WO######`. Include the WO number in invoice descriptions so reconciliation is exact (BUG-009).

## Key files

| Path | What |
|---|---|
| `NEXT.md` | Current state + priority actions |
| `BUGS.md` | 21 bugs, 10 improvements — **gitignored, local-only** |
| `WORK_ORDERS_OUTSTANDING.html` | 1 May–29 Jul audit — **gitignored, local-only** |
| `agent/JJP_Property_List.md` | 60 shortcodes → addresses — **gitignored, local-only** |
| `WORK_ORDER_PIPELINE.md`, `HANDOFF.md` | Pipeline detail, longer history |
| `agent/agent-runner.js` | Tool loop + tool definitions |
| `agent/scheduler.js` | Schedule, watchdog, HTTP endpoints (`:416-554`) |
| `agent/freeagent.js` | `create-invoice` / `update-invoice` / `send-invoice` / notes parser |
| `agent/invoice-run.js` | Deterministic complete→draft→email-after-24h run |
| `agent/gcal.js` | Calendar tools + both calendar IDs |
| `agent/store.js` | Local store incl. the unused invoice ledger |
| `tools/wo_audit.py` | Gmail work-order audit (broader than the processor's query) |
| `tools/fa_list.js` | Read-only FreeAgent invoice lister |
| `../CONTAINERS.html`, `../PORTS.html` | NAS-wide stack index and port registry |

## Agent skills

### Issue tracker

Issues live in GitHub Issues for JohnMacrae/property-agent (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
