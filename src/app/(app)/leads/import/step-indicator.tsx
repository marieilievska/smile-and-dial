"use client";

import { Check } from "lucide-react";

const STEPS = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Map columns" },
  { key: "summary", label: "Review" },
  { key: "done", label: "Done" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

/** Horizontal stepper shown at the top of the import wizard. Tells the
 *  user how many steps they have ahead before they commit a file. */
export function StepIndicator({ current }: { current: StepKey }) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <ol
      data-testid="import-step-indicator"
      className="flex w-full items-center gap-2 text-xs"
      aria-label="Import progress"
    >
      {STEPS.map((step, i) => {
        const isActive = i === currentIndex;
        const isDone = i < currentIndex;
        const isFuture = i > currentIndex;
        return (
          <li
            key={step.key}
            data-state={isActive ? "active" : isDone ? "done" : "future"}
            className="flex flex-1 items-center gap-2"
          >
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                isActive
                  ? "bg-foreground text-background"
                  : isDone
                    ? "bg-[color:var(--coral)] text-white"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isDone ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span
              className={`truncate text-sm font-medium ${
                isFuture ? "text-muted-foreground" : "text-foreground"
              }`}
            >
              {step.label}
            </span>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden
                className={`hidden h-px flex-1 sm:block ${
                  isDone ? "bg-[color:var(--coral)]" : "bg-border"
                }`}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
