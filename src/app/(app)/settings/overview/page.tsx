import {
  ArrowRight,
  BookOpen,
  Bot,
  FolderPlus,
  KeyRound,
  Phone,
  Plug,
  SlidersHorizontal,
  Target,
  Users,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/** Settings overview page. Round 29 — the audit asked for "a real
 *  overview surface that says here's what each section is for"
 *  without breaking the test contract that pins /settings →
 *  /settings/users for admin. This lives at /settings/overview and
 *  is reachable from the settings rail as "Overview" (first item).
 *  Renders a card per sub-page with its current count and a short
 *  one-line description of what the section is for, so a new user
 *  can scan and pick. */
type SectionCard = {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  count: number | null;
  ctaLabel: string;
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

  // Pull a count per section so the cards feel populated, not empty.
  // Everything runs in one fan-out; RLS does the per-user scoping.
  const [
    { count: listsCount },
    { count: goalsCount },
    { count: kbsCount },
    { count: agentsCount },
    { count: usersCountRaw },
    { count: fieldsCountRaw },
    { count: numbersCountRaw },
    { count: apiKeysCountRaw },
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
  ]);

  const workspaceCards: SectionCard[] = [
    {
      title: "Lists",
      description: "Group leads into lists for campaigns to dial through.",
      href: "/settings/lists",
      icon: <FolderPlus className="size-5" />,
      count: listsCount ?? null,
      ctaLabel: "Manage lists",
    },
    {
      title: "Goals",
      description: "What a campaign is trying to achieve on each call.",
      href: "/settings/goals",
      icon: <Target className="size-5" />,
      count: goalsCount ?? null,
      ctaLabel: "Manage goals",
    },
    {
      title: "Knowledge bases",
      description: "Reference material your agents can draw on mid-call.",
      href: "/settings/knowledge-bases",
      icon: <BookOpen className="size-5" />,
      count: kbsCount ?? null,
      ctaLabel: "Manage knowledge",
    },
    {
      title: "Agents",
      description: "The AI personalities that handle each conversation.",
      href: "/settings/agents",
      icon: <Bot className="size-5" />,
      count: agentsCount ?? null,
      ctaLabel: "Manage agents",
    },
  ];

  const adminCards: SectionCard[] = isAdmin
    ? [
        {
          title: "Users",
          description: "Add teammates and decide what they can do.",
          href: "/settings/users",
          icon: <Users className="size-5" />,
          count: usersCountRaw ?? null,
          ctaLabel: "Manage users",
        },
        {
          title: "Custom fields",
          description: "Extra columns on every lead in the workspace.",
          href: "/settings/custom-fields",
          icon: <SlidersHorizontal className="size-5" />,
          count: fieldsCountRaw ?? null,
          ctaLabel: "Manage fields",
        },
        {
          title: "Twilio numbers",
          description: "The pool of phone numbers campaigns dial from.",
          href: "/settings/twilio-numbers",
          icon: <Phone className="size-5" />,
          count: numbersCountRaw ?? null,
          ctaLabel: "Manage numbers",
        },
        {
          title: "Integrations",
          description: "Connect ElevenLabs, Calendly, and Close.",
          href: "/settings/integrations",
          icon: <Plug className="size-5" />,
          count: null,
          ctaLabel: "Manage integrations",
        },
        {
          title: "API keys",
          description: "Server-to-server access for partner integrations.",
          href: "/settings/api",
          icon: <KeyRound className="size-5" />,
          count: apiKeysCountRaw ?? null,
          ctaLabel: "Manage keys",
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The assets your campaigns rely on. Pick a section to manage it.
        </p>
      </div>

      <Section
        title="Workspace"
        description="Everyone on the team uses these to set up and run calls."
        cards={workspaceCards}
      />

      {isAdmin ? (
        <Section
          title="Administration"
          description="Admin-only configuration. Members can't see these pages."
          cards={adminCards}
        />
      ) : null}
    </div>
  );
}

function Section({
  title,
  description,
  cards,
}: {
  title: string;
  description: string;
  cards: SectionCard[];
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
          <SectionCardLink key={card.href} card={card} />
        ))}
      </div>
    </section>
  );
}

function SectionCardLink({ card }: { card: SectionCard }) {
  return (
    <Link
      href={card.href}
      data-testid="settings-section-card"
      data-section={card.title}
      className="border-border bg-card hover:bg-muted/30 focus-visible:ring-ring/60 group flex flex-col gap-2 rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
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
        {card.count != null ? (
          <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums">
            {card.count.toLocaleString()}
          </span>
        ) : null}
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
