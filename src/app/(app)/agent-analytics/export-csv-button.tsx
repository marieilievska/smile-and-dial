"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Download the given rows as a CSV. Headers + rows are plain strings/values;
 *  everything is quoted and escaped. Shared by every Agent Analytics tab. */
export function ExportCsvButton({
  filename,
  headers,
  rows,
}: {
  filename: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}) {
  function download() {
    const esc = (v: string | number | null | undefined) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv =
      "﻿" +
      [headers, ...rows].map((cells) => cells.map(esc).join(",")).join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={download}
      disabled={rows.length === 0}
    >
      <Download className="size-4" />
      Export CSV
    </Button>
  );
}
