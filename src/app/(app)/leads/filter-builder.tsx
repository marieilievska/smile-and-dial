"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BASE_FIELDS,
  customFieldKind,
  isGroup,
  OPERATOR_LABELS,
  OPERATORS_BY_KIND,
  type Condition,
  type FieldDef,
  type Group,
  type RecipeNode,
} from "@/lib/smart-lists/recipe";

import { SaveSmartListButton } from "./save-smart-list-button";

export type CustomFieldOption = {
  slug: string;
  name: string;
  type: string;
  options: string[];
};

export function FilterBuilder({
  initialRecipe,
  statusOptions,
  ownerOptions,
  customFields,
}: {
  initialRecipe: Group;
  statusOptions: { value: string; label: string }[];
  ownerOptions: { value: string; label: string }[];
  customFields: CustomFieldOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [recipe, setRecipe] = useState<Group>(initialRecipe);

  const fields = useMemo<FieldDef[]>(() => {
    const base = BASE_FIELDS.map((f) =>
      f.key === "status"
        ? { ...f, options: statusOptions }
        : f.key === "owner_id"
          ? { ...f, options: ownerOptions }
          : f,
    );
    const custom = customFields.map<FieldDef>((c) => ({
      key: `custom:${c.slug}`,
      label: c.name,
      kind: customFieldKind(c.type),
      options:
        c.type === "select"
          ? c.options.map((o) => ({ value: o, label: o }))
          : undefined,
    }));
    return [...base, ...custom];
  }, [statusOptions, ownerOptions, customFields]);

  const fieldByKey = useMemo(
    () => new Map(fields.map((f) => [f.key, f])),
    [fields],
  );

  function apply(next: Group) {
    setRecipe(next);
    const sp = new URLSearchParams(searchParams.toString());
    if (next.children.length === 0) sp.delete("recipe");
    else sp.set("recipe", JSON.stringify(next));
    sp.delete("page");
    router.push(`/leads?${sp.toString()}`);
  }

  const active = recipe.children.length > 0;

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Advanced filter</span>
        <div className="flex items-center gap-2">
          {active ? (
            <SaveSmartListButton recipeJson={JSON.stringify(recipe)} />
          ) : null}
          {active ? (
            <button
              type="button"
              onClick={() => apply({ combinator: "and", children: [] })}
              className="text-muted-foreground hover:text-destructive text-xs"
            >
              Clear all
            </button>
          ) : null}
        </div>
      </div>
      <GroupEditor
        group={recipe}
        fields={fields}
        fieldByKey={fieldByKey}
        onChange={apply}
        depth={0}
      />
    </div>
  );
}

