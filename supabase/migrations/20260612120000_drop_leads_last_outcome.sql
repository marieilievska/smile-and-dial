-- leads.last_outcome has never been written by any code path; all surfaces
-- that displayed it always showed empty/null. Remove the column entirely so
-- the schema matches reality.
alter table public.leads drop column if exists last_outcome;
