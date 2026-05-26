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

import { NotificationBell, type NotificationItem } from "./notification-bell";

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
}: {
  name: string;
  email: string;
  role: string;
  notifications: NotificationItem[];
  unreadCount: number;
}) {
  return (
    <header className="border-border bg-card flex h-16 shrink-0 items-center justify-end gap-1 border-b px-6">
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
