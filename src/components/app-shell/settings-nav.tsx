"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();

  const tabs = [
    ...(isAdmin
      ? [
          { label: "Users", href: "/settings/users" },
          { label: "Custom fields", href: "/settings/custom-fields" },
          { label: "Twilio numbers", href: "/settings/twilio-numbers" },
          { label: "Integrations", href: "/settings/integrations" },
        ]
      : []),
    { label: "Lists", href: "/settings/lists" },
    { label: "Knowledge bases", href: "/settings/knowledge-bases" },
    { label: "Agents", href: "/settings/agents" },
  ];

  return (
    <nav aria-label="Settings" className="flex gap-1">
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
    </nav>
  );
}
