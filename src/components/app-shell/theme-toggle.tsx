"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Theme = "light" | "dark" | "system";

/** Local key under which we cache the user's theme preference. We
 *  keep a copy in localStorage so the choice survives a hard reload
 *  before React rehydrates; the in-page `useState` reads it on mount.
 *
 *  The `system` value defers to `prefers-color-scheme`, which means
 *  the OS choice carries through. */
const STORAGE_KEY = "sd-theme";

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const systemPrefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effective =
    theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;
  root.classList.toggle("dark", effective === "dark");
}

/** Top-bar toggle. Round 27 — adds the dark-mode entry point the app
 *  was missing. Three options (Light / Dark / System) so OS-level
 *  preferences carry through. Choice persists in localStorage for
 *  signed-in operators and works in private mode too (no cookie
 *  round-trip required). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [open, setOpen] = useState(false);

  // First-mount: read the stored preference and apply it. We render
  // the trigger before this resolves; for that brief flash the SSR
  // default (light) is fine because the inline script in the layout
  // also applies the stored theme before paint when possible.
  useEffect(() => {
    try {
      const stored =
        (window.localStorage.getItem(STORAGE_KEY) as Theme) || "system";
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTheme(stored);
      applyTheme(stored);
    } catch {
      // localStorage can throw in some embedded contexts; ignore.
    }
    // React to OS-level changes only when we're in "system" mode.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current =
        (window.localStorage.getItem(STORAGE_KEY) as Theme) || "system";
      if (current === "system") applyTheme("system");
    };
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  function pick(next: Theme) {
    setTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — applying still works for this session
    }
    applyTheme(next);
    setOpen(false);
  }

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Theme" title="Theme">
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeItem
          label="Light"
          icon={<Sun className="size-3.5" />}
          active={theme === "light"}
          onClick={() => pick("light")}
        />
        <ThemeItem
          label="Dark"
          icon={<Moon className="size-3.5" />}
          active={theme === "dark"}
          onClick={() => pick("dark")}
        />
        <ThemeItem
          label="System"
          icon={<Monitor className="size-3.5" />}
          active={theme === "system"}
          onClick={() => pick("system")}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem onClick={onClick}>
      {icon}
      <span className="flex-1">{label}</span>
      {active ? (
        <span aria-hidden className="bg-primary size-1.5 rounded-full" />
      ) : null}
    </DropdownMenuItem>
  );
}
