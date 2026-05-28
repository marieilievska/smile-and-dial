"use client";

import { Menu } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import {
  AppSidebar,
  type SidebarSavedView,
  type SidebarStatusCounts,
} from "./sidebar";

/** Mobile-only hamburger that opens the full sidebar as an overlay
 *  sheet. Round 35 (R1) — the persistent left rail is hidden below
 *  `md`; this button takes its place in the top-bar. The sheet
 *  closes when the user picks a route, so navigating from mobile
 *  feels like a normal app, not a popup that lingers.
 *
 *  We render the same `<AppSidebar>` inside the sheet so there's
 *  exactly one component definition for the nav — no mobile
 *  divergence to keep in sync. The Sheet's own overflow + scroll
 *  handling takes care of long sections. */
export function MobileNavTrigger({
  isAdmin,
  savedViews,
  statusCounts,
}: {
  isAdmin: boolean;
  savedViews: SidebarSavedView[];
  statusCounts: SidebarStatusCounts;
}) {
  const [open, setOpen] = useState(false);

  // Close the drawer when the route changes. Using a popstate listener
  // and a window-level `sd-route-change` event keeps this tidy without
  // wiring a useRouter hook for every link.
  useEffect(() => {
    function onChange() {
      setOpen(false);
    }
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation"
          className="md:hidden"
        >
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="bg-sidebar text-sidebar-foreground w-72 p-0"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Main navigation</SheetTitle>
        </SheetHeader>
        {/* Tapping any link inside the sidebar fires this — the click
         *  bubbles up here before the route change kicks in, so we
         *  schedule the close on the next frame. */}
        <div onClick={() => requestAnimationFrame(() => setOpen(false))}>
          <AppSidebar
            isAdmin={isAdmin}
            savedViews={savedViews}
            statusCounts={statusCounts}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
