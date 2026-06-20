// The saved "recipe" for an advanced lead filter: a tree of AND/OR groups and
// condition leaves. Shared by the client builder and the server evaluator.

export type Combinator = "and" | "or";

export type ConditionOperator =
  | "is"
  | "is_any_of"
  | "is_not"
  | "is_none_of"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "has_value"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "between"
  | "before"
  | "after"
  | "in_last_days"
  | "is_true"
  | "is_false";

export type Condition = {
  /** Field key from the catalog, or `custom:<slug>` for a custom field. */
  field: string;
  operator: ConditionOperator;
  /** string for single-value ops; string[] for is_any_of/is_none_of/between;
   *  unused for is_empty/has_value/is_true/is_false. */
  value?: string | string[];
};

export type Group = { combinator: Combinator; children: RecipeNode[] };
export type RecipeNode = Group | Condition;

export function isGroup(n: RecipeNode): n is Group {
  return (n as Group).combinator !== undefined;
}

/** Logical value type of a field, which determines its operator set + input. */
export type FieldKind = "enum" | "text" | "number" | "date" | "flag";

export type FieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  /** For enum fields rendered from a fixed set (status/owner injected at runtime). */
  options?: { value: string; label: string }[];
};

export const OPERATORS_BY_KIND: Record<FieldKind, ConditionOperator[]> = {
  enum: ["is_any_of", "is_none_of", "is_empty", "has_value"],
  text: ["contains", "not_contains", "is", "is_empty", "has_value"],
  number: ["eq", "neq", "gt", "lt", "between", "is_empty"],
  date: ["before", "after", "between", "in_last_days", "is_empty"],
  flag: ["is_true", "is_false"],
};

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  is: "is",
  is_any_of: "is any of",
  is_not: "is not",
  is_none_of: "is none of",
  contains: "contains",
  not_contains: "doesn't contain",
  is_empty: "is empty",
  has_value: "has any value",
  eq: "=",
  neq: "≠",
  gt: ">",
  lt: "<",
  between: "between",
  before: "before",
  after: "after",
  in_last_days: "in last N days",
  is_true: "is yes",
  is_false: "is no",
};

/** Built-in (non-custom) fields. Status + owner OPTIONS are injected at runtime
 *  (status values + the owner list come from the page). */
export const BASE_FIELDS: FieldDef[] = [
  { key: "status", label: "Lead status", kind: "enum" },
  { key: "connected", label: "Connected (ever)", kind: "flag" },
  { key: "goal_met", label: "Goal met", kind: "flag" },
  { key: "dm_reached", label: "Decision maker reached", kind: "flag" },
  { key: "attempts", label: "# of attempts", kind: "number" },
  { key: "last_called", label: "Last called", kind: "date" },
  { key: "created_at", label: "Created date", kind: "date" },
  { key: "city", label: "City", kind: "text" },
  { key: "state", label: "State", kind: "text" },
  { key: "timezone", label: "Timezone", kind: "text" },
  { key: "owner_id", label: "Owner", kind: "enum" },
];

/** A custom field becomes a field with key `custom:<slug>`. select→enum,
 *  number→number, date→date, boolean→flag, everything else→text. */
export function customFieldKind(type: string): FieldKind {
  if (type === "select") return "enum";
  if (type === "number") return "number";
  if (type === "date") return "date";
  if (type === "boolean") return "flag";
  return "text";
}

const SLUG_RE = /^[a-z0-9_]+$/;
const VALID_OPS = new Set<string>(Object.keys(OPERATOR_LABELS));

/** Reject malformed recipes (defense in depth — the SQL function also
 *  allow-lists). Returns null if valid, else an error string. Empty groups are
 *  allowed and treated as "match all". Caps depth + node count. */
export function validateRecipe(node: RecipeNode, depth = 0): string | null {
  if (depth > 6) return "Filter is nested too deeply.";
  if (isGroup(node)) {
    if (node.combinator !== "and" && node.combinator !== "or")
      return "Bad group type.";
    if (node.children.length > 50) return "Too many conditions.";
    for (const child of node.children) {
      const err = validateRecipe(child, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (typeof node.field !== "string") return "Condition missing field.";
  if (node.field.startsWith("custom:")) {
    if (!SLUG_RE.test(node.field.slice("custom:".length)))
      return "Bad custom field.";
  } else if (!BASE_FIELDS.some((f) => f.key === node.field)) {
    return `Unknown field: ${node.field}`;
  }
  if (!VALID_OPS.has(node.operator))
    return `Unknown operator: ${node.operator}`;
  return null;
}

/** An empty top-level group = no restriction. */
export const EMPTY_RECIPE: Group = { combinator: "and", children: [] };
