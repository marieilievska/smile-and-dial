"use client";

import { useEffect } from "react";

import "./globals.css";

/** Last-resort boundary for errors thrown in the root layout itself. It
 *  replaces the entire document, so it ships its own <html>/<body>, imports
 *  the global stylesheet for tokens, and inlines the theme-init script. Kept
 *  deliberately minimal (no shared components) so it renders even when the
 *  app is badly broken. */
const THEME_INIT_SCRIPT = `
  try {
    var t = localStorage.getItem('sd-theme') || 'system';
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    var dark = t === 'dark' || (t === 'system' && mql.matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (_) {}
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <div className="border-border bg-card flex max-w-md flex-col items-center gap-4 rounded-2xl border p-8 text-center shadow-sm">
          <span className="bg-destructive/10 text-destructive flex size-12 items-center justify-center rounded-2xl text-2xl font-semibold">
            !
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-foreground text-lg font-semibold">
              Something went wrong
            </h1>
            <p className="text-muted-foreground text-sm">
              The app hit an unexpected error. Reloading usually fixes it.
            </p>
            {error.digest ? (
              <p className="text-muted-foreground/70 font-mono text-[11px]">
                Ref: {error.digest}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={reset}
            className="bg-primary hover:bg-primary/90 inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium text-white transition-colors"
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
