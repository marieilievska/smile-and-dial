import { SlidersHorizontal } from "lucide-react";
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
import { type CustomFieldType } from "@/lib/custom-fields/actions";
import { createClient } from "@/lib/supabase/server";

import { CustomFieldDialog } from "./custom-field-dialog";
import { CustomFieldRowActions } from "./custom-field-row-actions";

const TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes / No",
  select: "Dropdown",
};

export default async function CustomFieldsPage() {
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

  const { data } = await supabase
    .from("custom_field_defs")
    .select("id, name, slug, type, required, options, sort_order")
    .order("sort_order", { ascending: true });

  const fields = (data ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    slug: f.slug,
    type: f.type as CustomFieldType,
    required: f.required,
    options: Array.isArray(f.options)
      ? f.options.filter((o): o is string => typeof o === "string")
      : [],
  }));

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Custom fields
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Extra fields added to every lead in the workspace.
          </p>
        </div>
        <CustomFieldDialog mode="create" />
      </div>

      {fields.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Field key</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Required</TableHead>
                <TableHead className="w-48" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <TableRow key={field.id} className="group">
                  <TableCell className="font-medium">{field.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {field.slug}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {TYPE_LABELS[field.type]}
                  </TableCell>
                  <TableCell>
                    {field.required ? (
                      <Badge variant="warning">Required</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        Optional
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <CustomFieldRowActions
                        field={field}
                        isFirst={index === 0}
                        isLast={index === fields.length - 1}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <SlidersHorizontal className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No custom fields yet
          </p>
          <p className="text-muted-foreground text-sm">
            Add fields to capture extra information on every lead.
          </p>
        </div>
      )}
    </div>
  );
}
