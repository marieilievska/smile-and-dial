import type { GoalStatus } from "@/lib/goals/goal-statuses";

/** One row of the goal pipeline — a lead that's moved past a goal-met
 *  call. Hydrated once on the server and passed down to both the
 *  table and board views so the client doesn't refetch on view toggle. */
export type PipelineLead = {
  id: string;
  company: string | null;
  business_phone: string | null;
  business_email: string | null;
  status: GoalStatus;
  /** When the lead's most recent goal_met call happened — drives the
   *  "since" column and the "stale" indicator. */
  goalMetAt: string | null;
  campaign_id: string;
  campaign_name: string;
  goal_id: string;
  goal_name: string;
  originating_call_id: string | null;
};