function GroupEditor({
  group,
  fields,
  fieldByKey,
  onChange,
  depth,
}: {
  group: Group;
  fields: FieldDef[];
  fieldByKey: Map<string, FieldDef>;
  onChange: (g: Group) => void;
  depth: number;
}) {
  function setChild(i: number, node: RecipeNode) {
    const children = group.children.slice();
    children[i] = node;
    onChange({ ...group, children });
  }
  function removeChild(i: number) {
    onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  }
  function addCondition() {
    const first = fields[0];
    onChange({
      ...group,
      children: [
        ...group.children,
        {
          field: first.key,
          operator: OPERATORS_BY_KIND[first.kind][0],
          value: "",
        },
      ],
    });
  }
  function addGroup() {
    onChange({
      ...group,
      children: [...group.children, { combinator: "and", children: [] }],
    });
  }

  return (
    <div className={depth > 0 ? "border-border ml-2 border-l pl-3" : ""}>
      <div className="bg-muted/40 mb-2 inline-flex rounded-md p-0.5 text-xs">
        {(["and", "or"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange({ ...group, combinator: c })}
            className={
              "rounded px-2 py-0.5 font-medium " +
              (group.combinator === c
                ? "bg-background shadow-sm"
                : "text-muted-foreground")
            }
          >
            {c === "and" ? "Match ALL" : "Match ANY"}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {group.children.map((child, i) =>
          isGroup(child) ? (
            <div key={i} className="flex items-start gap-2">
              <GroupEditor
                group={child}
                fields={fields}
                fieldByKey={fieldByKey}
                onChange={(g) => setChild(i, g)}
                depth={depth + 1}
              />
              <RemoveBtn onClick={() => removeChild(i)} />
            </div>
          ) : (
            <ConditionRow
              key={i}
              condition={child}
              fields={fields}
              fieldByKey={fieldByKey}
              onChange={(c) => setChild(i, c)}
              onRemove={() => removeChild(i)}
            />
          ),
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addCondition}
        >
          <Plus className="size-4" /> Add condition
        </Button>
        {depth < 3 ? (
          <Button type="button" size="sm" variant="ghost" onClick={addGroup}>
            <Plus className="size-4" /> Add group
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label="Remove"
      className="text-muted-foreground hover:text-destructive size-8 shrink-0"
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

function ConditionRow({
  condition,
  fields,
  fieldByKey,
  onChange,
  onRemove,
}: {
  condition: Condition;
  fields: FieldDef[];
  fieldByKey: Map<string, FieldDef>;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const field = fieldByKey.get(condition.field) ?? fields[0];
  const ops = OPERATORS_BY_KIND[field.kind];
  const noValue =
    condition.operator === "is_empty" ||
    condition.operator === "has_value" ||
    condition.operator === "is_true" ||
    condition.operator === "is_false";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={condition.field}
        onValueChange={(f) => {
          const nf = fieldByKey.get(f);
          const kind = nf ? nf.kind : "text";
          onChange({
            field: f,
            operator: OPERATORS_BY_KIND[kind][0],
            value: "",
          });
        }}
      >
        <SelectTrigger className="h-8 w-[12rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={condition.operator}
        onValueChange={(op) =>
          onChange({ ...condition, operator: op as Condition["operator"] })
        }
      >
        <SelectTrigger className="h-8 w-[11rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!noValue ? (
        <ValueInput field={field} condition={condition} onChange={onChange} />
      ) : null}

      <RemoveBtn onClick={onRemove} />
    </div>
  );
}

function ValueInput({
  field,
  condition,
  onChange,
}: {
  field: FieldDef;
  condition: Condition;
  onChange: (c: Condition) => void;
}) {
  const isMulti =
    condition.operator === "is_any_of" || condition.operator === "is_none_of";
  const between = condition.operator === "between";

  if (field.kind === "enum" && field.options) {
    if (isMulti) {
      const selected = new Set(
        Array.isArray(condition.value) ? condition.value : [],
      );
      return (
        <div className="flex flex-wrap gap-1">
          {field.options.map((o) => {
            const on = selected.has(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  const next = new Set(selected);
                  if (on) next.delete(o.value);
                  else next.add(o.value);
                  onChange({ ...condition, value: [...next] });
                }}
                className={
                  "rounded-full border px-2 py-0.5 text-xs " +
                  (on
                    ? "text-foreground border-[color:var(--primary)]"
                    : "border-border text-muted-foreground")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <Select
        value={typeof condition.value === "string" ? condition.value : ""}
        onValueChange={(v) => onChange({ ...condition, value: v })}
      >
        <SelectTrigger className="h-8 w-[12rem]">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const inputType =
    field.kind === "number"
      ? "number"
      : field.kind === "date" && condition.operator !== "in_last_days"
        ? "date"
        : "text";

  if (between) {
    const arr = Array.isArray(condition.value) ? condition.value : ["", ""];
    return (
      <div className="flex items-center gap-1">
        <Input
          type={inputType}
          value={arr[0] ?? ""}
          className="h-8 w-[8rem]"
          onChange={(e) =>
            onChange({ ...condition, value: [e.target.value, arr[1] ?? ""] })
          }
        />
        <span className="text-muted-foreground text-xs">and</span>
        <Input
          type={inputType}
          value={arr[1] ?? ""}
          className="h-8 w-[8rem]"
          onChange={(e) =>
            onChange({ ...condition, value: [arr[0] ?? "", e.target.value] })
          }
        />
      </div>
    );
  }

  return (
    <Input
      type={inputType}
      value={typeof condition.value === "string" ? condition.value : ""}
      placeholder={
        field.kind === "date" && condition.operator === "in_last_days"
          ? "days"
          : ""
      }
      className="h-8 w-[12rem]"
      onChange={(e) => onChange({ ...condition, value: e.target.value })}
    />
  );
}
