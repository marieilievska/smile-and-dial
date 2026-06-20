/** A theme-aware "live voice" waveform for the Today hero. When `active`
 *  (autopilot running or calls in flight) the bars undulate organically — each
 *  on its own duration + delay, derived deterministically from its index so
 *  SSR/CSR match. When idle they settle to a calm flat line. Decorative; reuses
 *  the global `auth-wave` keyframe and respects prefers-reduced-motion. */
export function LiveWaveform({
  active = true,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  const bars = Array.from({ length: 28 }, (_, i) => {
    const base = 0.3 + 0.6 * Math.abs(Math.sin(i * 0.6));
    const jitter = 0.1 * Math.sin(i * 1.8 + 1);
    const height = Math.min(1, Math.max(0.18, base + jitter));
    const duration = 1.7 + (i % 6) * 0.24;
    const delay = (i % 9) * 0.12;
    return { height, duration, delay };
  });

  return (
    <div
      className={"flex h-10 items-center gap-[3px] " + (className ?? "")}
      aria-hidden
    >
      {bars.map((b, i) => (
        <span
          key={i}
          className="flex-1 rounded-full"
          style={{
            minWidth: "2px",
            height: active ? `${Math.round(b.height * 100)}%` : "22%",
            transformOrigin: "center",
            opacity: active ? 0.5 + b.height * 0.5 : 0.3,
            background:
              "linear-gradient(to top, var(--primary), color-mix(in oklab, var(--primary) 55%, var(--background)))",
            animation: active
              ? `auth-wave ${b.duration}s ease-in-out infinite`
              : undefined,
            animationDelay: `${b.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
