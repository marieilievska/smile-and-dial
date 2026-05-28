"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

const TABS = ["Endpoint", "Body", "Responses", "cURL"] as const;
type TabKey = (typeof TABS)[number];

/** Tabbed API documentation block. Round 23 — replaces the wall of
 *  stacked `<pre>` snippets with a single docs card whose tabs swap
 *  the visible snippet. Each snippet has a one-click Copy button
 *  that flips to a green check for 1.5s.
 *
 *  Pure client UX — no server state. Mirrors the costs view tabs:
 *  buttons toggle local state rather than navigating, because the
 *  docs are reference material, not URL-bound. */
const ENDPOINT_SNIPPET = `POST /api/v1/leads

Headers
  Authorization: Bearer sk_…
  Content-Type: application/json
  Idempotency-Key: <optional-uuid>`;

const BODY_SNIPPET = `{
  "business_phone": "+18005551234",
  "company": "Acme Gym",
  "city": "Austin",
  "state": "TX",
  "business_email": "info@acmegym.com",
  "owner_name": "Pat Smith",
  "list": "January Partner Imports",
  "custom_fields": { "tier": "gold" }
}`;

const CURL_SNIPPET = `curl -X POST https://your.app/api/v1/leads \\
  -H "Authorization: Bearer sk_…" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"business_phone":"+18005551234","company":"Acme"}'`;

export function ApiDocsTabs() {
  const [tab, setTab] = useState<TabKey>("Endpoint");
  return (
    <div className="flex flex-col gap-3">
      <nav
        aria-label="API documentation sections"
        className="border-border bg-background inline-flex flex-wrap items-center gap-0.5 self-start rounded-lg border p-1"
      >
        {TABS.map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-current={active ? "page" : undefined}
              className={`inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors ${
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
            >
              {t}
            </button>
          );
        })}
      </nav>

      {tab === "Endpoint" ? <Snippet text={ENDPOINT_SNIPPET} /> : null}
      {tab === "Body" ? (
        <>
          <p className="text-muted-foreground text-xs">
            Only <code className="font-mono">business_phone</code> is required.
            Everything else is optional.
          </p>
          <Snippet text={BODY_SNIPPET} />
        </>
      ) : null}
      {tab === "Responses" ? <ResponsesTable /> : null}
      {tab === "cURL" ? <Snippet text={CURL_SNIPPET} /> : null}
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; ignore.
    }
  }
  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        aria-label={copied ? "Copied snippet" : "Copy snippet"}
        className="absolute top-2 right-2"
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
      <pre className="bg-muted overflow-x-auto rounded-md p-3 pr-20 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

const RESPONSES: {
  code: string;
  label: string;
  tone: "success" | "warn" | "destructive";
}[] = [
  {
    code: "201 Created",
    label: "New lead. Response has id + status: created.",
    tone: "success",
  },
  {
    code: "200 OK",
    label: "Phone already exists. Response has id + status: duplicate.",
    tone: "warn",
  },
  {
    code: "400",
    label: "Missing business_phone or invalid JSON.",
    tone: "destructive",
  },
  { code: "401", label: "Missing or malformed key.", tone: "destructive" },
  { code: "403", label: "Invalid or revoked key.", tone: "destructive" },
];

function ResponsesTable() {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {RESPONSES.map((r) => (
        <li
          key={r.code}
          className="border-border bg-muted/20 flex flex-wrap items-center gap-3 rounded-md border p-2.5"
        >
          <code
            className={`font-mono text-xs font-medium ${
              r.tone === "success"
                ? "text-emerald-600 dark:text-emerald-400"
                : r.tone === "warn"
                  ? "text-primary"
                  : "text-destructive"
            }`}
          >
            {r.code}
          </code>
          <span className="text-muted-foreground text-xs">{r.label}</span>
        </li>
      ))}
    </ul>
  );
}
