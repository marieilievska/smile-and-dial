"use client";

import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileDown,
  TriangleAlert,
  Upload,
} from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { importDnc, type DncImportResult } from "@/lib/dnc/import-actions";

import { DncFileDropzone } from "./dnc-file-dropzone";
import { DncStepIndicator, type DncStepKey } from "./dnc-step-indicator";

type Parsed = { headers: string[]; rows: Record<string, string>[] };

const NO_COMPANY = "__none__";
const E164 = /^\+[1-9]\d{1,14}$/;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function guessHeader(headers: string[], keywords: string[]): string {
  for (const h of headers) {
    const norm = h.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (keywords.some((k) => norm.includes(k))) return h;
  }
  return "";
}

/** Same normaliser as the server-side action — lets the preview show
 *  what the saved value will look like, and lets the Done step build
 *  an accurate invalid-row export client-side without a second
 *  round-trip. */
function normalizePhone(raw: string): string {
  let s = raw.trim().replace(/^tel:/i, "");
  if (!s) return "";
  const hasPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return "";
  if (hasPlus) return `+${s}`;
  if (s.length === 10) return `+1${s}`;
  if (s.length === 11 && s.startsWith("1")) return `+${s}`;
  return "";
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** DNC CSV import wizard — Round 18 rebuild. Mirrors the leads
 *  importer with a 3-step indicator, drag-and-drop dropzone, sample
 *  CSV download, a live preview of the picked phone column at the
 *  Map step, and an Error Report download on Done so the operator
 *  can see which rows the importer rejected. */
export function DncImportWizard() {
  const [step, setStep] = useState<DncStepKey>("upload");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState("");
  const [phoneHeader, setPhoneHeader] = useState("");
  const [companyHeader, setCompanyHeader] = useState("");
  const [result, setResult] = useState<DncImportResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onFile(file: File) {
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        const rows = results.data as Record<string, string>[];
        if (headers.length === 0 || rows.length === 0) {
          toast.error("That CSV looks empty.");
          return;
        }
        setParsed({ headers, rows });
        setPhoneHeader(guessHeader(headers, ["phone", "tel", "number"]));
        setCompanyHeader(
          guessHeader(headers, ["company", "business", "name"]) || NO_COMPANY,
        );
        setStep("map");
      },
      error: (error) => toast.error(`Could not read the CSV: ${error.message}`),
    });
  }

  function clearFile() {
    setParsed(null);
    setFileName("");
    setPhoneHeader("");
    setCompanyHeader("");
  }

  function submit() {
    if (!parsed) return;
    startTransition(async () => {
      const r = await importDnc({
        phoneHeader,
        companyHeader: companyHeader === NO_COMPANY ? "" : companyHeader,
        rows: parsed.rows,
      });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      setResult(r);
      setStep("done");
    });
  }

  // Build a CSV of the rows the importer rejected as invalid. Built
  // client-side from the same normaliser the server uses, so the
  // operator gets a downloadable list without needing a server round
  // trip.
  const invalidExport = useMemo(() => {
    if (!parsed || !phoneHeader || !result) return null;
    if (result.skippedInvalid === 0) return null;
    const lines: string[] = ["row,phone_as_given,company"];
    parsed.rows.forEach((row, i) => {
      const raw = row[phoneHeader] ?? "";
      const normalised = normalizePhone(raw);
      const ok = normalised && E164.test(normalised);
      if (!ok) {
        const company =
          companyHeader && companyHeader !== NO_COMPANY
            ? (row[companyHeader] ?? "")
            : "";
        lines.push(
          [
            csvEscape(String(i + 2)), // +2 to match the spreadsheet row (1 is header)
            csvEscape(raw),
            csvEscape(company),
          ].join(","),
        );
      }
    });
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    return URL.createObjectURL(blob);
  }, [parsed, phoneHeader, companyHeader, result]);

  // Live preview of the chosen phone column — first 3 non-empty
  // values, with a tiny status tag indicating whether each parses to
  // a valid E.164 number.
  const preview = useMemo(() => {
    if (!parsed || !phoneHeader)
      return [] as { raw: string; normalised: string; ok: boolean }[];
    const seen: { raw: string; normalised: string; ok: boolean }[] = [];
    for (const row of parsed.rows) {
      const raw = row[phoneHeader] ?? "";
      if (!raw.trim()) continue;
      const normalised = normalizePhone(raw);
      const ok = Boolean(normalised) && E164.test(normalised);
      seen.push({ raw, normalised, ok });
      if (seen.length >= 3) break;
    }
    return seen;
  }, [parsed, phoneHeader]);

  return (
    <div className="flex flex-col gap-6">
      <DncStepIndicator current={step} />

      {step === "upload" ? (
        <Card className="duration-500">
          <CardHeader>
            <CardTitle>Upload CSV</CardTitle>
            <CardDescription>
              Required: a phone column (E.164 like{" "}
              <code className="bg-muted rounded px-1 py-0.5 text-xs">
                +15551234567
              </code>{" "}
              or a 10-digit US number). Optional: a company column.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <DncFileDropzone
              fileName={fileName}
              rowCount={parsed?.rows.length ?? null}
              onFile={onFile}
              onClear={clearFile}
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <a
                href="/dnc/import/sample"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs underline-offset-4 hover:underline"
                download
              >
                <Download className="size-3.5" />
                Download sample CSV
              </a>
              <p className="text-muted-foreground text-xs">
                Reason will be set to <strong>Imported</strong> on every row.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === "map" && parsed ? (
        <Card className="duration-500">
          <CardHeader>
            <CardTitle>Map columns</CardTitle>
            <CardDescription>
              {fileName} — {plural(parsed.rows.length, "row")} ·{" "}
              {plural(parsed.headers.length, "column")}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="dnc-phone-col">Phone column</Label>
                <Select value={phoneHeader} onValueChange={setPhoneHeader}>
                  <SelectTrigger id="dnc-phone-col">
                    <SelectValue placeholder="Pick a column" />
                  </SelectTrigger>
                  <SelectContent>
                    {parsed.headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="dnc-company-col">
                  Company column (optional)
                </Label>
                <Select value={companyHeader} onValueChange={setCompanyHeader}>
                  <SelectTrigger id="dnc-company-col">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_COMPANY}>None</SelectItem>
                    {parsed.headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Preview of the chosen phone column so the operator can
             *  spot a wrong mapping before the import runs. */}
            {phoneHeader && preview.length > 0 ? (
              <div className="border-border bg-muted/30 flex flex-col gap-2 rounded-lg border p-3">
                <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
                  Preview · {phoneHeader}
                </p>
                <ul className="flex flex-col gap-1.5 text-xs">
                  {preview.map((p, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="font-mono">{p.raw}</span>
                      <span className="text-muted-foreground inline-flex items-center gap-2">
                        {p.ok ? (
                          <>
                            <span className="font-mono">→ {p.normalised}</span>
                            <Badge variant="success">Valid</Badge>
                          </>
                        ) : (
                          <Badge variant="destructive">Invalid</Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="text-muted-foreground text-xs">
              Reason is set to <strong>Imported</strong> on every row. Numbers
              already on the list are skipped silently.
            </p>

            <div className="flex justify-between gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  clearFile();
                  setStep("upload");
                }}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
              <Button onClick={submit} disabled={pending || !phoneHeader}>
                <Upload className="size-4" />
                {pending ? "Importing…" : "Import"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === "done" && result ? (
        <Card className="duration-500">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="text-success size-5" />
              Import complete
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-1.5 text-sm">
              <li className="text-foreground inline-flex items-center gap-2">
                <span
                  className="text-success inline-flex size-5 items-center justify-center rounded-full"
                  style={{
                    backgroundColor:
                      "color-mix(in oklab, var(--success) 14%, transparent)",
                  }}
                  aria-hidden
                >
                  <CheckCircle2 className="size-3" />
                </span>
                {plural(result.added, "number")} added to DNC
              </li>
              <li className="text-muted-foreground inline-flex items-center gap-2">
                <span className="bg-muted text-muted-foreground inline-flex size-5 items-center justify-center rounded-full">
                  <FileDown className="size-3" />
                </span>
                {plural(result.skippedDuplicate, "duplicate")} skipped (already
                on DNC)
              </li>
              <li className="text-muted-foreground inline-flex items-center gap-2">
                <span
                  className="inline-flex size-5 items-center justify-center rounded-full"
                  style={{
                    backgroundColor:
                      "color-mix(in oklab, var(--primary) 14%, transparent)",
                    color: "var(--primary)",
                  }}
                  aria-hidden
                >
                  <TriangleAlert className="size-3" />
                </span>
                {plural(result.skippedInvalid, "row")} skipped (invalid phone)
              </li>
            </ul>

            {invalidExport ? (
              <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <p className="text-muted-foreground text-xs">
                  Need to fix the invalid rows? Download the rejection list with
                  each row&apos;s original phone string.
                </p>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={invalidExport}
                    download="dnc-import-invalid-rows.csv"
                  >
                    <Download className="size-4" />
                    Error report
                  </a>
                </Button>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => {
                  clearFile();
                  setResult(null);
                  setStep("upload");
                }}
              >
                Import another
              </Button>
              <Button asChild>
                <Link href="/dnc">Back to DNC</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
