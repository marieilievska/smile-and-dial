"use client";

import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications/actions";

export type NotificationItem = {
  id: string;
  kind: string;
  message: string;
  ref_table: string | null;
  ref_id: string | null;
  read_at: string | null;
  created_at: string;
};

const KIND_HREF: Record<string, (n: NotificationItem) => string | null> = {
  goal_met: (n) => (n.ref_id ? `/calls?call=${n.ref_id}` : null),
  email_replied: (n) => (n.ref_id ? `/leads/${n.ref_id}` : null),
  campaign_paused: (n) => (n.ref_id ? `/campaigns` : null),
  spend_cap_hit: () => `/campaigns`,
  number_flagged: () => `/settings/twilio-numbers`,
  connect_rate_low: () => `/campaigns`,
  call_now: (n) => (n.ref_id ? `/calls?call=${n.ref_id}` : null),
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(1, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Top-bar notification bell (Step 40 / BUILD_PLAN §5.0).
 *  Shows the most recent notifications with an unread badge; clicking a row
 *  marks it read and routes you to the relevant page. */
export function NotificationBell({
  initialItems,
  initialUnreadCount,
}: {
  initialItems: NotificationItem[];
  initialUnreadCount: number;
}) {
  const [items, setItems] = useState<NotificationItem[]>(initialItems);
  const [unread, setUnread] = useState<number>(initialUnreadCount);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleItemClick(item: NotificationItem) {
    if (item.read_at) {
      navigateForKind(item);
      return;
    }
    startTransition(async () => {
      const result = await markNotificationRead(item.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setItems((rows) =>
        rows.map((r) =>
          r.id === item.id ? { ...r, read_at: new Date().toISOString() } : r,
        ),
      );
      setUnread((u) => Math.max(0, u - 1));
      navigateForKind(item);
    });
  }

  function navigateForKind(item: NotificationItem) {
    const href = KIND_HREF[item.kind]?.(item) ?? null;
    if (href) router.push(href);
  }

  function handleMarkAll() {
    if (unread === 0) return;
    startTransition(async () => {
      const result = await markAllNotificationsRead();
      if (result.error) {
        toast.error(result.error);
        return;
      }
      const now = new Date().toISOString();
      setItems((rows) =>
        rows.map((r) => (r.read_at ? r : { ...r, read_at: now })),
      );
      setUnread(0);
      toast.success("All caught up.");
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          className="relative"
          data-testid="notification-bell"
          data-unread-count={unread}
        >
          <Bell className="size-4" />
          {unread > 0 ? (
            <span
              data-testid="notification-unread-badge"
              className="bg-primary text-primary-foreground absolute top-1 right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-medium"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 p-0"
        data-testid="notification-dropdown"
      >
        <div className="border-border flex items-center justify-between border-b px-3 py-2">
          <p className="text-foreground text-sm font-semibold">Notifications</p>
          <button
            type="button"
            disabled={unread === 0 || pending}
            onClick={handleMarkAll}
            className="text-muted-foreground hover:text-foreground text-xs disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="notification-mark-all"
          >
            Mark all read
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center text-sm">
              You&apos;re all caught up.
            </p>
          ) : (
            <ul className="flex flex-col">
              {items.map((item) => {
                const isUnread = item.read_at == null;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => handleItemClick(item)}
                      className={`hover:bg-muted/60 flex w-full flex-col gap-1 px-3 py-2 text-left ${
                        isUnread ? "bg-muted/30" : ""
                      }`}
                      data-testid="notification-item"
                      data-unread={isUnread ? "true" : "false"}
                    >
                      <div className="flex items-start gap-2">
                        {isUnread ? (
                          <span
                            aria-hidden
                            className="bg-primary mt-1.5 size-2 shrink-0 rounded-full"
                          />
                        ) : (
                          <span className="mt-1.5 size-2 shrink-0" />
                        )}
                        <span className="text-foreground text-sm leading-snug">
                          {item.message}
                        </span>
                      </div>
                      <span className="text-muted-foreground ml-4 text-xs">
                        {relativeTime(item.created_at)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
