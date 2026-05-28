import { DollarSign, Hash, Phone } from "lucide-react";
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

  const totalMonthly = numbers
    .filter((n) => !n.released_at)
    .reduce((sum, n) => sum + Number(n.monthly_cost ?? 0), 0);

  function buildStatusHref(next: string): string {
    const url = new URLSearchParams();
    if (next && next !== "all") url.set("status", next);
    const qs = url.toString();
    return qs ? `/settings/twilio-numbers?${qs}` : "/settings/twilio-numbers";
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex items-start justify-between gap-4 duration-500">
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
          <section
            data-testid="twilio-numbers-stat-strip"
            className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both grid grid-cols-3 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 delay-75 duration-500"
          >
            <StatTile
              icon={<Phone className="size-3.5" />}
              label="In pool"
              value={counts.in_pool.toLocaleString()}
            />
            <StatTile
              icon={<Hash className="size-3.5" />}
              label="Released"
              value={counts.released.toLocaleString()}
              divider
            />
            <StatTile
              icon={<DollarSign className="size-3.5" />}
              label="Monthly cost"
              value={`$${totalMonthly.toFixed(2)}`}
              divider
            />
          </section>

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

function StatTile({
  icon,
  label,
  value,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  divider?: boolean;
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
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
    </div>
  );
}
