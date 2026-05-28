import { ChevronRight } from "lucide-react";
import Link from "next/link";

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

/** Compact breadcrumb trail rendered above a page's heading. Round
 *  27 — the app's nested pages (lead detail, agent edit, campaign
 *  settings, KB sources) had no orientation cue. The trail sits as
 *  a thin row above the title, with the last item rendered as plain
 *  text (current page) and earlier items as muted links. */
export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs"
    >
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span
            key={`${item.label}-${idx}`}
            className="inline-flex items-center gap-1"
          >
            {item.href && !isLast ? (
              <Link
                href={item.href}
                className="hover:text-foreground transition-colors"
              >
                {item.label}
              </Link>
            ) : (
              <span
                aria-current={isLast ? "page" : undefined}
                className={isLast ? "text-foreground" : ""}
              >
                {item.label}
              </span>
            )}
            {!isLast ? (
              <ChevronRight
                aria-hidden
                className="text-muted-foreground/60 size-3"
              />
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
