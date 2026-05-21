/** Temporary page body used until a section is built out in a later phase. */
export function PagePlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="p-8">
      <h1 className="text-foreground text-2xl font-bold tracking-tight">
        {title}
      </h1>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        {description}
      </p>
    </div>
  );
}
