// Patch the live ElevenLabs agents' prompts by exact anchor-replace. Dry-run by
// default, verifies each write. Handles the two prompt surfaces:
//   target "disposition"  -> platform_settings.data_collection.disposition.description
//                            (preserves workspace_overrides.webhooks)
//   target "conversation" -> conversation_config.agent.prompt.prompt
//                            (drops deprecated prompt.tools to avoid the
//                             "both tools and tool IDs" 400; tool_ids+built_in cover it)
//
// Config (JSON): { "target":"disposition"|"conversation",
//                  "agents":["agent_...","agent_..."],
//                  "old":"<exact anchor>", "new":"<replacement>",
//                  "mustVanish":"<substring that must be gone>" (optional) }
// Usage: node el-patch.js config.json                       # dry-run (always)
//        node el-patch.js config.json --apply --confirmed   # writes to the LIVE agents
//
// ⚠️ GUARDRAIL (Marija, 2026-08-11): NEVER change a live agent's prompt without
// Marija's explicit confirmation. Show her the exact before/after and wait for a
// yes. Applying requires BOTH --apply AND --confirmed; --apply alone refuses.
const fs = require("fs");
const C = require("./_common");

const cfgPath = process.argv[2];
if (!cfgPath) { console.error("usage: node el-patch.js <config.json> [--apply --confirmed]"); process.exit(1); }
if (process.argv.includes("--apply") && !process.argv.includes("--confirmed")) {
  console.error("STOP: live agent-prompt changes need Marija's explicit confirmation.");
  console.error("Show her the exact diff, get a yes, then re-run with --apply --confirmed.");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply") && process.argv.includes("--confirmed");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const elPatch = (id, body) =>
  fetch(`https://api.elevenlabs.io/v1/convai/agents/${id}`, {
    method: "PATCH", headers: { "xi-api-key": C.EL_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

(async () => {
  for (const id of cfg.agents) {
    const a = await C.elGet(`convai/agents/${id}`);
    let target, apply;
    if (cfg.target === "disposition") {
      const ps = a.platform_settings, disp = ps.data_collection.disposition;
      target = disp.description;
      apply = (newDesc) => ({ platform_settings: { ...ps, data_collection: { ...ps.data_collection, disposition: { ...disp, description: newDesc } } } });
    } else if (cfg.target === "conversation") {
      target = a.conversation_config.agent.prompt.prompt;
      apply = (newPrompt) => {
        const cc = JSON.parse(JSON.stringify(a.conversation_config));
        cc.agent.prompt.prompt = newPrompt;
        const ids = (cc.agent.prompt.tool_ids || []).length;
        const built = Object.values(cc.agent.prompt.built_in_tools || {}).filter(Boolean).length;
        if (ids < 1 || built < 1) throw new Error(`unexpected tools tool_ids=${ids} built_in=${built}`);
        delete cc.agent.prompt.tools; // else 400 "Cannot specify both tools and tool IDs"
        return { conversation_config: cc };
      };
    } else throw new Error("target must be disposition|conversation");

    if (!target.includes(cfg.old)) {
      console.log(`ABORT ${id}: anchor not found${target.includes(cfg.new.slice(0, 40)) ? " (already patched?)" : ""}`);
      continue;
    }
    const updated = target.replace(cfg.old, cfg.new);
    if (updated.includes(cfg.old)) { console.log(`ABORT ${id}: anchor still present after replace`); continue; }
    if (cfg.mustVanish && updated.includes(cfg.mustVanish)) { console.log(`ABORT ${id}: "${cfg.mustVanish}" still present`); continue; }
    console.log(`\n${id}: len ${target.length} -> ${updated.length}, new text present=${updated.includes(cfg.new.slice(0, 40))}`);
    if (!APPLY) { console.log("  (dry-run)"); continue; }

    let body; try { body = apply(updated); } catch (e) { console.log("  ABORT:", e.message); continue; }
    const res = await elPatch(id, body);
    if (!res.ok) { console.log("  PATCH FAIL", res.status, (await res.text()).slice(0, 200)); continue; }
    const chk = await C.elGet(`convai/agents/${id}`);
    const wh = chk.platform_settings?.workspace_overrides?.webhooks?.post_call_webhook_id ?? "(none)";
    const now = cfg.target === "disposition" ? chk.platform_settings.data_collection.disposition.description : chk.conversation_config.agent.prompt.prompt;
    console.log(`  PATCHED. hasNew=${now.includes(cfg.new.slice(0, 40))} oldGone=${!now.includes(cfg.old)} webhook=${wh}`);
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
