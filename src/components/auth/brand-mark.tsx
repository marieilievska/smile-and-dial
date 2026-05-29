/** Smile & Dial logo mark — a small symmetric soundwave glyph that
 *  reads as "voice / dialer." Uses `currentColor` so callers tint it
 *  (usually `text-primary`). Decorative: aria-hidden, the wordmark
 *  beside it carries the accessible name. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <rect x="2.5" y="8.5" width="2.5" height="7" rx="1.25" />
      <rect x="7" y="5.5" width="2.5" height="13" rx="1.25" />
      <rect x="11.5" y="2.5" width="2.5" height="19" rx="1.25" />
      <rect x="16" y="5.5" width="2.5" height="13" rx="1.25" />
      <rect x="20.5" y="8.5" width="2.5" height="7" rx="1.25" />
    </svg>
  );
}
