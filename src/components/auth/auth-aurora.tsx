/** Full-bleed ambient backdrop for the auth command-center canvas.
 *  Pure decoration (aria-hidden): two slow-drifting aurora blooms in the
 *  brand blue, a faint masked dot grid, fine grain, and an edge vignette
 *  that focuses attention toward the center. The drift settles flat under
 *  the global prefers-reduced-motion rule. */
export function AuthAurora() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      {/* Base wash so the canvas isn't pure black. */}
      <div className="absolute inset-0 bg-[#080b14]" />

      {/* Aurora bloom — primary blue, top-left, drifting. */}
      <div
        className="absolute -top-[20%] -left-[10%] h-[80%] w-[70%] rounded-full blur-[120px]"
        style={{
          background:
            "radial-gradient(circle at center, color-mix(in oklab, var(--primary) 60%, transparent), transparent 70%)",
          opacity: 0.5,
          animation: "auth-aurora 18s ease-in-out infinite",
        }}
      />
      {/* Aurora bloom — cooler indigo/violet, bottom-right, counter-drifting. */}
      <div
        className="absolute -right-[15%] -bottom-[25%] h-[85%] w-[75%] rounded-full blur-[130px]"
        style={{
          background:
            "radial-gradient(circle at center, color-mix(in oklab, #7c5cff 55%, transparent), transparent 70%)",
          opacity: 0.4,
          animation: "auth-aurora-alt 22s ease-in-out infinite",
        }}
      />
      {/* A small teal accent so the palette reads 2026, not corporate-mono. */}
      <div
        className="absolute top-[35%] left-[45%] h-[40%] w-[40%] rounded-full blur-[120px]"
        style={{
          background:
            "radial-gradient(circle at center, color-mix(in oklab, #2dd4bf 40%, transparent), transparent 70%)",
          opacity: 0.18,
          animation: "auth-aurora 26s ease-in-out infinite",
        }}
      />

      {/* Faint dot grid, masked toward the edges. */}
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          maskImage:
            "radial-gradient(70% 70% at 50% 45%, black, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(70% 70% at 50% 45%, black, transparent 100%)",
        }}
      />

      {/* Fine grain for texture (SVG turbulence, very low opacity). */}
      <div
        className="absolute inset-0 opacity-[0.04] mix-blend-soft-light"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />

      {/* Edge vignette for depth/focus. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </div>
  );
}
