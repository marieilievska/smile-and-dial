-- Public API (Step 41 / BUILD_PLAN §14).
-- Per-user API keys + an idempotency-key log so retries are safe.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  key_prefix text not null unique,
  key_hash text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_keys_owner_id_idx
  on public.api_keys (owner_id, created_at desc);

alter table public.api_keys enable row level security;

-- Users see their own keys; admins see all.
create policy "api_keys_select"
  on public.api_keys
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

create policy "api_keys_insert"
  on public.api_keys
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

create policy "api_keys_update"
  on public.api_keys
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Idempotency cache for POST /api/v1/leads. We dedupe on (api_key_id, key)
-- so two different keys can use the same Idempotency-Key string without
-- colliding.
create table if not exists public.api_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references public.api_keys (id) on delete cascade,
  idempotency_key text not null,
  lead_id uuid references public.leads (id) on delete set null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  unique (api_key_id, idempotency_key)
);

create index if not exists api_idempotency_keys_created_at_idx
  on public.api_idempotency_keys (created_at desc);

-- No RLS — this is a server-side cache, written by the public API route
-- under the service role.
alter table public.api_idempotency_keys disable row level security;
