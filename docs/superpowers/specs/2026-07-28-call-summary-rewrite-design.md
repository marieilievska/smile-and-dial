# Call summary rewrite — design

**Date:** 2026-07-28
**Status:** approved, not yet implemented

## What we're building

Two changes to the rolling per-campaign note (`lead_campaign_summaries.ai_summary`)
— the memory each lead's next call reads back as `{{last_call_summary}}`:

1. **No name the AI heard on a call is ever written down.** Only names already on
   the lead record (i.e. from the imported CSV) may appear. Enforced in code, not
   just in the prompt.
2. **A structured note instead of a prose paragraph** — status, one pickup line,
   and carried-forward fact bullets — and nothing written at all when a call
   taught us nothing.

## What exists today

- After every call where a human was reached, `mergeLeadSummary`
  (`src/lib/openai/summary-merger.ts`) makes one `gpt-5.4-mini` pass over
  `previous note + this call's transcript` and overwrites the note. It also
  writes that call's `calls.callback_notes` pickup note.
- The prompt asks for a prose paragraph ending in a literal
  `"Already answered — don't re-ask:"` line.
- `autoFillLeadFromExtraction` (`src/lib/elevenlabs/post-call-webhook.ts:1333`)
  writes `owner_name` / `manager_name` / `employee_name` / `business_email` from
  the call's extraction onto the lead — but **only when the field is empty**.
- `buildVarsForCall` (`src/lib/elevenlabs/conversation-init.ts`) reads the note
  back as `{{last_call_summary}}`, prefixed with `"(Our last call with them was
<recency>.)"`, and separately sends `{{owner_name}}` etc. straight from the lead.
- The lead page renders the note verbatim (`campaign-summaries.tsx`), with edit
  and clear.
- The Close handoff uses the note as the closer's main context
  (`close/handoff.ts`), after `close/actions.ts:414` strips everything from the
  literal string `"Already answered"` onward.
- The live agent prompt says: _"If `{{last_callback_notes}}` or
  `{{last_call_summary}}` has content, reference where you left off in one short
  line, and skip anything already answered in there."_ and, for the owner name,
  _"One name → use it."_

## Root causes (measured against production, 2026-07-28)

**The wrong names are mostly not from transcripts — they're from the import, and
the never-overwrite rule locks them in.**

- 33,163 leads have an `owner_name` and have **never been called**, out of 33,472
  total. Essentially every owner name came from the CSV.
- 48 of 309 recently-called leads (**16%**) have an `owner_name` that is just a
  word from the company name: `Rhapsody Salon → "Rhapsody"`, `REPZ LLC → "Repz"`,
  `Onestop Aesthetic … → "Onestop"`, `Palm Beach Hair Co → "Palm"`,
  `Oxybaric LLC → "Hyperbaric"`, `One Beauty Aesthetics → "One"`.
