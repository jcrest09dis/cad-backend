# CAD Backend

Backend API for the event-medical Computer Aided Dispatch system. Implements
the dispatch delivery approach (push → ack → SMS escalation → dispatcher
alert), the Unit/Incident/Assignment state machine, and the RBAC/PHI boundary
from the design.

## Setup

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL, JWT_SECRET, and generate both local encryption keys:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# (run it twice - once for NOTES_ENCRYPTION_KEY, once for AUTH_ENCRYPTION_KEY.
#  They must be different values - see "Production hardening" below for why.)

npm run migrate
npm run dev
```

Requires a running Postgres instance matching `DATABASE_URL`.

On first startup with no admin yet, set `SEED_ADMIN_USERNAME` in `.env` to
create/promote the first admin — see "Production hardening" below.

## What's implemented

- **Schema** (`src/db/migrations/001_init.sql`) — full data model, including
  the two partial unique indexes that enforce "no double-booking a unit or
  incident" at the database level rather than trusting application logic.
- **Dispatch state machine** (`src/services/dispatch.js`) — create/ack/
  cancel/complete an Assignment, transactionally coupled to the Outbox insert
  so a crash between "write assignment" and "queue the push" can't drop a
  notification silently.
- **Outbox worker** (`src/services/outboxWorker.js`) — polls and sends
  pending push/SMS messages, with backoff and a `MAX_ATTEMPTS` cutoff.
- **Escalation worker** (`src/services/escalationWorker.js`) — the timeout
  ladder: resend push → SMS → flag UNCONFIRMED for a human. A hard failure
  in the outbox (e.g. SMS provider down) skips straight to the dispatcher
  alert instead of waiting out the clock.
- **RBAC / PHI boundary** (`src/middleware/auth.js`, `src/routes/incidents.js`)
  — field staff vs dispatcher access to incident notes, field-level
  encryption with a real KMS option alongside local dev mode
  (`src/lib/crypto.js` — see "Production hardening" below), and an
  append-only audit log entry on every read and write of notes.

## Gap surfaced during implementation

The original schema didn't define how a `Unit` maps to the `Staff` actually
crewing it — needed to know where to send push/SMS. Added a `unit_staff`
join table (many-to-many, since a unit can be a two-person team). Worth
reviewing whether that matches how units get staffed in practice.

## Auth (TOTP / authenticator app)

`src/routes/auth.js`, backed by a from-scratch RFC 6238 implementation
(`src/lib/totp.js`, `src/lib/base32.js`) using only Node's built-in `crypto`
— no external auth dependency.

- `POST /auth/enroll` — an existing admin (`staff.is_admin`) generates a
  TOTP secret for a staff member and gets back a `provisioningUri` (turn
  into a QR code for the staffer to scan into Google Authenticator/Authy/
  etc.) plus the raw secret as a manual-entry fallback. Requires a normal
  JWT from an admin account — see "Production hardening" below for how
  the very first admin gets created without any HTTP-reachable secret.
- `POST /auth/enroll/confirm` — staffer proves they scanned it correctly
  (submits one valid code) before `totp_enabled` flips true. Prevents a
  bad/mistyped enrollment from silently locking someone out later.
- `POST /auth/login` — username + current 6-digit code → JWT (12h expiry).
  Includes replay protection (`totp_last_step`) so a captured code can't be
  reused within its own 30s validity window.
- TOTP secrets are encrypted at rest under a separate key from incident
  notes — see "Production hardening" below.

## Admin CRUD

`src/routes/admin.js`, all under `/admin/*`, gated by a real
`staff.is_admin` flag checked against the caller's own JWT
(`requireGlobalAdmin` in `middleware/auth.js`) — see "Production
hardening" below for how this replaced the old shared secret. Covers the
records nothing else could create yet:

- `POST /admin/staff`, `GET /admin/staff` — staff records (name, role,
  phone, `username`). Create these before calling `/auth/enroll`.
- `PATCH /admin/staff/:id` — edit a staff record (partial update — only
  fields present in the body change). Includes `active`, but guards
  against deactivating the last usable admin the same way `set-admin`
  guards against demoting them (a deactivated admin can't log in, so
  "is_admin but inactive" is functionally the same dead end as no admin
  at all — this closed a related latent bug in the original `set-admin`
  check, which only counted `is_admin = TRUE` without also requiring
  `active = TRUE`).
- `DELETE /admin/staff/:id` — hard delete, but **only** when the record
  has zero references anywhere in the schema (`event_staffing`,
  `unit_staff`, `incidents.created_by`, `assignments.dispatcher_id`,
  `incident_note_revisions.author_id`, `audit_log.actor_id`). Anyone
  with real history gets a 409 telling you to use `PATCH .../active:
  false` (deactivate) instead — a true delete on someone with history
  would either hit a foreign-key error or silently damage the audit
  trail, and `staff.active` already exists specifically to be the real
  "remove this person" action.
- `POST /admin/staff/:id/set-admin` — promote/demote another staff
  member's admin status. Refuses to remove the last remaining *usable*
  (active) admin.
- `POST /admin/venues`, `GET /admin/venues`
- `POST /admin/venues/:venueId/zones`, `GET /admin/venues/:venueId/zones` —
  the location dropdown per venue.
- `POST /admin/events`, `GET /admin/events`, `POST /admin/events/:eventId/close`
- `POST /admin/events/:eventId/units` — create a unit already assigned
  to an event.
- `POST /admin/units` — create a unit with **no event yet** (pooled,
  same idea as staff being created once and checked into events rather
  than recreated per event). Migration `006_units_pool.sql` made
  `units.event_id` nullable to support this. A pooled unit won't appear
  on any event's live dispatch board — `GET /events/:eventId/units`
  still filters by `event_id`, unaffected by this change — until it's
  assigned.
- `POST /admin/units/:unitId/assign-event` — assign a pooled unit to an
  event (or move it between events, or pass `eventId: null` to return
  it to the pool). This is what actually makes a unit usable for
  dispatch.
- `GET /admin/events/:eventId/units` — units for one event.
- `GET /admin/units` — every unit across every event, flat, plus pooled
  ones (`event_name`/`event_status` come back `null` for those). Backs
  the admin console's Units tab.
- `POST /admin/units/:unitId/crew` / `.../crew/remove` — the `unit_staff`
  join table (who's actually on "Medic 1"), used by the outbox worker to
  know where to send push/SMS.
- `POST /admin/events/:eventId/staffing` — this is what grants event-scoped
  access: writes `EventStaffing`, which `requireEventMembership` reads to
  determine a caller's role (`field_staff`/`dispatcher`/`admin`) for that
  event. Upserts on repeat call (re-checks-in and can change role).
- `POST /admin/events/:eventId/staffing/:staffId/checkout`,
  `GET /admin/events/:eventId/staffing`

Self-service check-in now also exists — see `/me/*` below — so this is no
longer admin-only.

## Production hardening

Three changes made together, since they're all part of "make this safe to
actually deploy" rather than three unrelated fixes:

**1. Real admin auth, no shared secret.** `ADMIN_ENROLLMENT_SECRET` is
gone. `/admin/*` and `/auth/enroll` now check a real `staff.is_admin`
column against the caller's normal JWT
(`requireGlobalAdmin` in `middleware/auth.js`). The interesting problem
this creates: something has to be able to create the *first* admin, but
every admin-creating endpoint now requires an admin to already exist.
Rather than route around that with another HTTP-reachable secret,
`src/lib/seedAdmin.js` runs once at server startup (called from
`server.js`, before the server accepts connections): if no admin exists
yet and `SEED_ADMIN_USERNAME` is set in `.env`, it either promotes that
username (if the staff record already exists — e.g. your existing
dispatcher account) or creates a brand-new staff/admin record and prints
its TOTP secret to the server log once. Either way, **this can only ever
be triggered by someone with access to the server's own environment
config and logs — never over HTTP, at any point.** That's the actual
point of retiring the shared secret: not just moving it somewhere else,
but removing the HTTP attack surface entirely.

If you already have a working dispatcher/admin-ish account from earlier
testing, the simplest upgrade path is to set
`SEED_ADMIN_USERNAME=<that username>` and restart — it'll be promoted in
place, no re-enrollment needed.

**2. Real KMS envelope encryption, as an option alongside local dev
mode.** `src/lib/crypto.js` now supports two providers via
`ENCRYPTION_PROVIDER`:
- `local` (default, unchanged from before) — static AES-256-GCM key per
  category from env. Still dev-only: no rotation, no access audit trail,
  no HSM backing.
- `kms` — real AWS KMS envelope encryption. Generates a per-record data
  key via KMS, encrypts content with it locally, then stores the
  KMS-encrypted data key alongside the ciphertext (columns added in
  migration `003_admin_flag_and_kms.sql`). Decrypt asks KMS to unwrap the
  data key first. Requires `npm install @aws-sdk/client-kms` separately
  (not a default dependency — local dev never needs the AWS SDK pulled
  in), plus `KMS_NOTES_KEY_ID` / `KMS_AUTH_KEY_ID` (two separate KMS
  master keys) and AWS credentials resolved the standard way (env vars,
  shared config file, or an IAM role).

**Both providers now use genuinely separate keys per data category** —
incident notes (PHI) and TOTP secrets (auth) were previously protected by
one shared key even in local mode; that's fixed regardless of which
provider you use.

**⚠️ Breaking change for any already-enrolled staff, local mode only:**
because notes and TOTP secrets used to share one key and now don't,
**existing TOTP secrets enrolled before this change will fail to decrypt**
once `AUTH_ENCRYPTION_KEY` is set to a new value — login will fail with
"invalid credentials" for those accounts, not a clear error. Two ways to
handle it:
- **Simplest for a small/test roster:** just re-enroll affected staff
  through the console's admin panel (Staff tab → Enroll authenticator →
  Confirm) after upgrading. Takes a minute per person.
- **To preserve existing enrollments instead:** set `AUTH_ENCRYPTION_KEY`
  to the *exact same value* as your existing `NOTES_ENCRYPTION_KEY` (since
  the old code used that one key for everything, this keeps old TOTP
  secrets decryptable) — then rotate to a real separate key later once
  everyone's re-enrolled naturally.

**3. CORS locked to an explicit allowlist.** `origin: true` (reflects any
requesting origin) is gone. `CORS_ALLOWED_ORIGINS` in `.env`
(comma-separated) now controls exactly which origins can call this API
from a browser — defaults to the console's local dev port so nothing
breaks out of the box. **Set this to your real deployed console URL(s)
before this API is reachable from the public internet.** Doesn't affect
the field app either way — React Native's `fetch` doesn't send a browser
`Origin` header, so CORS never applied to it in the first place.

## Background worker crash-safety

Found via a real crash during Twilio testing, not code review: `outboxWorker.js`
and `escalationWorker.js` both ran on a raw `setInterval(asyncFn, ...)`.
When the async function's returned promise rejects, `setInterval` doesn't
catch it - Node terminates the entire process on an unhandled rejection
by default. A SQL type-inference bug in the outbox retry-scheduling query
(`interval '10 seconds' * $1` - Postgres couldn't unify $1's type across
its two uses in the same query; fixed with an explicit `::integer` cast)
took down live dispatch for the whole event, not just one failed send.
Both workers' `setInterval` callbacks now catch and log instead of
letting anything propagate - this closes the *class* of bug, not just
the one instance that happened to trigger it.

Also fixed while in there: a unit crewed by more than one person had a
head-of-line blocking bug — if the first crew member's send failed (e.g.
a missing/malformed phone number), everyone else on the same unit never
got their message at all, since the loop aborted on the first error.
Each recipient's send is now independent; one bad phone number no longer
silently blocks delivery to the rest of the crew.

## Still stubbed / not wired to real infrastructure

- **Push** has a real option (`PUSH_PROVIDER=expo`, see the field app's
  README) alongside the `stub` default.

## SMS removed from the escalation ladder

The escalation ladder is now two stages, not three: resend push, then
hand off to the dispatcher as `UNCONFIRMED`. SMS was tried (real Twilio
integration, `src/services/sms.js`) but removed after testing revealed
a genuine dead end: **Twilio trial accounts can only send from a small
set of Twilio-predefined canned templates** (`sms_2fa`,
`sms_appointment_reminders`, `sms_order_confirmation`) — no custom
message bodies at all, even to a verified number. Since the escalation
text is inherently dynamic (actual incident type/zone/priority each
time), it can't be expressed as any of those three fixed templates.
The only way around this is a paid Twilio account (a few dollars of
billing credit removes the restriction entirely).

Rather than ship a feature that's confirmed broken on a free account
and untested on a paid one, it was removed cleanly:
`src/services/sms.js` deleted, `SMS_PROVIDER`/`TWILIO_*`/
`ESCALATE_SMS_SEC` removed from `.env.example`, and
`escalationWorker.js`/`outboxWorker.js` no longer reference SMS at all.

**Historical data is untouched and still accurate** — any assignment
from before this change that actually reached `ESCALATED_SMS` /
`escalation_stage 2` keeps that status and displays correctly in the
Reports/history view (both the console and field app's status-label
mappings still understand it). New assignments simply never reach it
going forward — `escalation_stage` now tops out at 2 (`UNCONFIRMED`)
instead of 3.

To reintroduce SMS with a paid Twilio account: the removed code is
straightforward to rebuild following the same pattern as `push.js`
(dual-provider, lazy-imported SDK) — reintroduce a `sms.js` with a
`twilio` provider, add a `sendSms` call back into `outboxWorker.js`'s
per-channel branch, and add stage 2 (SMS) back into
`escalationWorker.js`'s `STAGE_THRESHOLDS_SEC` and `escalate()`,
renumbering the dispatcher-alert stage to 3.

## Incident/assignment coupling on resolve or cancel

Found via real testing, not code review: resolving or cancelling an
incident used to leave its Assignment (and the Unit tied to it) stranded
if nobody had separately completed or cancelled the assignment first —
the incident would vanish from the open-incidents list with no way back
to it, and the unit stayed stuck unavailable indefinitely. Fixed in
`POST /events/:eventId/incidents/:id/status` (`src/routes/incidents.js`):
resolving/cancelling an incident now also resolves any live assignment on
it, in the same transaction:
- `RESOLVED` + assignment was `ACKED` → assignment `COMPLETED` (it was
  actually delivered)
- `RESOLVED` + assignment never got acked → assignment `CANCELLED`
- `CANCELLED` + any live assignment → assignment `CANCELLED`

Either way the unit is freed back to `AVAILABLE`, and any not-yet-sent
outbox message (a queued SMS escalation) for that assignment is stopped,
matching the existing manual-cancel behavior.

## Real-time (console only): `src/routes/live.js`, `src/services/liveUpdates.js`

`GET /events/:eventId/live` is a WebSocket, not a REST endpoint. Console
connects after login and receives a lightweight `{ type: 'refresh' }`
signal any time something relevant to that event changes (assignment
create/ack/cancel/complete, unit status, incident create/resolve/cancel,
or an escalation-worker transition) — the client re-fetches from the
normal REST endpoints rather than the socket carrying the actual payload.
In-memory single-process pub/sub; would need a shared backend (Redis,
etc.) if this ever runs as multiple instances. Auth travels as
`?token=<jwt>` in the query string rather than an `Authorization` header,
since browsers' native `WebSocket` API can't send custom headers on the
handshake — verified manually in the route rather than through the usual
`requireAuth` preHandler. Deliberately **not** used by the field app —
see the console's README for why (mobile backgrounding is exactly the
problem push+ack+escalate was built to route around).

## Incident history / reporting

`src/routes/reports.js`, gated by `requireReportingAccess`
(`middleware/auth.js`) — admins plus anyone who has ever held the
dispatcher role for at least one event (checked via `EventStaffing`,
regardless of whether they're currently checked into anything). This is
deliberately broader than `requireEventMembership`: reporting is meant
to span past events, not just the one in the URL, and "was a dispatcher"
is treated as ongoing trust rather than something that expires when a
shift ends.

- `GET /reports/events` — every event including closed ones, for the
  filter dropdown. Separate from `/events` (active-only, self-check-in)
  and `/admin/events` (admin-gated) since reporting access is its own
  tier.
- `GET /reports/incidents` — filterable list (`eventId`, `from`, `to`,
  `type`, `priority`, `status` query params), across all events, capped
  at 200 most recent.
- `GET /reports/incidents/:id` — full detail: incident metadata,
  complete assignment history (every unit ever dispatched to it, not
  just the current one), and the **complete note revision history**
  (author + timestamp per revision, not just the current text) —
  decrypted, and logged to `audit_log` once per view (not once per
  revision, to avoid spamming N audit rows for N revisions in a single
  read).
- Added `incidents.closed_at` (migration `004_incident_closed_at.sql`,
  set by the existing resolve/cancel route) since there was previously
  no way to compute how long an incident took to close, only when it
  was created.
- `GET /me` now also returns `canViewReports`, computed the same way as
  `requireReportingAccess`, so the console doesn't need to reimplement
  the rule.
- Decrypt failures here fail per-revision, not per-request — a single
  bad revision (e.g. from a rotated/lost encryption key) shows as
  `[unable to decrypt this revision]` rather than taking down the whole
  report. Worth calling out given this project already lived through
  exactly that failure mode once, for real, during setup.

## Unit status "return to service" path

Found while building the console's click-to-change-status UI: once a
unit went `OUT_OF_SERVICE`, there was actually no way back —
`AVAILABLE` was deliberately excluded from the settable statuses (it
was meant to only be reached via completing/cancelling an assignment,
so a unit could never claim "available" while still tied to a live
assignment). That left `OUT_OF_SERVICE` a dead end. Fixed in
`src/routes/units.js`: `AVAILABLE` can now be set directly, but only
when the unit has no live assignment (`current_assignment_id IS NULL`)
— attempting it with one still active gets a clear 409 telling you to
complete or cancel the assignment first, so the original data-integrity
concern that excluded it stays fully protected.

## Incident location: free text instead of a required zone dropdown

Changed based on real usage feedback: `POST /events/:eventId/incidents`
now takes `locationText` (any string) instead of requiring
`locationZoneId` (a foreign key into a predefined `venue_zones` list).
Migration `005_incident_free_text_location.sql` makes
`incidents.location_zone_id` nullable and adds `incidents.location_text`.
New incidents populate `location_text` and leave `location_zone_id`
null; every read path (`incidents.js`, `reports.js`, `me.js`'s "my
units" endpoint, `outboxWorker.js`'s push payload lookup) now computes
`zone_label` as `COALESCE(location_text, <joined venue_zones label>)`,
so old incidents tied to a real zone and new free-text ones both display
correctly through the same field name — nothing downstream needed to
know which kind of incident it's looking at.

**Caught while making this change:** `outboxWorker.js`'s zone lookup was
a hard `JOIN venue_zones`, not a `LEFT JOIN`. Since new incidents have
`location_zone_id = NULL` by design now, that JOIN would have silently
excluded every new incident's outbox messages from ever being found —
push notifications for any incident created after this change would
never have been sent, with no error anywhere. Fixed before it became a
real bug in testing rather than production.

`venue_zones` and its admin management UI (`AdminVenuesTab`) are
untouched — no longer required for incident creation, but still used to
populate a suggestions `<datalist>` on the free-text field, and remain
available for whatever future purpose.

## Dispatcher-acknowledged assignments (confirmation by radio)

`POST /events/:eventId/assignments/:id/dispatcher-ack` — a dispatcher
can now acknowledge an assignment on the unit's behalf (e.g. confirmed
over the radio), so a busy/on-scene unit doesn't block status
progression just because they haven't tapped their phone yet. Migration
`007_assignment_ack_tracking.sql` adds `assignments.acked_by` and
`ack_method` (`'self' | 'dispatcher_override'`) — a dispatcher's radio
confirmation is recorded as a genuinely different kind of event from the
field device confirming receipt itself, which matters given the whole
point of the escalation ladder is knowing whether a message actually
reached someone. Both the live assignments list and the Reports/history
view surface who acked an assignment and by which method.

While making this change, also fixed a stale reference: `ackAssignment`
still checked for the removed `ESCALATED_SMS` status instead of
`UNCONFIRMED`, and now also accepts a self-ack *after* escalation to
`UNCONFIRMED` — a field device tapping Acknowledge late (they were just
busy, not unreachable) is still a real, valuable event, not something
that should be rejected once escalation has already fired.

## Self-initiate and self-dispatch

Two related but distinct capabilities, both driven by real usage
feedback:

- **Self-initiate** (report an incident yourself) — turns out this
  already worked at the backend level the whole time:
  `POST /events/:eventId/incidents` was never role-restricted, only
  `requireEventMembership`. What was actually missing was a field-app
  UI for it, which never existed.
- **Self-dispatch** (assign your own unit without a dispatcher) is
  genuinely new. `POST /events/:eventId/incidents/:id/self-dispatch`
  (`services/dispatch.js`'s `selfDispatchAssignment`), restricted to
  `field_staff`. Skips the push/ack handshake entirely — no outbox row,
  no `PENDING` state — since a unit obviously doesn't need to be
  notified of, or asked to acknowledge, their own action. Created
  directly as `ACKED`. `dispatcher_id` is set to the same staffId as
  `acked_by`, since there genuinely isn't a separate dispatcher for this
  assignment and that column is `NOT NULL`.

Migration `008_self_dispatch.sql` extends `ack_method`'s CHECK
constraint to a third value, `'self_initiated'` — distinct from both
`'self'` (field device confirmed a dispatcher's assignment) and
`'dispatcher_override'` (dispatcher confirmed by radio), since this
assignment was never dispatched by anyone else in the first place. Same
accountability principle as the dispatcher-ack feature: every assignment
should honestly reflect who actually initiated it and how.

The same partial unique indexes that prevent double-booking on a normal
dispatch apply here unchanged — a unit or incident that already has a
live assignment cleanly rejects a self-dispatch attempt with a 409,
same as it would a dispatcher-created one.

A self-dispatch also automatically creates a real note on the incident
("Self-dispatched Medic 1 to this incident.") rather than leaving the
event visible only as an assignment record. This reuses the existing
note-revision system entirely — author name and timestamp are handled
for free by the note display every screen already has (every revision
renders "authorName, timestamp" above its content), so the generated
note text only needs to say what happened, not restate who/when.

## Real event close/reopen

`POST /admin/events/:eventId/close` used to just flip a status field.
Now it does real cleanup, in one transaction: any unit still belonging
to the event returns to the pool (`event_id = NULL`, matching the
pooled-unit model — same as manually setting "Unassigned" in the admin
Units tab), reset to `AVAILABLE` with `current_assignment_id` cleared.
Any assignment still active at close time (`PENDING`/`ACKED`/
`UNCONFIRMED`) is cancelled first — otherwise it would be left
referencing a unit that just got pulled out of the event, and a status
that no longer means anything once the event is over.

`POST /admin/events/:eventId/reopen` sets the event back to `active`.
Deliberately does **not** restore any units automatically — they were
intentionally returned to the pool on close, and reassigning them (via
the Units tab's existing dropdown) is a fresh, explicit admin decision,
not something to silently redo.

Known gap, not addressed here: nothing stops an admin from assigning a
unit to an already-`closed` event via the Units tab's dropdown. Worth
adding a guard if this turns out to matter in practice.

## Self-service (`/me/*`)

`src/routes/me.js`. For a logged-in staff member acting on their own
behalf, not through admin tools:

- `GET /me` — own staff record.
- `GET /me/events` — events they're currently checked into (used by the
  console's event picker).
- `GET /events` — all currently-active events, for discovering something
  to check into. Deliberately unscoped by venue/roster — see the design
  discussion on staff being pooled across events.
- `POST /me/events/:eventId/checkin` — self-check-in. Can only grant
  `field_staff` on first check-in; re-checking in after a checkout
  preserves whatever role the staffer already had.
- `POST /me/events/:eventId/checkout` — self-checkout.

## Not built

Field app (mobile). Backend and dispatcher console came first.
