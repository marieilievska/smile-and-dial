"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Info,
  PhoneCall,
  Plus,
  Smartphone,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { analyzeImport, importLeads } from "@/lib/leads/import-actions";
import {
  COST_PER_LOOKUP,
  IMPORTABLE_FIELDS,
  type ImportAnalysis,
  type ImportResult,
} from "@/lib/leads/import-fields";

import { CreateListInlineDialog } from "./create-list-inline";
import { FileDropzone } from "./file-dropzone";
import { StepIndicator, type StepKey } from "./step-indicator";

type Parsed = { headers: string[]; rows: Record<string, string>[] };

/** Sentinel value used by the list <Select> to signal "the user clicked
 *  '+ Create a new list…' instead of picking an existing list." We can't
 *  use null because the radix Select needs strings. */
const CREATE_LIST_SENTINEL = "__create__";

function guessMapping(header: string): string {
  const norm = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const field of IMPORTABLE_FIELDS) {
    if (
      field.key.replace(/_/g, "") === norm ||
      field.label.toLowerCase().replace(/[^a-z0-9]/g, "") === norm
    ) {
      return `field:${field.key}`;
    }
  }
  return "skip";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function ImportWizard({
  lists: initialLists,
  customFields,
}: {
  lists: { id: string; name: string }[];
  customFields: { id: string; name: string }[];
}) {
  const [step, setStep] = useState<StepKey>("upload");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState("");
  const [lists, setLists] = useState(initialLists);
  const [listId, setListId] = useState("");
  const [createListOpen, setCreateListOpen] = useState(false);
  const [dedup, setDedup] = useState<"skip" | "update">("skip");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, startTransition] = useTransition();

  const selectedListName = useMemo(
    () => lists.find((l) => l.id === listId)?.name ?? "",
    [lists, listId],
  );

  function onFile(file: File) {
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = (res.meta.fields ?? []).filter(Boolean);
        setParsed({ headers, rows: res.data });
        const auto: Record<string, string> = {};
        for (const header of headers) auto[header] = guessMapping(header);
        setMapping(auto);
      },
      error: () => toast.error("Could not read that CSV file."),
    });
  }

  function clearFile() {
    setFileName("");
    setParsed(null);
    setMapping({});
  }

  function onListPicked(value: string) {
    if (value === CREATE_LIST_SENTINEL) {
      // Defer opening the dialog by one tick so the Select pop-over
      // has a chance to close cleanly before the Dialog takes over.
      setTimeout(() => setCreateListOpen(true), 50);
      return;
    }
    setListId(value);
  }

  function onListCreated(id: string, name: string) {
    setLists((current) =>
      [...current, { id, name }].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setListId(id);
  }

  function runAnalyze() {
    if (!parsed) return;
    startTransition(async () => {
      const res = await analyzeImport({ mapping, rows: parsed.rows });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setAnalysis(res);
      setStep("summary");
    });
  }

  function runImport() {
    if (!parsed || !analysis) return;
    startTransition(async () => {
      const res = await importLeads({
        listId,
        dedup,
        mapping,
        rows: parsed.rows,
        rowLineTypes: analysis.rowLineTypes,
      });
      setResult(res);
      if (res.error) toast.error(res.error);
      else setStep("done");
    });
  }

  function downloadErrorReport() {
    if (!analysis || analysis.skipped.length === 0) return;
    const lines = [
      ["phone", "reason"],
      ...analysis.skipped.map((s) => [s.phone, s.reason]),
    ];
    const csv = lines
      .map((cells) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "import-errors.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function resetWizard() {
    setStep("upload");
    clearFile();
    setAnalysis(null);
    setResult(null);
  }

  // ----- Done -------------------------------------------------------------
  if (step === "done" && result) {
    return (
      <DoneStep
        result={result}
        listId={listId}
        listName={selectedListName}
        onReset={resetWizard}
      />
    );
  }

  // ----- Summary ----------------------------------------------------------
  if (step === "summary" && parsed && analysis) {
    return (
      <div className="flex flex-col gap-6">
        <StepIndicator current="summary" />
        <ReviewStep
          analysis={analysis}
          fileName={fileName}
          pending={pending}
          onBack={() => setStep("map")}
          onImport={runImport}
          onDownloadErrors={downloadErrorReport}
        />
      </div>
    );
  }

  // ----- Map --------------------------------------------------------------
  if (step === "map" && parsed) {
    return (
      <div className="flex flex-col gap-6">
        <StepIndicator current="map" />
        <MapStep
          parsed={parsed}
          fileName={fileName}
          mapping={mapping}
          customFields={customFields}
          pending={pending}
          onMappingChange={(header, value) =>
            setMapping((m) => ({ ...m, [header]: value }))
          }
          onBack={() => setStep("upload")}
          onContinue={runAnalyze}
        />
      </div>
    );
  }

  // ----- Upload (default) -------------------------------------------------
  const hasLists = lists.length > 0;
  const canContinue = Boolean(parsed && listId);
  const blockedReason = !parsed
    ? "Drop a CSV above to continue."
    : !listId
      ? "Pick a list to continue."
      : "";

  const costEstimate =
    parsed != null ? parsed.rows.length * COST_PER_LOOKUP : 0;

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator current="upload" />

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <FileDropzone
            fileName={fileName}
            rowCount={parsed?.rows.length ?? null}
            columnCount={parsed?.headers.length ?? null}
            onFile={onFile}
            onClear={clearFile}
          />
          <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
            <Link
              href="/leads/import/sample"
              className="text-foreground inline-flex items-center gap-1 underline-offset-2 hover:text-[color:var(--coral)] hover:underline"
              prefetch={false}
            >
              <Download className="size-3.5" />
              Download a sample CSV
            </Link>
            {parsed ? (
              <span className="inline-flex items-center gap-1">
                <Info className="size-3.5" />
                Est. Twilio Lookup cost: ${costEstimate.toFixed(2)} for{" "}
                {parsed.rows.length.toLocaleString()} rows
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="import-list">Import into list</Label>
          {hasLists ? (
            <Select value={listId} onValueChange={onListPicked}>
              <SelectTrigger id="import-list">
                <SelectValue placeholder="Choose a list" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Your lists</SelectLabel>
                  {lists.map((list) => (
                    <SelectItem key={list.id} value={list.id}>
                      {list.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectSeparator />
                <SelectItem value={CREATE_LIST_SENTINEL}>
                  + Create a new list…
                </SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <div className="border-border bg-muted/20 flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <p className="text-foreground font-medium">No lists yet</p>
                <p className="text-muted-foreground text-xs">
                  Make one now to drop these leads into.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateListOpen(true)}
              >
                <Plus className="size-4" />
                Create a list
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="import-dedup">If a phone number already exists</Label>
          <Select
            value={dedup}
            onValueChange={(v) => setDedup(v as "skip" | "update")}
          >
            <SelectTrigger id="import-dedup">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">
                Skip — don&apos;t touch the existing lead
              </SelectItem>
              <SelectItem value="update">
                Update — overwrite with the new row&apos;s values
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Skip is safer. Use Update if your CSV has fresher data than
            what&apos;s already in Smile &amp; Dial.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-muted-foreground text-xs">
            {canContinue ? "Ready when you are." : blockedReason}
          </p>
          <Button onClick={() => setStep("map")} disabled={!canContinue}>
            Continue
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </section>

      <CreateListInlineDialog
        open={createListOpen}
        onOpenChange={setCreateListOpen}
        onCreated={onListCreated}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map step
// ---------------------------------------------------------------------------

function MapStep({
  parsed,
  fileName,
  mapping,
  customFields,
  pending,
  onMappingChange,
  onBack,
  onContinue,
}: {
  parsed: Parsed;
  fileName: string;
  mapping: Record<string, string>;
  customFields: { id: string; name: string }[];
  pending: boolean;
  onMappingChange: (header: string, value: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const totalHeaders = parsed.headers.length;
  const skippedCount = parsed.headers.filter(
    (h) => (mapping[h] ?? "skip") === "skip",
  ).length;
  const mappedCount = totalHeaders - skippedCount;

  // First 3 non-empty preview values per CSV column, formatted as a
  // muted "value · value · value" line under the header. Gives the user
  // a quick "what's in this column" before they commit a mapping.
  function previewFor(header: string): string {
    const seen: string[] = [];
    for (const row of parsed.rows) {
      const value = (row[header] ?? "").trim();
      if (value && !seen.includes(value)) seen.push(value);
      if (seen.length >= 3) break;
    }
    return seen.join(" · ") || "—";
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm">
          <FileSpreadsheet className="text-muted-foreground size-4" />
          <span className="text-foreground font-medium">{fileName}</span>
          <span className="text-muted-foreground">
            — {mappedCount} of {totalHeaders} auto-mapped
            {skippedCount > 0 ? ` · ${skippedCount} set to skip` : ""}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          We guess where each column belongs. Adjust anything that looks wrong —
          &quot;Skip this column&quot; means it won&apos;t be imported.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {parsed.headers.map((header) => {
          const value = mapping[header] ?? "skip";
          const isSkip = value === "skip";
          return (
            <li
              key={header}
              className="border-border bg-card flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span
                    className="text-foreground truncate text-sm font-medium"
                    title={header}
                  >
                    {header}
                  </span>
                  {isSkip ? (
                    <span
                      className="text-muted-foreground bg-muted/60 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                      title="This column will not be imported"
                    >
                      Skipped
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                      style={{
                        backgroundColor:
                          "color-mix(in oklab, var(--coral) 14%, transparent)",
                        color: "color-mix(in oklab, var(--coral) 85%, black)",
                      }}
                    >
                      Mapped
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground truncate text-xs">
                  {previewFor(header)}
                </p>
              </div>
              <Select
                value={value}
                onValueChange={(next) => onMappingChange(header, next)}
              >
                <SelectTrigger
                  className="sm:w-[220px]"
                  aria-label={`Map column ${header}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Skip this column</SelectItem>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Lead fields</SelectLabel>
                    {IMPORTABLE_FIELDS.map((field) => (
                      <SelectItem key={field.key} value={`field:${field.key}`}>
                        {field.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Custom fields</SelectLabel>
                    {customFields.map((field) => (
                      <SelectItem key={field.id} value={`custom:${field.id}`}>
                        {field.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="newcustom">
                      + Create as new custom field
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </li>
          );
        })}
      </ul>

      <div className="flex justify-between gap-2 pt-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onContinue} disabled={pending}>
          {pending ? "Checking numbers…" : "Review import"}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Review step
// ---------------------------------------------------------------------------

function ReviewStep({
  analysis,
  fileName,
  pending,
  onBack,
  onImport,
  onDownloadErrors,
}: {
  analysis: ImportAnalysis;
  fileName: string;
  pending: boolean;
  onBack: () => void;
  onImport: () => void;
  onDownloadErrors: () => void;
}) {
  const noImportable = analysis.importable === 0;
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">
          From {fileName}
        </p>
        <p className="text-foreground text-4xl font-semibold tabular-nums">
          {analysis.importable.toLocaleString()}{" "}
          <span className="text-muted-foreground text-base font-normal">
            {analysis.importable === 1 ? "lead" : "leads"} ready to import
          </span>
        </p>
      </div>

      <div className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-4 py-3 sm:grid-cols-3">
        <ReviewStat
          icon={<CheckCircle2 className="size-3.5" />}
          tone="success"
          label="Will import"
          value={analysis.importable}
        />
        <ReviewStat
          icon={<Smartphone className="size-3.5" />}
          tone="muted"
          label="Mobile numbers (skipped)"
          value={analysis.mobile}
          tooltip="Mobile lines can't be auto-dialed safely. Smile & Dial only calls landlines."
        />
        <ReviewStat
          icon={<AlertTriangle className="size-3.5" />}
          tone="muted"
          label="Invalid numbers (skipped)"
          value={analysis.invalid}
          tooltip="Twilio couldn't verify these numbers — usually a typo or a disconnected line."
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <Info className="size-3.5" />
          Twilio Lookup cost for this batch: ~${analysis.estCost.toFixed(2)}
        </p>
        {analysis.skipped.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={onDownloadErrors}>
            <Download className="size-3.5" />
            Download skipped rows
          </Button>
        ) : null}
      </div>

      {noImportable ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            Every row was skipped. Go back to the Map step and make sure a
            column is mapped to Business phone — without that, nothing can be
            verified.
          </p>
        </div>
      ) : null}

      <div className="flex justify-between gap-2 pt-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onImport} disabled={pending || noImportable}>
          {pending
            ? "Importing…"
            : `Import ${plural(analysis.importable, "lead")}`}
        </Button>
      </div>
    </section>
  );
}

function ReviewStat({
  icon,
  tone,
  label,
  value,
  tooltip,
}: {
  icon: React.ReactNode;
  tone: "success" | "muted";
  label: string;
  value: number;
  tooltip?: string;
}) {
  const accent =
    tone === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";
  return (
    <div className="flex flex-col gap-0.5" title={tooltip}>
      <p
        className={`inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase ${accent}`}
      >
        {icon}
        {label}
      </p>
      <p className="text-foreground text-xl font-medium tabular-nums">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Done step
// ---------------------------------------------------------------------------

function DoneStep({
  result,
  listId,
  listName,
  onReset,
}: {
  result: ImportResult;
  listId: string;
  listName: string;
  onReset: () => void;
}) {
  const detailParts: string[] = [];
  if (result.updated > 0) detailParts.push(`${result.updated} updated`);
  if (result.skipped > 0)
    detailParts.push(`${plural(result.skipped, "duplicate")} skipped`);
  if (result.skippedMobile > 0)
    detailParts.push(`${result.skippedMobile} mobile skipped`);
  if (result.skippedInvalid > 0)
    detailParts.push(`${result.skippedInvalid} invalid skipped`);

  const leadsHref = listId
    ? `/leads?list=${listId}&sort=created_at&dir=desc`
    : "/leads";

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator current="done" />
      <section
        className="bg-card flex flex-col items-center gap-4 rounded-2xl border p-8 text-center"
        style={{
          borderColor: "color-mix(in oklab, var(--coral) 35%, transparent)",
          backgroundColor: "color-mix(in oklab, var(--coral) 5%, var(--card))",
        }}
      >
        <div
          className="animate-in fade-in zoom-in-50 flex size-14 items-center justify-center rounded-full duration-500"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--coral) 22%, transparent)",
            color: "var(--coral)",
          }}
        >
          <CheckCircle2 className="size-7" />
        </div>

        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-2xl font-semibold tracking-tight">
            {result.imported.toLocaleString()}{" "}
            {result.imported === 1 ? "lead" : "leads"} imported
            {listName ? (
              <span className="text-foreground/70 font-normal">
                {" "}
                into &ldquo;{listName}&rdquo;
              </span>
            ) : null}
          </h2>
          {detailParts.length > 0 ? (
            <p className="text-muted-foreground text-sm">
              {detailParts.join(" · ")}
            </p>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button asChild>
            <Link href={leadsHref}>
              View imported leads
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button variant="outline" onClick={onReset}>
            Import another file
          </Button>
        </div>

        {result.imported > 0 ? (
          <Link
            href="/leads?action=call"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
          >
            <Sparkles className="size-3" />
            Or try a Call Now on one of these
            <PhoneCall className="size-3" />
          </Link>
        ) : null}
      </section>
    </div>
  );
}
