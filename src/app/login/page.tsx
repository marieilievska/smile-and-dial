import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
            Internal platform
          </p>
          <h1 className="text-primary mt-2 text-3xl font-bold tracking-tight">
            Smile <span className="text-coral">&amp;</span> Dial
          </h1>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
