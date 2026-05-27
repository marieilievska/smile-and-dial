"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addToDnc, type DncReason } from "@/lib/dnc/actions";

const REASONS: { value: DncReason; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "dnc_requested", label: "Caller requested" },
  { value: "invalid_number", label: "Invalid number" },
  { value: "language_barrier", label: "Language barrier" },
  { value: "imported", label: "Imported" },
];

export function AddDncDialog() {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState<DncReason>("manual");
  const [company, setCompany] = useState("");
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const result = await addToDnc({ phone, reason, company });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Added to DNC.");
        setOpen(false);
        setPhone("");
        setReason("manual");
        setCompany("");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Add number
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to do-not-call list</DialogTitle>
          <DialogDescription>
            Numbers on this list are blocked at dial time.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="dnc-phone">Phone</Label>
            <Input
              id="dnc-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1…  (E.164)"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="dnc-reason">Reason</Label>
            <Select
              value={reason}
              onValueChange={(value) => setReason(value as DncReason)}
            >
              <SelectTrigger id="dnc-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="dnc-company">Company</Label>
            <Input
              id="dnc-company"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !phone.trim()}>
            {pending ? "Adding…" : "Add to DNC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
