"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Upload } from "lucide-react";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { importDnc, type DncImportResult } from "@/lib/dnc/import-actions";

type Parsed = { headers: string[]; rows: Record<string, string>[] };

const NO_COMPANY = "__none__";

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

export function DncImportWizard() {
  const [step, setStep] = useState<"upload" | "map" | "done">("upload");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState("");
  const [phoneHeader, setPhoneHeader] = useState("");
  const [companyHeader, setCompanyHeader] = useState("");
  const [result, setResult] = useState<DncImportResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
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

  if (step === "upload") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Upload CSV</CardTitle>
          <CardDescription>
            Required: a phone column (E.164 like <code>+15551234567</code> or a
            10-digit US number). Optional: a company column.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="dnc-csv" className="sr-only">
            CSV file
          </Label>
          <Input
            id="dnc-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
          />
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
            {fileName} — {plural(parsed.rows.length, "row")}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
            <Label htmlFor="dnc-company-col">Company column (optional)</Label>
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
          <p className="text-muted-foreground text-sm">
            Reason is set to <strong>Imported</strong> on every row. Numbers
            already on the list are skipped silently.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setParsed(null);
                setPhoneHeader("");
                setCompanyHeader("");
                setStep("upload");
              }}
            >
              Back
            </Button>
            <Button onClick={submit} disabled={pending || !phoneHeader}>
              <Upload className="size-4" />
              {pending ? "Importing…" : "Import"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === "done" && result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="text-success size-5" />
            Import complete
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="text-foreground space-y-1 text-sm">
            <li>{plural(result.added, "number")} added to DNC</li>
            <li className="text-muted-foreground">
              {plural(result.skippedDuplicate, "duplicate")} skipped (already on
              DNC)
            </li>
            <li className="text-muted-foreground">
              {plural(result.skippedInvalid, "row")} skipped (invalid phone)
            </li>
          </ul>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setParsed(null);
                setFileName("");
                setPhoneHeader("");
                setCompanyHeader("");
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
    );
  }

  return null;
}
