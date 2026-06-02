"use client";

import { ArrowRight, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { askSmile, type AskSmileResult } from "@/lib/ai/ask-smile";
import { cn } from "@/lib/utils";

type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; result: AskSmileResult };

const SUGGESTIONS = [
  "How do I create an agent?",
  "How do I launch a campaign?",
  "What should I do next?",
  "How's my connect rate today?",
];

/** "Ask Smile" co-pilot launcher + side panel. Lives in the top bar.
 *  A grounded Q&A surface: every answer is computed from the live
 *  workspace snapshot server-side (see lib/ai/ask-smile). Read-only. */
export function AskSmile() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  function ask(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    setTurns((t) => [...t, { role: "user", text: q }]);
    setInput("");
    startTransition(async () => {
      const result = await askSmile(q);
      setTurns((t) => [...t, { role: "assistant", result }]);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      });
    });
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground gap-1.5"
          aria-label="Ask Smile"
          data-testid="ask-smile-trigger"
        >
          <Sparkles className="size-4" />
          <span className="hidden sm:inline">Ask Smile</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
        data-testid="ask-smile-panel"
      >
        <SheetHeader className="border-border border-b">
          <SheetTitle className="flex items-center gap-2">
            <span
              className="text-primary flex size-7 items-center justify-center rounded-lg"
              style={{
                backgroundColor:
                  "color-mix(in oklab, var(--primary) 14%, transparent)",
              }}
            >
              <Sparkles className="size-4" />
            </span>
            Ask Smile
          </SheetTitle>
          <SheetDescription>
            Ask how to do anything in Smile &amp; Dial — &ldquo;how do I create
            an agent?&rdquo; — or about today&apos;s calls, connect rate, costs,
            and what to do next.
          </SheetDescription>
        </SheetHeader>

        <div
          ref={scrollRef}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
        >
          {turns.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Try asking
              </p>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="border-border bg-card hover:bg-muted/50 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors"
                >
                  <span>{s}</span>
                  <ArrowRight className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              ))}
            </div>
          ) : (
            turns.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-sm">
                    {turn.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-2">
                  <div className="bg-muted/60 text-foreground max-w-[90%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed whitespace-pre-line">
                    {turn.result.answer}
                  </div>
                  {turn.result.href ? (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="w-fit"
                    >
                      <Link
                        href={turn.result.href}
                        onClick={() => setOpen(false)}
                      >
                        {turn.result.hrefLabel ?? "Take me there"}
                        <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ),
            )
          )}
          {pending ? (
            <div className="flex justify-start">
              <div className="bg-muted/60 text-muted-foreground inline-flex items-center gap-1.5 rounded-2xl rounded-bl-sm px-3 py-2 text-sm">
                <Sparkles className="size-3.5 animate-pulse" />
                Thinking…
              </div>
            </div>
          ) : null}
        </div>

        <form
          className="border-border flex items-center gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your workspace…"
            aria-label="Ask Smile a question"
            data-testid="ask-smile-input"
            disabled={pending}
          />
          <Button
            type="submit"
            size="icon"
            disabled={pending || !input.trim()}
            aria-label="Send"
            className={cn(!input.trim() && "opacity-50")}
          >
            <Send className="size-4" />
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
