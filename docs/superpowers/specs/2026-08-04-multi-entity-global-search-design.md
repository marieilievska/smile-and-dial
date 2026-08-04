# Multi-entity global search — design

**Date:** 2026-08-04
**Status:** Spec for review (not yet built)
**Owner:** Marija

## Goal

The top-bar search should find **any** primary object by name, not just leads. Today `fetchLeadSuggestions` only queries `leads`, and #336 added static "jump to page" nav results. A teammate who types "Q1 Outbound" (a campaign) or an agent name gets nothing. Extend the dropdown to search across the objects a teammate actually navigates to.

## Scope

Search these entities (each RLS-scoped, so members only see their own; admins see all):

| Entity    | Match on                                | Jumps to                                                     |
| --------- | --------------------------------------- | ------------------------------------------------------------ |
| Leads     | company, business_phone, business_email | `/leads/{id}`                                                |
| Campaigns | name                                    | `/campaigns` (open settings for that id — future: deep link) |
| Agents    | name                                    | `/settings/agents/{id}/edit`                                 |
| Lists     | name                                    | `/leads?list={id}`                                           |
| Callbacks | (skip — reached via lead)               | —                                                            |

Plus the existing static **jump-to-page** results (Today, Leads, Settings…). Calls are intentionally excluded (searched by lead, and the /calls page already has its own search).

## Approach

Replace `fetchLeadSuggestions` with a single `fetchGlobalSuggestions(query)` server action that fans out (one small `ilike … limit N` per entity, in `Promise.all`) and returns a typed, **grouped** result:

```ts
type GlobalSuggestions = {
  leads: LeadHit[]; // up to 5
  campaigns: NameHit[]; // up to 3
  agents: NameHit[]; // up to 3
  lists: NameHit[]; // up to 3
};
```

- All queries run on the user client, so RLS does the per-user scoping for free (leads/campaigns/agents/lists are all owner-or-admin). No new policies needed.
- Reuse the existing Postgres-safe sanitization (`replace(/[%,()\\*]/g, "")`).
- Keep the 2-char minimum + debounce already in `global-search.tsx`.

## UI

`global-search.tsx` renders the dropdown as sections with small headers ("Leads", "Campaigns", "Agents", "Lists", "Go to"), each row an icon + name + secondary line (e.g. a lead's city/state, a campaign's status). Keyboard up/down cycles across all rows; Enter navigates. Empty groups are omitted. The existing jump-to-page block stays as the final "Go to" section.

## Files

- `src/components/app-shell/search-suggestions-action.ts` → rename/extend to `fetchGlobalSuggestions`; add the campaign/agent/list queries + types.
- `src/components/app-shell/global-search.tsx` → render grouped sections; generalize the keyboard nav over a flat list of `{label, href, kind}`.
- Update the one caller of `fetchLeadSuggestions`.

## Risks / notes

- **No DB or permission change** — all entities are already RLS-scoped to owner-or-admin.
- Perf: 4 tiny `ilike` queries per keystroke (debounced). Each is `limit 3–5`, indexed-ish on name; acceptable. If it shows up in Vercel usage, raise the debounce to ~250ms.
- Keep total dropdown rows ≤ ~14 so it doesn't overflow the viewport.

## Open questions

1. Should a campaign hit deep-link straight into its settings sheet (needs a `?campaign={id}&open=1` param on `/campaigns`), or just land on the list? (Recommend: list for v1, deep-link as a fast-follow.)
2. Include **Knowledge bases** and **Templates** too, or keep v1 to the four high-traffic entities? (Recommend: four for v1.)
