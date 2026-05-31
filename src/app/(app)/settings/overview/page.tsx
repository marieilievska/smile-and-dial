import {
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  Circle,
  FolderPlus,
  KeyRound,
  Phone,
  Plug,
  SlidersHorizontal,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

/** Settings overview page. Round 30 — turned the passive card index
 *  into a "is my workspace ready to make calls?" surface. Each card
 *  now reports configured vs not, a setup-progress banner sums the
 *  essentials and deep-links to the single most important gap, and
 *  the recommended next step is visually elevated in the grid. The
 *  /settings redirect points here for everyone (admins and members),
 *  so this is the real Settings landing now. */
type SectionCard = {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  count: number | null;
  ctaLabel: string;
  /** Counts toward "ready to make calls" progress when set. */
  essential?: boolean;
  /** Whether the section is set up. Drives the status pill + progress. */
  configured: boolean;
  /** Short state line under the title, e.g. "None yet — create one". */
  statusLabel: string;
};

export default async function SettingsOverviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const isAdmin = profile?.role === "admin";

  // Pull a count per section so the cards can report configured vs
  // missing. Everything runs in one fan-out; RLS does the per-user
  // scoping. The ElevenLabs key lives in server env (read below).
  const [
    { count: listsCount },
    { count: goalsCount },
    { count: kbsCount },
    { count: agentsCount },
    { count: usersCountRaw },
    { count: fieldsCountRaw },
    { count: numbersCountRaw },
    { count: apiKeysCountRaw },
    { data: appSettings },
  ] = await Promise.all([
    supabase.from("lists").select("id", { count: "exact", head: true }),
    supabase.from("goals").select("id", { count: "exact", head: true }),
    supabase
      .from("knowledge_bases")
      .select("id", { count: "exact", head: true }),
    supabase.from("agents").select("id", { count: "exact", head: true }),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("active", true),
    supabase
      .from("custom_field_defs")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("twilio_numbers")
      .select("id", { count: "exact", head: true })
      .is("released_at", null),
    supabase
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .is("revoked_at", null),
    supabase
      .from("app_settings")
      .select("close_connected_at, calendly_connected_at")
      .eq("id", 1)
      .maybeSingle(),
  ]);

  const lists = listsCount ?? 0;
  const goals = goalsCount ?? 0;
  const kbs = kbsCount ?? 0;
  const agents = agentsCount ?? 0;
  const numbers = numbersCountRaw ?? 0;
  const fields = fieldsCountRaw ?? 0;
  const users = usersCountRaw ?? 0;
  const apiKeys = apiKeysCountRaw ?? 0;

  // Voice is the must-have integration to place calls. Close/Calendly
  // are optional, so the Integrations card's "configured" tracks voice.
  const elevenLabsConnected = Boolean(process.env.ELEVENLABS_API_KEY?.trim());
  const closeConnected = Boolean(appSettings?.close_connected_at);
  const calendlyConnected = Boolean(appSettings?.calendly_connected_at);
  const extraIntegrations = [closeConnected, calendlyConnected].filter(
    Boolean,
  ).length;

  const workspaceCards: SectionCard[] = [
    {
      title: "Lists",
      description: "Group leads into lists for campaigns to dial through.",
      href: "/settings/lists",
      icon: <FolderPlus className="size-5" />,
      count: lists,
      ctaLabel: "Manage lists",
      essential: true,
      configured: lists > 0,
      statusLabel:
        lists > 0
          ? `${lists.toLocaleString()} ready`
          : "None yet — add one to dial",
    },
    {
      title: "Goals",
      description: "What a campaign is trying to achieve on each call.",
      href: "/settings/goals",
      icon: <Target className="size-5" />,
      count: goals,
      ctaLabel: "Manage goals",
      essential: true,
      configured: goals > 0,
      statusLabel:
        goals > 0 ? `${goals.toLocaleString()} ready` : "None yet — define one",
    },
    {
      title: "Knowledge bases",
      description: "Reference material your agents can draw on mid-call.",
      href: "/settings/knowledge-bases",
      icon: <BookOpen className="size-5" />,
      count: kbs,
      ctaLabel: "Manage knowledge",
      configured: kbs > 0,
      statusLabel:
        kbs > 0 ? `${kbs.toLocaleString()} ready` : "Optional — none added yet",
    },
    {
      title: "Agents",
      description: "The AI personalities that handle each conversation.",
      href: "/settings/agents",
      icon: <Bot className="size-5" />,
      count: agents,
      ctaLabel: "Manage agents",
      essential: true,
      configured: agents > 0,
      statusLabel:
        agents > 0
          ? `${agents.toLocaleString()} ready`
          : "None yet — build one to call",
    },
  ];

  const adminCards: SectionCard[] = isAdmin
    ? [
        {
          title: "Users",
          description: "Add teammates and decide what they can do.",
          href: "/settings/users",
          icon: <Users className="size-5" />,
          count: users,
          ctaLabel: "Manage users",
          configured: users > 0,
          statusLabel: `${users.toLocaleString()} active`,
        },
        {
          title: "Custom fields",
          description: "Extra columns on every lead in the workspace.",
          href: "/settings/custom-fields",
          icon: <SlidersHorizontal className="size-5" />,
          count: fields,
          ctaLabel: "Manage fields",
          configured: fields > 0,
          statusLabel:
            fields > 0
              ? `${fields.toLocaleString()} defined`
              : "Optional — none defined",
        },
        {
          title: "Twilio numbers",
          description: "The pool of phone numbers campaigns dial from.",
          href: "/settings/twilio-numbers",
          icon: <Phone className="size-5" />,
          count: numbers,
          ctaLabel: "Manage numbers",
          essential: true,
          configured: numbers > 0,
          statusLabel:
            numbers > 0
              ? `${numbers.toLocaleString()} in pool`
              : "None yet — add a number",
        },
        {
          title: "Integrations",
          description: "Voice, email, and scheduling. ElevenLabs powers calls.",
          href: "/settings/integrations",
          icon: <Plug className="size-5" />,
          count: null,
          ctaLabel: "Manage integrations",
          essential: true,
          configured: elevenLabsConnected,
          statusLabel: elevenLabsConnected
            ? extraIntegrations > 0
              ? `Voice + ${extraIntegrations} more connected`
              : "Voice connected"
            : "ElevenLabs not connected",
        },
        {
          title: "API keys",
          description: "Server-to-server access for partner integrations.",
          href: "/settings/api",
          icon: <KeyRound className="size-5" />,
          count: apiKeys,
          ctaLabel: "Manage keys",
          configured: apiKeys > 0,
          statusLabel:
            apiKeys > 0
              ? `${apiKeys.toLocaleString()} active`
              : "Optional — none active",
        },
      ]
    : [];

  // Setup progress — sum the essentials across both groups (admins
  // see all 6; members see the 3 workspace essentials they own).
  const allCards = [...workspaceCards, ...adminCards];
  const essentials = allCards.filter((c) => c.essential);
  const readyCount = essentials.filter((c) => c.configured).length;
  const totalEssentials = essentials.length;
  // The recommended next step: first unconfigured essential in
  // priority order (numbers + voice before content), else null.
  const nextStep = essentials.find((c) => !c.configured) ?? null;
  const allReady = nextStep === null;

  return (
    <div className="flex flex-col gap-5 p-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Get your workspace ready to make calls — here&apos;s what&apos;s set
          up and what&apos;s left.
        </p>
      </div>

      <SetupBanner
        ready={readyCount}
        total={totalEssentials}
        allReady={allReady}
        nextStep={
          nextStep ? { title: nextStep.title, href: nextStep.href } : null
        }
      />

      <Section
        title="Workspace"
        description="Everyone on the team uses these to set up and run calls."
        cards={workspaceCards}
        nextHref={nextStep?.href}
      />

      {isAdmin ? (
        <Section
          title="Administration"
          description="Admin-only configuration. Members can't see these pages."
          cards={adminCards}
          nextHref={nextStep?.href}
        />
      ) : null}
    </div>
  );
}

