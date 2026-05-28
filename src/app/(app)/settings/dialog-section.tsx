/** Reusable Section wrapper for the settings dialogs. Same visual
 *  treatment as the campaign-settings and add-to-DNC modals: a small
 *  coral-tinted icon chip + title + optional description, with the
 *  body indented under the chip so the eye gets a clean column.
 *
 *  Centralised here so every settings dialog (Lists / Goals / KBs /
 *  Custom fields / Invite user / Buy number) shares the same shape
 *  and a future visual tweak only needs to land in one place. */
export function DialogSection({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span
          className="text-primary inline-flex size-5 shrink-0 items-center justify-center rounded-md"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--primary) 14%, transparent)",
          }}
        >
          {icon}
        </span>
        <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      </div>
      {description ? (
        <p className="text-muted-foreground -mt-1 ml-7 text-xs">
          {description}
        </p>
      ) : null}
      <div className="ml-7">{children}</div>
    </section>
  );
}
