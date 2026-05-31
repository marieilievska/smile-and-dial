"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Save,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createAgent,
  draftAgentFromDescription,
  updateAgent,
} from "@/lib/agents/actions";
import {
  ALL_TOOLS,
  TOOL_LABELS,
  assemblePrompt,
  type ToolKey,
  type ToolsEnabled,
} from "@/lib/agents/prompt";

/** Per-model helper line so the dropdown isn't a guessing game. */
const AI_MODELS: { value: string; helper: string }[] = [
  {
    value: "gpt-4o",
    helper: "OpenAI's flagship. Best for nuanced sales conversations.",
  },
  {
    value: "gpt-4o-mini",
    helper: "Cheaper, snappier. Good default for simple booking flows.",
  },
  {
    value: "claude-sonnet-4",
    helper: "Anthropic. Calmer tone, fewer hallucinations on long prompts.",
  },
  {
    value: "gemini-2.5-flash",
    helper: "Google. Fast and inexpensive; less polished for live voice.",
  },
];

/** One-line summary per tool — surfaced under the tools step so the
 *  operator knows what each tool actually does at call time. */
const TOOL_HELPERS: Record<ToolKey, string> = {
  send_email: "Mid-call: send a follow-up email to the lead's address.",
  schedule_callback: "Records a callback request for human follow-up later.",
  get_available_times:
    "Fetches the user's Calendly availability so the agent can offer slots.",
  book_appointment:
    "Books a Calendly slot directly during the call. Counts as Goal Met.",
  mark_dnc:
    "Adds the lead's number to the workspace DNC list with reason 'caller requested'.",
  transfer_to_number:
    "Warm-transfers the live call to a human number set on the campaign.",
};

const STEPS = [
  {
    title: "Basics",
    description: "Name your agent and pick its voice and model.",
  },
  {
    title: "Personality",
    description: "How would you describe this agent's personality?",
  },
  { title: "Environment", description: "Where is this agent operating?" },
  { title: "Tone", description: "How should the agent speak?" },
  { title: "Goal", description: "What is the agent trying to accomplish?" },
  { title: "Guardrails", description: "What should the agent never do?" },
  {
    title: "Tools",
    description: "Which capabilities should the agent have?",
  },
  {
    title: "Knowledge base",
    description: "Which knowledge bases should the agent draw on?",
  },
  {
    title: "Review",
    description: "Final prompt — tweak anything before saving.",
  },
];

type KbOption = { id: string; name: string };

export type AgentInitial = {
  id: string;
  name: string;
  voiceId: string;
  aiModel: string;
  personality: string;
  environment: string;
  tone: string;
  goal: string;
  guardrails: string;
  systemPrompt: string;
  toolsEnabled: ToolsEnabled;
  knowledgeBaseIds: string[];
};

/** Step indicator pip row. Round 24 — replaces the "Step X of 9" text
 *  with a visual stepper matching the leads import wizard. Steps you
 *  already filled get a coral filled circle; the active step is the
 *  dark filled circle; future steps are muted. */
