"use client";

/** A live strength indicator shaped like a tiny waveform — ties the password
 *  step into the product's voice-AI motif. As the password gets stronger, more
 *  of the wave "lights up" in the strength color. Heuristic-only (length tiers
 *  + character-class variety); it reassures, it doesn't reject.
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

  const BARS = 16;
  const lit = value.length === 0 ? 0 : Math.round((score / 4) * BARS);
  // A gentle wave shape so the resting bars already look like audio.
  const heights = Array.from({ length: BARS }, (_, i) =>
    Math.round((0.4 + 0.6 * Math.abs(Math.sin(i * 0.6))) * 100),
  );

  return (
    <div
      data-testid="password-strength"
      className="flex flex-col gap-1.5"
      aria-live="polite"
    >
      <div className="flex h-5 items-center gap-[3px]">
        {heights.map((h, i) => (
          <span
            key={i}
            className={`flex-1 rounded-full transition-colors duration-300 ${
              i < lit ? colorClass : "bg-white/12"
            }`}
            style={{ height: `${h}%`, minWidth: "2px" }}
          />
        ))}
      </div>
      <p className="text-xs text-white/55">
        {value.length === 0 ? (
          <>Pick a password — anything from 8 characters works.</>
        ) : (
          <>
            Strength: <span className="font-medium text-white">{label}</span>
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
