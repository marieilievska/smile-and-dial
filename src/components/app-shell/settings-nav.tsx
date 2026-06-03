"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

type Tab = { label: string; href: string };

/** Settings sub-navigation. Round 28 — renders as a vertical left
 *  rail on `lg+` screens (Referrizer "Detached Sidebar Workspace"
 *  pattern: persistent context block while inner views swap), and
 *  falls back to a horizontal tab row on smaller widths where a left
 *  rail would steal too much canvas. The orientation prop lets the
 *  layout pick the right form per breakpoint without rerendering. */
/** Round 29 — "Overview" added as the first item so the rail
 *  surfaces the overview landing card grid (each settings sub-page
 *  with its count + one-line purpose). The `/settings` redirect to
 *  /settings/users stays for the admin-clicks-Settings-in-the-main-nav
 *  flow; this is the explicit entry point for the overview. */
const OVERVIEW_TAB: Tab = { label: "Overview", href: "/settings/overview" };

const WORKSPACE_TABS: Tab[] = [
  { label: "Lists", href: "/settings/lists" },
  { label: "Goals", href: "/settings/goals" },
  { label: "Knowledge bases", href: "/settings/knowledge-bases" },
  { label: "Email templates", href: "/settings/email-templates" },
  { label: "Agents", href: "/settings/agents" },
];

const ADMIN_TABS: Tab[] = [
  { label: "Users", href: "/settings/users" },
  { label: "Custom fields", href: "/settings/custom-fields" },
  { label: "Twilio numbers", href: "/settings/twilio-numbers" },
  { label: "Integrations", href: "/settings/integrations" },
  { label: "API keys", href: "/settings/api" },
];

export function SettingsNav({
  isAdmin,
  orientation = "horizontal",
}: {
  isAdmin: boolean;
  orientation?: "horizontal" | "vertical";
}) {
  const pathname = usePathname();

  if (orientation === "vertical") {
    const overviewActive = pathname === OVERVIEW_TAB.href;
    return (
      <nav aria-label="Settings" className="flex flex-col gap-5 text-sm">
        <div className="flex flex-col gap-1">
          <Link
            href={OVERVIEW_TAB.href}
            aria-current={overviewActive ? "page" : undefined}
            className={cn(
              "flex items-center rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
              overviewActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            {OVERVIEW_TAB.label}
          </Link>
        </div>
        <NavGroupVertical
          label="Workspace"
          tabs={WORKSPACE_TABS}
          pathname={pathname}
        />
        {isAdmin ? (
          <NavGroupVertical
            label="Administration"
            tabs={ADMIN_TABS}
            pathname={pathname}
          />
        ) : null}
      </nav>
    );
  }

  const overviewActive = pathname === OVERVIEW_TAB.href;
  return (
    <nav aria-label="Settings" className="flex flex-wrap items-center gap-1">
      <Link
        href={OVERVIEW_TAB.href}
        aria-current={overviewActive ? "page" : undefined}
        className={cn(
          "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
          overviewActive
            ? "border-primary text-foreground"
            : "text-muted-foreground hover:text-foreground border-transparent",
        )}
      >
        {OVERVIEW_TAB.label}
      </Link>
      <Divider />
      <NavGroup label="Workspace" tabs={WORKSPACE_TABS} pathname={pathname} />
      {isAdmin ? (
        <>
          <Divider />
          <NavGroup
            label="Administration"
            tabs={ADMIN_TABS}
            pathname={pathname}
          />
        </>
      ) : null}
    </nav>
  );
}

function NavGroup({
  label,
  tabs,
  pathname,
}: {
  label: string;
  tabs: Tab[];
  pathname: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <span className="text-muted-foreground hidden text-[10px] font-semibold tracking-[0.16em] uppercase sm:inline">
        {label}
      </span>
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function NavGroupVertical({
  label,
  tabs,
  pathname,
}: {
  label: string;
  tabs: Tab[];
  pathname: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <p className="text-muted-foreground px-2 text-[10px] font-semibold tracking-[0.16em] uppercase">
        {label}
      </p>
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function Divider() {
  return (
    <span
      aria-hidden
      className="bg-border mx-2 hidden h-5 w-px self-center sm:inline-block"
    />
  );
}