function SetupBanner({
  ready,
  total,
  allReady,
  nextStep,
}: {
  ready: number;
  total: number;
  allReady: boolean;
  nextStep: { title: string; href: string } | null;
}) {
  const pct = total > 0 ? Math.round((ready / total) * 100) : 100;

  if (allReady) {
    return (
      <section
        data-testid="settings-setup-banner"
        data-complete="true"
        className="border-success/30 bg-success/5 flex flex-col gap-3 rounded-xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3">
          <span
            className="text-success flex size-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              backgroundColor:
                "color-mix(in oklab, var(--success) 14%, transparent)",
            }}
          >
            <Sparkles className="size-5" />
          </span>
          <div>
            <p className="text-foreground text-sm font-semibold">
              Your workspace is ready to make calls
            </p>
            <p className="text-muted-foreground text-xs">
              All {total} essentials are set up. Launch a campaign whenever you
              are.
            </p>
          </div>
        </div>
        <Link
          href="/campaigns"
          className="bg-primary text-primary-foreground inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
        >
          Go to campaigns
          <ArrowRight className="size-3.5" />
        </Link>
      </section>
    );
  }

  return (
    <section
      data-testid="settings-setup-banner"
      data-complete="false"
      className="border-border bg-card flex flex-col gap-3 rounded-xl border px-5 py-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-foreground text-sm font-semibold">
            Workspace setup — {ready} of {total} essentials ready
          </p>
          <p className="text-muted-foreground text-xs">
            {nextStep
              ? `Next: set up ${nextStep.title} to get closer to your first call.`
              : "Finish the remaining essentials to start calling."}
          </p>
        </div>
        {nextStep ? (
          <Link
            href={nextStep.href}
            data-testid="settings-next-step"
            className="bg-primary text-primary-foreground inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
          >
            Set up {nextStep.title}
            <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </div>
      <div
        className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={ready}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Workspace setup progress"
      >
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

function Section({
  title,
  description,
  cards,
  nextHref,
}: {
  title: string;
  description: string;
  cards: SectionCard[];
  nextHref?: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
          {title}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <SectionCardLink
            key={card.href}
            card={card}
            isNext={nextHref === card.href}
          />
        ))}
      </div>
    </section>
  );
}

