"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
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
import { purchaseNumber, searchNumbers } from "@/lib/twilio/number-actions";
import type { AvailableNumber, Country } from "@/lib/twilio/numbers";

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Buy a phone number</DialogTitle>
          <DialogDescription>
            Search for a number to add to the workspace pool.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="buy-country">Country</Label>
              <Select
                value={country}
                onValueChange={(value) => setCountry(value as Country)}
              >
                <SelectTrigger id="buy-country" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="US">US</SelectItem>
                  <SelectItem value="CA">CA</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="buy-area-code">Area code</Label>
              <Input
                id="buy-area-code"
                value={areaCode}
                placeholder="Optional, e.g. 415"
                onChange={(event) => setAreaCode(event.target.value)}
              />
            </div>
            <Button variant="outline" onClick={search} disabled={searching}>
              {searching ? "Searching…" : "Search"}
            </Button>
          </div>

          {results !== null ? (
            results.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {results.map((number) => (
                  <li
                    key={number.phoneNumber}
                    className="border-border flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    <div className="flex-1">
                      <p className="text-foreground text-sm font-medium">
                        {number.friendlyName}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        ~${number.monthlyCost.toFixed(2)}/mo
                      </p>
                    </div>
                    <Button
                      size="sm"
                      aria-label={`Buy ${number.phoneNumber}`}
                      disabled={buying}
                      onClick={() => buy(number)}
                    >
                      Buy
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">
                No numbers found. Try a different area code.
              </p>
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
