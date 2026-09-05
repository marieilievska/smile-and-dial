import { describe, expect, it } from "vitest";

import { classifyCallOutcome, hangUpKind } from "@/lib/calls/classify-outcome";

/** Convenience: build a transcript of {role, message} turns. */
const t = (...turns: [string, string][]) =>
  turns.map(([role, message]) => ({ role, message }));

const VM_DETECTED = "voicemail_detection tool was called.";
const SILENCE = "Ending conversation after 40 seconds of silence.";

describe("classifyCallOutcome", () => {
  it("labels a plain answering-machine greeting as voicemail", () => {
    const r = classifyCallOutcome({
      transcript: t([
        "user",
        "You've reached Dr. Smith's office. Please leave a message after the tone.",
      ]),
      disposition: "gatekeeper", // LLM often mis-guesses on a greeting
      terminationReason: VM_DETECTED,
      callDurationSecs: 20,
    });
    expect(r.outcome).toBe("voicemail");
    expect(r.reachedHuman).toBe(false);
  });

  it("keeps voicemail when EL fires voicemail_detection and nobody really replied", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Hi, thank you for calling. We are currently closed."],
        ["agent", "Hi there, I'm calling for the owner..."],
      ),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 25,
    });
    expect(r.outcome).toBe("voicemail");
    expect(r.reachedHuman).toBe(false);
  });

  it("does NOT let a voicemail tail erase a real human gatekeeper conversation (Vida Fitness)", () => {
    // A real front-desk person answered, talked, offered to transfer — then the
    // transfer dumped the AI into an extension mailbox at the very end. EL fired
    // voicemail_detection and the LLM guessed disposition=voicemail, but a human
    // was clearly reached: this must be a gatekeeper, not a voicemail.
    const r = classifyCallOutcome({
      transcript: t(
        [
          "user",
          "Thank you for calling Vida Fitness. Press one for new membership inquiries. Press two for the front desk.",
        ],
        ["user", "Thank you for calling Vida. How can I help you?"],
        ["agent", "Hey, can I have fifteen seconds? You can hang up on me."],
        ["user", "Sure."],
        ["agent", "You wouldn't happen to be the owner there, would ya?"],
        ["user", "No."],
        ["agent", "Is there a better time I can call and grab them?"],
        ["user", "I can transfer you to my manager if that helps."],
        ["agent", "Yeah, that'd be perfect."],
        ["user", "All righty, give me one second."],
        [
          "user",
          "The person at extension 106 is unavailable. Please leave your message after the tone.",
        ],
      ),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 116,
    });
    expect(r.outcome).toBe("gatekeeper");
    expect(r.reachedHuman).toBe(true);
  });

  it("prefers a real human disposition over voicemail when a human replied", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Hi, is the owner around?"],
        ["user", "Not interested, thanks."],
        ["agent", "No worries, have a good one."],
        ["user", "Bye now."],
      ),
      disposition: "not_interested",
      terminationReason: VM_DETECTED,
      callDurationSecs: 30,
    });
    expect(r.outcome).toBe("not_interested");
    expect(r.reachedHuman).toBe(true);
  });

  it("labels an AI receptionist (self-identified) as ai_receptionist, not voicemail", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Hello, I am your AI receptionist. How can I help you?"],
        ["agent", "Hi, are you the owner there?"],
        [
          "user",
          "No, I'm the automated receptionist for Revive Pain Solutions.",
        ],
      ),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 85,
    });
    expect(r.outcome).toBe("ai_receptionist");
    expect(r.reachedHuman).toBe(false);
  });

  it("labels a 'virtual assistant' bot as ai_receptionist", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Hi, are you the owner?"],
        [
          "user",
          "Hello. I am Atlas, your virtual assistant from Evolve Med Spa. How can I help you today?",
        ],
      ),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 43,
    });
    expect(r.outcome).toBe("ai_receptionist");
    expect(r.reachedHuman).toBe(false);
  });

  it("labels dead air (agent talks, only silence from the other end) as no_answer", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "..."],
        [
          "agent",
          "Hey, are you still there? I caught a little silence on the line. If you can hear me, just let me know.",
        ],
      ),
      disposition: "voicemail", // LLM guesses voicemail on silence
      terminationReason: SILENCE,
      callDurationSecs: 40,
    });
    expect(r.outcome).toBe("no_answer");
    expect(r.reachedHuman).toBe(false);
  });

  it("keeps an IVR phone-tree the AI got stuck in as voicemail (not human)", () => {
    // SevLaser-style menu loop: opening is a menu, later turns are error text —
    // NOT genuine human replies. EL fires voicemail_detection. Must stay
    // voicemail (no human reached), never flip to gatekeeper.
    const r = classifyCallOutcome({
      transcript: t(
        [
          "user",
          "Thank you for calling Sev Laser. For directions, press one. To make an appointment, press two.",
        ],
        ["agent", "Tom from HireAI."],
        ["user", "That option is invalid. Please try again."],
        ["agent", "Hi, I'm calling for the owner."],
        ["user", "Sorry, you're having problem."],
      ),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 131,
    });
    expect(r.outcome).toBe("voicemail");
    expect(r.reachedHuman).toBe(false);
  });

  it("does not misclassify a Spanish-language voicemail greeting as human", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Gracias. Permanece en la linea."],
        ["agent", "Hola, llamo para el dueño."],
        [
          "user",
          "No puedo hablar ahora. Puedes dejar un mensaje después del tono.",
        ],
      ),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 45,
    });
    expect(r.outcome).toBe("voicemail");
    expect(r.reachedHuman).toBe(false);
  });

  it("preserves existing dispositions for normal live calls", () => {
    for (const [disposition, expected] of [
      ["callback", "callback"],
      ["goal_met", "goal_met"],
      ["not_interested", "not_interested"],
      ["dnc", "dnc"],
      ["gatekeeper", "gatekeeper"],
    ] as const) {
      const r = classifyCallOutcome({
        transcript: t(
          ["agent", "Hi, this is Sara at Referrizer."],
          ["user", "Hi, this is Mike, go ahead."],
        ),
        disposition,
        terminationReason: "",
        callDurationSecs: 92,
      });
      expect(r.outcome).toBe(expected);
    }
  });

  it("maps a gatekeeper_not_interested disposition to its outcome (a reached human, not DM-implying)", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Seaside Chiropractic, this is Sue."],
        ["agent", "Hi Sue, are you the owner?"],
        ["user", "No, and we're not interested, thanks."],
      ),
      disposition: "gatekeeper_not_interested",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 40,
    });
    expect(r.outcome).toBe("gatekeeper_not_interested");
    // A real human conversation happened (a screener declined), so reachedHuman
    // is true — but it must NOT be treated as reaching the decision-maker.
    expect(r.reachedHuman).toBe(true);
  });

  it("still infers an immediate hang-up on a sub-20s call the other party ended", () => {
    const r = classifyCallOutcome({
      transcript: t(["agent", "Hi, is the owner around?"]), // no reply
      disposition: "gatekeeper", // LLM guess on a 5-second call
      terminationReason: "The remote party hung up.",
      callDurationSecs: 5,
    });
    expect(r.outcome).toBe("hung_up_immediately");
    expect(r.reachedHuman).toBe(false);
  });

  it("splits a hang-up into immediate (no real reply, ≤30s) vs later (engaged or stayed on)", () => {
    // No reply, short → immediate.
    const immediate = classifyCallOutcome({
      transcript: t(["agent", "Hi, honestly I'm calling out of the blue..."]),
      disposition: "hung_up",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 8,
    });
    expect(immediate.outcome).toBe("hung_up_immediately");

    // They said something back before hanging up → later, even though short.
    const engaged = classifyCallOutcome({
      transcript: t(
        ["agent", "Hi, is the owner around?"],
        ["user", "Yeah, who's this?"],
      ),
      disposition: "hung_up",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 30,
    });
    expect(engaged.outcome).toBe("hung_up_later");
    expect(engaged.reachedHuman).toBe(false);

    // No reply, but stayed on the line past 30s → later.
    const stayedOn = classifyCallOutcome({
      transcript: t(["agent", "Hi, honestly I'm calling out of the blue..."]),
      disposition: "hung_up",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 45,
    });
    expect(stayedOn.outcome).toBe("hung_up_later");
  });

  // 2026-09-02: 54 of 144 "later" calls were a receptionist greeting + Tom's
  // opener + click at 16–20s, and ~25 more were a bare "Hello?" counted as a
  // reply. Neither is engagement — both are immediate hang-ups.
  it("immediate: receptionist greeting + opener + click at 19s, no reply", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Honeycomb Salon, this is Erica. How may I help you?"],
        [
          "agent",
          "Oh hey, honestly I'm calling a little out of the blue here…",
        ],
      ),
      disposition: "",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 19,
    });
    expect(r.outcome).toBe("hung_up_immediately");
  });

  it("immediate: a bare 'Hello?' after the opener is not engagement", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Hi, is the owner around?"],
        ["user", "Hello?"],
        ["agent", "Hi, honestly I'm calling a little out of the blue…"],
        ["user", "Hello? Hello?"],
      ),
      disposition: "hung_up",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 22,
    });
    expect(r.outcome).toBe("hung_up_immediately");
  });

  it("later: a real remark before the click stays hung_up_later", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Hi, is the owner around?"],
        ["user", "You sound like a robot, man."],
      ),
      disposition: "hung_up",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 12,
    });
    expect(r.outcome).toBe("hung_up_later");
  });

  it("hangUpKind: boundary at 30s with no substantive reply", () => {
    expect(hangUpKind(30, 0)).toBe("hung_up_immediately");
    expect(hangUpKind(31, 0)).toBe("hung_up_later");
    expect(hangUpKind(3, 1)).toBe("hung_up_later"); // a real reply → later
    expect(hangUpKind(0, 0)).toBe("hung_up_immediately");
  });

  it("falls back to a telephony state when there's no disposition", () => {
    const r = classifyCallOutcome({
      transcript: [],
      disposition: "",
      terminationReason: "no answer - timeout",
      callDurationSecs: 0,
    });
    expect(r.outcome).toBe("no_answer");
  });

  // REGRESSION (Aug 2026): ~1,000 completed calls were left with outcome=null.
  // ElevenLabs sends termination_reason "Call ended by remote party" (the far
  // end hung up) — which is NOT voicemail/silence/busy/failure — and the agent
  // often extracts no disposition. With no telephony signal and no disposition,
  // the classifier returned null and the post-call webhook (which writes the
  // outcome exactly once) left the call blank forever. classifyCallOutcome must
  // now ALWAYS resolve to a real bucket.
  describe("final fallback — never returns null", () => {
    it("empty transcript, no disposition, remote party ended, 0s → hung_up_immediately", () => {
      const r = classifyCallOutcome({
        transcript: [],
        disposition: "",
        terminationReason: "Call ended by remote party",
        callDurationSecs: 0,
      });
      expect(r.outcome).toBe("hung_up_immediately");
      expect(r.reachedHuman).toBe(false);
    });

    it("empty transcript, no disposition, remote party ended, 56s → hung_up_later", () => {
      // Past the 20s short-hangup window, so the old code fell through to null.
      const r = classifyCallOutcome({
        transcript: [],
        disposition: "",
        terminationReason: "Call ended by remote party",
        callDurationSecs: 56,
      });
      expect(r.outcome).toBe("hung_up_later");
    });

    it("real two-way conversation, no disposition, remote party ended → gatekeeper", () => {
      // A person clearly engaged (>=2 genuine replies) but the agent extracted no
      // disposition. We reached someone but it's inconclusive → gatekeeper.
      const r = classifyCallOutcome({
        transcript: t(
          ["agent", "Hi, is the owner around?"],
          ["user", "This is she, what's this about?"],
          ["agent", "I'm calling about your webinar signup..."],
          ["user", "Oh right, can you send me the details?"],
        ),
        disposition: "",
        terminationReason: "Call ended by remote party",
        callDurationSecs: 62,
      });
      expect(r.outcome).toBe("gatekeeper");
      expect(r.reachedHuman).toBe(true);
    });

    it("across an unmapped-termination matrix, outcome is never null", () => {
      const cases = [
        { transcript: [], disposition: "", callDurationSecs: 0 },
        { transcript: [], disposition: "", callDurationSecs: 30 },
        {
          transcript: t(["agent", "Hi there..."]),
          disposition: "",
          callDurationSecs: 8,
        },
        {
          transcript: t(["agent", "Hi"], ["user", "yeah?"]),
          disposition: "",
          callDurationSecs: 25,
        },
      ];
      for (const c of cases) {
        const r = classifyCallOutcome({
          ...c,
          terminationReason: "Call ended by remote party",
        });
        expect(r.outcome).not.toBeNull();
      }
    });
  });

  it("labels an ElevenLabs quota-killed call as ai_error, not a hang-up", () => {
    // A live human answered ("this is Julie speaking") and the AI died mid-call
    // because ElevenLabs was out of quota. The agent guessed disposition=hung_up,
    // but the lead didn't hang up — our platform failed. That's ai_error.
    const r = classifyCallOutcome({
      transcript: t(
        [
          "user",
          "Trendy Wellness, this is Julie speaking. How may I help you?",
        ],
        [
          "agent",
          "Hey Julie, honestly I'm calling a little out of the blue...",
        ],
      ),
      disposition: "hung_up",
      terminationReason: "This request exceeds your quota limit.",
      callDurationSecs: 16,
    });
    expect(r.outcome).toBe("ai_error");
    expect(r.reachedHuman).toBe(false);
  });

  it("labels a call that died on silence as no_answer even when the agent guessed hung_up", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Hi, is the owner around?"],
        ["user", "Uh, who is this?"],
      ),
      disposition: "hung_up", // agent's fallback guess
      terminationReason: "Ending conversation after 40 seconds of silence.",
      callDurationSecs: 75,
    });
    expect(r.outcome).toBe("no_answer");
    expect(r.reachedHuman).toBe(false);
  });

  it("keeps a genuine short caller hang-up as hung_up_immediately", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Hello?"],
        ["agent", "Hey, honestly I'm calling a little out of the blue..."],
      ),
      disposition: "hung_up",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 12,
    });
    expect(r.outcome).toBe("hung_up_immediately");
    expect(r.reachedHuman).toBe(false);
  });

  it("does NOT downgrade a real human disposition to no_answer on a silence end", () => {
    // If the agent captured a real human outcome (not_interested), a trailing
    // silence must not erase it.
    // NB: the reply here is a plain decline on purpose. It used to read "take me
    // off your list", which is a DNC request in its own right — that now
    // (correctly) classifies as `dnc`, which would test the removal net rather
    // than the silence rule this case exists for.
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Is the owner around?"],
        ["user", "We're not interested, thanks."],
      ),
      disposition: "not_interested",
      terminationReason: "Ending conversation after 40 seconds of silence.",
      callDurationSecs: 45,
    });
    expect(r.outcome).toBe("not_interested");
    expect(r.reachedHuman).toBe(true);
  });

  describe("not_interested owner guard", () => {
    const reached = t(
      ["agent", "Hi, is the owner around?"],
      ["user", "This is the front desk, who's calling?"],
      ["agent", "It's Tom from HireAI..."],
      ["user", "We're not interested, thanks."],
    );
    const base = {
      transcript: reached,
      disposition: "not_interested",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 40,
    };

    it("keeps not_interested when the AI reached the owner (dm=yes)", () => {
      const r = classifyCallOutcome({ ...base, decisionMakerReached: "yes" });
      expect(r.outcome).toBe("not_interested");
      expect(r.reachedHuman).toBe(true);
    });

    it("downgrades to gatekeeper_not_interested when dm=no", () => {
      const r = classifyCallOutcome({ ...base, decisionMakerReached: "no" });
      expect(r.outcome).toBe("gatekeeper_not_interested");
      expect(r.reachedHuman).toBe(true);
    });

    it("downgrades when dm=unknown (or padded/upper-cased)", () => {
      expect(
        classifyCallOutcome({ ...base, decisionMakerReached: "unknown" })
          .outcome,
      ).toBe("gatekeeper_not_interested");
      expect(
        classifyCallOutcome({ ...base, decisionMakerReached: " No " }).outcome,
      ).toBe("gatekeeper_not_interested");
    });

    it("leaves not_interested unchanged when dm is missing (backward compatible)", () => {
      expect(classifyCallOutcome(base).outcome).toBe("not_interested");
    });

    it("only touches not_interested — a gatekeeper with dm=no stays gatekeeper", () => {
      const r = classifyCallOutcome({
        ...base,
        disposition: "gatekeeper",
        decisionMakerReached: "no",
      });
      expect(r.outcome).toBe("gatekeeper");
    });
  });
});

