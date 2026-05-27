"use client";

/** A 4-bar live strength indicator. Drop it under a password input.
 *  Heuristic-only — counts length tiers and character-class variety
 *  (lowercase, uppercase, digit, symbol). Doesn't enforce, just
 *  reassures: most users want to see "strong" not "rejected."
 *
 *  Scoring (max 4):
 *  - length >=  8  → +1
 *  - length >= 12  → +1
 *  - length >= 16  → +1
 *  - 3+ character classes used → +1 */
export function PasswordStrength({ value }: { value: string }) {
  const score = scorePassword(value);
  const label = LABELS[score];
  const colorClass = COLORS[score];

  return (
    <div
      data-testid="password-strength"
      className="flex flex-col gap-1.5"
      aria-live="polite"
    >
      <div className="flex items-center gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < score ? colorClass : "bg-muted"
            }`}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        {value.length === 0 ? (
          <>Pick a password — anything from 8 characters works.</>
        ) : (
          <>
            Strength:{" "}
            <span className="text-foreground font-medium">{label}</span>
          </>
        )}
      </p>
    </div>
  );
}

const LABELS = ["Too short", "Weak", "OK", "Good", "Strong"] as const;
const COLORS = [
  "bg-rose-400",
  "bg-rose-400",
  "bg-amber-400",
  "bg-emerald-400",
  "bg-emerald-500",
] as const;

function scorePassword(value: string): number {
  if (value.length === 0) return 0;
  if (value.length < 8) return 1;
  let score = 1;
  if (value.length >= 12) score++;
  if (value.length >= 16) score++;
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;
  if (classes >= 3 && score < 4) score++;
  return Math.min(4, score);
}
