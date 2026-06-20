/** The hero waveform on the auth brand panel — an ambient nod to live voice
 *  AI. Each bar undulates on its own duration + delay (derived deterministically
 *  from its index, so SSR and client render identically) which makes it read as
 *  organically *alive* rather than a uniform pulse. A soft glow breathes behind
 *  it. All decorative; the global reduced-motion rule settles it flat. */
export function AuthWaveform({ className }: { className?: string }) {
  const bars = Array.from({ length: 36 }, (_, i) => {
    // A travelling wave shape, modulated so neighbours differ.
    const base = 0.32 + 0.6 * Math.abs(Math.sin(i * 0.55));
    const jitter = 0.12 * Math.sin(i * 1.9 + 1);
    const height = Math.min(1, Math.max(0.18, base + jitter));
    const duration = 1.7 + (i % 6) * 0.26;
    const delay = (i % 9) * 0.13;
    const opacity = 0.5 + height * 0.5;
    return { height, duration, delay, opacity };
  });

  return (
    <div className={"relative " + (className ?? "")} aria-hidden>
      {/* Breathing glow behind the bars. */}
      <div
        className="absolute inset-x-0 top-1/2 h-24 -translate-y-1/2 blur-2xl"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 50%, color-mix(in oklab, var(--primary) 45%, transparent), transparent 75%)",
          animation: "auth-breathe 4s ease-in-out infinite",
        }}
      />
      <div className="relative flex h-24 items-center gap-[5px]">
        {bars.map((b, i) => (
          <span
            key={i}
            className="flex-1 rounded-full"
            style={{
              height: `${Math.round(b.height * 100)}%`,
              minWidth: "3px",
              transformOrigin: "center",
              opacity: b.opacity,
              background:
                "linear-gradient(to top, color-mix(in oklab, var(--primary) 70%, transparent), #93b0ff)",
              animation: `auth-wave ${b.duration}s ease-in-out infinite`,
              animationDelay: `${b.delay}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
