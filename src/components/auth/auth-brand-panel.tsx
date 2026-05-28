/** Right-side brand panel for the split-screen auth layout. Round 26
 *  rewrite — pulled back the marketing styling per the Referrizer
 *  design spec (no waveform, no oversized hero typography, no faux
 *  animated call rows, no coral glow). What's left: solid dark navy
 *  surface, restrained wordmark with an eyebrow, the tagline, and a
 *  single thin support line. Reads as one cohesive Referrizer sibling
 *  product — calm, enterprise-y, not a launch landing page. */
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
      {/* Top — wordmark + eyebrow. Both deliberately calm. */}
      <div className="flex flex-col gap-2">
        <p className="text-sidebar-foreground/60 font-mono text-[10px] tracking-[0.2em] uppercase">
          Internal platform
        </p>
        <p className="text-sidebar-primary-foreground text-2xl font-semibold tracking-tight lg:text-3xl">
          Smile &amp; Dial
        </p>
      </div>

      {/* Middle — a single thin tagline. We dropped the live-calls
       *  visualization here: a fake widget on a login page violates the
       *  Referrizer spec's "no marketing flourish on operational
       *  product chrome" rule. */}
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

      {/* Bottom — a small product line so it doesn't feel orphaned. */}
      <p className="text-sidebar-foreground/50 text-xs tracking-wide">
        A Referrizer SDR product.
      </p>
    </aside>
  );
}