- Because the field is never empty, a real name learned on a call is discarded.
  Of the last 86 calls with an extraction, an owner name was heard 12 times and
  **6 were dropped** in favour of a worse stored value (Rhapsody Salon: heard
  "Amanda Ziegler", kept "Rhapsody"; Palm Beach Hair Co: heard "Pompi
  Chiaconati", kept "Palm").
- Those stored names are then fed to the summariser as _"Contacts already on
  file: owner Rhapsody"_, producing lines like _"the owner on file was Prisada"_.
- The same field goes to the live agent as `{{owner_name}}`, so the AI asks for
  "Repz" and "Palm" on real calls.

**Names the AI _does_ hear are also unreliable.** Observed: `Jin → "Jinmi"`,
`Rosalynn → "Rosalind"`, `River City Bicycles → "Versity E-Bikes"`,
`Rejuvamed → "Richard the Man"`. A lead answering with their business name was
transcribed as "Piggy" and the note then referred to them as Piggy. **A name in a
transcript is not evidence.**

**The note reads like an incident report.** Median **117 words** (n=61; max 207).
**75%** contain "nothing happened" phrasing. **39 of the last 61** summarised
calls were `gatekeeper` — someone said "I'm not the owner" and hung up — and each
produced ~110 words cataloguing what we failed to learn ("no decision process,
lead-handling process, contact method, or business software was confirmed"). The
`"Already answered — don't re-ask:"` line often reads _"nothing has been answered
yet."_ This is poor raw material for a prompt instruction that says "reference
where you left off in one short line."

**It is a game of telephone.** Each call rewrites the whole note from the previous
note plus the new transcript, so wording drifts and facts are silently reworded or
lost across calls.

## Decisions

Each was chosen over a stated alternative.

**Prompt rule _and_ a code-level scrubber — not the prompt alone.** Prototyped
against real transcripts, the same prompt on the same input leaked the unverified
name "Amanda" on one run and not on the next; `gpt-5.4-mini` is a reasoning model
and the existing call sends no `temperature`, so output is not stabilisable that
way. A deterministic post-check is what makes the guarantee real. Verified on real
fixtures: catches "Amanda", "Nicole", "Piggy"; keeps "Vagaro", and keeps on-file
names "Paula", "Michelle", "Trey".

**Scrubber drops the whole line, not just the name.** Excising a word leaves
"Owner is usually in on Wednesdays" reading as though we know who — or produces
"The owner is and she is in tomorrow." Dropping the line loses a fact; keeping a
half-sentence risks asserting something false. The note is allowed to be shorter.

**Keep the fact, drop the name.** _"the owner is Nicole, she's in Wednesdays"_ →
**"Owner is usually in on Wednesdays."** The alternative — recording the name with
a hedge ("someone said the owner may be Nicole") — still puts an ASR guess in
front of the next caller, which is the failure being fixed.

**Stop auto-writing heard names and emails onto the lead.** `owner_name`,
`manager_name`, `employee_name`, `business_email` are no longer written by
`autoFillLeadFromExtraction`. The values remain on `calls.extracted_data` and
visible in the call detail, so nothing is lost — they simply stop silently
becoming the lead's identity. `callback_datetime` is untouched: it is operational
and books the callback. The alternative — a review queue for conflicting names —
was explicitly rejected: it is thousands of rows of manual work, and the CSV is
the intended source of truth.

**Fact bullets carry forward verbatim.** The prompt is given the previous bullets
as exact strings to copy unchanged, and may only append. This is what stops the
drift. The stronger alternative — storing bullets as a JSON array — needs a
migration and a UI change; the text column plus a copy-forward instruction gets
most of the benefit for none of the risk, and can be upgraded later.

**Two separate "nothing happened" guards, because measurement contradicted the
first draft.** `gatekeeper` calls are _not_ mostly silent hangups: across the last
61 summarised calls their median is **37 lead-spoken words** (min 4, max 187).
That is how Palace Spa told us it opens at 9:30 and the owner is in tomorrow. So:

- _Deterministic skip, before any OpenAI call:_ if the lead spoke **fewer than 15
  words**, there is nothing to learn — leave the note completely untouched and
  make no model call. Measured: skips 9 of 61 (15%), and skips **zero** calls
  whose outcome was `callback`, `goal_met`, `not_interested` or
  `call_back_later`. The threshold is a named constant so it can be retuned.
- _Model-level:_ every other call still goes to the model, but a call that yields
  nothing new returns no bullets, so the previous fact list is preserved and only
  `status` / `left_off` change. The volume reduction comes from the format rules,
  not from skipping: in the prototype a nothing-happened gatekeeper call went from
  110 words to 7.

**The Close handoff sends the whole note; delete the splitter.** `close/actions.ts:414`
currently splits on the literal `"Already answered"`. That string disappears, so
left alone the splitter silently stops matching and everything flows through
anyway. The bullets are plain facts a closer wants (opens at 9:30, uses Vagaro,
interested in after-hours answering) and the heading "don't re-ask" is reasonable
advice for a closer too. Removing the split is simpler than re-targeting it at a
new marker and matches the "same shape for every reader" decision.

**Existing summaries are left alone.** All 61 self-heal on the lead's next call.
Regenerating them was offered and declined; a backfill script already exists
(`scripts/regen-summaries.mjs`) if that changes.

## The note format

Stored as text in the same column, rendered by the same components:

```
Status: Interested, callback booked
Left off: Owner usually in on Wednesdays.
Known — don't re-ask:
  • Front desk handles the phones.
  • After-hours calls sometimes go to voicemail.
  • Interested in an AI answering after hours.
```

- **Status** — at most 10 words, reflects the whole history, always present.
- **Left off** — one sentence naming a concrete pickup point, or omitted.
  "They weren't the owner" is not a pickup point.
- **Known — don't re-ask** — bullets of what the _lead_ said. Each ≤10 words,
  third person, never a transcript quote. Max 8; oldest dropped first. Never a
  bullet about what we failed to learn. Omitted when empty.

Measured against real production calls (before → after):

| Business                        | Before | After |
| ------------------------------- | ------ | ----- |
| River City Bicycles             | 110 w  | 7 w   |
| Youglow wellness & spa          | 118 w  | 28 w  |
| RECVR oc Active Recovery Lounge | 92 w   | 27 w  |
| Palace Spa & Massage            | 133 w  | 30 w  |
| Rhapsody Salon                  | 156 w  | 46 w  |

## Files touched

- `src/lib/openai/summary-merger.ts` — new system + user prompt, new JSON schema
  (`status` / `left_off` / `known[]` / `callback_notes`), the scrubber, the
  render-to-text step, and the <15-lead-word skip.
- `src/lib/elevenlabs/post-call-webhook.ts` — `autoFillLeadFromExtraction` stops
  writing the four identity fields; comment at :1080 updated.
- `src/lib/close/actions.ts` — drop the `"Already answered"` split.
- `tests/` — a Playwright spec covering: an unverified name never reaching the
  stored note, an on-file name surviving, and a no-new-facts call leaving the
  previous note unchanged.

## Out of scope

- **Cleaning the imported `owner_name` values.** ~16% are business-name
  fragments and the agent says them out loud on live calls. This is a data
  problem the CSV owner fixes; the code change stops it getting worse but does
  not repair existing rows. A list of suspect rows can be exported on request.
- **The per-call recap shown in the Calls list** (`calls.summary`) — still
  ElevenLabs' `transcript_summary` verbatim, still occasionally wrong
  ("called Richard the Man", "Summary couldn't be generated for this call").
- **The live agent prompt.** `{{owner_name}}` still comes straight from the lead
  record; "One name → use it" is unchanged.
- Storing facts as structured JSON rather than rendered text.

## Verification

- `npx tsc --noEmit`, `npx eslint`, `npm run build` clean on changed files.
- Scrubber unit-tested against the real leaked strings collected during design:
  "Amanda", "Nicole", "Piggy" dropped; "Vagaro", "Paula", "Michelle", "Trey" kept.
- The <15-lead-word skip leaves an existing note byte-for-byte unchanged and
  makes no model call.
- After deploy, re-run the design-time inspection against production: median note
  length well under 117 words, and no note containing a personal name absent from
  its lead record.
