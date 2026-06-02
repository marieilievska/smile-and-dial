import "server-only";

/**
 * Product knowledge base for the "Ask Smile" co-pilot.
 *
 * Each topic is a detailed, step-by-step how-to with the exact in-app
 * navigation path. The full set is concatenated into PRODUCT_GUIDE and handed
 * to the LLM (live mode) so it can answer "how do I …" questions thoroughly;
 * the same topics power a deterministic matcher (matchHowTo) used in mock /
 * offline mode and to pick a "Take me there" deep link.
 *
 * Keep this in lockstep with the real product — wrong steps are worse than
 * none.
 */

export type HowToTopic = {
  key: string;
  title: string;
  href?: string;
  hrefLabel?: string;
  /** Detailed answer body (markdown-ish; newlines render in the panel). */
  body: string;
  /** True when the question is asking how to do this topic. */
  test: (q: string) => boolean;
};

const has = (q: string, re: RegExp) => re.test(q);
const howIntent =
  /\b(how|create|build|make|set ?up|add|connect|import|configure|enable|start|launch|where|guide|walk me)\b/;

export const HOW_TO_TOPICS: HowToTopic[] = [
  {
    key: "create_agent",
    title: "Create an AI agent",
    href: "/settings/agents/new",
    hrefLabel: "Build an agent",
    test: (q) => has(q, /agent/) && (has(q, howIntent) || has(q, /wizard/)),
    body: `Agents are the AI personas that run your calls. To build one:

1. Go to Settings → Agents and click "Build new agent".
2. (Optional) Use "Draft with AI" — describe in a sentence or two what the agent should do, and it pre-fills the prompt for you to refine.
3. Work through the wizard:
   • Basics — name, the ElevenLabs voice, and the AI model.
   • Personality / Environment / Tone — who the agent is, the calling context, and how it should sound.
   • Goal — the single outcome it drives toward (e.g. "book a demo"). This also becomes the post-call success check.
   • Guardrails — hard rules it must never break.
   • Tools — switch on the actions it can take mid-call: send an email, schedule a callback, get available times, book an appointment, mark do-not-call, or transfer to a human.
   • Knowledge base — attach reference docs it can draw on.
   • Data & evaluation — the fields to pull from each call plus any extra success criteria.
4. Save. The agent is pushed to ElevenLabs automatically and shows a "Synced" badge on the Agents list.

Edit any time from Settings → Agents → Edit. After changing shared defaults, use "Re-sync all" to push updates to every agent at once.`,
  },
  {
    key: "create_campaign",
    title: "Create and launch a campaign",
    href: "/campaigns",
    hrefLabel: "Open campaigns",
    test: (q) =>
      (has(q, /campaign/) && has(q, howIntent)) ||
      has(q, /start calling|go live|begin dialing|start dialing/),
    body: `A campaign is what actually makes calls — it ties an agent, a phone number, and your leads together. To launch one:

1. Go to Campaigns → "New campaign" and give it a name.
2. Attach the pieces:
   • Agent — the AI persona that will talk.
   • Goal — the outcome to drive toward.
   • Twilio number — the number it dials from.
   • Lists — one or more lists of leads to call.
3. Set the guardrails: calling hours (only dials in this window), a daily spend cap, the "transfer to a human" number, and — if the agent books meetings — the Calendly event type.
4. Click Activate.

While active, the dialer works through the leads during calling hours, automatically skipping do-not-call numbers and stopping once the daily spend cap is hit. You can pause or resume any time from the campaign.`,
  },
  {
    key: "import_leads",
    title: "Import leads from a CSV",
    href: "/leads/import",
    hrefLabel: "Import leads",
    test: (q) =>
      has(q, /import|upload|csv|spreadsheet/) &&
      has(q, /lead|contact|csv|spreadsheet|import|upload/),
    body: `To load leads in bulk:

1. Go to Leads → Import.
2. Drag in your CSV (or click to browse). A sample template is available on the upload step.
3. Map the columns — the importer auto-maps the obvious ones (company, phone, email…). You can create a brand-new custom field right here if a column doesn't have a home yet.
4. Choose options: pick or create a list to import into, toggle de-duplication (skip numbers already in the workspace), and optionally skip the Twilio number-validation lookup.
5. Review — it shows the row count and a cost estimate — then click Import.

Imported leads land in the chosen list, ready to attach to a campaign.`,
  },
  {
    key: "connect_calendly",
    title: "Connect your Calendly",
    href: "/settings/integrations",
    hrefLabel: "Open integrations",
    test: (q) =>
      has(q, /calendly/) ||
      (has(q, /book|booking|appointment|schedul/) &&
        has(q, /connect|set ?up|enable|integrat/)),
    body: `Calendly is per-user — each rep connects their own, and the AI books on the campaign owner's calendar. To connect:

1. Go to Settings → Integrations → Calendly.
2. Paste your Calendly Personal Access Token (from your Calendly account's developer/integrations settings) and click Connect. It verifies the token and pulls in your event types.
3. On each campaign, assign which Calendly event type the agent should book into.

Once connected, the agent's "get available times" and "book appointment" tools read your real availability and book the meeting directly — the lead gets a calendar invite. The lead is moved to the "scheduled" pipeline automatically.`,
  },
  {
    key: "connect_close",
    title: "Connect your Close (email)",
    href: "/settings/integrations",
    hrefLabel: "Open integrations",
    test: (q) =>
      has(q, /close/) && has(q, /email|connect|set ?up|integrat|crm/),
    body: `Close powers the agent's email tool and email-reply notifications. It's per-user:

1. Go to Settings → Integrations → Close.
2. Paste your Close API key and click Connect.

The agent's "send email" tool then sends from your Close account during a call (when a lead asks to be emailed details), and replies show up as notifications.`,
  },
  {
    key: "twilio_numbers",
    title: "Add, release, or delete a phone number",
    href: "/settings/twilio-numbers",
    hrefLabel: "Open Twilio numbers",
    test: (q) =>
      has(q, /twilio|phone number|caller id/) &&
      has(q, /buy|purchase|add|release|delete|remove|get|how|set ?up/),
    body: `Phone numbers are admin-managed under Settings → Twilio Numbers:

• Buy — search by area code and click Buy. Its voice + status webhooks are pointed at the app automatically.
• Sync from Twilio — adopt numbers you bought directly in Twilio so they show here too.
• Repoint webhooks — re-aim a number's webhooks at this deployment if they drift.
• Release — hands the number back to Twilio and stops billing; it stays in the "Released" tab for history.
• Delete — permanently removes a released number from the list so it stops cluttering "Released".

Attach a number to a campaign so the dialer has something to call from.`,
  },
  {
    key: "callbacks",
    title: "Work callbacks",
    href: "/callbacks",
    hrefLabel: "Open callbacks",
    test: (q) => has(q, /callback/) && has(q, howIntent),
    body: `When a lead asks to be called back, the agent schedules a callback for you automatically. On the Callbacks page:

• The dialer auto-redials pending callbacks at their scheduled time, during calling hours.
• Call now — dial the lead immediately instead of waiting.
• Reschedule — move it to a new time.
• Cancel — drop it and return the lead to the normal queue.
• Delete — remove a callback entirely (admin).`,
  },
  {
    key: "dnc",
    title: "Do-not-call list",
    href: "/dnc",
    hrefLabel: "Open DNC",
    test: (q) => has(q, /dnc|do not call|do-not-call|opt ?out|unsubscribe/),
    body: `The DNC list holds numbers that must never be called. The agent's "mark do-not-call" tool adds to it automatically when a lead asks to be removed, and you can add or remove numbers manually on the DNC page (removals are logged). The dialer always skips any number on this list.`,
  },
  {
    key: "costs",
    title: "Track cost and set a budget",
    href: "/costs",
    hrefLabel: "Open costs",
    test: (q) =>
      has(q, /cost|budget|spend|cap/) &&
      has(q, /set|how|limit|cap|control|configure/),
    body: `The Costs page breaks spend down by vendor (Twilio, ElevenLabs, OpenAI), shows cost per appointment, and tracks budget pace. To control spend, set a daily spend cap on a campaign — the dialer stops dialing that campaign for the day once the cap is reached, then resumes the next day.`,
  },
  {
    key: "users",
    title: "Invite and manage users",
    href: "/settings/users",
    hrefLabel: "Open users",
    test: (q) =>
      has(q, /user|teammate|team member|invite|colleague|rep account/) &&
      has(
        q,
        /invite|add|remove|delete|deactivate|role|admin|member|how|manage/,
      ),
    body: `Users are managed (admins only) under Settings → Users:

• Invite — enter an email; they get a link to set a password.
• Roles — switch someone between admin and member.
• Deactivate — blocks their login but keeps their record.
• Delete — for an already-deactivated user, permanently removes the account and everything they own.`,
  },
  {
    key: "knowledge_base",
    title: "Knowledge bases",
    href: "/settings/knowledge-bases",
    hrefLabel: "Open knowledge bases",
    test: (q) =>
      has(q, /knowledge base|knowledge-base|reference doc/) &&
      has(q, howIntent),
    body: `Knowledge bases are reference documents an agent can draw on during a call. Create them under Settings → Knowledge bases, then attach one in the agent wizard's Knowledge base step so the agent can pull facts from it.`,
  },
  {
    key: "custom_fields",
    title: "Custom lead fields",
    href: "/settings/custom-fields",
    hrefLabel: "Open custom fields",
    test: (q) => has(q, /custom field/) && has(q, howIntent),
    body: `Custom fields are extra columns on your leads (beyond the built-in ones). Create them under Settings → Custom fields. They then show up in the CSV import mapping and on the lead detail page, and the agent can reference them on a call.`,
  },
  {
    key: "go_live",
    title: "What it takes to place a real call",
    href: "/campaigns",
    hrefLabel: "Open campaigns",
    test: (q) =>
      has(
        q,
        /go live|first call|real call|production|launch.*call|start.*calling/,
      ) ||
      (has(q, /everything|checklist|what.*need/) && has(q, /call|live|launch/)),
    body: `To go from setup to live calls:

1. Core services are configured globally (ElevenLabs for the voice, Twilio for telephony, OpenAI for summaries) — that part is admin/server setup.
2. Register a phone number (Settings → Twilio Numbers).
3. Build a real agent (Settings → Agents → Build new agent).
4. Import a list of leads (Leads → Import).
5. Create a campaign tying the agent + number + list together, set calling hours and a daily spend cap, and Activate it.
6. (Optional) Connect Calendly and Close per-user so the agent can book meetings and send email.

Once a campaign is active and within calling hours, the dialer starts placing calls automatically.`,
  },
];

/** Header + every topic, for the LLM's product-knowledge context. */
export const PRODUCT_GUIDE = [
  "Smile & Dial is an AI cold-calling platform. Operators build AI agents, " +
    "attach them to campaigns that dial lists of leads, and the agents book " +
    "appointments, send emails, schedule callbacks, and more. The how-to " +
    "reference below uses the real in-app navigation paths.",
  ...HOW_TO_TOPICS.map((t) => `## ${t.title}\n${t.body}`),
].join("\n\n");

/** First how-to topic the question is asking about, or null. */
export function matchHowTo(question: string): HowToTopic | null {
  const q = question.toLowerCase();
  for (const topic of HOW_TO_TOPICS) {
    try {
      if (topic.test(q)) return topic;
    } catch {
      // a bad predicate should never break the assistant
    }
  }
  return null;
}
