"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Campaign = { id: string; name: string };

/**
 * URL-driven filter bar for the Calls table. Submits via a normal GET form
 * so the server component re-renders with the new searchParams. Picking
 * "All …" clears the param entirely by submitting empty values.
 */
export function CallsFilters({
  campaigns,
  initial,
}: {
  campaigns: Campaign[];
  initial: {
    q: string;
    direction: string;
    status: string;
    outcome: string;
    campaign: string;
    from: string;
    to: string;
  };
}) {
  // Track local state so the user can clear a Select dropdown without
  // submitting. The native form submission still uses the underlying
  // <input name=...> hidden fields below.
  const [direction, setDirection] = useState(initial.direction);
  const [status, setStatus] = useState(initial.status);
  const [outcome, setOutcome] = useState(initial.outcome);
  const [campaign, setCampaign] = useState(initial.campaign);

  return (
    <form
      method="get"
      action="/calls"
      className="flex flex-wrap items-end gap-2"
    >
      <div className="flex flex-col gap-2">
        <label
          htmlFor="calls-q"
          className="text-foreground text-sm font-medium"
        >
          Search
        </label>
        <Input
          id="calls-q"
          name="q"
          defaultValue={initial.q}
          placeholder="Company, phone, or email"
          className="w-56"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="calls-direction"
          className="text-foreground text-sm font-medium"
        >
          Direction
        </label>
        <Select
          value={direction || "__any__"}
          onValueChange={(value) =>
            setDirection(value === "__any__" ? "" : value)
          }
        >
          <SelectTrigger id="calls-direction" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">Any</SelectItem>
            <SelectItem value="outbound">Outbound</SelectItem>
            <SelectItem value="inbound">Inbound</SelectItem>
          </SelectContent>
        </Select>
        <input type="hidden" name="direction" value={direction} />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="calls-status"
          className="text-foreground text-sm font-medium"
        >
          Status
        </label>
        <Select
          value={status || "__any__"}
          onValueChange={(value) => setStatus(value === "__any__" ? "" : value)}
        >
          <SelectTrigger id="calls-status" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">Any</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="in_progress">In progress</SelectItem>
            <SelectItem value="ringing">Ringing</SelectItem>
            <SelectItem value="dialing">Dialing</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <input type="hidden" name="status" value={status} />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="calls-outcome"
          className="text-foreground text-sm font-medium"
        >
          Outcome
        </label>
        <Select
          value={outcome || "__any__"}
          onValueChange={(value) =>
            setOutcome(value === "__any__" ? "" : value)
          }
        >
          <SelectTrigger id="calls-outcome" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">Any</SelectItem>
            <SelectItem value="voicemail">Voicemail</SelectItem>
            <SelectItem value="no_answer">No answer</SelectItem>
            <SelectItem value="busy">Busy</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="gatekeeper">Gatekeeper</SelectItem>
            <SelectItem value="not_interested">Not interested</SelectItem>
            <SelectItem value="callback">Callback</SelectItem>
            <SelectItem value="goal_met">Goal met</SelectItem>
            <SelectItem value="dnc">DNC</SelectItem>
            <SelectItem value="invalid_number">Invalid number</SelectItem>
            <SelectItem value="language_barrier">Language barrier</SelectItem>
            <SelectItem value="ai_receptionist">AI receptionist</SelectItem>
            <SelectItem value="ai_error">AI error</SelectItem>
            <SelectItem value="transferred_to_human">
              Transferred to human
            </SelectItem>
            <SelectItem value="hung_up_immediately">
              Hung up immediately
            </SelectItem>
          </SelectContent>
        </Select>
        <input type="hidden" name="outcome" value={outcome} />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="calls-campaign"
          className="text-foreground text-sm font-medium"
        >
          Campaign
        </label>
        <Select
          value={campaign || "__any__"}
          onValueChange={(value) =>
            setCampaign(value === "__any__" ? "" : value)
          }
        >
          <SelectTrigger id="calls-campaign" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">Any</SelectItem>
            {campaigns.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input type="hidden" name="campaign" value={campaign} />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="calls-from"
          className="text-foreground text-sm font-medium"
        >
          Started from
        </label>
        <Input
          id="calls-from"
          name="from"
          type="date"
          defaultValue={initial.from}
          className="w-40"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="calls-to"
          className="text-foreground text-sm font-medium"
        >
          Started to
        </label>
        <Input
          id="calls-to"
          name="to"
          type="date"
          defaultValue={initial.to}
          className="w-40"
        />
      </div>

      <Button type="submit" variant="outline">
        Filter
      </Button>
    </form>
  );
}
