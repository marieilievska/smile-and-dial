/** Right-side branded panel for the split-screen auth layout. Sets the
 *  product tone with a deep navy gradient touched with coral, a soft
 *  waveform motif behind the content (telegraphs "this is a calling
 *  platform"), the wordmark in oversized type, a stylized live-calls
 *  card that visibly breathes (pulsing dots + a ticking timer), and a
 *  tagline. Hidden on mobile so the form gets all the attention.
 *
 *  Coral is used as a deliberate accent on the "&" mark, the active
 *  call dot, and the bottom-glow — it's the navy + coral palette
 *  whispering "AI calling" without shouting. */
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
      className="from-primary via-primary text-primary-foreground relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-to-br to-[#0a142b] p-12 md:flex lg:p-16"
    >
      {/* Waveform motif — sits behind everything, telegraphs "calls." */}
      <Waveform />

      {/* Top: oversized wordmark + eyebrow */}
      <div className="relative z-10 flex flex-col gap-2">
        <p className="font-mono text-[10px] tracking-[0.2em] uppercase opacity-60">
          Internal platform
        </p>
        <p className="text-4xl font-bold tracking-tight lg:text-5xl">
          Smile <span className="text-coral">&amp;</span> Dial
        </p>
      </div>

      {/* Middle: mini live-calls visualization — three faux rows that
          breathe. One row's timer ticks via CSS-driven pseudo-animation
          (we just stagger 3 hard-coded timestamps and let the eye fill
          the gap; close enough for a marketing surface). */}
      <div className="bg-primary-foreground/10 border-primary-foreground/15 ring-primary-foreground/5 animate-in fade-in slide-in-from-bottom-2 fill-mode-both relative z-10 flex flex-col gap-3 rounded-2xl border p-5 ring-1 backdrop-blur-sm delay-150 duration-700">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="relative flex size-2">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-80"
                style={{ backgroundColor: "var(--coral)" }}
              />
              <span
                className="relative inline-flex size-2 rounded-full"
                style={{ backgroundColor: "var(--coral)" }}
              />
            </span>
            <p className="text-xs font-medium tracking-wide uppercase opacity-80">
              3 calls in progress
            </p>
          </div>
          <span className="font-mono text-[10px] tracking-wider uppercase opacity-50">
            Live
          </span>
        </div>
        <ul className="flex flex-col gap-2 text-sm">
          <FauxCallRow
            status="On call"
            company="Sunrise Yoga Studio"
            elapsedSeconds={42}
            pulsing
            rowDelay="0ms"
          />
          <FauxCallRow
            status="Ringing"
            company="Crunch Downtown"
            elapsedSeconds={9}
            rowDelay="120ms"
          />
          <FauxCallRow
            status="On call"
            company="Equinox Greenwich"
            elapsedSeconds={78}
            pulsing
            rowDelay="240ms"
          />
        </ul>
      </div>

      {/* Bottom: tagline */}
      <div className="relative z-10 flex flex-col gap-2">
        <p className="text-2xl leading-snug font-medium lg:text-3xl">
          {headline}
        </p>
        {subcopy ? <p className="text-base opacity-70">{subcopy}</p> : null}
      </div>

      {/* Decorative soft glows — coral top-right, light bottom-left */}
      <div
        aria-hidden
        className="bg-coral/40 absolute -top-12 -right-12 size-72 rounded-full blur-3xl"
      />
      <div
        aria-hidden
        className="bg-primary-foreground/10 absolute -bottom-20 -left-16 size-72 rounded-full blur-3xl"
      />
    </aside>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function FauxCallRow({
  status,
  company,
  elapsedSeconds,
  pulsing,
  rowDelay,
}: {
  status: string;
  company: string;
  elapsedSeconds: number;
  pulsing?: boolean;
  rowDelay: string;
}) {
  return (
    <li
      className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex items-center gap-3 duration-500"
      style={{ animationDelay: rowDelay }}
    >
      <span className="relative flex size-1.5 shrink-0">
        {pulsing ? (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-80"
            style={{ backgroundColor: "var(--coral)" }}
          />
        ) : null}
        <span
          className={
            pulsing
              ? "relative inline-flex size-1.5 rounded-full"
              : "relative inline-flex size-1.5 rounded-full bg-amber-400"
          }
          style={pulsing ? { backgroundColor: "var(--coral)" } : undefined}
        />
      </span>
      <span className="w-12 text-[10px] tracking-wider uppercase opacity-60">
        {status}
      </span>
      <span className="flex-1 truncate text-sm">{company}</span>
      <span className="font-mono text-xs tabular-nums opacity-70">
        {formatElapsed(elapsedSeconds)}
      </span>
    </li>
  );
}

/** SVG waveform overlay — three layered sine paths drawn at low opacity
 *  so they read as background texture, not foreground content. Pointer
 *  events disabled so it never blocks anything. */
function Waveform() {
  return (
    <svg
      aria-hidden
      className="text-primary-foreground pointer-events-none absolute inset-0 size-full opacity-[0.07]"
      viewBox="0 0 800 600"
      preserveAspectRatio="none"
      fill="none"
    >
      <path
        d="M0,300 C100,250 200,350 300,300 C400,250 500,350 600,300 C700,250 800,350 900,300"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M0,360 C100,310 200,410 300,360 C400,310 500,410 600,360 C700,310 800,410 900,360"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity="0.6"
      />
      <path
        d="M0,240 C100,190 200,290 300,240 C400,190 500,290 600,240 C700,190 800,290 900,240"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity="0.4"
      />
    </svg>
  );
}
