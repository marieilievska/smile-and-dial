/** Lead pipeline-status values, in display order.
 *
 *  Lives in its own plain (NON-"use client") module on purpose: it's consumed
 *  by BOTH the server `page.tsx` (to build the filter builder's status options)
 *  and the client `leads-filters.tsx`. Importing a plain value from a
 *  "use client" module into a Server Component hands the server a client-
 *  reference proxy instead of the array (so `STATUSES.map` throws). Keeping the
 *  constant here, free of any "use client" or React imports, lets both sides
 *  import the real array safely. */
export const STATUSES = [
  "ready_to_call",
  "callback",
  "resting",
  "goal_met",
  "attended",
  "no_show",
  "closed",
  "sale",
  "dnc",
  "email_replied",
];
