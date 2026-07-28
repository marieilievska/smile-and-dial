# Call summary rewrite — design

**Date:** 2026-07-28
**Status:** approved, not yet implemented

## What we're building

Two changes to the rolling per-campaign note (`lead_campaign_summaries.ai_summary`)
— the memory each lead's next call reads back as `{{last_call_summary}}`:

1. **A person's name is recorded only when someone explicitly said it**, proved by
   a verbatim transcript quote that is checked in code, and stored as a **first
   name only**. A name the model inferred — from a greeting, from the company
   name, from our own caller — is thrown away along with every line that mentions
   it.
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

**Names the model _adopts_ rather than hears stated are unreliable.** Observed:
`Jin → "Jinmi"`, `Rosalynn → "Rosalind"`, `River City Bicycles → "Versity
E-Bikes"`, `Rejuvamed → "Richard the Man"`. A lead answering with their business
name was transcribed as "Piggy", and the note then referred to the person as
Piggy. In one prototype run the model tried to record **"Jack" — our own agent's
name** — as a contact at the business. The failure mode is not "a name was heard",
it is "a name was assumed by someone who was never actually named".

**The note reads like an incident report.** Median **117 words** (n=61; max 207).
**75%** contain "nothing happened" phrasing. **39 of the last 61** summarised
calls were `gatekeeper` — and each produced ~110 words cataloguing what we failed
to learn ("no decision process, lead-handling process, contact method, or business
software was confirmed"). The `"Already answered — don't re-ask:"` line often
reads _"nothing has been answered yet."_ This is poor raw material for a prompt
instruction that says "reference where you left off in one short line."

**It is a game of telephone.** Each call rewrites the whole note from the previous
note plus the new transcript, so wording drifts and facts are silently reworded or
lost across calls.

## Decisions

Each was chosen over a stated alternative.

**A name is allowed, but it must come with evidence.** The model may write a
person's name when (a) it is already on the lead record, or (b) a speaker
explicitly identified that person — "the owner is …", "this is … speaking", "ask
for …". For case (b) the model must return the **verbatim transcript line** that
states it. This was chosen over a blanket ban on heard names, which was the first
draft: when a gatekeeper clearly says who the owner is, that is the single most
valuable thing on the call and throwing it away made the note materially worse.

**The evidence is verified in code, not trusted.** Each quote must actually appear
in the transcript (case- and punctuation-insensitive) and must contain the name.
A name also fails if it is a word from the company name — that is precisely the
mishearing pattern ("Piggy", "Rhapsody", "Repz"). A rejected name causes **every
line mentioning it to be dropped**, not just the name. Excising the word leaves
"The owner is and she is in tomorrow"; dropping the line loses a fact but can
never assert a false one. Verified on real calls: accepts "Amanda Ziegler" on the
evidence _"Lead: Amanda, Amanda Ziegler."_, rejects "Jack" as not in the
transcript, and drops "Piggy"-class names as company-name fragments.

**First names only.** An accepted name contributes only its first token to the
note; "Amanda Ziegler" is stored and spoken as "Amanda". The shortening runs in
code over every field before the unverified-token check, so a surname can never
survive by being attached to a verified first name — and a surname left stranded
on its own drops its line like any other unverified token. Surnames add nothing
the next caller can use on the phone and double the surface area for an ASR error
(the observed mishears were `Jin → "Jinmi"`, `Rosalynn → "Rosalind"`). Applied to
on-file contacts too, so the note is consistent regardless of what the CSV holds.

**A deterministic gate, not prompt wording.** Prototyped against real transcripts,
the same prompt on the same input leaked an unverified name on one run and not the
next; `gpt-5.4-mini` is a reasoning model and the existing call sends no
`temperature`, so output is not stabilisable that way.

**Prompt examples use angle-bracket placeholders, never sample values.** A draft
whose example read _"the owner is Nicole, she's usually in Wednesdays"_ caused the
model to emit **"Owner is usually in on Wednesdays"** for a business whose
transcript said _tomorrow_ — it copied the example instead of reading the
transcript. Examples now read `<NAME>` / `<DAY>` with an explicit instruction never
to copy a detail out of them. This is load-bearing: the bug produced a confident,
plausible, wholly invented fact.

**Stop auto-writing heard names and emails onto the lead.** `owner_name`,
`manager_name`, `employee_name`, `business_email` are no longer written by
`autoFillLeadFromExtraction`. The values remain on `calls.extracted_data` and
visible in the call detail. Deliberate asymmetry: the note may _record_ that
someone said the owner is Amanda Ziegler, but the lead's identity fields stay
owned by the CSV. The alternative — a review queue for conflicting names — was
explicitly rejected: thousands of rows of manual work, and the CSV is the intended
source of truth. Consequence to accept: the note can name an owner the agent's
`{{owner_name}}` variable does not know about, until the CSV is corrected.
`callback_datetime` is untouched — it is operational and books the callback.

**No bullet may restate a contact already on file.** A draft produced bullets like
"owner Trey" and "Owner Jacob" — data we already hold, padding the list the next
caller has to read.

**Fact bullets carry forward verbatim.** The prompt is given the previous bullets
as exact strings to copy unchanged, and may only append. This is what stops the
drift. The stronger alternative — storing bullets as a JSON array — needs a
migration and a UI change; the text column plus a copy-forward instruction gets
most of the benefit for none of the risk, and can be upgraded later.

**Two separate "nothing happened" guards, because measurement contradicted the
first draft.** `gatekeeper` calls are _not_ mostly silent hangups: across the last
61 summarised calls their median is **37 lead-spoken words** (min 4, max 187).
That is how Palace Spa told us it opens at 9:30. So:

- _Deterministic skip, before any OpenAI call:_ if the lead spoke **fewer than 15
  words**, leave the note completely untouched and make no model call. Measured:
  skips 9 of 61 (15%), and skips **zero** calls whose outcome was `callback`,
  `goal_met`, `not_interested` or `call_back_later`. The threshold is a named
  constant so it can be retuned.
- _Model-level:_ every other call still goes to the model, but a call that yields
  nothing new returns no bullets, so the previous fact list is preserved and only
  `status` / `left_off` change.

**The Close handoff sends the whole note; delete the splitter.**
`close/actions.ts:414` currently splits on the literal `"Already answered"`. That
string disappears, so left alone the splitter silently stops matching and
everything flows through anyway. The bullets are plain facts a closer wants and
"don't re-ask" is reasonable advice for a closer too. Removing the split is
simpler than re-targeting it at a new marker, and matches the "same shape for
every reader" decision.

**Existing summaries are left alone.** All 61 self-heal on the lead's next call.
Regenerating them was offered and declined; a backfill script already exists
(`scripts/regen-summaries.mjs`) if that changes.

## The note format

Stored as text in the same column, rendered by the same components:

```
Status: Interested, callback booked
Left off: Callback was set with Amanda for Wednesday morning.
Known — don't re-ask:
  • Owner is usually here on Wednesdays.
  • Some missed calls go to voicemail.
  • She returns voicemails in the mornings.
```

- **Status** — at most 10 words, reflects the whole history, always present.
- **Left off** — one sentence naming a concrete pickup point, or omitted.
  "They weren't the owner" is not a pickup point.
- **Known — don't re-ask** — bullets of what the _lead_ said. Each ≤10 words,
  third person, never a transcript quote, never a restatement of on-file data.
  Max 8; oldest dropped first. Never a bullet about what we failed to learn.
  Omitted when empty.

Measured against real production calls (before → after):

| Business                        | Before | After | Note                              |
| ------------------------------- | ------ | ----- | --------------------------------- |
| River City Bicycles             | 110 w  | 7 w   | mis-heard "Versity E-Bikes" gone  |
| Youglow wellness & spa          | 118 w  | 7 w   | junk owner "Prisada" gone         |
| RECVR oc Active Recovery Lounge | 92 w   | 36 w  | objection kept, padding gone      |
| Palace Spa & Massage            | 133 w  | 52 w  | hours + objection + owner kept    |
| Rhapsody Salon                  | 156 w  | 37 w  | "Amanda" kept, quoted + shortened |

## Files touched

- `src/lib/openai/summary-merger.ts` — new system + user prompt, new JSON schema
  (`status` / `left_off` / `known[]` / `callback_notes` / `names[]` with
  evidence), the evidence verifier, the first-name shortener, the line-dropper,
  the render-to-text step, and the <15-lead-word skip.
- `src/lib/elevenlabs/post-call-webhook.ts` — `autoFillLeadFromExtraction` stops
  writing the four identity fields; comment at :1080 updated.
- `src/lib/close/actions.ts` — drop the `"Already answered"` split.
- `tests/` — a Playwright spec covering: a name with a fabricated quote never
  reaching the stored note, a name with a real quote surviving, an on-file name
  surviving, and a no-new-facts call leaving the previous note unchanged.

## Out of scope

- **Cleaning the imported `owner_name` values.** ~16% are business-name
  fragments and the agent says them out loud on live calls. This is a data
  problem the CSV owner fixes; the code change stops it getting worse but does
  not repair existing rows.
- **The per-call recap shown in the Calls list** (`calls.summary`) — still
  ElevenLabs' `transcript_summary` verbatim, still occasionally wrong
  ("called Richard the Man", "Summary couldn't be generated for this call").
- **The live agent prompt.** `{{owner_name}}` still comes straight from the lead
  record; "One name → use it" is unchanged.
- Storing facts as structured JSON rather than rendered text.

## Verification

- `npx tsc --noEmit`, `npx eslint`, `npm run build` clean on changed files.
- Evidence verifier tested against the real strings collected during design:
  accepts "Amanda Ziegler" (quote present) and on-file "Paula"/"Michelle"/"Trey";
  rejects "Jack" (quote absent) and company-name fragments. "Amanda Ziegler" is
  stored as "Amanda" everywhere, including the callback pickup note, and a bare
  "Ziegler" drops its line.
- The <15-lead-word skip leaves an existing note byte-for-byte unchanged and
  makes no model call.
- After deploy, re-run the design-time inspection against production: median note
  length well under 117 words, and every personal name in a note either on its
  lead record or quoted in that call's transcript.