// INBOUND calls: the "user" is a person who dialed US back after a missed call.
// Nothing on our side of the line is a voicemail, so the outbound voicemail
// tells ("sorry I missed your call", EL voicemail_detection, a silent line)
// must never label an inbound call "voicemail".
describe("classifyCallOutcome — inbound direction", () => {
  it("a returning caller who says 'sorry I missed your call' then hangs up is a hang-up, not voicemail", () => {
    const r = classifyCallOutcome({
      direction: "inbound",
      transcript: t(
        ["agent", "Hello?"],
        [
          "user",
          "Hi, this is Noah with Free To Be Chiropractic. Sorry I missed your call.",
        ],
        [
          "agent",
          "Oh yeah, [laugh] that was actually me. I was calling earlier to see if I could invite you to a free Zoom session we run called Answer Every Call, Book Every Lead. Genuinely not trying to sell you anything,...",
        ],
      ),
      disposition: "",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 20,
    });
    expect(r.outcome).toBe("hung_up_immediately");
    expect(r.reachedHuman).toBe(false);
  });

  it("a silent inbound caller is a hang-up even when EL guessed voicemail", () => {
    const r = classifyCallOutcome({
      direction: "inbound",
      transcript: t(["agent", "Hello?"]),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 22,
    });
    expect(r.outcome).toBe("hung_up_immediately");
    expect(r.reachedHuman).toBe(false);
  });

  it("an inbound line that went dead is a hang-up, not no_answer", () => {
    const r = classifyCallOutcome({
      direction: "inbound",
      transcript: t(
        ["agent", "Hello?"],
        ["agent", "Hey, uh, are you still there?"],
      ),
      disposition: "",
      terminationReason: SILENCE,
      callDurationSecs: 32,
    });
    expect(r.outcome).toBe("hung_up_later");
    expect(r.reachedHuman).toBe(false);
  });

  it("outbound keeps the missed-your-call voicemail tell (direction unspecified)", () => {
    const r = classifyCallOutcome({
      transcript: t(
        [
          "user",
          "Hi, you've reached Free To Be Chiropractic. Sorry we missed your call, please leave a message.",
        ],
        ["agent", "Hi there, I'm calling for the owner..."],
      ),
      disposition: "",
      terminationReason: VM_DETECTED,
      callDurationSecs: 20,
    });
    expect(r.outcome).toBe("voicemail");
  });
});

