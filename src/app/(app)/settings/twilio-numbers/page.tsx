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

import { BuyNumberDialog } from "./buy-number-dialog";
import { ReleaseNumberDialog } from "./release-number-dialog";

export default async function TwilioNumbersPage() {
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

  const { data: numbers } = await supabase
    .from("twilio_numbers")
    .select(
      "id, phone_number, friendly_name, country, monthly_cost, released_at, purchased_at",
    )
    .order("purchased_at", { ascending: false });

  return (
    <div className="p-8">
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

      {numbers && numbers.length > 0 ? (
        <div className="border-border mt-6 overflow-hidden rounded-lg border">
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
              {numbers.map((number) => (
                <TableRow key={number.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {number.phone_number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {number.friendly_name || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {number.country}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    ~${Number(number.monthly_cost).toFixed(2)}/mo
                  </TableCell>
                  <TableCell>
                    {number.released_at ? (
                      <span className="text-muted-foreground text-sm">
                        Released
                      </span>
                    ) : (
                      <Badge variant="secondary">In pool</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(number.purchased_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    {number.released_at ? null : (
                      <div className="flex justify-end">
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
        <div className="border-border mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
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
