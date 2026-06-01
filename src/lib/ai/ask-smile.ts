"use server";

import {
  fetchActionQueue,
  fetchHeroCounts,
  type ActionItem,
  type HeroCounts,
} from "@/lib/today/queries";
import { createClient } from "@/lib/supabase/server";

/** "Ask Smile" co-pilot. Answers plain-English questions about the
 *  workspace's current state. It is grounded: we gather deterministic
 *  context (today's hero counts + the action queue) server-side first,
 *  then either ask OpenAI to phrase an answer (live mode) or fall back to
 *  a deterministic data-driven answer (mock mode) so the feature works in
 *  local dev and CI without spend. Read-only — it never mutates. */

export type AskSmileResult = {
  answer: string;
  /** Optional deep link the UI renders as a "Take me there" button. */
  href?: string;
  hrefLabel?: string;
  source: "openai" | "mock";
};

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function buildContext(hero: HeroCounts, actions: ActionItem[]): string {
  const lines = [
    `Calls today: ${hero.callsToday} (yesterday: ${hero.callsYesterday})`,
    `Connect rate today: ${fmtPct(hero.connectRateToday)} (yesterday: ${fmtPct(hero.connectRateYesterday)})`,
    `Appointments today: ${hero.appointmentsToday} (yesterday: ${hero.appointmentsYesterday})`,
    `Cost per appointment today: $${hero.costPerAppointmentToday.toFixed(2)}`,
    `Pending callbacks: ${hero.pendingCallbacks}, of which overdue: ${hero.overdueCallbacks}`,
  ];
  if (actions.length > 0) {
    lines.push(
      `Open items needing attention: ${actions
        .slice(0, 6)
        .map((a) => a.message)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}

/** Pick the most useful deep link for the question + state. */
function suggestLink(
  question: string,
  hero: HeroCounts,
  actions: ActionItem[],
): { href: string; hrefLabel: string } | null {
  const q = question.toLowerCase();
  if (hero.overdueCallbacks > 0 && /callback|overdue|follow|next|do/.test(q)) {
    return { href: "/callbacks", hrefLabel: "Review callbacks" };
  }
  if (/connect|answer|pickup|rate/.test(q)) {
    return { href: "/analytics", hrefLabel: "Open analytics" };
  }
  if (/cost|spend|budget|money|expensive/.test(q)) {
    return { href: "/costs", hrefLabel: "Open costs" };
  }
  if (/campaign|pause|paused/.test(q)) {
    return { href: "/campaigns", hrefLabel: "Open campaigns" };
  }
  if (actions[0]?.href) {
    return { href: actions[0].href, hrefLabel: "Take me there" };
  }
  return null;
}

/** Deterministic answer used in mock mode — genuinely useful, reads the
 *  real numbers back with a recommendation rather than placeholder text. */
function mockAnswer(
  question: string,
  hero: HeroCounts,
  actions: ActionItem[],
): string {
  const q = question.toLowerCase();
  const callsDelta = hero.callsToday - hero.callsYesterday;
  const connectDelta = hero.connectRateToday - hero.connectRateYesterday;

  if (/what.*next|what should i do|priorit|focus/.test(q)) {
    if (hero.overdueCallbacks > 0) {
      return `You have ${hero.overdueCallbacks} overdue callback${hero.overdueCallbacks === 1 ? "" : "s"} — that's the highest-value thing to clear right now. After that, ${hero.pendingCallbacks - hero.overdueCallbacks} more callbacks are still pending today.`;
    }
    if (actions.length > 0) {
      return `Top of your list: ${actions[0].message}. ${actions.length > 1 ? `${actions.length - 1} more item${actions.length - 1 === 1 ? "" : "s"} after that.` : "Nothing else is waiting."}`;
    }
    return `Nothing urgent is waiting — you're caught up. ${hero.callsToday} calls placed today at a ${fmtPct(hero.connectRateToday)} connect rate.`;
  }

  if (/connect|answer|pickup|rate/.test(q)) {
    const dir =
      connectDelta > 0.01
        ? `up ${fmtPct(Math.abs(connectDelta))} from yesterday`
        : connectDelta < -0.01
          ? `down ${fmtPct(Math.abs(connectDelta))} from yesterday`
          : "about the same as yesterday";
    return `Your connect rate today is ${fmtPct(hero.connectRateToday)}, ${dir}. That's across ${hero.callsToday} call${hero.callsToday === 1 ? "" : "s"}.`;
  }

  if (/cost|spend|budget|money|expensive/.test(q)) {
    return `Today's cost per appointment is $${hero.costPerAppointmentToday.toFixed(2)}, with ${hero.appointmentsToday} appointment${hero.appointmentsToday === 1 ? "" : "s"} booked. Open Costs for the full vendor breakdown and budget pace.`;
  }

  if (/appointment|booked|goal|meeting/.test(q)) {
    return `${hero.appointmentsToday} appointment${hero.appointmentsToday === 1 ? "" : "s"} booked today (yesterday: ${hero.appointmentsYesterday}). At the current connect rate of ${fmtPct(hero.connectRateToday)}, more calls is the main lever.`;
  }

  if (/call|today|how.*doing|summary|recap/.test(q)) {
    const dir =
      callsDelta > 0
        ? `${callsDelta} more than yesterday`
        : callsDelta < 0
          ? `${Math.abs(callsDelta)} fewer than yesterday`
          : "same as yesterday";
    return `Today: ${hero.callsToday} calls (${dir}), ${fmtPct(hero.connectRateToday)} connect rate, ${hero.appointmentsToday} appointment${hero.appointmentsToday === 1 ? "" : "s"} booked. ${hero.overdueCallbacks > 0 ? `Heads up — ${hero.overdueCallbacks} callback${hero.overdueCallbacks === 1 ? "" : "s"} overdue.` : "No overdue callbacks."}`;
  }

  // Generic fallback — read the headline numbers back.
  return `Here's where things stand: ${hero.callsToday} calls today at a ${fmtPct(hero.connectRateToday)} connect rate, ${hero.appointmentsToday} appointment${hero.appointmentsToday === 1 ? "" : "s"} booked${hero.overdueCallbacks > 0 ? `, and ${hero.overdueCallbacks} overdue callback${hero.overdueCallbacks === 1 ? "" : "s"} to clear` : ""}. Ask me about connect rate, costs, callbacks, or what to do next.`;
}

