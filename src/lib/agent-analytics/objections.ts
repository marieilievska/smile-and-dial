import {
  OBJECTION_CATEGORIES,
  type ObjectionCategory,
} from "@/lib/openai/objection-extractor";

export type ObjectionRow = {
  leadId: string;
  company: string;
  category: ObjectionCategory | null;
  specific: string | null;
  quote: string | null;
};

export type ObjectionSample = {
  leadId: string;
  company: string;
  specific: string;
  quote: string;
};

export type ObjectionBreakdown = {
  total: number;
  byCategory: {
    category: ObjectionCategory;
    count: number;
    samples: ObjectionSample[];
  }[];
};

const MAX_SAMPLES = 25;

/** Aggregate per-call objections into per-category counts + quote samples,
 *  most-common category first. Rows without a category are ignored. Pure. */
export function computeObjectionBreakdown(
  rows: ObjectionRow[],
): ObjectionBreakdown {
  const buckets = new Map<
    ObjectionCategory,
    { count: number; samples: ObjectionSample[] }
  >();
  let total = 0;
  for (const r of rows) {
    if (!r.category) continue;
    total += 1;
    const b = buckets.get(r.category) ?? { count: 0, samples: [] };
    b.count += 1;
    if (b.samples.length < MAX_SAMPLES && (r.quote || r.specific)) {
      b.samples.push({
        leadId: r.leadId,
        company: r.company,
        specific: r.specific ?? "",
        quote: r.quote ?? "",
      });
    }
    buckets.set(r.category, b);
  }
  const byCategory = [...buckets.entries()]
    .map(([category, b]) => ({ category, count: b.count, samples: b.samples }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        OBJECTION_CATEGORIES.indexOf(a.category) -
          OBJECTION_CATEGORIES.indexOf(b.category),
    );
  return { total, byCategory };
}
