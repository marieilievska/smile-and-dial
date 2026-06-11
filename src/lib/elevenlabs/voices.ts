/**
 * Fixed set of ElevenLabs voices available when building an agent.
 *
 * Smile & Dial runs on ONE shared ElevenLabs account behind the whole product,
 * so the voice roster is the same for every Smile & Dial account — there is
 * nothing per-tenant to configure. We therefore bake the list here in code
 * instead of storing it in app_settings / exposing it in Settings.
 *
 * `id` is the ElevenLabs voice id (what we send as `voice_id` when syncing an
 * agent). `name` + `vibe` are display-only, shown in the Agent Builder's voice
 * picker so an operator chooses by character rather than an opaque id.
 *
 * To change the roster, edit this list (names/vibes come from the ElevenLabs
 * dashboard). Keep the ids exactly as ElevenLabs reports them.
 */

export type FixedVoice = {
  id: string;
  name: string;
  gender: "female" | "male";
  accent: string;
  vibe: string;
};

export const FIXED_VOICES: FixedVoice[] = [
  {
    id: "DODLEQrClDo8wCz460ld",
    name: "Lauren",
    gender: "female",
    accent: "American",
    vibe: "Friendly, comforting, soft",
  },
  {
    id: "s3TPKV1kjDlVtZbl4Ksh",
    name: "Adam",
    gender: "male",
    accent: "American",
    vibe: "Engaging, friendly, bright",
  },
  {
    id: "c6SfcYrb2t09NHXiT80T",
    name: "Jarnathan",
    gender: "male",
    accent: "American",
    vibe: "Confident, versatile",
  },
  {
    id: "yM93hbw8Qtvdma2wCnJG",
    name: "Ivanna",
    gender: "female",
    accent: "American",
    vibe: "Young, versatile, casual",
  },
  {
    id: "NHRgOEwqx5WZNClv5sat",
    name: "Chelsea",
    gender: "female",
    accent: "American",
    vibe: "Conversational, bright",
  },
  {
    id: "MClEFoImJXBTgLwdLI5n",
    name: "Ivy",
    gender: "female",
    accent: "American",
    vibe: "Sophisticated, professional",
  },
  {
    id: "pvxGJdhknm00gMyYHtET",
    name: "Kota",
    gender: "female",
    accent: "American",
    vibe: "Smooth, rich, expressive",
  },
  {
    id: "uYXf8XasLslADfZ2MB4u",
    name: "Hope",
    gender: "female",
    accent: "American",
    vibe: "Bubbly, upbeat",
  },
  {
    id: "uKGPYP2uuyRQv8SeFre0",
    name: "Chris Anthony",
    gender: "male",
    accent: "American",
    vibe: "Confident",
  },
  {
    id: "ZauUyVXAz5znrgRuElJ5",
    name: "Russell",
    gender: "male",
    accent: "American",
    vibe: "Energetic",
  },
  {
    id: "kdnRe2koJdOK4Ovxn2DI",
    name: "Eryn",
    gender: "female",
    accent: "American",
    vibe: "Genuine, friendly, natural",
  },
  {
    id: "XcXEQzuLXRU9RcfWzEJt",
    name: "Veda Sky",
    gender: "female",
    accent: "American",
    vibe: "Natural, crisp",
  },
  {
    id: "7EzWGsX10sAS4c9m9cPf",
    name: "Jack John",
    gender: "male",
    accent: "American",
    vibe: "Customer-support, professional",
  },
  {
    id: "inGcvmoPgbvKUk9uCvHu",
    name: "Adam M",
    gender: "male",
    accent: "American",
    vibe: "Calm",
  },
  {
    id: "wSO34DbFKBGmeCNpJL5K",
    name: "Josh",
    gender: "male",
    accent: "American",
    vibe: "Deep, conversational, calm",
  },
  {
    id: "oWjuL7HSoaEJRMDMP3HD",
    name: "Lina",
    gender: "female",
    accent: "American",
    vibe: "Confident, dynamic, strong",
  },
  {
    id: "iLVmqjzCGGvqtMCk6vVQ",
    name: "Antonio",
    gender: "male",
    accent: "Italian",
    vibe: "Lively, energetic",
  },
];

/** Just the ids, in roster order. */
export const FIXED_VOICE_IDS: string[] = FIXED_VOICES.map((v) => v.id);

/** Look up a voice's display info by id (for showing the chosen voice's name
 *  rather than its raw id outside the picker). */
export function findVoice(id: string): FixedVoice | undefined {
  return FIXED_VOICES.find((v) => v.id === id);
}
