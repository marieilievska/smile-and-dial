import { Target } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
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

export default async function GoalsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: goals } = await supabase
    .from("goals")
    .select("id, name, description, is_default, created_at")
    .order("created_at", { ascending: true });

  return (
    <div className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Goals
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Define what a successful call looks like. A campaign picks one goal,
            and the agent is scored against it.
          </p>
        </div>
        <GoalFormDialog mode="create" />
      </div>

      {goals && goals.length > 0 ? (
        <div className="border-border mt-6 overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {goals.map((goal) => (
                <TableRow key={goal.id}>
                  <TableCell className="font-medium">{goal.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {goal.description || "—"}
                  </TableCell>
                  <TableCell>
                    {goal.is_default ? (
                      <Badge variant="secondary">Default</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(goal.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <GoalFormDialog mode="edit" goal={goal} />
                      <DeleteGoalDialog goal={goal} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
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
