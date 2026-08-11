import { describe, expect, it } from "vitest";

import { classifyCallOutcome } from "@/lib/calls/classify-outcome";

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

  it("still infers an immediate hang-up on a sub-20s call the other party ended", () => {
    const r = classifyCallOutcome({
      transcript: t(["agent", "Hi, is the owner around?"], ["user", "yeah"]),
      disposition: "gatekeeper", // LLM guess on a 5-second call
      terminationReason: "The remote party hung up.",
      callDurationSecs: 5,
    });
    expect(r.outcome).toBe("hung_up_immediately");
    expect(r.reachedHuman).toBe(false);
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
});
