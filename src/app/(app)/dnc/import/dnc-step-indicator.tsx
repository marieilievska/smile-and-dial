"use client";

import { Check } from "lucide-react";

const STEPS = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Map columns" },
  { key: "done", label: "Done" },
] as const;

export type DncStepKey = (typeof STEPS)[number]["key"];

/** Horizontal stepper at the top of the DNC import wizard. Same visual
 *  treatment as the leads import indicator so the two flows feel like
 *  the same family — coral-filled circle when done, dark when active,
 *  muted when in the future. */
export function DncStepIndicator({ current }: { current: DncStepKey }) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <ol
      data-testid="dnc-import-step-indicator"
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
