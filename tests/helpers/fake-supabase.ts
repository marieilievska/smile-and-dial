/**
 * A tiny in-memory stand-in for the Supabase service client, covering the
 * query-builder surface our server modules use: from(table).select/insert/
 * upsert/update + eq/is/or/order/limit + maybeSingle/single/await, and rpc().
 *
 * Rows live in plain arrays per table so tests can seed state and assert on
 * what a module wrote — no mocking of individual chains.
 */
type Row = Record<string, unknown>;
type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "is"; col: string; val: unknown }
  | { kind: "or"; groups: Array<{ col: string; val: unknown }> };

export function makeFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, rows] of Object.entries(seed)) {
    tables[k] = rows.map((r) => ({ ...r }));
  }
  const rpcResults: Record<string, unknown> = {};
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  let nextId = 1;

  const table = (name: string) => (tables[name] ??= []);

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.kind === "eq") return row[f.col] === f.val;
      if (f.kind === "is") return f.val === null && row[f.col] == null;
      return f.groups.some((g) => row[g.col] === g.val);
    });
  }

  function builder(name: string) {
    const filters: Filter[] = [];
    let order: { col: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let op: "select" | "insert" | "upsert" | "update" = "select";
    let payload: Row | null = null;
    let onConflict: string | null = null;
    let result: Promise<Row[]> | null = null;

    const exec = (): Row[] => {
      let rows = table(name).filter((r) => matches(r, filters));
      if (order) {
        const { col, ascending } = order;
        rows = [...rows].sort((a, b) => {
          const x = String(a[col] ?? ""),
            y = String(b[col] ?? "");
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (limit != null) rows = rows.slice(0, limit);
      return rows;
    };

    const run = (): Promise<Row[]> => {
      if (result) return result;
      result = (async () => {
        if (op === "select") return exec();
        if (op === "update") {
          const rows = exec();
          rows.forEach((r) => Object.assign(r, payload));
          return rows;
        }
        const row = payload as Row;
        if (op === "upsert" && onConflict) {
          const existing = table(name).find(
            (r) => r[onConflict as string] === row[onConflict as string],
          );
          if (existing) {
            Object.assign(existing, row);
            return [existing];
          }
        }
        const created = {
          id: `${name}-${nextId++}`,
          created_at: new Date().toISOString(),
          ...row,
        };
        table(name).push(created);
        return [created];
      })();
      return result;
    };

    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return api;
      },
      is: (col: string, val: unknown) => {
        filters.push({ kind: "is", col, val });
        return api;
      },
      or: (expr: string) => {
        const groups = expr.split(",").map((part) => {
          const [col, , ...rest] = part.split(".");
          return { col, val: rest.join(".") };
        });
        filters.push({ kind: "or", groups });
        return api;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        order = { col, ascending: opts?.ascending ?? true };
        return api;
      },
      limit: (n: number) => {
        limit = n;
        return api;
      },
      insert: (row: Row) => {
        op = "insert";
        payload = row;
        return api;
      },
      upsert: (row: Row, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = row;
        onConflict = opts?.onConflict ?? null;
        return api;
      },
      update: (patch: Row) => {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: async () => ({
        data: (await run())[0] ?? null,
        error: null,
      }),
      single: async () => {
        const rows = await run();
        return rows[0]
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "no rows" } };
      },
      then: (
        onOk: (v: { data: Row[]; error: null }) => unknown,
        onErr?: (e: unknown) => unknown,
      ) =>
        run()
          .then((rows) => ({ data: rows, error: null }))
          .then(onOk, onErr),
    };
    return api;
  }

  const client = {
    from: (name: string) => builder(name),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { data: rpcResults[fn] ?? null, error: null };
    },
  };

  return {
    /** Pass this wherever a module expects the Supabase service client.
     *  Typed `never` so it's assignable to the typed client parameter. */
    client: client as never,
    tables,
    rpcCalls,
    setRpc(fn: string, value: unknown) {
      rpcResults[fn] = value;
    },
  };
}
