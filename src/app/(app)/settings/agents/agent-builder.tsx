"use client";

import { ArrowLeft, Lock, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  createAgentFromTemplate,
  updateAgentScript,
} from "@/lib/agents/actions";
import {
  toFieldId,
  type ExtraDataCollectionField,
} from "@/lib/agents/data-collection";
import { previewScript } from "@/lib/agents/preview";
import { saveTemplate, updateTemplate } from "@/lib/agents/template-actions";
import type {
  AgentScript,
  AgentTemplate,
  KeyDetail,
} from "@/lib/agents/templates";
import { validateScript } from "@/lib/agents/validate";
import { tidyProseAction as tidyProse } from "@/lib/ai/tidy-prose-action";
import type { FixedVoice } from "@/lib/elevenlabs/voices";
import type { ToolsEnabled } from "@/lib/agents/prompt";

export type BuilderAgent = {
  id: string;
  name: string;
  voiceId: string;
  templateKey: string;
  instructions: string;
  tools: ToolsEnabled;
  knowledgeBaseIds: string[];
  script: AgentScript;
};

export function AgentBuilder({
  template,
  voices,
  agent,
  mode = "agent",
  templateId,
}: {
  template: AgentTemplate;
  voices: FixedVoice[];
  agent?: BuilderAgent;
  mode?: "agent" | "template";
  templateId?: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(agent);
  const isTemplate = mode === "template";
  const [name, setName] = useState(
    agent?.name ?? (mode === "template" ? template.name : ""),
  );
  // In template mode `name` holds the TEMPLATE name; description + editable
  // instructions are template-only.
  const [description, setDescription] = useState(template.description ?? "");
  const [instructions, setInstructions] = useState(template.instructions);
  const [voiceId, setVoiceId] = useState(
    agent?.voiceId || template.defaultVoiceId || voices[0]?.id || "",
  );
  const tools = agent?.tools ?? template.tools; // fixed in Phase 1 (read-only)
  const [purpose, setPurpose] = useState(
    agent?.script.purpose ?? template.script.purpose,
  );
  const [goal, setGoal] = useState(agent?.script.goal ?? template.script.goal);
  const [keyDetails, setKeyDetails] = useState<KeyDetail[]>(
    agent?.script.keyDetails ?? template.script.keyDetails,
  );
  const [scriptProse, setScriptProse] = useState(
    agent?.script.scriptProse ?? template.script.scriptProse,
  );
  const [dataCollection, setDataCollection] = useState<
    ExtraDataCollectionField[]
  >(agent?.script.dataCollection ?? template.script.dataCollection);
  const [pending, startTransition] = useTransition();

  const script: AgentScript = {
    purpose,
    goal,
    keyDetails,
    scriptProse,
    dataCollection,
  };
  const errors = validateScript(name, script);
  // Cheap + deterministic, so recompute on render rather than memoizing over a
  // per-render object (which never actually memoizes).
  const preview = previewScript(script);

  function setDetail(i: number, patch: Partial<KeyDetail>) {
    setKeyDetails((ds) =>
      ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );
  }

  function save() {
    if (errors.length > 0) {
      toast.error(errors[0]);
      return;
    }
    startTransition(async () => {
      if (isTemplate) {
        const payload = {
          name,
          description,
          instructions,
          defaultVoiceId: voiceId,
          tools,
          script,
        };
        const result = templateId
          ? await updateTemplate(templateId, payload)
          : await saveTemplate(payload);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(templateId ? "Template updated." : "Template saved.");
          router.push("/settings/agents/new");
        }
        return;
      }
      const payload = {
        name,
        voiceId,
        script,
        toolsEnabled: tools,
        knowledgeBaseIds: agent?.knowledgeBaseIds ?? [],
      };
      const result = agent
        ? await updateAgentScript(agent.id, payload)
        : await createAgentFromTemplate({
            templateKey: template.key,
            ...payload,
          });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(isEdit ? "Agent updated." : "Agent created.");
        router.push("/settings/agents");
      }
    });
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings/overview" },
          { label: "Agents", href: "/settings/agents" },
          { label: isEdit ? "Edit agent" : template.name },
        ]}
      />
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {isEdit ? "Edit agent" : "Build agent"}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {isEdit
            ? "Editing the script — behavior stays locked."
            : `From the ${template.name} template`}
        </p>
      </div>

      <div className="grid max-w-5xl gap-5 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {/* Basics */}
          <Card className="rounded-2xl">
            <CardContent className="flex flex-col gap-4 pt-6">
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-name">
                  {isTemplate ? "Template name" : "Agent name"}
                </Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. HireAI Webinar — September"
                />
              </div>
              {isTemplate ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="template-description">Description</Label>
                  <Input
                    id="template-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="One line shown on the gallery card"
                  />
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-voice">Voice</Label>
                <Select value={voiceId} onValueChange={setVoiceId}>
                  <SelectTrigger id="agent-voice">
                    <SelectValue placeholder="Choose a voice" />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} · {v.gender === "female" ? "Female" : "Male"} ·{" "}
                        {v.vibe}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Locked instructions */}
          <Card className="bg-muted/20 rounded-2xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Lock className="size-4" /> Instructions — how the agent behaves
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isTemplate ? (
                <Textarea
                  aria-label="Instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={14}
                  className="font-mono text-xs"
                />
              ) : (
                <p className="text-muted-foreground text-xs">
                  Locked, proven behavior — turn-taking, human delivery,
                  gatekeeper handling, do-not-call, voicemail/IVR. You
                  can&apos;t break it, and don&apos;t need to.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Editable script */}
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-sm">
                Script — what it says &amp; what it&apos;s for
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-purpose">Purpose</Label>
                <Input
                  id="agent-purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-goal">
                  Goal — what counts as success
                </Label>
                <Input
                  id="agent-goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </div>

              {/* Key details */}
              <div className="flex flex-col gap-2">
                <Label>Key details</Label>
                {keyDetails.map((d, i) => (
                  <div key={d.id} className="flex items-center gap-2">
                    <span className="text-muted-foreground w-32 shrink-0 text-xs">
                      {d.label}
                    </span>
                    <Input
                      aria-label={d.label}
                      type={d.type === "date" ? "date" : "text"}
                      value={d.value}
                      onChange={(e) => setDetail(i, { value: e.target.value })}
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-script">The script</Label>
                <Textarea
                  id="agent-script"
                  value={scriptProse}
                  onChange={(e) => setScriptProse(e.target.value)}
                  rows={12}
                />
                <TidyButton value={scriptProse} onChange={setScriptProse} />
              </div>

              {/* Data collection — plain English */}
              <DataCollectionEditor
                value={dataCollection}
                onChange={setDataCollection}
              />
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={() => router.back()}
              disabled={pending}
            >
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button onClick={save} disabled={pending || errors.length > 0}>
              {pending ? (
                <Sparkles className="size-4 animate-pulse" />
              ) : (
                <Save className="size-4" />
              )}
              {pending
                ? "Saving…"
                : isTemplate
                  ? templateId
                    ? "Save template"
                    : "Save as template"
                  : isEdit
                    ? "Save changes"
                    : "Save agent"}
            </Button>
          </div>
          {errors.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              Before saving: {errors[0]}
            </p>
          ) : null}
        </div>

        {/* Live preview */}
        <aside className="flex flex-col gap-3">
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-sm">How the call will sound</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p
                className="text-foreground text-sm"
                data-testid="preview-opening"
              >
                {preview.opening || "Write a script to see the opening here."}
              </p>
              {preview.specifics.length > 0 ? (
                <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
                  {preview.specifics.map((s) => (
                    <li key={s.label}>
                      <span className="font-medium">{s.label}:</span> {s.value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** Plain-English data collection rows (no field_name/enum jargon). The machine
 *  id is derived from the label via toFieldId under the hood. */
function DataCollectionEditor({
  value,
  onChange,
}: {
  value: ExtraDataCollectionField[];
  onChange: (v: ExtraDataCollectionField[]) => void;
}) {
  function add() {
    onChange([
      ...value,
      { id: "", type: "boolean", description: "", enumValues: [] },
    ]);
  }
  function update(i: number, label: string) {
    onChange(
      value.map((f, idx) =>
        idx === i ? { ...f, id: toFieldId(label), description: label } : f,
      ),
    );
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  return (
    <div className="flex flex-col gap-2">
      <Label>What should the agent find out on each call?</Label>
      {value.map((f, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label="What to find out"
            value={f.description}
            onChange={(e) => update(i, e.target.value)}
            placeholder="e.g. Are they the decision-maker?"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove"
            onClick={() => remove(i)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        className="w-fit"
      >
        <Plus className="size-4" /> Add
      </Button>
    </div>
  );
}

/** "Tidy up wording" — grammar/flow cleanup of the script prose via OpenAI
 *  (meaning preserved), with a one-shot Undo. */
function TidyButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [pending, start] = useTransition();
  const [prev, setPrev] = useState<string | null>(null);
  function tidy() {
    start(async () => {
      const before = value;
      const cleaned = await tidyProse(before);
      if (cleaned === before) {
        toast.message("Nothing to tidy.");
        return;
      }
      setPrev(before);
      onChange(cleaned);
      toast.success("Tidied the wording.");
    });
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={tidy}
        disabled={pending}
      >
        <Sparkles className="size-4" />{" "}
        {pending ? "Tidying…" : "Tidy up wording"}
      </Button>
      {prev !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(prev);
            setPrev(null);
          }}
        >
          Undo
        </Button>
      ) : null}
    </div>
  );
}
