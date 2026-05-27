"use client";

import { useRef, useState } from "react";

import { type SaveResult } from "../lead-detail-parts";

/** Inline-editable company name. Reads as a big plain h1 by default;
 *  click it (or focus + start typing) to edit. Commits on blur or
 *  Enter; Escape reverts. The hero owns the h1 semantic — no separate
 *  "Company" field in the left-column form sections. */
export function EditableCompanyName({
  initial,
  onSave,
}: {
  initial: string | null;
  onSave: (value: string) => Promise<SaveResult>;
}) {
  const [value, setValue] = useState(initial ?? "");
  const saved = useRef(initial ?? "");
  const ref = useRef<HTMLSpanElement>(null);

  function commit() {
    const next = value.trim();
    if (next === saved.current) return;
    onSave(next).then((result) => {
      if (result.error) {
        setValue(saved.current);
        if (ref.current) ref.current.textContent = saved.current || "Lead";
      } else {
        saved.current = next;
      }
    });
  }

  return (
    <h1
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-testid="editable-company-name"
      onInput={(e) => setValue((e.target as HTMLSpanElement).innerText)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLSpanElement).blur();
        }
        if (e.key === "Escape") {
          if (ref.current) ref.current.textContent = saved.current;
          setValue(saved.current);
          (e.target as HTMLSpanElement).blur();
        }
      }}
      className="text-foreground hover:bg-muted/40 focus:bg-muted/20 focus:ring-ring/30 -mx-2 max-w-full rounded-md px-2 py-0.5 text-3xl font-semibold tracking-tight transition-colors outline-none focus:ring-2"
    >
      {initial || "Lead"}
    </h1>
  );
}