function StepIndicator({ current }: { current: number }) {
  return (
    <ol
      aria-label="Agent build progress"
      className="flex w-full items-center gap-1 text-xs"
    >
      {STEPS.map((step, i) => {
        const idx = i + 1;
        const isActive = idx === current;
        const isDone = idx < current;
        return (
          <li
            key={step.title}
            data-state={isActive ? "active" : isDone ? "done" : "future"}
            className="flex flex-1 items-center gap-1.5"
          >
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                isActive
                  ? "bg-foreground text-background"
                  : isDone
                    ? "bg-primary text-white"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isDone ? <Check className="size-3" /> : idx}
            </span>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden
                className={`hidden h-px flex-1 sm:block ${
                  isDone ? "bg-primary" : "bg-border"
                }`}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function AgentWizard({
  voiceIds,
  knowledgeBases,
  agent,
}: {
  voiceIds: string[];
  knowledgeBases: KbOption[];
  agent?: AgentInitial;
}) {
  const router = useRouter();
  const isEdit = Boolean(agent);
  const [step, setStep] = useState(1);
  const [name, setName] = useState(agent?.name ?? "");
  const [voiceId, setVoiceId] = useState(agent?.voiceId || voiceIds[0] || "");
  const [aiModel, setAiModel] = useState(agent?.aiModel || AI_MODELS[0].value);
  const [personality, setPersonality] = useState(agent?.personality ?? "");
  const [environment, setEnvironment] = useState(agent?.environment ?? "");
  const [tone, setTone] = useState(agent?.tone ?? "");
  const [goal, setGoal] = useState(agent?.goal ?? "");
  const [guardrails, setGuardrails] = useState(agent?.guardrails ?? "");
  const [tools, setTools] = useState<ToolsEnabled>(agent?.toolsEnabled ?? {});
  const [kbIds, setKbIds] = useState<string[]>(agent?.knowledgeBaseIds ?? []);
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  // AI draft — describe the agent once, let the model fill the prompt
  // blocks, then refine the pre-filled steps. Separate transition from
  // save so the two spinners never collide.
  const [description, setDescription] = useState("");
  const [drafting, startDrafting] = useTransition();
  const [drafted, setDrafted] = useState(false);

  function onDraft() {
    startDrafting(async () => {
      try {
        const result = await draftAgentFromDescription(description);
        if (result.error || !result.draft) {
          toast.error(result.error ?? "Couldn't draft the agent.");
          return;
        }
        const d = result.draft;
        if (!name.trim() && d.name) setName(d.name);
        setPersonality(d.personality);
        setEnvironment(d.environment);
        setTone(d.tone);
        setGoal(d.goal);
        setGuardrails(d.guardrails);
        setDrafted(true);
        toast.success(
          d.source === "openai"
            ? "Draft ready — review the next steps and tweak anything."
            : "Sample draft ready — review the next steps and tweak anything.",
        );
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  function next() {
    if (step === 8) {
      setSystemPrompt(
        assemblePrompt({
          personality,
          environment,
          tone,
          goal,
          guardrails,
          toolsEnabled: tools,
        }),
      );
    }
    setStep((s) => Math.min(9, s + 1));
  }

  function back() {
    setStep((s) => Math.max(1, s - 1));
  }

  function toggleTool(key: ToolKey) {
    setTools((t) => ({ ...t, [key]: !t[key] }));
  }

  function toggleKb(id: string) {
    setKbIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(systemPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; ignore.
    }
  }

  function save() {
    startTransition(async () => {
      const input = {
        name,
        voiceId,
        aiModel,
        personality,
        environment,
        tone,
        goal,
        guardrails,
        systemPrompt,
        toolsEnabled: tools,
        knowledgeBaseIds: kbIds,
      };
      const result =
        isEdit && agent
          ? await updateAgent(agent.id, input)
          : await createAgent(input);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(isEdit ? "Agent updated." : "Agent created.");
        router.push("/settings/agents");
      }
    });
  }

  const canProceed = step !== 1 || name.trim().length > 0;
  const current = STEPS[step - 1];
  const modelHelper = AI_MODELS.find((m) => m.value === aiModel)?.helper ?? "";

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Round 36 (N3) — breadcrumb trail above the heading so a user
       *  deep-linked into the wizard knows where they are and how to
       *  get back to the agents list / settings root with one click. */}
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings/overview" },
          { label: "Agents", href: "/settings/agents" },
          { label: isEdit ? "Edit agent" : "New agent" },
        ]}
      />
      <div className="duration-500">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {isEdit ? "Edit agent" : "Build agent"}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Step {step} of {STEPS.length} · {current.title}
        </p>
      </div>

      <div className="max-w-3xl">
        <StepIndicator current={step} />
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{current.title}</CardTitle>
          <CardDescription>{current.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === 1 ? (
            <>
              <div
                className="border-primary/30 flex flex-col gap-3 rounded-xl border p-4"
                style={{
                  backgroundColor:
                    "color-mix(in oklab, var(--primary) 5%, transparent)",
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="text-primary flex size-9 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor:
                        "color-mix(in oklab, var(--primary) 14%, transparent)",
                    }}
                  >
                    <Sparkles className="size-5" />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-foreground text-sm font-semibold">
                      Describe it — AI drafts the rest
                    </h3>
                    <p className="text-muted-foreground text-xs leading-snug">
                      Say what this agent should do in plain English. We&apos;ll
                      fill in the personality, tone, goal, and guardrails for
                      you to review.
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-description" className="sr-only">
                    What should this agent do?
                  </Label>
                  <Textarea
                    id="agent-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                    placeholder="e.g. Call gym leads who booked a free trial, confirm they're coming, and book a tour with a coach."
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  {drafted ? (
                    <span className="text-success inline-flex items-center gap-1 text-xs font-medium">
                      <Check className="size-3.5" />
                      Draft filled in — review the next steps
                    </span>
                  ) : (
                    <span aria-hidden />
                  )}
                  <Button
                    type="button"
                    onClick={onDraft}
                    disabled={drafting || description.trim().length < 10}
                  >
                    <Sparkles className="size-4" />
                    {drafting
                      ? "Drafting…"
                      : drafted
                        ? "Redraft"
                        : "Draft with AI"}
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-[10px] font-medium tracking-[0.16em] uppercase">
                  Or set up by hand
                </span>
                <div className="bg-border h-px flex-1" />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Friendly outbound assistant"
                  required
                />
                <p className="text-muted-foreground text-xs">
                  Operators see this name when picking which agent a campaign
                  uses.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-voice">Voice</Label>
                {voiceIds.length > 0 ? (
                  <>
                    <Select value={voiceId} onValueChange={setVoiceId}>
                      <SelectTrigger id="agent-voice">
                        <SelectValue placeholder="Choose a voice" />
                      </SelectTrigger>
                      <SelectContent>
                        {voiceIds.map((v) => (
                          <SelectItem key={v} value={v}>
                            <span className="font-mono text-xs">{v}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">
                      ElevenLabs voice ID. Preview voices in the ElevenLabs
                      dashboard; add or remove available IDs under{" "}
                      <strong>Settings → Integrations</strong>.
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    No voices configured yet. Add some in Settings →
                    Integrations.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-model">AI model</Label>
                <Select value={aiModel} onValueChange={setAiModel}>
                  <SelectTrigger id="agent-model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_MODELS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{modelHelper}</p>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <TextStep
              id="agent-personality"
              label="Personality"
              value={personality}
              onChange={setPersonality}
              placeholder="e.g., friendly and curious, professional and direct"
              helper="The agent's overall vibe — picked up on by callers within the first two sentences."
            />
          ) : null}
          {step === 3 ? (
            <TextStep
              id="agent-environment"
              label="Environment"
              value={environment}
              onChange={setEnvironment}
              placeholder="e.g., outbound phone calls to small business owners during business hours"
              helper="Where and to whom the agent is calling. Helps it pick the right tone for the moment."
            />
          ) : null}
          {step === 4 ? (
            <TextStep
              id="agent-tone"
              label="Tone"
              value={tone}
              onChange={setTone}
              placeholder="e.g., concise, 2-3 sentences max, brief affirmations like 'I see' or 'Got it'"
              helper="How the agent speaks. Length, formality, filler words, etc."
            />
          ) : null}
          {step === 5 ? (
            <TextStep
              id="agent-goal"
              label="Goal"
              value={goal}
              onChange={setGoal}
              placeholder="What success looks like, and the steps the agent should follow."
              helper="What 'Goal Met' means for this agent. Be specific — vague goals lead to vague calls."
            />
          ) : null}
          {step === 6 ? (
            <TextStep
              id="agent-guardrails"
              label="Guardrails"
              value={guardrails}
              onChange={setGuardrails}
              placeholder="One thing the agent should never do per line."
              helper="Hard limits — e.g. 'never promise a discount', 'never name competitors'. One per line."
            />
          ) : null}

          {step === 7 ? (
            <div className="flex flex-col gap-3">
              {ALL_TOOLS.map((key) => {
                const enabled = Boolean(tools[key]);
                return (
                  <label
                    key={key}
                    htmlFor={`tool-${key}`}
                    className={`border-border hover:bg-muted/30 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                      enabled ? "bg-muted/40" : ""
                    }`}
                  >
                    <Checkbox
                      id={`tool-${key}`}
                      checked={enabled}
                      onCheckedChange={() => toggleTool(key)}
                      className="mt-0.5"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-foreground text-sm font-medium">
                        {TOOL_LABELS[key]}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {TOOL_HELPERS[key]}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          ) : null}

          {step === 8 ? (
            knowledgeBases.length > 0 ? (
              <div className="flex flex-col gap-3">
                <p className="text-muted-foreground text-xs">
                  The agent will be able to reference any knowledge base you
                  attach here when forming answers mid-call.
                </p>
                {knowledgeBases.map((kb) => {
                  const checked = kbIds.includes(kb.id);
                  return (
                    <label
                      key={kb.id}
                      htmlFor={`kb-${kb.id}`}
                      className={`border-border hover:bg-muted/30 flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                        checked ? "bg-muted/40" : ""
                      }`}
                    >
                      <Checkbox
                        id={`kb-${kb.id}`}
                        checked={checked}
                        onCheckedChange={() => toggleKb(kb.id)}
                      />
                      <span className="text-foreground text-sm font-medium">
                        {kb.name}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No knowledge bases yet. You can add some in Settings → Knowledge
                bases.
              </p>
            )
          ) : null}

          {step === 9 ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="agent-prompt">System prompt</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={copyPrompt}
                  aria-label={copied ? "Copied prompt" : "Copy system prompt"}
                >
                  {copied ? (
                    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <Textarea
                id="agent-prompt"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                rows={20}
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">
                Final prompt sent to ElevenLabs. Tweak anything before saving —
                but remember edits here won&apos;t flow back into the individual
                personality / tone / goal blocks.
              </p>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button
            variant="ghost"
            onClick={back}
            disabled={step === 1 || pending}
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          {step < 9 ? (
            <Button onClick={next} disabled={!canProceed || pending}>
              Next
              <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button onClick={save} disabled={pending || !name.trim()}>
              {pending ? (
                <Sparkles className="size-4 animate-pulse" />
              ) : (
                <Save className="size-4" />
              )}
              {pending ? "Saving…" : isEdit ? "Save changes" : "Save agent"}
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}

function TextStep({
  id,
  label,
  value,
  onChange,
  placeholder,
  helper,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helper?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        placeholder={placeholder}
      />
      {helper ? (
        <p className="text-muted-foreground text-xs">{helper}</p>
      ) : null}
    </div>
  );
}
