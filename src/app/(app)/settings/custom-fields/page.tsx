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
  const isAdmin = me?.role === "admin";

  // Everyone sees every field. Who may change one follows the RLS policies
  // (20260905193000): edit / reorder = the creator, or an admin when the
  // field has no creator; delete = the creator or any admin. The controls
  // below mirror that so a teammate never sees a button that would fail.
  const { data } = await supabase
    .from("custom_field_defs")
    .select("id, name, slug, type, required, options, sort_order, created_by")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  const fields = (data ?? []).map((f) => {
    const isMine = f.created_by === user.id;
    const orphan = f.created_by === null;
    return {
      id: f.id,
      name: f.name,
      slug: f.slug,
      type: f.type as CustomFieldType,
      required: f.required,
      options: Array.isArray(f.options)
        ? f.options.filter((o): o is string => typeof o === "string")
        : [],
      isMine,
      canEdit: isMine || (orphan && isAdmin),
      canDelete: isMine || isAdmin,
    };
  });

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Custom fields
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Extra fields added to every lead in the workspace. Anyone can add a
            field; only the person who created one can change it.
          </p>
        </div>
        <CustomFieldDialog mode="create" />
      </div>

      {fields.length > 0 ? (
        <div className="border-border overflow-hidden rounded-2xl border shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Field key</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Required</TableHead>
                <TableHead className="w-56" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <TableRow key={field.id} className="group">
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      {field.name}
                      {field.isMine ? (
                        <Badge variant="secondary">Yours</Badge>
                      ) : null}
                    </span>
                  </TableCell>
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
                    <div className="opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <CustomFieldRowActions
                        field={field}
                        isFirst={index === 0}
                        isLast={index === fields.length - 1}
                        canEdit={field.canEdit}
                        canDelete={field.canDelete}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-2xl border border-dashed py-16 text-center">
          <SlidersHorizontal className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No custom fields yet
          </p>
          <p className="text-muted-foreground text-sm">
            Add fields to capture extra information on every lead.
          </p>
          <div className="mt-2">
            <CustomFieldDialog
              mode="create"
              triggerLabel="Create your first field"
            />
          </div>
        </div>
      )}
    </div>
  );
}
