"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Smartphone,
  Upload,
} from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  IMPORTABLE_FIELDS,
  type ImportAnalysis,
  type ImportResult,
} from "@/lib/leads/import-fields";

type Parsed = { headers: string[]; rows: Record<string, string>[] };

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
  lists,
  customFields,
}: {
  lists: { id: string; name: string }[];
  customFields: { id: string; name: string }[];
}) {
  const [step, setStep] = useState<"upload" | "map" | "summary" | "done">(
    "upload",
  );
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState("");
  const [listId, setListId] = useState("");
  const [dedup, setDedup] = useState<"skip" | "update">("skip");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
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

  if (step === "done" && result) {
    const parts = [
      `${plural(result.imported, "lead")} imported`,
      `${result.updated} updated`,
    ];
    if (result.skipped > 0) {
      parts.push(`${plural(result.skipped, "duplicate")} skipped`);
    }
    if (result.skippedMobile > 0) {
      parts.push(`${result.skippedMobile} mobile skipped`);
    }
    if (result.skippedInvalid > 0) {
      parts.push(`${result.skippedInvalid} invalid skipped`);
    }
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="text-success size-5" />
            Import complete
          </CardTitle>
          <CardDescription>{parts.join(" · ")}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button asChild>
            <Link href="/leads">View leads</Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setStep("upload");
              setParsed(null);
              setFileName("");
              setMapping({});
              setAnalysis(null);
              setResult(null);
            }}
          >
            Import another file
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (step === "summary" && parsed && analysis) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Review import</CardTitle>
          <CardDescription>
            {fileName} — {plural(analysis.total, "row")} checked against Twilio
            Lookup.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex items-center gap-2">
              <CheckCircle2 className="text-success size-4" />
              <span className="text-foreground font-medium">
                {plural(analysis.importable, "lead")} ready to import
              </span>
            </li>
            {analysis.mobile > 0 ? (
              <li className="text-muted-foreground flex items-center gap-2">
                <Smartphone className="size-4" />
                {plural(analysis.mobile, "mobile number")} skipped (TCPA
                compliance)
              </li>
            ) : null}
            {analysis.invalid > 0 ? (
              <li className="text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="size-4" />
                {plural(analysis.invalid, "invalid number")} skipped
              </li>
            ) : null}
          </ul>
          <p className="text-muted-foreground text-sm">
            Estimated Twilio Lookup cost ~${analysis.estCost.toFixed(2)}.
          </p>
          {analysis.skipped.length > 0 ? (
            <div>
              <Button variant="outline" size="sm" onClick={downloadErrorReport}>
                <Download className="size-4" />
                Download error report
              </Button>
            </div>
          ) : null}
          <div className="flex justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep("map")}>
              Back
            </Button>
            <Button
              onClick={runImport}
              disabled={pending || analysis.importable === 0}
            >
              {pending
                ? "Importing…"
                : `Import ${plural(analysis.importable, "lead")}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === "map" && parsed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Map columns</CardTitle>
          <CardDescription>
            Match each column from {fileName} to a lead field.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {parsed.headers.map((header) => (
            <div
              key={header}
              className="grid grid-cols-[1fr_1fr] items-center gap-3"
            >
              <span className="truncate text-sm font-medium" title={header}>
                {header}
              </span>
              <Select
                value={mapping[header] ?? "skip"}
                onValueChange={(value) =>
                  setMapping((m) => ({ ...m, [header]: value }))
                }
              >
                <SelectTrigger aria-label={`Map column ${header}`}>
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
            </div>
          ))}
          <div className="flex justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep("upload")}>
              Back
            </Button>
            <Button onClick={runAnalyze} disabled={pending}>
              {pending ? "Checking numbers…" : "Review import"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload a CSV</CardTitle>
        <CardDescription>
          Choose a file, pick the list to import into, and how to handle
          duplicate phone numbers.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="csv-file">CSV file</Label>
          <Input
            id="csv-file"
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
          />
          {parsed ? (
            <p className="text-muted-foreground text-sm">
              {fileName} — {parsed.rows.length} rows, {parsed.headers.length}{" "}
              columns
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="import-list">Import into list</Label>
          <Select value={listId} onValueChange={setListId}>
            <SelectTrigger id="import-list">
              <SelectValue placeholder="Choose a list" />
            </SelectTrigger>
            <SelectContent>
              {lists.map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {list.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="import-dedup">Duplicate phone numbers</Label>
          <Select
            value={dedup}
            onValueChange={(v) => setDedup(v as "skip" | "update")}
          >
            <SelectTrigger id="import-dedup">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Skip duplicates</SelectItem>
              <SelectItem value="update">Update existing leads</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end pt-2">
          <Button onClick={() => setStep("map")} disabled={!parsed || !listId}>
            <Upload className="size-4" />
            Continue
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
