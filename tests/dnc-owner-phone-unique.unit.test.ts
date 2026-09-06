import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards for 20260905241000: dnc_entries goes from `unique (phone)` to
 * `unique (owner_id, phone)` so two users can each list the same number.
 *
 * The constraint could only move once EVERY writer conflicted on
 * (owner_id, phone): Postgres refuses `ON CONFLICT (phone)` the moment no
 * unique index on exactly (phone) exists, and the post-call webhook never
 * checked that error — AI-detected DNC numbers would have silently stopped
 * being written. So this pins both halves: the migration's shape, and that
 * no `onConflict: "phone"` survives anywhere in src.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION =
  "supabase/migrations/20260905241000_dnc_unique_owner_phone.sql";

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Drop `-- ...` comments so prose about the old behaviour never matches. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("20260905241000 — dnc_entries unique per (owner_id, phone)", () => {
  const sql = stripComments(read(MIGRATION));

  it("drops the unique-on-phone constraint (by name and by shape)", () => {
    // The DO block finds any unique constraint whose only column is phone …
    expect(sql).toMatch(/con\.contype = 'u'/);
    expect(sql).toMatch(/attname = 'phone'/);
    expect(sql).toMatch(/drop constraint %I/);
  });

  it("adds unique (owner_id, phone)", () => {
    expect(sql).toMatch(
      /add constraint dnc_entries_owner_phone_key unique \(owner_id, phone\)/,
    );
  });

  it("keeps a plain index on phone for the dial-time lookups", () => {
    expect(sql).toMatch(
      /create index if not exists dnc_entries_phone_idx\s+on public\.dnc_entries \(phone\)/,
    );
  });

  it("does not touch dial-time enforcement (dial_queue / pre_call_check / is_phone_on_dnc)", () => {
    expect(sql).not.toMatch(/dial_queue|pre_call_check|is_phone_on_dnc/);
  });
});

describe("every dnc_entries writer conflicts on (owner_id, phone)", () => {
  const files = walk(join(ROOT, "src"));

  it('no dnc_entries write still conflicts on "phone" alone', () => {
    // Scoped to dnc_entries statements: other tables (phone_line_types, the
    // Twilio-lookup cache) legitimately key on `phone` by itself, and `[^;]*`
    // keeps the match inside a single statement.
    const offenders = files.filter((f) =>
      /from\("dnc_entries"\)[^;]*onConflict:\s*["']phone["']/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the known writers upsert on owner_id,phone and stamp owner_id", () => {
    const writers = [
      "src/lib/elevenlabs/post-call-webhook.ts",
      "src/lib/elevenlabs/tool-webhook.ts",
      "src/app/api/close/webhook/route.ts",
      "src/lib/dnc/actions.ts",
      "src/lib/dnc/import-actions.ts",
      "src/lib/leads/inline-actions.ts",
    ];
    for (const rel of writers) {
      const src = read(rel);
      expect(src, rel).toMatch(/onConflict:\s*"owner_id,phone"/);
      expect(src, rel).toMatch(/owner_id:/);
    }
  });

  it("dial-time / send-time DNC reads never use maybeSingle() on phone (two owners can hold one number)", () => {
    for (const rel of [
      "src/lib/elevenlabs/tool-webhook.ts",
      "src/lib/leads/recompute-call-state.ts",
    ]) {
      const src = read(rel);
      // `[^;]*?` keeps each match inside one statement — across statements it
      // would run from the dnc_entries upsert into the next unrelated
      // maybeSingle() in the file and fail on code that is fine.
      const reads = src.match(
        /from\("dnc_entries"\)[^;]*?\.(maybeSingle|limit)\(/g,
      );
      expect(reads, rel).not.toBeNull();
      for (const r of reads ?? []) {
        expect(r, rel).not.toMatch(/maybeSingle\(/);
      }
    }
  });
});
