-- Cross-import cache of Twilio Lookup line types.
--
-- A Line Type Intelligence lookup costs money every time it runs, and the
-- import wizard was paying repeatedly for the same number: Back → "Review
-- import" re-analysed the whole file, a retried batch re-ran lookups that had
-- already completed, a number repeated inside one file was looked up per
-- occurrence, and a number one teammate had already classified was looked up
-- again by the next teammate. A line type is a property of the phone number,
-- not of any user's lead, so it is safe to share across owners.
--
-- Written by src/lib/leads/import-actions.ts after a live lookup that came
-- back with a definitive type; consulted before calling Twilio. RLS is ON with
-- NO policies on purpose: only the service-role client touches this table.
-- Unknown results are never stored, so a number Twilio could not classify is
-- retried on the next import instead of being frozen as "unknown".

create table if not exists public.phone_line_types (
  phone text primary key,
  line_type text not null
    check (line_type in ('landline', 'mobile', 'voip', 'invalid')),
  looked_up_at timestamptz not null default now()
);

comment on table public.phone_line_types is
  'Twilio Lookup line type per E.164 phone, shared across owners so a number '
  'is billed once. Service-role only (RLS on, no policies).';

alter table public.phone_line_types enable row level security;
