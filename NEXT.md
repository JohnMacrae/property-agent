# NEXT — Property Agent / Property Docs

Last updated: **2026-09-09**

> Older detail (Stage A–F invoice-automation plan, the 2026-07 decouple-from-OB1 work,
> WO→Paperless bridge fixes, Telegram pending-question fix, etc.) has been trimmed from this
> file to keep it current — it's all still in git history: `git log -- NEXT.md`.

## Current state

Branch **`main`**, pushed. Image rebuilt and container recreated 2026-09-08 — the code now
running matches source for the first time since `a07a675` (2026-09-04).

## What just happened

**John reported "this container's timing is running on GMT - it needs to run on DST".**
Investigated: the container clock/TZ itself was fine (`TZ=Europe/London`, `date` correctly
showed BST). The actual bug was in `scheduler.js:333-334` — every session prompt stamped
"Current time" with `now.toISOString()`, which is always raw UTC regardless of container TZ.
The model was expected to mentally add the BST offset itself (per
`agent-system-prompt.md:211`) and evidently wasn't doing so reliably. Fixed: the prompt now
carries the already-converted Europe/London wall-clock time plus zone abbreviation (e.g.
`2026-09-08T10:54:35 BST (Europe/London)`), so the model never has to do DST arithmetic.

**While rebuilding to deploy that fix, found the real reason the noise-PDF report-once fix
(`a07a675`, 2026-09-04) never took effect: `agent/Dockerfile` was never updated to `COPY
wo-scan-noise.js`.** The file existed in the repo and `wo-gmail-scan.js` required it, but the
image never included it — so the running container had silently stayed on pre-`a07a675`
behaviour (bare growing noise count, no dedup) since it was written. This is also why John was
still seeing "(13 other rentopia.uk PDF(s) ignored — not work orders)" today. First rebuild
attempt after the DST fix crashed immediately (`MODULE_NOT_FOUND: ./wo-scan-noise`), which is
what surfaced it. Fixed by adding `COPY wo-scan-noise.js ./` to the Dockerfile; rebuilt again,
container started clean.

Also committed the previously-uncommitted `compose.yml` change from the prior session
(`GOOGLE_REFRESH_TOKEN_FILE=/gmail-config/calendar-refresh-token`) — checked it points at a
real, current token file (`/volume1/docker/gmail-mcp/config/jramacrae/calendar-refresh-token`,
written 2026-09-01) and `gcal.js` already prefers `GOOGLE_REFRESH_TOKEN_FILE` over the legacy
env var, so this is a real config improvement, not a mystery diff. Calendar auth confirmed OK
in the post-rebuild boot log.

**2026-09-09: same trap, different shape.** John reported the `[ref:...]` suffix still showing
in the noise-PDF Telegram report, "we were meant to have fixed this yesterday." Checked: commit
`706b318` (2026-09-08 11:50 BST) added the strip regex to `formatTelegramReport` in
`wo-gmail-scan.js` — but the container image had been built at 09:56 UTC (10:56 BST) that same
morning, **before** the commit landed. So the fix was in git but never in the running image.
Not a code bug — rebuilt (`docker compose build agent && docker compose up -d agent`), clean
boot, done. Lesson: a same-day "rebuilt the image" note in this file does **not** mean every
commit from that day is deployed — check the commit's timestamp against the image build time,
don't assume.

**2026-09-09: BUG-020 fixed (calendar dedup) + 3 duplicate events cleaned up.** John reported
`/wo-report` listing WOs that were already marked done. Checked the live Maintenance calendar:
WO001513, WO001518, WO001522 each had a genuine complete event from June **and** a fresh,
untouched duplicate dated 7 Sep — `gcal_create_event` had no dedup check (this was BUG-020,
open since 2026-07-29, and it had recurred). Fixed properly: `agent-runner.js`'s
`gcal_create_event` case now extracts the WO number from the summary/description and checks it
against a session-scoped cache of Maintenance events (lazily loaded via `gcal.js list-events`
from `wo-colour.DEFAULT_FROM`, topped up with events the session itself creates) — a match
returns `ok:false` with the existing event's id instead of creating a duplicate. Verified against
the live calendar (correctly blocked for WO001518, correctly allowed for a fake WO with no
existing event). Rebuilt and deployed, clean boot.

Also marked the 3 live 7-Sep duplicates `Cancelled — duplicate of an already-completed event...`
via `gcal.js update-event` (no `delete-event` command exists in `gcal.js`, and this route is
reversible) — confirmed via `wo-report.collect()` they no longer show as outstanding. Left
WO001496 and WO001557 alone: both are older duplicates where **both** copies are already marked
complete, so there's no way to tell from the calendar which one is "real" — needs a human glance
if it matters. See `BUGS.md` BUG-020 for full detail.

## Next actions

1. Watch the next scheduled session to confirm the "Current time: ... BST (Europe/London)"
   framing actually gets DST-correct behaviour out of the model in practice (e.g. any
   time-sensitive replies, calendar event creation).
2. Watch the next real (non-dry) `wo-gmail-scan.js` run — this is the **first** run of the
   noise-dedup logic in a container that actually has it baked in. Confirm the report only
   lists genuinely new subjects, not a repeat of already-seen ones.
3. Watch the next Telegram-driven "done" reply with hours to confirm `ensureCompletionHoursLine`
   writes a clean line in practice (only unit-tested so far, from 2026-09-04).
