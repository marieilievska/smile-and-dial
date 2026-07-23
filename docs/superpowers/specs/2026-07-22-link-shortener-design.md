# Link shortener for the in-call send_text / send_email tools

**Date:** 2026-07-22
**Status:** approved, ready to build

## The problem

The `send_text` and `send_email` tools send a fixed per-campaign template. We
want that template to carry a link to the HireAI presell page, personalised for
the lead the AI is talking to — their business name, phone, email and Google
place id, plus UTM attribution.

Two constraints pull against each other:

- The URL with all of those parameters is ~250 characters. In an SMS that is
  3 segments (3x the cost) and long URLs attract carrier spam filtering.
- The parameters are **per lead**, so the link cannot be pre-baked into a
  template — it has to be built at send time.

## What we're building

At send time, for both channels:

1. Find the URL the template author pasted into the template body.
2. Append the lead's details to it (URL-encoded).
3. Exchange it for a short URL via HireAI's shortener API.
4. Substitute the short URL into the message.

The template author pastes a plain link and never types a parameter.

## Why HireAI's shortener and not our own

The CEO's presell app already exposes a shortener API
(`POST https://presale.hireai.me/api/public/shortlinks`, bearer auth) that
returns `https://presale.hireai.me/s/<code>` and answers clicks with a
server-side 302, logging click analytics.

Using it means:

- **No DNS work.** Building our own needed a branded domain, and every
  candidate was blocked: `hireai.me` is registered in another Vercel account
  (ownership-claim wall, which risked breaking `presale.hireai.me` itself), and
  nobody on this side has access to `referrizer.com` DNS.
- **The short link and the landing page share a domain**, so the link the
  prospect taps matches the page they arrive at.
- **Less code.** We call an API instead of hosting a redirect.

Accepted trade-offs: click analytics live in his admin dashboard rather than our
Reporting tab, and links already sent would break if that app were ever retired.

## Where it hooks in

Both tools already funnel through one line — `renderTemplate(tmpl.body, ctx)` in
`src/lib/elevenlabs/tool-webhook.ts` (`sendEmail` ~L468, `sendText` ~L689). The
shortening step goes immediately after, before delivery and before the row is
recorded, so what we store is exactly what was sent.

## The parameters we send

| Param             | Source                                                          |
| ----------------- | --------------------------------------------------------------- |
| `business_name`   | `leads.company`                                                 |
| `phone`           | `leads.business_phone`                                          |
| `email`           | the address the AI confirmed on the call, else `business_email` |
| `google_place_id` | `leads.google_place_id`                                         |
| `utm_source`      | `smile-and-dial` (matches the Close handoff convention)         |
| `utm_medium`      | `sms` or `email`                                                |
| `utm_campaign`    | the campaign name                                               |

Two rules:

- **Anything already in the pasted URL wins.** We only fill parameters that
  aren't there, so an author who writes their own `utm_campaign` keeps it.
- **Missing values are omitted entirely**, never sent as `key=`. The presell
  page treats all parameters as optional and shows a placeholder for anything
  absent; an empty value risks rendering as a filled-but-blank field.

`address` is deliberately **not** sent: we store `city`/`state` but no street
address, and a half-filled address field reads as broken.

## Data model

```sql
create table public.short_links (
  id, lead_id, owner_id, campaign_id,
  channel text check (channel in ('sms','email')),
  code text, short_url text, long_url text, created_at
);
```

Looked up by `(lead_id, campaign_id, channel)`; if the newest row's `long_url`
matches what we just built, its short URL is reused. This stops repeat sends
minting a new code forever and keeps click counts consolidated. A changed
template produces a different `long_url`, so a fresh code is minted.

RLS: owner/admin select only. Writes come from the tool webhook's service-role
client, which bypasses RLS.

## Failure behaviour

The API call happens **during a live phone call**, while the AI is telling the
lead their text is on the way. It must never be what stops a send.

| Failure                    | Behaviour                          |
| -------------------------- | ---------------------------------- |
| No `SHORTLINK_API_KEY` set | Skip shortening, send the full URL |
| Shortener slow (>4s)       | Abort, send the full URL           |
| Shortener down / 401 / 500 | Send the full URL                  |
| 409 code collision         | Retry once, then send the full URL |
| No URL in the template     | Send the message unchanged         |

**We always send the real personalised destination.** Shortening is an
optimisation on top, never a precondition — a rare fallback costs extra SMS
segments but the prospect still lands on a prefilled page. Failures are logged
distinctly (401 vs timeout vs down) so a bad key is diagnosable.

## Incidental fix

`buildEmailContext` never populated `campaign`, so the documented
`{{campaign.name}}` token silently rendered as an empty string in every
template. We need the campaign name for `utm_campaign` anyway, so it is now
populated and the token works.

## Configuration

`SHORTLINK_API_KEY` in Vercel env (Production). Absent locally and in tests, so
neither ever calls the live API.

## Testing

Unit tests (vitest) cover the pure logic, which is where the risk is:
URL detection, parameter merging, author-wins precedence, omission of empty
values, and encoding of names containing `&`, `'` and spaces.