async function callOpenAi(
  apiKey: string,
  question: string,
  context: string,
): Promise<string | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Smile, the in-app assistant for an AI cold-calling platform. " +
            "Answer the operator's question using ONLY the workspace snapshot provided. " +
            "Be concise (2-3 sentences), concrete, and reference the real numbers. " +
            "If the snapshot doesn't contain the answer, say so plainly. Never invent data.",
        },
        {
          role: "user",
          content: `Workspace snapshot:\n${context}\n\nQuestion: ${question}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 220,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

export async function askSmile(question: string): Promise<AskSmileResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    return {
      answer: "Ask me anything about your workspace — try the suggestions.",
      source: "mock",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { answer: "You're not signed in.", source: "mock" };
  }

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const isAdmin = me?.role === "admin";

  const [hero, actions] = await Promise.all([
    fetchHeroCounts(supabase, { isAdmin, ownerId: user.id }),
    fetchActionQueue(supabase, { isAdmin, ownerId: user.id }),
  ]);

  const link = suggestLink(trimmed, hero, actions);
  const live = process.env.OPENAI_LIVE === "live";
  const apiKey = process.env.OPENAI_API_KEY;

  if (live && apiKey) {
    try {
      const context = buildContext(hero, actions);
      const answer = await callOpenAi(apiKey, trimmed, context);
      if (answer) {
        return {
          answer,
          href: link?.href,
          hrefLabel: link?.hrefLabel,
          source: "openai",
        };
      }
    } catch {
      // fall through to mock
    }
  }

  return {
    answer: mockAnswer(trimmed, hero, actions),
    href: link?.href,
    hrefLabel: link?.hrefLabel,
    source: "mock",
  };
}
