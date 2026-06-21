import { Compass } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/** App-wide 404. Lives at the root so it covers unknown URLs anywhere.
 *  Renders outside the /(app) layout, so it inlines the same theme-init
 *  script the app uses (so dark mode applies before paint). */
const THEME_INIT_SCRIPT = `
  try {
    var t = localStorage.getItem('sd-theme') || 'system';
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    var dark = t === 'dark' || (t === 'system' && mql.matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (_) {}
`;

export default function NotFound() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <div className="bg-background text-foreground flex min-h-screen flex-1 items-center justify-center p-6">
        <div className="border-border bg-card flex max-w-md flex-col items-center gap-4 rounded-2xl border p-8 text-center shadow-sm">
          <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-2xl">
            <Compass className="size-6" />
          </span>
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-[11px] font-medium tracking-[0.18em] uppercase">
              404
            </p>
            <h1 className="text-foreground text-lg font-semibold">
              Page not found
            </h1>
            <p className="text-muted-foreground text-sm">
              The page you&apos;re looking for doesn&apos;t exist or may have
              moved.
            </p>
          </div>
          <Button asChild>
            <Link href="/today">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    </>
  );
}
