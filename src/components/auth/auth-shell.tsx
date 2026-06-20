import Link from "next/link";

import { AuthAurora } from "./auth-aurora";
import { AuthBrandPanel } from "./auth-brand-panel";
import { BrandMark } from "./brand-mark";

/** Immersive split layout for /login, /auth/set-password, /auth/forgot-password.
 *
 *  The whole surface is a single dark "command center" canvas (the `dark`
 *  class scopes the dark theme + token set to this subtree, independent of the
 *  app's theme): a drifting aurora backdrop, a brand panel on the left with the
 *  live hero waveform, and the form floating in a glass card on the right.
 *
 *  Under md the brand panel hides and the form gets the full screen, with a
 *  compact wordmark + tagline above so the brand still lands on mobile. */
export function AuthShell({
  panelHeadline,
  panelSubcopy,
  footer,
  mobileTagline = "Internal AI calling platform for Referrizer's SDR team.",
  children,
}: {
  panelHeadline: string;
  panelSubcopy?: string;
  footer?: React.ReactNode;
  mobileTagline?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="dark text-foreground relative isolate flex min-h-screen w-full overflow-hidden">
      <AuthAurora />

      {/* BRAND COLUMN — hidden on mobile */}
      <AuthBrandPanel headline={panelHeadline} subcopy={panelSubcopy} />

      {/* FORM COLUMN */}
      <div className="relative z-10 flex w-full flex-col justify-between p-6 sm:p-10 md:w-1/2 md:p-12 lg:p-16">
        {/* Mobile-only brand header (the brand panel is desktop-only). */}
        <div className="animate-in fade-in slide-in-from-top-1 flex flex-col gap-1.5 duration-500 md:hidden">
          <div className="flex items-center gap-2">
            <BrandMark className="size-5 text-[color:var(--primary)]" />
            <p className="text-base font-bold tracking-tight text-white">
              Smile <span className="text-[color:var(--primary)]">&amp;</span>{" "}
              Dial
            </p>
          </div>
          {mobileTagline ? (
            <p className="text-xs text-white/50">{mobileTagline}</p>
          ) : null}
        </div>

        {/* The glass auth card. */}
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-8">
          <div
            className="animate-in fade-in zoom-in-95 rounded-2xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur-2xl duration-500 sm:p-9"
            style={{ boxShadow: "0 24px 70px -30px rgba(0,0,0,0.65)" }}
          >
            {children}
          </div>
        </div>

        <div className="text-xs text-white/45">
          {footer ?? <DefaultFooter />}
        </div>
      </div>
    </main>
  );
}

function DefaultFooter() {
  return (
    <p>
      Internal platform · Need help?{" "}
      <Link
        href="mailto:marketing@referrizer.com"
        className="text-white/80 underline-offset-2 hover:text-white hover:underline"
      >
        marketing@referrizer.com
      </Link>
    </p>
  );
}

/** Single-column variant used by /auth/auth-error. Same immersive dark canvas,
 *  centered glass card, no split. */
export function AuthSingleColumn({ children }: { children: React.ReactNode }) {
  return (
    <main className="dark text-foreground relative isolate flex min-h-screen w-full flex-col overflow-hidden">
      <AuthAurora />
      <div className="relative z-10 flex items-center gap-2 p-8 md:p-12">
        <BrandMark className="size-5 text-[color:var(--primary)]" />
        <p className="text-base font-bold tracking-tight text-white">
          Smile <span className="text-[color:var(--primary)]">&amp;</span> Dial
        </p>
      </div>
      <div className="relative z-10 flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </main>
  );
}
