"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { AlertTriangle, ArrowRight, CheckCheck, Eye } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { markBucketReviewed } from "@/lib/review/actions";
import type { ReviewBucket, ReviewSummary } from "@/lib/review/buckets";

/** Sentinel value for the cross-cutting "needs your eyes" filter on /calls. No
 *  real flag_key uses a hyphen, so it can't collide with one. Kept in sync with
 *  NEEDS_REVIEW_BUCKET in src/lib/review/calls-filter.ts. */
const NEEDS_REVIEW_BUCKET = "needs-review";

const LENS_LABEL: Record<ReviewBucket["lens"], string> = {
  bug: "Bugs & failures",
  compliance: "Compliance",
  quality: "Call quality",
  opportunity: "Missed opportunities",
  voc: "Voice of customer",
};

const LENS_ORDER: ReviewBucket["lens"][] = [
  "bug",
  "compliance",
  "quality",
  "opportunity",
  "voc",
];

export function CallReviewTable({
  summary,
  buckets,
}: {
  summary: ReviewSummary;
  buckets: ReviewBucket[];
}) {
  if (buckets.length === 0) {
    return (
      <div className="border-border/70 bg-muted/10 flex flex-col items-center gap-2 rounded-2xl border border-dashed py-14 text-center">
        <Eye className="text-muted-foreground/70 size-7" />
        <p className="text-foreground text-sm font-medium">
          Nothing to review yet
        </p>
        <p className="text-muted-foreground max-w-sm text-sm">
          As the reviewer analyzes human-reached calls, flagged calls group into
          buckets here.
        </p>
      </div>
    );
  }

  // Group the already-severity-ordered buckets by lens for display.
  const byLens = new Map<ReviewBucket["lens"], ReviewBucket[]>();
  for (const b of buckets) {
    const arr = byLens.get(b.lens) ?? [];
    arr.push(b);
    byLens.set(b.lens, arr);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Summary strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Flagged calls" value={summary.flaggedCalls} />
        <SummaryCard label="Unreviewed" value={summary.unreviewedCalls} />
        <SummaryCard
          label="Needs your eyes"
          value={summary.needsEyesCalls}
          tone="warn"
        />
      </div>

      {/* Pinned "needs your eyes" bucket — the AI-vs-AI disagreements. */}
      {summary.needsEyesCalls > 0 ? (
        <Link
          href={`/calls?review_flag=${NEEDS_REVIEW_BUCKET}`}
          className="flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 transition-colors hover:bg-amber-100"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-amber-600" />
            <div>
              <p className="text-foreground text-sm font-semibold">
                ⚠️ Needs your eyes
              </p>
              <p className="text-muted-foreground text-xs">
                Calls where the two AI passes disagreed — a human should decide.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-foreground text-lg font-bold tabular-nums">
              {summary.needsEyesCalls}
            </span>
            <ArrowRight className="text-muted-foreground size-4" />
          </div>
        </Link>
      ) : null}

      {LENS_ORDER.filter((lens) => byLens.has(lens)).map((lens) => (
        <div key={lens} className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {LENS_LABEL[lens]}
          </h3>
          <div className="border-border overflow-hidden rounded-xl border">
            {byLens.get(lens)!.map((b, i) => (
              <BucketRow key={b.key} bucket={b} topBorder={i > 0} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One bucket row: the label + counts deep-link into the filtered calls list,
 *  and (when anything is still unreviewed) a "Mark all reviewed" button clears
 *  the whole bucket in place without opening the list. */
function BucketRow({
  bucket,
  topBorder,
}: {
  bucket: ReviewBucket;
  topBorder: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const href = `/calls?review_flag=${bucket.key}`;

  function markAll() {
    start(async () => {
      const r = await markBucketReviewed({ flagKey: bucket.key });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(
        `Marked ${r.updated} call${r.updated === 1 ? "" : "s"} reviewed.`,
      );
      router.refresh();
    });
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 px-4 py-3 ${
        topBorder ? "border-border border-t" : ""
      }`}
    >
      <Link
        href={href}
        className="hover:text-primary flex min-w-0 flex-1 items-center gap-2 underline-offset-2 hover:underline"
      >
        <span className="text-foreground truncate text-sm font-medium">
          {bucket.label}
        </span>
        {bucket.needsReview > 0 ? (
          <Badge variant="outline" className="border-amber-300 text-amber-700">
            {bucket.needsReview} needs eyes
          </Badge>
        ) : null}
        {bucket.unreviewed > 0 ? (
          <Badge variant="secondary">{bucket.unreviewed} unreviewed</Badge>
        ) : null}
      </Link>
      <div className="flex shrink-0 items-center gap-2">
        {bucket.unreviewed > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={markAll}
            className="h-8"
            title={`Mark all ${bucket.unreviewed} unreviewed calls in this bucket reviewed`}
          >
            <CheckCheck className="size-3.5" />
            Mark all reviewed
          </Button>
        ) : null}
        <span className="text-foreground text-base font-bold tabular-nums">
          {bucket.total}
        </span>
        <Link href={href} aria-label={`Open ${bucket.label}`}>
          <ArrowRight className="text-muted-foreground hover:text-foreground size-4" />
        </Link>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn";
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        tone === "warn"
          ? "border-amber-300 bg-amber-50"
          : "border-border bg-card"
      }`}
    >
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-0.5 text-2xl font-bold tabular-nums">
        {value.toLocaleString()}
      </p>
    </div>
  );
}
