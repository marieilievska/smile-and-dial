import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  isUnattributed,
  mobileShare,
  reachedShare,
  totalsFor,
  voicemailShare,
  workedShare,
  type ListPerformanceRow,
} from "@/lib/analytics/list-performance";

function count(n: number): string {
  return n.toLocaleString();
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function listHref(baseParams: string, listId: string): string {
  const p = new URLSearchParams(baseParams);
  p.set("list", listId);
  return `/analytics?${p.toString()}`;
}

/**
 * "Which lead list is still worth dialling" — the reachability half.
 *
 * Section one asks whether a list paid for itself. This one asks whether it
 * can be reached at all, and how much of it is left. Same query, so the two
 * can never disagree about how big a list is or how much of it has been
 * worked.
 *
 * Two kinds of column, and the difference matters when you move the date
 * pills:
 *   * Reached and Voicemail are ACTIVITY — they follow the period toggle on
 *     the section above, and the campaign filter.
 *   * Everything else is INVENTORY, counted as of now. What is left in a list
 *     is not a property of the window you are looking through it with.
 *
 * The unattributed row is dropped here: it carries registrations that could
 * not be traced to a lead, and so has no list to be reachable.
 */
export function ListReachabilitySection({
  rows,
  baseParams,
}: {
  rows: readonly ListPerformanceRow[];
  baseParams: string;
}) {
  const lists = rows.filter((r) => !isUnattributed(r));
  const totals = totalsFor(lists);
  // "We checked and found no mobiles" and "we never checked" must not render
  // the same. Today no lookup has ever run, so this is zero everywhere.
  const anyLineTyped = totals.line_typed > 0;

  return (
    <section className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm delay-250 duration-500">
      <div>
        <h2 className="text-foreground text-sm font-semibold">
          Reach and what is left
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Reached and Voicemail follow the period above. Everything else is
          counted as it stands now.
        </p>
      </div>

      <div className="border-border overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>List</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">Worked</TableHead>
              <TableHead className="text-right">Reached</TableHead>
              <TableHead className="text-right">Voicemail</TableHead>
              <TableHead className="text-right">Mobiles</TableHead>
              <TableHead className="text-right">Bad no.</TableHead>
              <TableHead className="text-right">Suppressed</TableHead>
              <TableHead className="text-right">Resting</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lists.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={10}
                  className="text-muted-foreground py-10 text-center text-sm"
                >
                  No lists with activity yet.
                </TableCell>
              </TableRow>
            ) : (
              lists.map((r) => (
                <TableRow key={r.list_id ?? "unattributed"}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      <Link
                        href={listHref(baseParams, r.list_id!)}
                        className="hover:text-primary underline-offset-4 hover:underline"
                      >
                        {r.list_name || "Untitled list"}
                      </Link>
                      {r.is_inbound ? (
                        <Badge variant="secondary" className="text-[10px]">
                          Inbound
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(r.leads)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(workedShare(r))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(reachedShare(r))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(voicemailShare(r))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(mobileShare(r))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(r.bad_number)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(r.suppressed)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(r.resting)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {count(r.remaining)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          {lists.length > 1 ? (
            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">All lists</TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.leads)}
                </TableCell>
                {/* Recomputed from the summed parts, never averaged across
                    rows — an average would weight a 42-lead list like an
                    84,000-lead one. */}
                <TableCell className="text-right tabular-nums">
                  {pct(
                    totals.leads === 0 ? null : totals.worked / totals.leads,
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(
                    totals.worked === 0 ? null : totals.reached / totals.worked,
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(
                    totals.calls === 0 ? null : totals.voicemail / totals.calls,
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(
                    !anyLineTyped || totals.leads === 0
                      ? null
                      : totals.mobiles / totals.leads,
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.bad_number)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.suppressed)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {count(totals.resting)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {count(totals.remaining)}
                </TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>

      <p className="text-muted-foreground text-xs">
        <strong>Remaining</strong> is what is still workable — has a number, not
        suppressed, not a mobile, not finished. It is deliberately <em>not</em>{" "}
        the dial queue, which is gated on calling hours and reads zero
        overnight. <strong>Voicemail</strong> is a share of calls; every other
        rate here is a share of leads.
        {anyLineTyped ? null : (
          <>
            {" "}
            <strong>Mobiles</strong> shows an em dash because no phone number in
            these lists has had its line type looked up yet — so the
            never-auto-dial-mobiles rule has never had anything to act on.
          </>
        )}
      </p>
    </section>
  );
}
