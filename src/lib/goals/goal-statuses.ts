/** Goal-pipeline statuses on the lead. Kept in a non-"use server" file so
 *  client components (and the Goals page server component, transitively
 *  via client components) can import the constant directly. */
export type GoalStatus =
  | "goal_met"
  | "attended"
  | "no_show"
  | "sale"
  | "closed";

export const GOAL_STATUSES: GoalStatus[] = [
  "goal_met",
  "attended",
  "no_show",
  "sale",
  "closed",
];
