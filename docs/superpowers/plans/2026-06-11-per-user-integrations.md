# Per-User Integrations + Fixed ElevenLabs Voices — Plan

**Branch:** `feat/per-user-integrations`
**Goal:** Move Close / Calendly / Meta from one workspace-level config to **per-user** config, and make ElevenLabs voices a **fixed code-level set** (drop from integrations). Each account sets up + acts on **their own** data (their owned leads → their own Meta audience; their campaigns → their Calendly/Close). Existing config carries over to **marie@referrizer.com** (`3d5c50a7-7eff-40da-989b-a5ea75067fda`).

**Today's state:** single admin (marie) owns all 14,622 live leads. Only **Meta** is connected (Calendly/Close are not). So marie's behavior must stay identical (her owned leads = all leads = her current audience). Low regression risk.

---

## Phase 1 — Foundation: per-user storage + migrate marie's config

**Migration** `supabase/migrations/20260611160000_user_integrations.sql`:

- `create table public.user_integrations` — `user_id uuid primary key references public.profiles(id) on delete cascade`, plus the columns currently on `app_settings`:
  - calendly_access_token, calendly_refresh_token, calendly_organization_uri, calendly_user_uri, calendly_connected_at, calendly_last_sync_at
  - close_api_key, close_connected_at
  - meta_ad_account_id, meta_access_token, meta_custom_audience_id, meta_audience_terms_accepted_at, meta_connected_at, meta_last_sync_at, meta_last_sync_count, meta_last_sync_error
- RLS: enable; policy "own row" — `select`/`insert`/`update` where `user_id = auth.uid()`. (Service role bypasses RLS for usage/cron.)
- Data migration: `insert into public.user_integrations (user_id, <all cols>) select p.id, s.<cols> from public.app_settings s cross join public.profiles p where p.email = 'marie@referrizer.com' limit 1;` so marie keeps her Meta connection + audience.
- KEEP `meta_sync_secret` on `app_settings` (cron auth is workspace-level; the cron iterates users).
- Do NOT drop the old `app_settings` integration columns yet (cleanup is Phase 5, after everything is verified).

Apply + regenerate types.

**Lib** `src/lib/integrations/user-integrations.ts`:

- `getUserIntegrations(supabase, userId): Promise<Row | null>` — read one user's row (works with user-scoped or service-role client).
- `patchUserIntegrations(supabase, userId, patch): Promise<void>` — upsert the user's row (`onConflict: user_id`).
- A typed shape mirroring the columns.

---

## Phase 2 — Settings UI: per-user Close / Calendly / Meta

- `settings/integrations/meta-form.tsx` + its action (`src/lib/meta/settings.ts` / `actions.ts`): read/write the **current user's** `user_integrations` row instead of `app_settings`. The page already loads the user — pass `user.id`.
- Calendly connect/disconnect + Close form: same swap to per-user.
- Copy tweak: each section says "your" connection (these are now personal).
- Settings access: any logged-in user manages **their own** integrations (no longer admin-only for these three — confirm against the current gate and adjust so a member can connect their own).

---

## Phase 3 — ElevenLabs voices: fixed set, drop from integrations

- New `src/lib/elevenlabs/voices.ts` exporting `FIXED_VOICE_IDS` (the 17 current ids) — ideally `{ id, label }[]` (label can be the EL voice name if the wizard already fetches names; otherwise a short friendly label).
  Current ids: DODLEQrClDo8wCz460ld, s3TPKV1kjDlVtZbl4Ksh, c6SfcYrb2t09NHXiT80T, yM93hbw8Qtvdma2wCnJG, NHRgOEwqx5WZNClv5sat, MClEFoImJXBTgLwdLI5n, pvxGJdhknm00gMyYHtET, uYXf8XasLslADfZ2MB4u, uKGPYP2uuyRQv8SeFre0, ZauUyVXAz5znrgRuElJ5, kdnRe2koJdOK4Ovxn2DI, XcXEQzuLXRU9RcfWzEJt, 7EzWGsX10sAS4c9m9cPf, inGcvmoPgbvKUk9uCvHu, wSO34DbFKBGmeCNpJL5K, oWjuL7HSoaEJRMDMP3HD, iLVmqjzCGGvqtMCk6vVQ
- Agent wizard reads `FIXED_VOICE_IDS` instead of `app_settings.elevenlabs_voice_ids`.
- Remove the ElevenLabs voice section from `settings/integrations/page.tsx` (delete/retire `elevenlabs-form.tsx`).
- Stop reading `elevenlabs_voice_ids` anywhere (leave the column for now; cleanup later).

---

## Phase 4 — Usage scoping (the careful part)

- **Meta sync** (`src/lib/meta/sync.ts` + the sync route/cron `src/app/api/meta/sync/route.ts` + cron migration): the sync now takes a `userId` + that user's connection; the lead query gains `.eq("owner_id", userId)` (push only that user's owned leads); reads `meta_*` from `user_integrations`. The route/cron iterates **every user with `meta_connected_at` set**, syncing each into their own audience. `meta_last_sync_*` writes go to that user's row. (For marie this is behavior-identical since she owns all leads.)
- **Calendly** (the `get_available_times` tool in `tool-webhook.ts`): resolve the **campaign owner's** Calendly from `user_integrations` (campaign → owner*id → user's calendly*\*). Falls back gracefully (generic slots) when the owner has no Calendly.
- **Close**: wherever the Close key is read, use the relevant user's row (Close is currently a mock — keep it working, just per-user-sourced).

---

## Phase 5 — Cleanup (defer until verified)

Drop the now-unused integration columns from `app_settings` (`elevenlabs_voice_ids`, `calendly_*`, `close_*`, `meta_*` except `meta_sync_secret`) in a later migration, once Phases 1–4 are confirmed live.

## Verify each phase

tsc clean (filtered) + `npm run build` exit 0 after every phase; a live read-only probe to confirm marie's migrated row + that her Meta sync still targets her audience.
