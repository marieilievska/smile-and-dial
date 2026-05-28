"use client";

import { FileSpreadsheet, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/** Custom drag-and-drop CSV picker. Replaces the browser's native
 *  "Choose File / No file chosen" with something that matches the rest
 *  of the UI and supports drag-and-drop.
 *
 *  Click-to-pick is implemented via a real `<label htmlFor="csv-file">`
 *  wrapping the empty-state visual. That way the browser's built-in
 *  label-to-input plumbing opens the file chooser — no JS, no
 *  programmatic `.click()`, and no risk of the event bubbling back
 *  through the wrapper and firing the picker more than once. */
export function FileDropzone({
  fileName,
  rowCount,
  columnCount,
  onFile,
  onClear,
}: {
  fileName: string;
  rowCount: number | null;
  columnCount: number | null;
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

  if (fileName && rowCount !== null && columnCount !== null) {
    return (
      <div
        data-testid="file-dropzone-filled"
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
            {rowCount.toLocaleString()} rows · {columnCount} columns · ready to
            map
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
        {/* Keep the input mounted so onClear can reset it and the
            user can immediately pick a new file via the dropzone again. */}
        <input
          ref={inputRef}
          id="csv-file"
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
        htmlFor="csv-file"
        data-testid="file-dropzone-empty"
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
        className={`focus-within:ring-ring/50 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-8 text-center transition-colors focus-within:ring-2 focus-within:outline-none ${
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
            One row per lead. We&apos;ll verify every phone number with Twilio.
          </p>
        </div>
      </label>
      <input
        ref={inputRef}
        id="csv-file"
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => handleFiles(e.target.files)}
        aria-label="CSV file"
        className="sr-only"
      />
    </>
  );
}
