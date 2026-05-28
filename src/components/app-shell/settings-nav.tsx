"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

type Tab = { label: string; href: string };

/** Settings sub-navigation. Round 23 — grouped into "Workspace" (the
 *  assets everyone needs to do their job) and "Administration"
 *  (admin-only configuration). Members only see the Workspace group;
 *  admins see both with a thin divider between them.
 *
 *  Visual treatment matches the v1 tab row (border-bottom active
 *  state) so muscle memory survives; only the order + grouping
 *  changed. */
const WORKSPACE_TABS: Tab[] = [
  { label: "Lists", href: "/settings/lists" },
  { label: "Goals", href: "/settings/goals" },
  { label: "Knowledge bases", href: "/settings/knowledge-bases" },
  { label: "Agents", href: "/settings/agents" },
];

const ADMIN_TABS: Tab[] = [
  { label: "Users", href: "/settings/users" },
  { label: "Custom fields", href: "/settings/custom-fields" },
  { label: "Twilio numbers", href: "/settings/twilio-numbers" },
  { label: "Integrations", href: "/settings/integrations" },
  { label: "API", href: "/settings/api" },
];

export function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings" className="flex flex-wrap items-center gap-1">
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

function Divider() {
  return (
    <span
      aria-hidden
      className="bg-border mx-2 hidden h-5 w-px self-center sm:inline-block"
    />
  );
}
