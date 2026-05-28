"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  ShieldCheck,
  User,
  UserPlus,
} from "lucide-react";
import { useMemo, useState, useTransition } from "react";
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
import { inviteUser } from "@/lib/users/actions";

import { DialogSection } from "../dialog-section";

type Role = "admin" | "member";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_META: Record<
  Role,
  { label: string; helper: string; icon: React.ReactNode }
> = {
  member: {
    label: "Member",
    helper: "Can run campaigns, import leads, and manage their own assets.",
    icon: <User className="size-3.5" />,
  },
  admin: {
    label: "Admin",
    helper:
      "Member access plus settings: users, integrations, custom fields, Twilio numbers, API keys.",
    icon: <ShieldCheck className="size-3.5" />,
  },
};

/** Invite-user dialog. Round 24 — segmented role control with
 *  per-option helper, live email validation, and a Sentence-case
 *  description that mentions the one-shot nature of the invite. The
 *  "Send invitation" button still has its exact label so the
 *  Playwright test continues to find it. */
export function InviteUserDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [pending, startTransition] = useTransition();

  const validity = useMemo<"idle" | "valid" | "invalid">(() => {
    const trimmed = email.trim();
    if (!trimmed) return "idle";
    return EMAIL_RE.test(trimmed) ? "valid" : "invalid";
  }, [email]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (validity !== "valid") return;
    const trimmed = email.trim();
    startTransition(async () => {
      try {
        const result = await inviteUser(trimmed, role);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(`Invitation sent to ${trimmed}.`);
          setEmail("");
          setRole("member");
          setOpen(false);
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setEmail("");
          setRole("member");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="size-4" />
          Invite user
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a user</DialogTitle>
          <DialogDescription>
            They&apos;ll get a one-time link to set a password and join the
            workspace. The link expires in 24 hours.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogSection
            icon={<Mail className="size-3.5" />}
            title="Email"
            description="Work email is best — we use it for sign-in too."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <div className="relative">
                <Input
                  id="invite-email"
                  name="email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={validity === "invalid"}
                  className={
                    validity === "invalid"
                      ? "aria-invalid:ring-destructive/30 aria-invalid:border-destructive pr-9"
                      : "pr-9"
                  }
                  placeholder="pat@example.com"
                  required
                />
                {validity === "valid" ? (
                  <CheckCircle2 className="text-success absolute top-1/2 right-2.5 size-4 -translate-y-1/2" />
                ) : validity === "invalid" ? (
                  <AlertTriangle className="text-destructive absolute top-1/2 right-2.5 size-4 -translate-y-1/2" />
                ) : null}
              </div>
              {validity === "invalid" ? (
                <p className="text-destructive text-xs">
                  That doesn&apos;t look like a valid email address.
                </p>
              ) : null}
            </div>
          </DialogSection>

          <DialogSection
            icon={ROLE_META[role].icon}
            title="Role"
            description={ROLE_META[role].helper}
          >
            <div
              role="radiogroup"
              aria-label="Role"
              className="border-border bg-background inline-flex w-full items-center gap-0.5 self-start rounded-lg border p-1"
            >
              {(Object.keys(ROLE_META) as Role[]).map((r) => {
                const active = r === role;
                return (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setRole(r)}
                    className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
                      active
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    }`}
                  >
                    {ROLE_META[r].icon}
                    {ROLE_META[r].label}
                  </button>
                );
              })}
            </div>
          </DialogSection>

          <DialogFooter className="flex-row items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || validity !== "valid"}>
              {pending ? "Sending…" : "Send invitation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