function SectionCardLink({
  card,
  isNext,
}: {
  card: SectionCard;
  isNext: boolean;
}) {
  return (
    <Link
      href={card.href}
      data-testid="settings-section-card"
      data-section={card.title}
      data-configured={card.configured ? "true" : "false"}
      data-next={isNext ? "true" : "false"}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none",
        "focus-visible:ring-ring/60",
        isNext
          ? "border-primary/60 bg-primary/[0.03] ring-primary/15 hover:bg-primary/[0.06] ring-1"
          : "border-border bg-card hover:bg-muted/30",
      )}
    >
      {isNext ? (
        <span className="bg-primary text-primary-foreground absolute -top-2 left-4 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
          Start here
        </span>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div
          className="text-primary flex size-9 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--primary) 14%, transparent)",
          }}
        >
          {card.icon}
        </div>
        {card.configured ? (
          <span className="text-success inline-flex items-center gap-1 text-[11px] font-medium">
            <CheckCircle2 className="size-3.5" />
            {card.statusLabel}
          </span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11px] font-medium",
              card.essential ? "text-warning" : "text-muted-foreground",
            )}
          >
            <Circle className="size-3.5" />
            {card.statusLabel}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-foreground text-sm font-semibold">{card.title}</h3>
        <p className="text-muted-foreground text-xs leading-snug">
          {card.description}
        </p>
      </div>
      <span className="text-muted-foreground group-hover:text-foreground mt-1 inline-flex items-center gap-1 text-xs transition-colors">
        {card.ctaLabel}
        <ArrowRight className="size-3" />
      </span>
    </Link>
  );
}
