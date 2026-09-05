import { Sparkles } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AiChargeKindTotal } from "@/lib/analytics/costs";
import { aiChargeKindLabel } from "@/lib/costs/ai-charges";
import { formatUsd as usd } from "@/lib/format-usd";

/** AI spend that is not a call's own cost — the `ai_charges` ledger, by kind:
 *  Ask Smile answers, agent drafting, template splitting, script tidy-ups,
 *  the demo's live business research, ElevenLabs test calls. Already folded
 *  into the OpenAI vendor line and the headline total; this table says what
 *  it was. Renders nothing when the range has none. */
export function CostsOtherAi({ items }: { items: AiChargeKindTotal[] }) {
  if (items.length === 0) return null;
  const total = items.reduce((a, b) => a + b.cost, 0);
  const count = items.reduce((a, b) => a + b.count, 0);
  return (
    <section
      className="border-border overflow-hidden rounded-2xl border shadow-sm"
      data-testid="costs-other-ai"
    >
      <div className="border-border/70 flex items-baseline justify-between gap-2 border-b px-5 py-3">
        <h2 className="text-foreground inline-flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="text-primary size-3.5" />
          Other AI usage
        </h2>
        <p className="text-muted-foreground text-xs">
          Included in the OpenAI line and the total above
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>What</TableHead>
            <TableHead className="text-right">Uses</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) => (
            <TableRow key={i.kind}>
              <TableCell className="text-foreground font-medium">
                {aiChargeKindLabel(i.kind)}
              </TableCell>
              <TableCell className="text-muted-foreground text-right tabular-nums">
                {i.count.toLocaleString()}
              </TableCell>
              <TableCell className="text-foreground text-right tabular-nums">
                {usd(i.cost)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Total
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {count.toLocaleString()}
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {usd(total)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </section>
  );
}
