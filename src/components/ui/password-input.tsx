"use client";

import { Eye, EyeOff } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

import { Input } from "./input";

/** A password Input with a show/hide eye toggle on the right side.
 *  Drop-in replacement for <Input type="password" /> — keeps every
 *  attribute the underlying Input accepts. The toggle is purely a
 *  client convenience; the form data still posts the real value.
 *
 *  Polish notes:
 *  - The eye button is tabIndex={-1} so it isn't a tab stop between
 *    fields — keyboard users tab from password input straight to submit.
 *  - The icon swaps via a tiny scale animation so the toggle feels
 *    responsive, not abrupt.
 *  - The button sits on the muted layer at rest and brightens on hover
 *    so it doesn't compete with the input chrome. */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<typeof Input>, "type">
>(function PasswordInput({ className, ...props }, ref) {
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        type={visible ? "text" : "password"}
        className={cn("pr-11", className)}
      />
      <button
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 absolute top-1/2 right-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md transition-all focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="relative flex size-4 items-center justify-center">
          <Eye
            className={cn(
              "absolute size-4 transition-all duration-150",
              visible ? "scale-50 opacity-0" : "scale-100 opacity-100",
            )}
          />
          <EyeOff
            className={cn(
              "absolute size-4 transition-all duration-150",
              visible ? "scale-100 opacity-100" : "scale-50 opacity-0",
            )}
          />
        </span>
      </button>
    </div>
  );
});
