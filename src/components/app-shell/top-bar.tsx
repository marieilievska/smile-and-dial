"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth/actions";

import {
  ActiveCampaignChip,
  type ActiveCampaignOption,
} from "./active-campaign-chip";
import { AskSmile } from "./ask-smile";
import { GlobalSearch } from "./global-search";
import { NotificationBell, type NotificationItem } from "./notification-bell";
import { ThemeToggle } from "./theme-toggle";

function initialsOf(name: string) {
  const letters = name
    .split(" ")
    .map((part) => part.trim()[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return letters.toUpperCase() || "U";
}

export function TopBar({
  name,
  email,
  role,
  notifications,
  unreadCount,
  activeCampaign,
  campaigns,
  mobileNav,
}: {
  name: string;
  email: string;
  role: string;
  notifications: NotificationItem[];
  unreadCount: number;
  activeCampaign: { id: string; name: string } | null;
  campaigns: ActiveCampaignOption[];
  /** Round 35 (R1) — hamburger trigger for the sidebar drawer below
   *  `md`. Slotted from the layout so the trigger has the same
   *  isAdmin / saved-views payload as the persistent sidebar. */
  mobileNav?: React.ReactNode;
}) {
  return (
    <header className="border-border bg-card flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
      {mobileNav}
      <div className="flex-1">
        <GlobalSearch />
      </div>
      {/* Round 27 — operator-scoped chrome: ask-smile co-pilot, active
       *  campaign chip, theme toggle, notifications, user. Active
       *  campaign drives manual call destinations. */}
      <AskSmile />
      <ActiveCampaignChip
        activeCampaign={activeCampaign}
        campaigns={campaigns}
      />
      <ThemeToggle />
      <NotificationBell
        initialItems={notifications}
        initialUnreadCount={unreadCount}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-2" aria-label="Open user menu">
            <Avatar className="size-7">
              <AvatarFallback className="text-xs">
                {initialsOf(name)}
              </AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium">{name}</span>
            <ChevronsUpDown className="text-muted-foreground size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{name}</span>
            <span className="text-muted-foreground text-xs font-normal">
              {email}
            </span>
            <span className="text-muted-foreground text-xs font-normal capitalize">
              {role}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <form action={signOut}>
            <DropdownMenuItem asChild>
              <button type="submit" className="w-full">
                <LogOut className="size-4" />
                Sign out
              </button>
            </DropdownMenuItem>
          </form>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
