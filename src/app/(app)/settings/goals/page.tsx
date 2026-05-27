import { Megaphone, Star, Target } from "lucide-react";
import { redirect } from "next/navigation";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { DeleteGoalDialog } from "./delete-goal-dialog";
import { GoalFormDialog } from "./goal-form-dialog";

export default async function SettingsGoalsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Load goals and the count of active campaigns referencing each one.
  // Two parallel queries: goals + campaigns. Match up in code so we can
  // surface "Used by N campaigns" inline and gate Delete accordingly.
  const [{ data: goals }, { data: campaigns }] = await Promise.all([
    supabase
      .from("goals")
      .select("id, name, description, is_default, created_at")
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true }),
    supabase
      .from("campaigns")
      .select("id, goal_id, status")
      .neq("status", "ended"),
  ]);

  const usageByGoal = new Map<string, number>();
  for (const c of campaigns ?? []) {
    if (!c.goal_id) continue;
    usageByGoal.set(c.goal_id, (usageByGoal.get(c.goal_id) ?? 0) + 1);
  }

  const totalGoals = goals?.length ?? 0;
  const inUse = (goals ?? []).filter(
    (g) => (usageByGoal.get(g.id) ?? 0) > 0,
  ).length;
  const defaultGoal = (goals ?? []).find((g) => g.is_default);

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Goals
          </h1>
          <p className="text-muted-foreground text-sm">
            What a campaign&apos;s calls are trying to achieve. Pick one when
            you create a campaign.
          </p>
        </div>
        <GoalFormDialog mode="create" />
      </div>

      {/* G1 — small at-a-glance strip matching the rest of the app. */}
      <section
        data-testid="goals-stat-strip"
        className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 duration-500 sm:grid-cols-3"
      >
        <StatTile
          icon={<Target className="size-3.5" />}
          label="Goals"
          value={totalGoals.toLocaleString()}
        />
        <StatTile
          icon={<Megaphone className="size-3.5" />}
          label="In active campaigns"
          value={inUse.toLocaleString()}
          divider
        />
        <StatTile
          icon={<Star className="size-3.5" />}
          label="Default"
          value={defaultGoal?.name ?? "—"}
          divider
          mono
        />
      </section>

      {goals && goals.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-[180px]">Used by</TableHead>
                <TableHead className="w-[140px]">Created</TableHead>
                <TableHead className="w-[180px]" aria-label="Row actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {goals.map((goal) => {
                const usage = usageByGoal.get(goal.id) ?? 0;
                return (
                  <TableRow key={goal.id} className="group">
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium">
                          {goal.name}
                          {goal.is_default ? (
                            <span
                              className="inline-flex items-center gap-0.5 rounded-full bg-[color:var(--coral)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--coral)]"
                              title="Default goal — applied when creating a new campaign"
                            >
                              <Star className="size-2.5 fill-current" />
                              Default
                            </span>
                          ) : null}
                        </span>
                        {goal.description ? (
                          <span className="text-muted-foreground truncate text-xs">
                            {goal.description}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {usage > 0 ? (
                        <span className="text-foreground text-xs tabular-nums">
                          {usage} active campaign{usage === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          Not in use
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(goal.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="ml-auto flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <GoalFormDialog mode="edit" goal={goal} />
                        <DeleteGoalDialog goal={goal} usageCount={usage} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Target className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No goals yet</p>
          <p className="text-muted-foreground text-sm">
            Create your first goal to start building campaigns.
          </p>
        </div>
      )}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  divider,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  divider?: boolean;
  mono?: boolean;
}) {
  return (
    <div
      className={`-mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-[color:var(--coral)]">{icon}</span>
        {label}
      </p>
      <p
        className={`text-foreground truncate text-2xl leading-none font-medium ${
          mono ? "text-base font-semibold" : "tabular-nums"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
