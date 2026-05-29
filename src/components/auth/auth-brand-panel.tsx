import { BrandMark } from "./brand-mark";

/** Right-side brand panel for the split-screen auth layout.
 *
 *  2026 refresh — the Round 26 rewrite stripped this down to a flat
 *  navy rectangle with three text blocks, which read as "2018 B2B
 *  login template." This version keeps the calm, enterprise tone but
 *  gives the empty space *atmosphere* rather than leaving it blank:
 *    - a soft drifting gradient mesh + faint dot grid behind the navy,
 *    - a low-contrast "breathing" waveline that signals voice AI
 *      without faking a live-call widget,
 *    - a logo mark beside the wordmark,
 *    - a quietly pulsing "all systems operational" status chip,
 *    - a 1px gradient seam so the light/dark split feels composed.
 *
 *  All of it is decorative (aria-hidden on the whole aside) and the
 *  global prefers-reduced-motion rule settles the motion flat. */
export function AuthBrandPanel({
  headline,
  subcopy,
}: {
  headline: string;
  subcopy?: string;
}) {
  return (
    <aside
      aria-hidden
      className="bg-sidebar text-sidebar-foreground relative hidden w-1/2 flex-col justify-between overflow-hidden p-12 md:flex lg:p-16"
    >
      {/* Ambient layers — pure decoration, sit behind the content. */}
      <BrandPanelBackdrop />

      {/* Top — logo mark + wordmark + eyebrow. */}
      <div className="relative flex flex-col gap-3">
        <p className="text-sidebar-foreground/60 font-mono text-[10px] tracking-[0.2em] uppercase">
          Internal platform
        </p>
        <div className="flex items-center gap-2.5">
          <BrandMark className="text-sidebar-primary size-6 lg:size-7" />
          <p className="text-sidebar-primary-foreground text-2xl font-semibold tracking-tight lg:text-3xl">
            Smile &amp; Dial
          </p>
        </div>
      </div>

      {/* Middle — tagline + the breathing waveline. */}
      <div className="relative flex flex-col gap-6">
        <AuthWaveline />
        <div className="flex flex-col gap-3">
          <p className="text-sidebar-primary-foreground text-xl leading-snug font-medium lg:text-2xl">
            {headline}
          </p>
          {subcopy ? (
            <p className="text-sidebar-foreground/70 text-sm leading-relaxed">
              {subcopy}
            </p>
          ) : null}
        </div>
      </div>

      {/* Bottom — live status chip + product line. */}
      <div className="relative flex flex-col gap-4">
        <StatusChip />
        <p className="text-sidebar-foreground/50 text-xs tracking-wide">
          A Referrizer SDR product.
        </p>
      </div>
    </aside>
  );
}

/** Layered ambient backdrop: a drifting gradient mesh, a faint dot
 *  grid, and a 1px gradient seam on the left edge that softens the
 *  hard split between the form and brand columns. */
function BrandPanelBackdrop() {
  return (
    <>
      {/* Gradient mesh — two soft primary-blue blooms. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(60% 50% at 85% 15%, color-mix(in oklab, var(--sidebar-primary) 24%, transparent), transparent 70%), radial-gradient(55% 45% at 10% 95%, color-mix(in oklab, var(--sidebar-primary) 16%, transparent), transparent 70%)",
        }}
      />
      {/* Faint dot grid, masked so it fades toward the edges. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          maskImage:
            "radial-gradient(80% 80% at 50% 40%, black, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(80% 80% at 50% 40%, black, transparent 100%)",
        }}
      />
      {/* Seam — a thin vertical gradient on the left edge. */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-px"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, transparent, color-mix(in oklab, var(--sidebar-primary) 50%, transparent), transparent)",
        }}
      />
    </>
  );
}

/** A low-contrast row of bars that slowly undulate — an ambient nod to
 *  voice/audio, not a real visualization. Staggered animation delays
 *  make it read as a travelling wave. */
function AuthWaveline() {
  // Symmetric-ish heights so the resting shape already looks wave-like.
  const bars = [40, 64, 88, 72, 100, 60, 84, 48, 76, 92, 56, 68, 44, 80, 52];
  return (
    <div className="flex h-12 items-center gap-1.5" aria-hidden>
      {bars.map((h, i) => (
        <span
          key={i}
          className="bg-sidebar-primary/30 w-1 flex-1 rounded-full"
          style={{
            height: `${h}%`,
            transformOrigin: "center",
            animation: "auth-wave 3.2s ease-in-out infinite",
            animationDelay: `${(i % 7) * 0.16}s`,
          }}
        />
      ))}
    </div>
  );
}

/** "All systems operational" with a pulsing dot — a small but potent
 *  "this is real software running right now" signal. */
function StatusChip() {
  return (
    <span className="border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground/80 inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs">
      <span className="relative flex size-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
      </span>
      All systems operational
    </span>
  );
}
