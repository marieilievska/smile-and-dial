"use client";

import { FileSpreadsheet, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/** Custom drag-and-drop CSV picker for the DNC import wizard. Twin of
 *  the leads import dropzone with DNC-specific copy ("phone numbers"
 *  instead of "leads", no Twilio-lookup mention). Click-to-pick is
 *  driven by a real `<label htmlFor="dnc-csv-file">` wrapping the
 *  empty-state visual so the browser handles the file picker
 *  natively. */
export function DncFileDropzone({
  fileName,
  rowCount,
  onFile,
  onClear,
}: {
  fileName: string;
  rowCount: number | null;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    onFile(file);
  }

  if (fileName && rowCount !== null) {
    return (
      <div
        data-testid="dnc-file-dropzone-filled"
        className="border-border bg-card flex items-center gap-3 rounded-xl border px-4 py-3"
      >
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--primary) 14%, transparent)",
            color: "var(--primary)",
          }}
        >
          <FileSpreadsheet className="size-5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-foreground truncate text-sm font-medium">
            {fileName}
          </p>
          <p className="text-muted-foreground text-xs">
            {rowCount.toLocaleString()} {rowCount === 1 ? "row" : "rows"} ·
            ready to map
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onClear();
            if (inputRef.current) inputRef.current.value = "";
          }}
          aria-label="Use a different file"
        >
          <X className="size-3.5" />
          Use a different file
        </Button>
        <input
          ref={inputRef}
          id="dnc-csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => handleFiles(e.target.files)}
          aria-label="CSV file"
          className="sr-only"
        />
      </div>
    );
  }

  return (
    <>
      <label
        htmlFor="dnc-csv-file"
        data-testid="dnc-file-dropzone-empty"
        data-state={dragOver ? "drag-over" : "idle"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`focus-within:ring-ring/50 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-10 text-center transition-colors focus-within:ring-2 focus-within:outline-none ${
          dragOver
            ? "bg-muted/40"
            : "border-border bg-muted/10 hover:bg-muted/30"
        }`}
        style={
          dragOver
            ? {
                borderColor:
                  "color-mix(in oklab, var(--primary) 50%, transparent)",
              }
            : undefined
        }
      >
        <div
          className="flex size-10 items-center justify-center rounded-full"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--primary) 14%, transparent)",
            color: "var(--primary)",
          }}
        >
          <Upload className="size-5" />
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="text-foreground text-sm font-medium">
            Drop a CSV here, or click to choose one
          </p>
          <p className="text-muted-foreground text-xs">
            One row per phone number. Already-blocked numbers are skipped
            silently.
          </p>
        </div>
      </label>
      <input
        ref={inputRef}
        id="dnc-csv-file"
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => handleFiles(e.target.files)}
        aria-label="CSV file"
        className="sr-only"
      />
    </>
  );
}
