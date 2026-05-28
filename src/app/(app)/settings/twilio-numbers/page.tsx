import { Phone } from "lucide-react";
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

import { formatCreatedAt } from "../format-created";
import { BuyNumberDialog } from "./buy-number-dialog";
import { ReleaseNumberDialog } from "./release-number-dialog";
import { TwilioNumbersStatusTabs } from "./status-tabs";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function TwilioNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/leads");

  const params = await searchParams;
  const status = ["all", "in_pool", "released"].includes(str(params.status))
    ? str(params.status)
    : "all";

  const { data: rawNumbers } = await supabase
    .from("twilio_numbers")
    .select(
      "id, phone_number, friendly_name, country, monthly_cost, released_at, purchased_at",
    )
    .order("purchased_at", { ascending: false });
  const numbers = rawNumbers ?? [];

  const counts = {
    all: numbers.length,
    in_pool: numbers.filter((n) => !n.released_at).length,
    released: numbers.filter((n) => n.released_at).length,
  };
  const visible = numbers.filter((n) => {
    if (status === "in_pool") return !n.released_at;
    if (status === "released") return Boolean(n.released_at);
    return true;
  });

  function buildStatusHref(next: string): string {
    const url = new URLSearchParams();
    if (next && next !== "all") url.set("status", next);
    const qs = url.toString();
    return qs ? `/settings/twilio-numbers?${qs}` : "/settings/twilio-numbers";
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Twilio numbers
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The pool of phone numbers your campaigns dial from.
          </p>
        </div>
        <BuyNumberDialog />
      </div>

      {numbers.length > 0 ? (
        <>
          {/* Round 29 — dropped the stat strip. The status tabs below
           *  carry the In pool / Released split with per-tab counts,
           *  and the monthly cost wasn't urgent enough to chrome up
           *  every settings visit with it. */}
          <TwilioNumbersStatusTabs
            current={status}
            counts={counts}
            buildHref={buildStatusHref}
          />

          {visible.length > 0 ? (
            <div className="border-border overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Friendly name</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead>Monthly cost</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Purchased</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((number) => (
                    <TableRow key={number.id} className="group">
                      <TableCell className="font-mono text-xs font-medium">
                        {number.phone_number}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {number.friendly_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {number.country}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        ~${Number(number.monthly_cost).toFixed(2)}/mo
                      </TableCell>
                      <TableCell>
                        {number.released_at ? (
                          <Badge variant="ghost" dot>
                            Released
                          </Badge>
                        ) : (
                          <Badge variant="success" dot>
                            In pool
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground tabular-nums"
                        title={new Date(number.purchased_at).toLocaleString()}
                      >
                        {formatCreatedAt(number.purchased_at, now)}
                      </TableCell>
                      <TableCell>
                        {number.released_at ? null : (
                          <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <ReleaseNumberDialog
                              number={{
                                id: number.id,
                                phone_number: number.phone_number,
                              }}
                            />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
              <Phone className="text-muted-foreground size-8" />
              <p className="text-foreground text-sm font-medium">
                No numbers in this view
              </p>
              <p className="text-muted-foreground text-sm">
                Switch to another tab to see released or all numbers.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Phone className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No numbers yet</p>
          <p className="text-muted-foreground text-sm">
            Buy your first phone number to start building campaigns.
          </p>
        </div>
      )}
    </div>
  );
}