4. Watch the next real invoice-run (06:00) to confirm minimum-charge drafts create cleanly.
5. WO-capture parallel run (property-agent native vs `mail-reader`'s `work-order-processor`)
   — compare a few more days of logs before retiring the old Python container.
6. Watch the next session that creates a Maintenance event to confirm the new BUG-020 dedup
   guard doesn't false-positive on a legitimate new WO (it only matches on WO number substring,
   so a WO number reused for a genuinely different job — shouldn't happen, but hasn't been
   observed in practice yet — would be wrongly blocked).

## Do not re-litigate

- **The Dockerfile `COPY` list must be kept in sync with every new `agent/*.js` file** — this
  bit twice now (the running container silently missing a whole fix for 4 days). When adding a
  new required module, add its `COPY` line in the same commit, and actually rebuild
  (`docker compose build agent && docker compose up -d agent`), not just `docker cp` — `docker
  cp` masks a missing-COPY bug because the file lands in the container's filesystem without
  ever being added to the image.
- **`scheduler.js` reports "Current time" to the model pre-converted to Europe/London local
  time + zone abbreviation**, not a raw UTC `.toISOString()` — added 2026-09-08 because relying
  on the model to apply the BST/GMT offset itself was unreliable. Don't revert to raw UTC.
- **Maintenance calendar only** for invoicing — Property calendar carries Rentr lettings
  viewings, never invoice those.
- **Automated invoice-run now bills every completed job** — either parsed billable lines, or a
  1-hour minimum charge if notes have none. There is no more "completed but unbillable, skip"
  state in the automated path (2026-09-04 decision, John confirmed explicitly).
- **Completion notes with hours are normalized deterministically at write time**
  (`ensureCompletionHoursLine`, called from `gcal_update_event`) and parsed more liberally at
  invoice-run time (`extractHours` mid-sentence fallback) — both landed 2026-09-04 specifically
  because the model doesn't reliably follow the "write a clean Complete Nhr line" instruction
  even when the input matches its own worked examples. Don't revert to prompt-only enforcement.
- **`wo-gmail-scan.js` noise PDFs are reported once, ever, not on every scan** — see
  `wo-scan-noise.js`; if the noise report looks wrong (missing an entry that should reappear,
  or a real WO wrongly landing in "noise"), check `/data/wo-scan-noise-seen.json` and the
  `propertyRelated` split in `wo-gmail-scan.js:240-252` before assuming it's a new bug. (This
  logic was unreachable in the running container until 2026-09-08 — see above.)
- **`gcal.js list-events` defaults to `--limit 50`** — pass a higher `--limit` explicitly when
  scanning a wide date range (e.g. `wo-report`/`invoice-run` use their own paging; ad-hoc
  scripts querying the full `2026-05-01`–present window silently truncate at 50 otherwise, as
  seen during the 2026-09-04 draft verification).
- **The local `ob1` container is not a dependency** — not on a reachable network, nothing
  reads `OPEN_BRAIN_MCP_URL`.
- **`DATABASE_URL` is correct** — `ECONNREFUSED` at boot is a harmless one-shot startup race
  (`agent/scheduler.js:837-845`); weekend gaps are `isWorkday()`, not a fault.
- **`agent/` is baked into the image, not bind-mounted for the running container.** `docker cp`
  is fine for a fast test of a single changed file (agent-runner.js is spawned fresh per
  session, no restart needed) but always commit + rebuild the image properly afterward — see
  the Dockerfile-sync note above for what happens when that step gets skipped.
- Completion state **is** recorded — free text in Maintenance event descriptions ("Done 1hr",
  "Completed — 1.5 hours"). Unstructured, but present.
- Gmail re-auth: `get_token.py` from John's laptop with `py -3`, writing to
  `W:\gmail-mcp\config\<account>\token.json`. Not the container-based helper.
- **`gcal_create_event` refuses to create a second Maintenance event for a WO number that
  already has one** (BUG-020 fix, 2026-09-09) — session-scoped cache in `agent-runner.js`
  (`woEventCache`), not persisted between sessions. If a genuinely new job needs a new event for
  a WO number that already has one (shouldn't happen — WO numbers aren't reused), the tool call
  will fail; that's intentional, don't loosen it without checking why first.

## Key paths

- `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html`, `agent/JJP_Property_List.md` — **local-only,
  gitignored**
- `agent/scheduler.js` — session launch (`launchSession`, ~:330) now stamps Europe/London local
  time, not UTC, into the "Current time" prompt field
- `agent/Dockerfile` — must list every `agent/*.js` module that gets `require`'d; check this
  first if a rebuilt container crashes with `MODULE_NOT_FOUND`
- `agent/invoice-run.js` — deterministic complete→draft→email-after-24h run; `allowMinimum:
  true` switch, `no_billable_lines` skip path removed
- `agent/freeagent.js` — `notesToInvoiceItems`/`createInvoice`/minimum-charge fallback
  (`:259-266`); `extractHours` mid-sentence fallback and `ensureCompletionHoursLine`
- `agent/agent-runner.js` — `gcal_update_event` case now calls
  `freeagent.ensureCompletionHoursLine` before writing
- `agent/wo-gmail-scan.js` / `agent/wo-scan-noise.js` — Gmail WO capture; noise-PDF report-once
  dedup (now actually running in the image as of 2026-09-08)
- `agent/wo-report.js` / `agent/wo-colour.js` — separate "still open" report; shares the
  `done`/`complete[d]`/`cancelled` completion heuristic with invoice-run but has no concept of
  billing state — a job marked done never appears there regardless of invoicing outcome
- Maintenance calendar: `963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com`
- Property calendar: `jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com`
