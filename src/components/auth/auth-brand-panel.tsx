/** Right-side branded panel for the split-screen auth layout. Sets the
 *  product tone with a soft navy gradient, the wordmark in larger
 *  type, a stylized "live calls" element with one pulsing dot (the
 *  same heartbeat used on the Today page), and a tagline. The mini
 *  call list is decorative — these are made-up names that read as a
 *  plausible workspace. Hidden on mobile so the form gets all the
 *  attention. */
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
      className="from-primary via-primary to-primary/80 text-primary-foreground relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-to-br p-12 md:flex lg:p-16"
    >
      {/* Top: oversized wordmark */}
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[10px] tracking-[0.2em] uppercase opacity-60">
          Internal platform
        </p>
        <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
          Smile <span className="text-coral">&amp;</span> Dial
        </h1>
      </div>

      {/* Middle: mini live-calls visualization — three faux rows with one
          live status dot to telegraph the AI-calling product. */}
      <div className="bg-primary-foreground/10 border-primary-foreground/15 ring-primary-foreground/5 flex flex-col gap-3 rounded-2xl border p-5 ring-1 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
          <p className="text-xs font-medium tracking-wide uppercase opacity-80">
            3 calls in progress
          </p>
        </div>
        <ul className="flex flex-col gap-2 text-sm">
          <FauxCallRow
            status="On call"
            company="Sunrise Yoga Studio"
            elapsed="0:42"
            pulsing
          />
          <FauxCallRow
            status="Ringing"
            company="Crunch Downtown"
            elapsed="0:09"
          />
          <FauxCallRow
            status="On call"
            company="Equinox Greenwich"
            elapsed="1:18"
            pulsing
          />
        </ul>
      </div>

      {/* Bottom: tagline */}
      <div className="flex flex-col gap-2">
        <p className="text-2xl leading-snug font-medium lg:text-3xl">
          {headline}
        </p>
        {subcopy ? <p className="text-base opacity-70">{subcopy}</p> : null}
      </div>

      {/* Decorative soft glow behind the card */}
      <div
        aria-hidden
        className="bg-coral/30 absolute -top-12 -right-12 size-64 rounded-full blur-3xl"
      />
      <div
        aria-hidden
        className="bg-primary-foreground/10 absolute -bottom-16 -left-16 size-72 rounded-full blur-3xl"
      />
    </aside>
  );
}

function FauxCallRow({
  status,
  company,
  elapsed,
  pulsing,
}: {
  status: string;
  company: string;
  elapsed: string;
  pulsing?: boolean;
}) {
  return (
    <li className="flex items-center gap-3">
      <span className="relative flex size-1.5 shrink-0">
        {pulsing ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
        ) : null}
        <span
          className={
            pulsing
              ? "relative inline-flex size-1.5 rounded-full bg-emerald-400"
              : "relative inline-flex size-1.5 rounded-full bg-amber-400"
          }
        />
      </span>
      <span className="w-12 text-[10px] tracking-wider uppercase opacity-60">
        {status}
      </span>
      <span className="flex-1 truncate text-sm">{company}</span>
      <span className="font-mono text-xs tabular-nums opacity-70">
        {elapsed}
      </span>
    </li>
  );
}
