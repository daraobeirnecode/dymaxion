---
slug: permit-monitor
name: Permit Monitor
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# Permit Monitor

## Purpose

Poll a permit Feature Service for records matching a saved where filter that
are new since the last check, and produce a Telegram-ready alert message for
any hits. Designed to run on a schedule (n8n or cron), one invocation per
check.

## When to use this skill

- User says "tell me when a new permit of type X appears" or "watch this
  service for Y"
- A scheduled agent run fires for an existing monitor registered in
  `dymaxion.preferences`

## When NOT to use this skill

- One-off "what permits exist" questions — use `feature-service-query`
- Monitoring anything other than record arrival (e.g. attribute drift,
  service health) — needs a different monitor skill
- Sub-minute latency requirements — this is a polling skill, not a webhook

## Inputs

- `service_url` (string, required): permit Feature Service root URL
- `filter_where` (string, required): saved SQL filter, e.g.
  `PERMIT_TYPE = 'DEMOLITION' AND STATUS = 'ISSUED'`
- `last_check_timestamp` (string, optional): ISO 8601 checkpoint; defaults to
  the stored checkpoint in `dymaxion.preferences`
- `alert_channel` (string, optional): gateway to notify. Default `telegram`

## Outputs

- `new_permits` (array): new matching records (attributes only)
- `alert_message` (string): formatted alert; empty string when no new hits

## Tools required

- `esri-mcp` — Feature Service query operation

## Execution plan

1. Validate allowlist; load checkpoint from `dymaxion.preferences` if
   `last_check_timestamp` not supplied
2. Detect the layer's edit-tracking date field (candidates: `EditDate`,
   `created_date`, `ISSUE_DATE`); cache the choice per service
3. Query with `({filter_where}) AND {date_field} > {checkpoint}` ordered by
   the date field
4. If zero hits: return empty `new_permits` and empty `alert_message`, and
   leave the checkpoint unchanged
5. Classification-tier LLM formats the alert: count first, one line per
   permit (number, type, address, date)
6. Persist the new checkpoint (max date-field value from the results, never
   local wall-clock time) to `dymaxion.preferences`
7. Return; the gateway layer sends `alert_message` to `alert_channel`

## LLM prompts

### Alert formatting (classification tier)

System: You format permit alerts for Telegram. First line: total count and
the filter name. Then one line per permit: permit number, type, address,
date. No adjectives, no emoji, no markdown tables.

User: {count} new permits since {checkpoint} matching "{filter_where}" on
{service_url}: {records_json}. Format the alert.

## Failure modes

- No recognizable date field on the layer — fail once with the layer's field
  list and ask the operator to pin a date field in preferences
- Service down at poll time — skip this cycle, keep the old checkpoint, log
  the miss; never advance the checkpoint on failure (prevents silent gaps)
- Duplicate alerts from clock skew — checkpoint is set from the server-side
  max date value, never from local wall-clock time
- Filter matches an unexpectedly large batch (>200 new) — send a count-only
  alert and attach the full list to the run record instead

## Cost + timeout

- Max cost per invocation: $0.05 (budget cap)
- Max duration: 60 seconds
- Typical actual cost: $0.02 per check, typical duration: 4 seconds
