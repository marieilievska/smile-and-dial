import { BrandMark } from "./brand-mark";
import { AuthWaveform } from "./auth-waveform";

/** Left-side brand panel for the immersive auth canvas — a quiet
 *  "command center for AI calling." It sits transparently over the shared
 *  AuthAurora backdrop: eyebrow, wordmark, the breathing hero waveform,
 *  the page headline, and a non-sensitive status line. Entirely decorative
 *  (aria-hidden) and hidden under md, where the form takes the full screen. */
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
      className="relative z-10 hidden w-1/2 flex-col justify-between p-12 md:flex lg:p-16"
    >
      {/* Top — eyebrow + wordmark. */}
      <div className="flex flex-col gap-3">
        <p className="font-mono text-[10px] tracking-[0.25em] text-white/45 uppercase">
          Internal platform
        </p>
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-6 text-[color:var(--primary)] lg:size-7" />
          <p className="text-2xl font-semibold tracking-tight text-white lg:text-3xl">
            Smile <span className="text-[color:var(--primary)]">&amp;</span>{" "}
            Dial
          </p>
        </div>
      </div>

      {/* Middle — the alive waveform + the page headline. */}
      <div className="flex flex-col gap-8">
        <AuthWaveform />
        <div className="flex flex-col gap-3">
          <p className="max-w-md text-2xl leading-snug font-medium text-white lg:text-[28px]">
            {headline}
          </p>
          {subcopy ? (
            <p className="max-w-md text-sm leading-relaxed text-white/55">
              {subcopy}
            </p>
          ) : null}
        </div>
      </div>

      {/* Bottom — non-sensitive status + product line (no real metrics on a
          logged-out page). */}
      <div className="flex flex-col gap-4">
        <StatusChip />
        <p className="text-xs tracking-wide text-white/40">
          A Referrizer SDR product.
        </p>
      </div>
    </aside>
  );
}

/** "All systems operational" with a pulsing dot — a small "this is real
 *  software running right now" signal. Deliberately carries no business
 *  data (no call/agent counts) since the page is pre-auth. */
function StatusChip() {
  return (
    <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/70 backdrop-blur-sm">
      <span className="relative flex size-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
      </span>
      All systems operational
    </span>
  );
}
