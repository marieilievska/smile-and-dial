"use client";

import { useState, useTransition } from "react";
import { Combine, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  mergeInboundLead,
  searchMergeCandidates,
  type MergeCandidate,
} from "@/lib/leads/lead-actions";

/**
 * "Merge into existing lead" dialog. Only rendered for auto-created
 * inbound leads (see LeadDetailModal). Search the user's other leads,
 * pick a destination, confirm — the source soft-deletes and its calls /
 * callbacks repoint to the destination.
 */
export function MergeInboundDialog({ sourceLeadId }: { sourceLeadId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MergeCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [pending, startTransition] = useTransition();

  async function runSearch() {
    setSearching(true);
    try {
      const result = await searchMergeCandidates({
        sourceLeadId,
        query,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setResults(result.candidates);
      setSelectedId("");
    } finally {
      setSearching(false);
    }
  }

  function confirm() {
    if (!selectedId) return;
    startTransition(async () => {
      const result = await mergeInboundLead({
        sourceLeadId,
        destinationLeadId: selectedId,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Merged into the destination lead.");
      setOpen(false);
      // Navigate to the destination lead's detail view.
      router.push(`/leads/${selectedId}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Combine className="size-4" />
          Merge into existing lead
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge into existing lead</DialogTitle>
          <DialogDescription>
            Search your leads, then pick the one this inbound caller actually
            belongs to. Empty fields on the destination get filled from the
            source; call history and callbacks move over; the inbound lead is
            archived.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label htmlFor="merge-search">
            Search by company, phone, or email
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="merge-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch();
                }
              }}
              placeholder="Acme, +1555…"
            />
            <Button
              type="button"
              variant="outline"
              onClick={runSearch}
              disabled={!query || searching}
            >
              <Search className="size-4" />
              Search
            </Button>
          </div>

          {results.length > 0 ? (
            <div
              className="border-border flex flex-col rounded-lg border"
              role="listbox"
              aria-label="Merge candidates"
            >
              {results.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={`hover:bg-muted/50 flex items-center justify-between gap-3 px-3 py-2 text-left ${
                    selectedId === c.id ? "bg-muted" : ""
                  }`}
                  aria-selected={selectedId === c.id}
                  role="option"
                >
                  <span className="text-foreground text-sm font-medium">
                    {c.company ?? "—"}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {c.business_phone ?? "—"}
                  </span>
                </button>
              ))}
            </div>
          ) : query && !searching ? (
            <p className="text-muted-foreground text-sm">
              No matches yet — try a different search.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={confirm} disabled={!selectedId || pending}>
            {pending ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
