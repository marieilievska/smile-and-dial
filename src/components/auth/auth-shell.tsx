import Link from "next/link";

import { AuthBrandPanel } from "./auth-brand-panel";
import { BrandMark } from "./brand-mark";

/** Barely-there radial warmth behind the form column so the flat
 *  canvas reads as composed depth rather than empty gray. */
const FORM_COLUMN_TINT =
  "radial-gradient(70% 60% at 0% 0%, color-mix(in oklab, var(--primary) 5%, transparent), transparent 60%)";

/** Two-column layout for /login, /auth/set-password, /auth/forgot-password.
 *  Form on the left, branded gradient panel on the right with a calm
 *  live-calls visual that telegraphs "this is an AI calling platform."
 *
 *  Under md the brand panel hides and the form gets the full screen —
 *  but a compact wordmark + one-line tagline sits above the form so the
 *  brand still lands on mobile. */
export function AuthShell({
  panelHeadline,
  panelSubcopy,
  footer,
  mobileTagline = "Internal AI calling platform for Referrizer's SDR team.",
  children,
}: {
  /** Tagline shown on the brand panel under the wordmark. */
  panelHeadline: string;
  panelSubcopy?: string;
  /** Optional per-page footer node. Defaults to the standard help line. */
  footer?: React.ReactNode;
  /** Optional tagline shown only on mobile, under the wordmark. */
  mobileTagline?: string;
  /** The form (or whatever interactive content the page hosts). */
  children: React.ReactNode;
}) {
  return (
    <main className="bg-background flex min-h-screen w-full">
      {/* FORM COLUMN */}
      <div
        className="relative flex w-full flex-col justify-between p-8 md:w-1/2 md:p-12 lg:p-16"
        style={{ backgroundImage: FORM_COLUMN_TINT }}
      >
        {/* Header — logo mark + wordmark on every viewport, mobile gets a
            tagline too. The wordmark is the document's h1 (the brand
            panel is aria-hidden so it doesn't reach the a11y tree). */}
        <div className="animate-in fade-in slide-in-from-top-1 flex flex-col gap-1.5 duration-500">
          <div className="flex items-center gap-2">
            <BrandMark className="text-primary size-5" />
            <h1 className="text-foreground text-base font-bold tracking-tight">
              Smile <span className="text-primary">&amp;</span> Dial
            </h1>
          </div>
          {mobileTagline ? (
            <p className="text-muted-foreground text-xs md:hidden">
              {mobileTagline}
            </p>
          ) : null}
        </div>

        <div className="mx-auto flex w-full max-w-md flex-col py-12">
          {children}
        </div>

        <div className="text-muted-foreground text-xs">
          {footer ?? <DefaultFooter />}
        </div>
      </div>

      {/* BRAND COLUMN — hidden on mobile */}
      <AuthBrandPanel headline={panelHeadline} subcopy={panelSubcopy} />
    </main>
  );
}

function DefaultFooter() {
  return (
    <p>
      Internal platform · Need help?{" "}
      <Link
        href="mailto:marketing@referrizer.com"
        className="text-foreground underline-offset-2 hover:underline"
      >
        marketing@referrizer.com
      </Link>
    </p>
  );
}

/** Single-column variant used by /auth/auth-error. Centered, calmer
 *  background, no split-screen. */
export function AuthSingleColumn({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-background flex min-h-screen w-full flex-col">
      <div className="flex items-center gap-2 p-8 md:p-12">
        <BrandMark className="text-primary size-5" />
        <h1 className="text-foreground text-base font-bold tracking-tight">
          Smile <span className="text-primary">&amp;</span> Dial
        </h1>
      </div>
      <div className="flex flex-1 items-center justify-center px-8 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </main>
  );
}
