"use client";

import {
  ArrowRight,
  Bot,
  Phone,
  PhoneOutgoing,
  Rocket,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { markWelcomeSeen } from "@/lib/onboarding/actions";

const BLOCKS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Users, title: "Leads", body: "The businesses to call." },
  { icon: Phone, title: "Number", body: "The line calls go out from." },
  { icon: Bot, title: "Agent", body: "Your AI caller — its voice and goal." },
  {
    icon: Rocket,
    title: "Campaign",
    body: "Ties them together, starts calling.",
  },
];

/** One-time welcome primer. Shown on Today when the profile has no
 *  `welcome_seen_at`. Teaches the four building blocks and points the new
 *  teammate at step 1 (import leads). Any dismissal stamps welcome_seen_at
 *  so it never reappears. */
export function WelcomeDialog({ firstName }: { firstName: string }) {
  const [open, setOpen] = useState(true);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function markSeen() {
    startTransition(async () => {
      await markWelcomeSeen();
    });
  }

  function explore() {
    setOpen(false);
    markSeen();
  }

  function importLeads() {
    startTransition(async () => {
      await markWelcomeSeen();
      router.push("/leads/import");
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) explore();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
              <PhoneOutgoing className="size-4" />
            </span>
            <DialogTitle className="text-lg">
              {firstName
                ? `Welcome to Smile and Dial, ${firstName}`
                : "Welcome to Smile and Dial"}
            </DialogTitle>
          </div>
          <DialogDescription>
            Your AI makes the calls. You set it up once — four pieces fit
            together.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {BLOCKS.map((b, i) => (
            <div
              key={b.title}
              className="border-border bg-muted/30 flex items-start gap-2.5 rounded-lg border p-3"
            >
              <span className="bg-background text-primary border-border flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-medium tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                  <b.icon className="text-primary size-3.5" />
                  {b.title}
                </p>
                <p className="text-muted-foreground text-xs leading-snug">
                  {b.body}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={importLeads} disabled={pending}>
            Import leads
            <ArrowRight className="size-4" />
          </Button>
          <Button variant="ghost" onClick={explore} disabled={pending}>
            Explore on my own
          </Button>
        </div>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Sparkles className="size-3.5" />
          Stuck anywhere? Ask Smile, top-right — it knows every step.
        </p>
      </DialogContent>
    </Dialog>
  );
}
