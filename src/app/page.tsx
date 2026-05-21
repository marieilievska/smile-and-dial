export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="border-border bg-card w-full max-w-md rounded-lg border p-8 text-center shadow-sm">
        <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
          Internal platform
        </p>
        <h1 className="text-primary mt-3 text-3xl font-bold tracking-tight">
          Smile <span className="text-coral">&amp;</span> Dial
        </h1>
        <p className="text-muted-foreground mt-3 text-base">
          AI calling platform for Referrizer.
        </p>
        <div className="border-border mt-6 border-t pt-6">
          <p className="text-muted-foreground text-sm">
            Foundation ready — Phase 1, Step 1.
          </p>
        </div>
      </div>
    </main>
  );
}
