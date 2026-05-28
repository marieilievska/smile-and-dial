"use client";

import {
  DollarSign,
  Globe,
  MapPin,
  MessageSquare,
  Phone,
  Plus,
  PhoneCall,
  Search,
  SearchX,
} from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { formatPhone } from "@/lib/format-phone";
import { purchaseNumber, searchNumbers } from "@/lib/twilio/number-actions";
import type { AvailableNumber, Country } from "@/lib/twilio/numbers";

import { DialogSection } from "../dialog-section";

export function BuyNumberDialog() {
  const [open, setOpen] = useState(false);
  const [country, setCountry] = useState<Country>("US");
  const [areaCode, setAreaCode] = useState("");
  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [searching, startSearch] = useTransition();
  const [buying, startBuy] = useTransition();

  function search() {
    startSearch(async () => {
      const result = await searchNumbers({ country, areaCode });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setResults(result.numbers);
    });
  }

  function buy(number: AvailableNumber) {
    startBuy(async () => {
      const result = await purchaseNumber({
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName,
        country,
        monthlyCost: number.monthlyCost,
      });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Number purchased.");
        setOpen(false);
        setResults(null);
        setAreaCode("");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setResults(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Buy number
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Buy a phone number</DialogTitle>
          <DialogDescription>
            Search Twilio&apos;s inventory and add a number to the workspace
            pool. Numbers cost ~$1.15/mo plus per-call usage.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <DialogSection
            icon={<Globe className="size-3.5" />}
            title="Country"
            description="The country the number is in. Determines where it can dial cheaply."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="buy-country">Country</Label>
              <Select
                value={country}
                onValueChange={(value) => setCountry(value as Country)}
              >
                <SelectTrigger id="buy-country" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="US">United States · +1</SelectItem>
                  <SelectItem value="CA">Canada · +1</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </DialogSection>

          <DialogSection
            icon={<MapPin className="size-3.5" />}
            title="Area code"
            description="Optional. Skipping this returns numbers from any region."
          >
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="buy-area-code">Area code</Label>
                <Input
                  id="buy-area-code"
                  value={areaCode}
                  placeholder="e.g. 415, 212, 312"
                  onChange={(event) => setAreaCode(event.target.value)}
                />
              </div>
              <Button
                variant="outline"
                onClick={search}
                disabled={searching}
                aria-label="Search Twilio inventory"
              >
                <Search className="size-4" />
                {searching ? "Searching…" : "Search"}
              </Button>
            </div>
          </DialogSection>

          {results !== null ? (
            results.length > 0 ? (
              <DialogSection
                icon={<Phone className="size-3.5" />}
                title="Available numbers"
                description={`${results.length} ${results.length === 1 ? "number" : "numbers"} found. Click Buy to add it to your pool.`}
              >
                <ul className="flex flex-col gap-2">
                  {results.map((number) => (
                    <li
                      key={number.phoneNumber}
                      className="border-border hover:bg-muted/30 flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex items-baseline gap-2">
                          <p className="text-foreground font-mono text-sm font-medium">
                            {formatPhone(number.phoneNumber)}
                          </p>
                          <CapabilityChip
                            icon={<PhoneCall className="size-2.5" />}
                            label="Voice"
                          />
                          <CapabilityChip
                            icon={<MessageSquare className="size-2.5" />}
                            label="SMS"
                          />
                        </div>
                        <p className="text-muted-foreground inline-flex items-center gap-1 text-xs tabular-nums">
                          <DollarSign className="size-3" />
                          {number.monthlyCost.toFixed(2)}/mo · $
                          {(number.monthlyCost * 12).toFixed(2)}/yr
                        </p>
                      </div>
                      <Button
                        size="sm"
                        aria-label={`Buy ${number.phoneNumber}`}
                        disabled={buying}
                        onClick={() => buy(number)}
                      >
                        {buying ? "Buying…" : "Buy"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </DialogSection>
            ) : (
              <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
                <SearchX className="text-muted-foreground size-6" />
                <p className="text-foreground text-sm font-medium">
                  No numbers in {country === "US" ? "the US" : "Canada"}
                  {areaCode ? ` for area code ${areaCode}` : ""}
                </p>
                <p className="text-muted-foreground max-w-xs text-xs">
                  Try a nearby area code — Twilio inventory ebbs and flows.
                  Common nearby codes for {areaCode || "your region"}:{" "}
                  {country === "US" ? "212, 415, 312, 213" : "416, 604, 514"}.
                </p>
              </div>
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CapabilityChip({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <span className="border-border bg-muted/50 text-muted-foreground inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[10px] font-medium">
      {icon}
      {label}
    </span>
  );
}
