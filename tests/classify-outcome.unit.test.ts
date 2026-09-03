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
    const r = classifyCallOutcome({
      transcript: t(
        ["agent", "Is the owner around?"],
        ["user", "Not interested, take me off your list."],
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
