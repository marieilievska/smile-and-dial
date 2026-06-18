"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Info,
  Loader2,
  PhoneCall,
  Plus,
  Smartphone,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

import { CreateCustomFieldInlineDialog } from "./create-custom-field-inline";
import { CreateListInlineDialog } from "./create-list-inline";
import { FileDropzone } from "./file-dropzone";
import { StepIndicator, type StepKey } from "./step-indicator";

type Parsed = { headers: string[]; rows: Record<string, string>[] };

/** Sentinel value used by the list <Select> to signal "the user clicked
 *  '+ Create a new list…' instead of picking an existing list." We can't
 *  use null because the radix Select needs strings. */
const CREATE_LIST_SENTINEL = "__create__";
/** Same idea for the column-mapping select — "+ Create as new custom
 *  field" — picks it, the wizard opens the inline create dialog. */
const CREATE_FIELD_SENTINEL = "newcustom";

/** Rows per server-action call. Large imports (10k+) are chunked into batches
 *  so each call stays well under the function timeout and payload limit —
 *  sending everything at once timed out on the Twilio lookups. */
const IMPORT_BATCH = 500;

/** Retry one batched server-action call a few times before giving up. A 20k
 *  import is ~40 sequential batches; a single transient failure (a function
 *  timeout on a slow Twilio-lookup batch, a network blip, a cold start) should
 *  NOT nuke the whole run. Re-throws the last error only after every attempt
 *  fails, with a short backoff between tries. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

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
  customFields: initialCustomFields,
  activeCampaignListIds,
}: {
  lists: { id: string; name: string }[];
  customFields: { id: string; name: string }[];
  /** List ids that already have an active campaign attached. The Done
   *  step uses this to frame the Autopilot handoff. */
  activeCampaignListIds: string[];
}) {
  const [step, setStep] = useState<StepKey>("upload");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState("");
  const [lists, setLists] = useState(initialLists);
  const [listId, setListId] = useState("");
  const [createListOpen, setCreateListOpen] = useState(false);
  const [customFields, setCustomFields] = useState(initialCustomFields);
  // When the user picks "+ Create as new custom field" on a column,
  // remember which header opened the dialog so we can map that exact
  // column to the new field id on success — and revert the mapping if
  // they cancel.
  const [createFieldForHeader, setCreateFieldForHeader] = useState<
    string | null
  >(null);
  const [previousMappingForHeader, setPreviousMappingForHeader] = useState<
    string | null
  >(null);
  const [dedup, setDedup] = useState<"skip" | "update">("skip");
  const [skipLookup, setSkipLookup] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // Progress across batched server-action calls (large imports are chunked so
  // each call stays under the function timeout / payload limit).
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
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

  function onMappingChange(header: string, value: string) {
    if (value === CREATE_FIELD_SENTINEL) {
      // Remember what was there before, then open the create-field
      // dialog. We set mapping to the sentinel optimistically so the
      // select shows "+ Create as new custom field" while the dialog
      // is open; we revert on cancel.
      setPreviousMappingForHeader(mapping[header] ?? "skip");
      setCreateFieldForHeader(header);
      setMapping((m) => ({ ...m, [header]: CREATE_FIELD_SENTINEL }));
      return;
    }
    setMapping((m) => ({ ...m, [header]: value }));
  }

  function onCustomFieldCreated(id: string, name: string) {
    if (!createFieldForHeader) return;
    setCustomFields((current) =>
      [...current, { id, name }].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setMapping((m) => ({ ...m, [createFieldForHeader]: `custom:${id}` }));
    setCreateFieldForHeader(null);
    setPreviousMappingForHeader(null);
  }

  function onCreateFieldCancelled() {
    if (createFieldForHeader && previousMappingForHeader !== null) {
      setMapping((m) => ({
        ...m,
        [createFieldForHeader]: previousMappingForHeader,
      }));
    }
    setCreateFieldForHeader(null);
    setPreviousMappingForHeader(null);
  }

  function runAnalyze() {
    if (!parsed) return;
    const rows = parsed.rows;
    startTransition(async () => {
      const merged: ImportAnalysis = {
        total: rows.length,
        importable: 0,
        mobile: 0,
        invalid: 0,
        duplicateExisting: 0,
        duplicateInFile: 0,
        estCost: 0,
        rowLineTypes: [],
        skipped: [],
        error: null,
      };
      setProgress({ done: 0, total: rows.length });
      // Chunked so 10k+ row imports don't time the function out on Twilio
      // lookups. Batches run in order so rowLineTypes stays aligned to rows.
      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        const chunk = rows.slice(i, i + IMPORT_BATCH);
        let res;
        try {
          res = await withRetry(() =>
            analyzeImport({ mapping, rows: chunk, skipLookup }),
          );
        } catch {
          toast.error(
            `Couldn't verify a batch after several tries (around ${Math.min(
              i + IMPORT_BATCH,
              rows.length,
            ).toLocaleString()} of ${rows.length.toLocaleString()}). Check your connection and try again` +
              (skipLookup
                ? "."
                : " — or turn off the Twilio lookup to make a large import much faster."),
          );
          setProgress(null);
          return;
        }
        if (res.error) {
          toast.error(res.error);
          setProgress(null);
          return;
        }
        merged.importable += res.importable;
        merged.mobile += res.mobile;
        merged.invalid += res.invalid;
        merged.duplicateExisting += res.duplicateExisting;
        merged.duplicateInFile += res.duplicateInFile;
        merged.estCost += res.estCost;
        merged.rowLineTypes.push(...res.rowLineTypes);
        merged.skipped.push(...res.skipped);
        setProgress({
          done: Math.min(i + IMPORT_BATCH, rows.length),
          total: rows.length,
        });
      }
      setProgress(null);
      setAnalysis(merged);
      setStep("summary");
    });
  }

  function runImport() {
    if (!parsed || !analysis) return;
    const rows = parsed.rows;
    const lineTypes = analysis.rowLineTypes;
    startTransition(async () => {
      const total: ImportResult = {
        imported: 0,
        revived: 0,
        updated: 0,
        skipped: 0,
        skippedMobile: 0,
        skippedInvalid: 0,
        error: null,
      };
      setProgress({ done: 0, total: rows.length });
      // Batches MUST run sequentially: each one dedups against leads already
      // inserted by earlier batches.
      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        let res;
        try {
          // Import batches are idempotent (dedup + upsert), so retrying a
          // batch is safe — already-inserted leads are skipped on the re-try.
          res = await withRetry(() =>
            importLeads({
              listId,
              dedup,
              mapping,
              rows: rows.slice(i, i + IMPORT_BATCH),
              rowLineTypes: lineTypes.slice(i, i + IMPORT_BATCH),
            }),
          );
        } catch {
          // A batch failed even after retries. Everything imported so far is
          // already saved; running the import again will skip those and pick up
          // where this left off (the dedup makes a re-run safe).
          setResult({
            ...total,
            error: `Stopped after a batch failed (${total.imported.toLocaleString()} imported so far). Those leads are saved — just run the import again and it'll skip them and continue.`,
          });
          setProgress(null);
          return;
        }
        total.imported += res.imported;
        total.revived += res.revived;
        total.updated += res.updated;
        total.skipped += res.skipped;
        total.skippedMobile += res.skippedMobile;
        total.skippedInvalid += res.skippedInvalid;
        if (res.error) {
          setResult({ ...total, error: res.error });
          toast.error(res.error);
          setProgress(null);
          return;
        }
        setProgress({
          done: Math.min(i + IMPORT_BATCH, rows.length),
          total: rows.length,
        });
      }
      setProgress(null);
      setResult(total);
      setStep("done");
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
        hasActiveCampaign={activeCampaignListIds.includes(listId)}
        onReset={resetWizard}
      />
    );
  }

  // ----- Summary ----------------------------------------------------------
  if (step === "summary" && parsed && analysis) {
    return (
      <div
        key="summary"
        className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-6 duration-300"
      >
        <StepIndicator current="summary" />
        <ReviewStep
          analysis={analysis}
          fileName={fileName}
          skippedLookup={skipLookup}
          dedup={dedup}
          pending={pending}
          progress={progress}
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
      <div
        key="map"
        className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-6 duration-300"
      >
        <StepIndicator current="map" />
        <MapStep
          parsed={parsed}
          fileName={fileName}
          mapping={mapping}
          customFields={customFields}
          pending={pending}
          progress={progress}
          skipLookup={skipLookup}
          onMappingChange={onMappingChange}
          onBack={() => setStep("upload")}
          onContinue={runAnalyze}
        />
        <CreateCustomFieldInlineDialog
          open={createFieldForHeader !== null}
          initialName={createFieldForHeader ?? ""}
          onOpenChange={(next) => {
            if (!next) onCreateFieldCancelled();
          }}
          onCreated={onCustomFieldCreated}
          onCancel={onCreateFieldCancelled}
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
    parsed != null && !skipLookup ? parsed.rows.length * COST_PER_LOOKUP : 0;

  return (
    <div
      key="upload"
      className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-6 duration-300"
    >
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
              className="text-foreground hover:text-primary inline-flex items-center gap-1 underline-offset-2 hover:underline"
              prefetch={false}
            >
              <Download className="size-3.5" />
              Download a sample CSV
            </Link>
            {parsed ? (
              skipLookup ? (
                <span className="inline-flex items-center gap-1">
                  <Info className="size-3.5" />
                  Twilio Lookup skipped — $0 cost,{" "}
                  {parsed.rows.length.toLocaleString()} rows will import as-is
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Info className="size-3.5" />
                  Est. Twilio Lookup cost: ${costEstimate.toFixed(2)} for{" "}
                  {parsed.rows.length.toLocaleString()} rows
                </span>
              )
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

        {/* Skip-Twilio-Lookup toggle. When checked, analyzeImport
            bypasses lookups so all rows pass through with no per-row
            cost. There is NO later line-type gate, so skipping means
            mobile numbers won't be detected or filtered — they may be
            imported and dialed. This is the only place mobiles are
            caught, so only skip when you already trust the data. */}
        <div className="border-border bg-muted/20 flex items-start gap-3 rounded-lg border px-4 py-3">
          <Checkbox
            id="skip-lookup"
            checked={skipLookup}
            onCheckedChange={(value) => setSkipLookup(value === true)}
            className="mt-0.5"
          />
          <div className="flex flex-col gap-0.5">
            <Label
              htmlFor="skip-lookup"
              className="cursor-pointer text-sm font-medium"
            >
              Skip Twilio number verification
            </Label>
            <p className="text-muted-foreground text-xs">
              Use this when you already trust the data — internal lists,
              re-imports of leads you&apos;ve called before, or imports where
              speed matters more than catching mobile numbers up front. Saves
              $0.005 per row.
            </p>
          </div>
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
  progress,
  skipLookup,
  onMappingChange,
  onBack,
  onContinue,
}: {
  parsed: Parsed;
  fileName: string;
  mapping: Record<string, string>;
  customFields: { id: string; name: string }[];
  pending: boolean;
  progress: { done: number; total: number } | null;
  skipLookup: boolean;
  onMappingChange: (header: string, value: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const totalHeaders = parsed.headers.length;
  const skippedCount = parsed.headers.filter(
    (h) => (mapping[h] ?? "skip") === "skip",
  ).length;
  const mappedCount = totalHeaders - skippedCount;

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
          &quot;Skip this column&quot; means it won&apos;t be imported. To add a
          new custom field, pick &ldquo;+ Create as new custom field&rdquo; from
          any column&apos;s dropdown.
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
                          "color-mix(in oklab, var(--primary) 14%, transparent)",
                        color: "color-mix(in oklab, var(--primary) 85%, black)",
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
                    <SelectItem value={CREATE_FIELD_SENTINEL}>
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
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {skipLookup
                ? progress
                  ? `Preparing ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}…`
                  : "Preparing import…"
                : progress
                  ? `Verifying ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} with Twilio…`
                  : `Verifying ${parsed.rows.length.toLocaleString()} ${
                      parsed.rows.length === 1 ? "number" : "numbers"
                    } with Twilio…`}
            </>
          ) : (
            <>
              Review import
              <ArrowRight className="size-4" />
            </>
          )}
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
  skippedLookup,
  dedup,
  pending,
  progress,
  onBack,
  onImport,
  onDownloadErrors,
}: {
  analysis: ImportAnalysis;
  fileName: string;
  skippedLookup: boolean;
  dedup: "skip" | "update";
  pending: boolean;
  progress: { done: number; total: number } | null;
  onBack: () => void;
  onImport: () => void;
  onDownloadErrors: () => void;
}) {
  const dupExisting = analysis.duplicateExisting;
  const dupInFile = analysis.duplicateInFile;
  // Net-new = rows that pass the line-type check and aren't duplicates. This is
  // what actually gets created, so it's the honest headline number (the old
  // "importable" counted duplicates too, which made a re-import of leads you
  // already have read as "everything will import").
  const newCount = Math.max(0, analysis.importable - dupExisting - dupInFile);
  const hasDuplicates = dupExisting > 0 || dupInFile > 0;
  // No row passed the line-type gate at all — usually a missing phone mapping.
  const noImportable = analysis.importable === 0;
  // In Update mode, existing duplicates aren't dead weight — they refresh the
  // leads in place, so there's still work to do even with zero net-new.
  const willUpdateExisting = dedup === "update" && dupExisting > 0;
  const nothingToDo = newCount === 0 && !willUpdateExisting;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">
          From {fileName}
        </p>
        <p className="text-foreground text-4xl font-semibold tabular-nums">
          {newCount.toLocaleString()}{" "}
          <span className="text-muted-foreground text-base font-normal">
            new {newCount === 1 ? "lead" : "leads"} ready to import
          </span>
        </p>
      </div>

      {skippedLookup ? (
        <div
          className="border-border bg-muted/20 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
          role="status"
        >
          <Info className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          <p className="text-muted-foreground">
            Twilio number verification was skipped, so mobile numbers won&apos;t
            be detected or filtered — they may be imported and dialed. Run the
            lookup if you want mobiles flagged.
          </p>
        </div>
      ) : (
        <div className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-4 py-3 sm:grid-cols-3">
          <ReviewStat
            icon={<CheckCircle2 className="size-3.5" />}
            tone="success"
            label="New leads"
            value={newCount}
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
      )}

      {/* Duplicate callout — the whole point of the preview fix: tell the user
          up front how many rows they already have, before they commit. */}
      {hasDuplicates ? (
        <div
          className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
          role="status"
          style={{
            borderColor: "color-mix(in oklab, var(--primary) 30%, transparent)",
            backgroundColor:
              "color-mix(in oklab, var(--primary) 6%, transparent)",
          }}
        >
          <Info
            className="mt-0.5 size-3.5 shrink-0"
            style={{ color: "var(--primary)" }}
          />
          <div className="text-foreground/80 flex flex-col gap-0.5">
            {dupExisting > 0 ? (
              <p>
                <span className="text-foreground font-medium">
                  {plural(dupExisting, "number")}
                </span>{" "}
                already in your leads —{" "}
                {dedup === "update"
                  ? "these will be updated in place, not duplicated."
                  : "these will be skipped, not duplicated."}
              </p>
            ) : null}
            {dupInFile > 0 ? (
              <p>
                <span className="text-foreground font-medium">
                  {plural(dupInFile, "row")}
                </span>{" "}
                repeated within this file — only the first of each is imported.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <Info className="size-3.5" />
          {skippedLookup
            ? "Twilio Lookup cost for this batch: $0 (skipped)"
            : `Twilio Lookup cost for this batch: ~$${analysis.estCost.toFixed(2)}`}
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
      ) : nothingToDo ? (
        <div
          role="alert"
          className="border-border bg-muted/30 text-foreground/80 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            Nothing new to add — every number here is already in your leads. Set
            the duplicate option to <span className="font-medium">Update</span>{" "}
            on the first step if you want to refresh them with this file&apos;s
            data instead.
          </p>
        </div>
      ) : null}

      <div className="flex justify-between gap-2 pt-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={onImport}
          disabled={pending || noImportable || nothingToDo}
        >
          {pending
            ? progress
              ? `Importing ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}…`
              : "Importing…"
            : willUpdateExisting && newCount === 0
              ? `Update ${plural(dupExisting, "lead")}`
              : `Import ${plural(newCount, "lead")}`}
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
  hasActiveCampaign,
  onReset,
}: {
  result: ImportResult;
  listId: string;
  listName: string;
  /** True when the destination list already has an active campaign
   *  attached — so Autopilot will pick these leads up on its own.
   *  When false we nudge the user to attach one. */
  hasActiveCampaign: boolean;
  onReset: () => void;
}) {
  // Newly-present leads = fresh inserts + revived (previously-deleted) leads.
  const totalAdded = result.imported + result.revived;
  const detailParts: string[] = [];
  if (result.revived > 0) detailParts.push(`${result.revived} restored`);
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
          borderColor: "color-mix(in oklab, var(--primary) 35%, transparent)",
          backgroundColor:
            "color-mix(in oklab, var(--primary) 5%, var(--card))",
        }}
      >
        <div
          className="animate-in fade-in zoom-in-50 flex size-14 items-center justify-center rounded-full"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--primary) 22%, transparent)",
            color: "var(--primary)",
          }}
        >
          <CheckCircle2 className="size-7" />
        </div>

        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-2xl font-semibold tracking-tight">
            {totalAdded.toLocaleString()} {totalAdded === 1 ? "lead" : "leads"}{" "}
            imported
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

        {totalAdded > 0 ? (
          hasActiveCampaign ? (
            <p
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
              style={{
                backgroundColor:
                  "color-mix(in oklab, var(--primary) 12%, transparent)",
                color: "color-mix(in oklab, var(--primary) 90%, black)",
              }}
            >
              <Sparkles className="size-3.5" />
              Autopilot will start dialing these shortly
            </p>
          ) : (
            <div className="border-border bg-muted/30 flex max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs">
              <Info className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <p className="text-muted-foreground">
                No active campaign is attached to this list yet, so these leads
                are waiting.{" "}
                <Link
                  href="/campaigns"
                  className="text-foreground hover:text-primary font-medium underline-offset-2 hover:underline"
                >
                  Attach a campaign
                </Link>{" "}
                to let Autopilot start dialing.
              </p>
            </div>
          )
        ) : null}

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

        {totalAdded > 0 ? (
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
