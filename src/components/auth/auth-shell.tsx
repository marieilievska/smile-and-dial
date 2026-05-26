import Link from "next/link";

import { AuthBrandPanel } from "./auth-brand-panel";

/** Two-column layout for /login and /auth/set-password. Form on the
 *  left, branded gradient panel on the right with a calm live-calls
 *  visual that telegraphs "this is an AI calling platform." The right
 *  panel is hidden under md so mobile gets the form full-width.
 *
 *  Auth pages that aren't routine sign-in moments (the auth-error
 *  dead-end) use AuthSingleColumn instead — split-screen is overkill
 *  for an error page. */
export function AuthShell({
  panelHeadline,
  panelSubcopy,
  children,
}: {
  /** Tagline shown on the brand panel under the wordmark. */
  panelHeadline: string;
  panelSubcopy?: string;
  /** The form (or whatever interactive content the page hosts). */
  children: React.ReactNode;
}) {
  return (
    <main className="bg-background flex min-h-screen w-full">
      {/* FORM COLUMN */}
      <div className="flex w-full flex-col justify-between p-8 md:w-1/2 md:p-12 lg:p-16">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-base font-bold tracking-tight">
            Smile <span className="text-coral">&amp;</span> Dial
          </span>
        </div>

        <div className="mx-auto flex w-full max-w-md flex-col py-12">
          {children}
        </div>

        <p className="text-muted-foreground text-xs">
          Internal platform · Need help?{" "}
          <Link
            href="mailto:platform@referrizer.com"
            className="text-foreground underline-offset-2 hover:underline"
          >
            platform@referrizer.com
          </Link>
        </p>
      </div>

      {/* BRAND COLUMN — hidden on mobile */}
      <AuthBrandPanel headline={panelHeadline} subcopy={panelSubcopy} />
    </main>
  );
}

/** Single-column variant used by /auth/auth-error. Centered, calmer
 *  background, no split-screen. */
export function AuthSingleColumn({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-background flex min-h-screen w-full flex-col">
      <div className="flex items-center gap-2 p-8 md:p-12">
        <span className="text-foreground text-base font-bold tracking-tight">
          Smile <span className="text-coral">&amp;</span> Dial
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center px-8 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </main>
  );
}
