"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

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
import { createAgent } from "@/lib/agents/actions";
import {
  ALL_TOOLS,
  TOOL_LABELS,
  assemblePrompt,
  type ToolKey,
  type ToolsEnabled,
} from "@/lib/agents/prompt";

const AI_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-4",
  "gemini-2.5-flash",
];

const STEPS = [
  {
    title: "Basics",
    description: "Name your agent and pick its voice and model.",
  },
  {
    title: "Personality",
    description: "How would you describe this agent's personality?",
  },
  {
    title: "Environment",
    description: "Where is this agent operating?",
  },
  {
    title: "Tone",
    description: "How should the agent speak?",
  },
  {
    title: "Goal",
    description: "What is the agent trying to accomplish?",
  },
  {
    title: "Guardrails",
    description: "What should the agent never do?",
  },
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

export function AgentWizard({
  voiceIds,
  knowledgeBases,
}: {
  voiceIds: string[];
  knowledgeBases: KbOption[];
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [voiceId, setVoiceId] = useState(voiceIds[0] ?? "");
  const [aiModel, setAiModel] = useState(AI_MODELS[0]);
  const [personality, setPersonality] = useState("");
  const [environment, setEnvironment] = useState("");
  const [tone, setTone] = useState("");
  const [goal, setGoal] = useState("");
  const [guardrails, setGuardrails] = useState("");
  const [tools, setTools] = useState<ToolsEnabled>({});
  const [kbIds, setKbIds] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [pending, startTransition] = useTransition();

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

  function save() {
    startTransition(async () => {
      const result = await createAgent({
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
      });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Agent created.");
        router.push("/settings/agents");
      }
    });
  }

  const canProceed = step !== 1 || name.trim().length > 0;
  const current = STEPS[step - 1];

  return (
    <div className="p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Build agent
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">Step {step} of 9</p>
      </div>

      <Card className="mt-6 max-w-3xl">
        <CardHeader>
          <CardTitle>{current.title}</CardTitle>
          <CardDescription>{current.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === 1 ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-voice">Voice</Label>
                {voiceIds.length > 0 ? (
                  <Select value={voiceId} onValueChange={setVoiceId}>
                    <SelectTrigger id="agent-voice">
                      <SelectValue placeholder="Choose a voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {voiceIds.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            />
          ) : null}
          {step === 3 ? (
            <TextStep
              id="agent-environment"
              label="Environment"
              value={environment}
              onChange={setEnvironment}
              placeholder="e.g., outbound phone calls to small business owners during business hours"
            />
          ) : null}
          {step === 4 ? (
            <TextStep
              id="agent-tone"
              label="Tone"
              value={tone}
              onChange={setTone}
              placeholder="e.g., concise, 2-3 sentences max, brief affirmations like 'I see' or 'Got it'"
            />
          ) : null}
          {step === 5 ? (
            <TextStep
              id="agent-goal"
              label="Goal"
              value={goal}
              onChange={setGoal}
              placeholder="What success looks like, and the steps the agent should follow."
            />
          ) : null}
          {step === 6 ? (
            <TextStep
              id="agent-guardrails"
              label="Guardrails"
              value={guardrails}
              onChange={setGuardrails}
              placeholder="One thing the agent should never do per line."
            />
          ) : null}

          {step === 7 ? (
            <div className="flex flex-col gap-3">
              {ALL_TOOLS.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <Checkbox
                    id={`tool-${key}`}
                    checked={Boolean(tools[key])}
                    onCheckedChange={() => toggleTool(key)}
                  />
                  <Label htmlFor={`tool-${key}`} className="font-normal">
                    {TOOL_LABELS[key]}
                  </Label>
                </div>
              ))}
            </div>
          ) : null}

          {step === 8 ? (
            knowledgeBases.length > 0 ? (
              <div className="flex flex-col gap-3">
                {knowledgeBases.map((kb) => (
                  <div key={kb.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`kb-${kb.id}`}
                      checked={kbIds.includes(kb.id)}
                      onCheckedChange={() => toggleKb(kb.id)}
                    />
                    <Label htmlFor={`kb-${kb.id}`} className="font-normal">
                      {kb.name}
                    </Label>
                  </div>
                ))}
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
              <Label htmlFor="agent-prompt">System prompt</Label>
              <Textarea
                id="agent-prompt"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                rows={20}
                className="font-mono text-xs"
              />
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button
            variant="ghost"
            onClick={back}
            disabled={step === 1 || pending}
          >
            Back
          </Button>
          {step < 9 ? (
            <Button onClick={next} disabled={!canProceed || pending}>
              Next
            </Button>
          ) : (
            <Button onClick={save} disabled={pending || !name.trim()}>
              {pending ? "Saving…" : "Save agent"}
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
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
    </div>
  );
}
