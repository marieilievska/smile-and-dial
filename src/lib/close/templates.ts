/** Variable interpolation for email templates (BUILD_PLAN §12).
 *
 *  Supported tokens:
 *    {{lead.company}}, {{lead.business_phone}}, {{lead.business_email}},
 *    {{lead.owner_name}}, {{lead.manager_name}}, {{lead.employee_name}},
 *    {{lead.city}}, {{lead.state}},
 *    {{campaign.name}}, {{owner.full_name}},
 *    {{appointment.time}}, {{appointment.url}}.
 *
 *  Custom fields are passed through as `lead.<slug>` and we look them up
 *  in the `customFields` map.
 */
export type TemplateContext = {
  lead: Record<string, string | null | undefined>;
  campaign?: { name?: string | null };
  owner?: { full_name?: string | null };
  appointment?: { time?: string | null; url?: string | null };
  customFields?: Record<string, string | null | undefined>;
};

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, raw) => {
    const path = String(raw).split(".");
    if (path.length !== 2) return "";
    const [scope, key] = path;
    if (scope === "lead") {
      if (ctx.lead[key] != null) return String(ctx.lead[key]);
      if (ctx.customFields && ctx.customFields[key] != null)
        return String(ctx.customFields[key]);
      return "";
    }
    if (scope === "campaign") return String(ctx.campaign?.name ?? "");
    if (scope === "owner") return String(ctx.owner?.full_name ?? "");
    if (scope === "appointment") {
      if (key === "time")
        return ctx.appointment?.time
          ? new Date(ctx.appointment.time).toLocaleString()
          : "";
      if (key === "url") return ctx.appointment?.url ?? "";
    }
    return "";
  });
}