// A person asking us to stop is compliance-critical and used to reach the
// classifier ONLY via the agent's own disposition guess. The 2026-09-05
// full-corpus audit (all 8,123 calls) found 5 calls where someone plainly said
// "don't call us again" but the agent said gatekeeper_not_interested — 4 were
// queued to be re-dialled. These lock in the safety net and the two traps that
// were proved against the corpus.
describe("classifyCallOutcome — lead asked to stop (DNC safety net)", () => {
  const ENDED = "Call ended by remote party";

  it("forces dnc when the lead says don't call again but the agent guessed a gatekeeper decline", () => {
    // Verbatim: Park & Eve - Hair Studio, 2026-09-04 (was queued for Sep 17).
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Hello, Puck and Eve. How can I help you?"],
        ["agent", "Hi, I'm reaching out to a few salons... are you the owner?"],
        ["user", "Nope. Don't call us again."],
      ),
      disposition: "gatekeeper_not_interested",
      terminationReason: ENDED,
      callDurationSecs: 23,
    });
    expect(r.outcome).toBe("dnc");
    expect(r.reachedHuman).toBe(true);
  });

  it("matches a CURLY apostrophe — ElevenLabs writes don’t, not don't", () => {
    // Verbatim: Healing Waters Wellness. A `don'?t` pattern misses this, which
    // is exactly how this one slipped through (~134 curly turns per 400 calls).
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Healing Waters Wellness and Med Spa, this is Claire."],
        ["agent", "Hi Claire, this is Tom calling back..."],
        ["user", "No, don’t call back. We are not interested."],
      ),
      disposition: "gatekeeper_not_interested",
      terminationReason: ENDED,
      callDurationSecs: 34,
    });
    expect(r.outcome).toBe("dnc");
  });

  it("beats the short-call hang-up correction", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Hi, I'm calling for the owner..."],
        ["user", "Stop calling."],
      ),
      disposition: "hung_up",
      terminationReason: ENDED,
      callDurationSecs: 11,
    });
    expect(r.outcome).toBe("dnc");
  });

  it("catches the other real phrasings", () => {
    const say = (m: string) =>
      classifyCallOutcome({
        transcript: t(["agent", "Hi, is the owner around?"], ["user", m]),
        disposition: "gatekeeper",
        terminationReason: ENDED,
        callDurationSecs: 30,
      }).outcome;
    expect(say("Do not call this number again.")).toBe("dnc");
    expect(say("Please take us off your calling list.")).toBe("dnc");
    expect(say("Can you please remove me from your call list?")).toBe("dnc");
    expect(say("No, take us off your list.")).toBe("dnc");
  });

  // TRAP 1 — the pattern must never fire on a recorded greeting. A looser
  // version matched "leave us a voicemail and watch out for a text": 14 false
  // positives across the corpus, every one a machine.
  it("does NOT fire on a voicemail greeting that says 'leave us a voicemail... watch out for'", () => {
    const r = classifyCallOutcome({
      transcript: t([
        "user",
        "Thanks for calling. Unfortunately, we cannot take your call right now. Feel free to leave us a voicemail and watch out for a text from our virtual agent who will be able to help you manage bookings.",
      ]),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 27,
    });
    expect(r.outcome).toBe("voicemail");
    expect(r.reachedHuman).toBe(false);
  });

  it("does not let a machine greeting be forced to dnc even when it says do-not-call", () => {
    const r = classifyCallOutcome({
      transcript: t([
        "user",
        "You've reached our office. To be added to our do not call list, press one, or leave a message after the tone.",
      ]),
      disposition: "voicemail",
      terminationReason: VM_DETECTED,
      callDurationSecs: 22,
    });
    expect(r.outcome).toBe("voicemail");
  });

  it("ignores the AGENT offering removal — only the called party's own words count", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "Hello, this is the front desk."],
        ["agent", "No problem, I'll make sure we don't call you again. Take care."],
      ),
      disposition: "gatekeeper",
      terminationReason: ENDED,
      callDurationSecs: 30,
    });
    expect(r.outcome).toBe("gatekeeper");
  });

  // TRAP 2 — goal_met wins, and it costs nothing: goal_met is terminal too, so
  // the lead is never dialled again either way; we just keep the real booking.
  it("does not override a booking", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Great, you're booked for Tuesday at 2."],
        ["user", "Perfect. And don't call this line again, use my email."],
      ),
      disposition: "goal_met",
      terminationReason: ENDED,
      callDurationSecs: 210,
    });
    expect(r.outcome).toBe("goal_met");
  });

  it("leaves an ordinary gatekeeper alone", () => {
    const r = classifyCallOutcome({
      transcript: t(
        ["user", "She's not in today, try Wednesday."],
        ["agent", "No worries, I'll try then."],
      ),
      disposition: "gatekeeper",
      terminationReason: ENDED,
      callDurationSecs: 40,
    });
    expect(r.outcome).toBe("gatekeeper");
  });
});
