"use client";

import {
  ArrowRight,
  Bot,
  Check,
  CircleCheck,
  Phone,
  Rocket,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { dismissOnboarding } from "@/lib/onboarding/actions";
import type {
  OnboardingProgress,
  OnboardingStep,
} from "@/lib/onboarding/queries";
import { cn } from "@/lib/utils";

const META: Record<
  OnboardingStep["key"],
  { title: string; body: string; href: string; icon: LucideIcon }
> = {
  leads: {
    title: "Import your leads",
    body: "Upload a CSV of businesses to call.",
    href: "/leads/import",
    icon: Users,
  },
  number: {
    title: "Get your phone number",
    body: "Pick a local number to dial from.",
    href: "/settings/twilio-numbers",
    icon: Phone,
  },
  agent: {
    title: "Build your AI agent",
    body: "Its voice, personality, and goal.",
    href: "/settings/agents/new",
    icon: Bot,
  },
  campaign: {
    title: "Launch your campaign",
    body: "Put it live and start dialing.",
    href: "/campaigns",
    icon: Rocket,
  },
};

const SUCCESS_TINT = {
  backgroundColor: "color-mix(in oklab, var(--success) 14%, transparent)",
} as const;

/** The first-run "Getting started" card on Today. Tracks the user's real
 *  progress to a live campaign (Leads → Number → Agent → Campaign) and, once
 *  all four are done, flips to a success state. Rendered by Today only while
 *  the profile has no `onboarding_dismissed_at`. */
export function GettingStarted({ progress }: { progress: OnboardingProgress }) {
  const [pending, startTransition] = useTransition();

  function hide() {
    startTransition(async () => {
      await dismissOnboarding();
    });
  }

  if (progress.complete) {
    return (
      <section
        data-testid="onboarding-success"
        className="border-success/30 bg-success/5 flex flex-col gap-3 rounded-2xl border px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3">
          <span
            className="text-success flex size-10 shrink-0 items-center justify-center rounded-lg"
            style={SUCCESS_TINT}
          >
            <CircleCheck className="size-6" />
          </span>
          <div>
            <p className="text-foreground text-sm font-semibold">
              You&apos;re live
              {progress.agentName ? ` — ${progress.agentName} is dialing` : ""}
            </p>
            <p className="text-muted-foreground text-xs">
              Watch calls land in real time below as they happen.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" onClick={hide}>
            <Link href="/campaigns">View campaign</Link>
          </Button>
          <Button size="sm" onClick={hide} disabled={pending}>
            Got it
          </Button>
        </div>
      </section>
    );
  }

  const firstTodo = progress.steps.findIndex((s) => !s.done);

  return (
    <section
      data-testid="onboarding-checklist"
      className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-foreground text-base font-semibold tracking-tight">
          Getting started
        </h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {progress.doneCount} of {progress.total} done
        </span>
      </div>
      <div
        className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={progress.doneCount}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-label="Getting started progress"
      >
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-500"
          style={{ width: `${(progress.doneCount / progress.total) * 100}%` }}
        />
      </div>

      <ol className="flex flex-col">
        {progress.steps.map((step, i) => {
          const meta = META[step.key];
          const isNext = i === firstTodo;
          return (
            <li
              key={step.key}
              className={cn(
                "flex items-center gap-3 border-t py-3 first:border-t-0",
                isNext ? "border-primary/30" : "border-border",
              )}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full",
                  step.done
                    ? "text-success"
                    : isNext
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground border",
                )}
                style={step.done ? SUCCESS_TINT : undefined}
              >
                {step.done ? (
                  <Check className="size-3.5" />
                ) : (
                  <meta.icon className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    step.done || isNext
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {meta.title}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {step.done ? step.detail : meta.body}
                </p>
              </div>
              {step.done ? (
                <span className="text-success text-xs font-medium">Done</span>
              ) : isNext ? (
                <Button asChild size="sm">
                  <Link href={meta.href}>
                    Start here
                    <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="border-border flex items-center justify-between border-t pt-3">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Sparkles className="size-3.5" />
          Ask Smile if you get stuck
        </span>
        <Button variant="ghost" size="sm" onClick={hide} disabled={pending}>
          Hide for now
        </Button>
      </div>
    </section>
  );
}
