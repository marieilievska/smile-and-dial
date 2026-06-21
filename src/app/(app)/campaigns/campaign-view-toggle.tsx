"use client";

import { LayoutGrid, Rows3 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

/** Board | Table view toggle on /campaigns. URL-driven so refresh /
 *  back / share preserve the choice. Board is the default — only the
 *  table view needs an explicit ?view=table param, so toggling back to
 *  board drops it. */
export function CampaignViewToggle({
  current,
}: {
  current: "table" | "board";
}) {
  const searchParams = useSearchParams();
  function hrefFor(view: "table" | "board"): string {
    const params = new URLSearchParams(searchParams.toString());
    if (view === "board") params.delete("view");
    else params.set("view", view);
    return `/campaigns?${params.toString()}`;
  }
  return (
    <div
      role="tablist"
      aria-label="Campaign view"
      className="border-border bg-background inline-flex items-center gap-0.5 rounded-xl border p-1"
    >
      <ViewLink
        href={hrefFor("board")}
        active={current === "board"}
        label="Board"
        icon={<LayoutGrid className="size-4" />}
      />
      <ViewLink
        href={hrefFor("table")}
        active={current === "table"}
        label="Table"
        icon={<Rows3 className="size-4" />}
      />
    </div>
  );
}

function ViewLink({
  href,
  active,
  label,
  icon,
}: {
  href: string;
  active: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}
