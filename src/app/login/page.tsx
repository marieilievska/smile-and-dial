import { AuthShell } from "@/components/auth/auth-shell";

import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <AuthShell
      panelHeadline="AI calling, supervised by humans."
      panelSubcopy="Outbound campaigns, real-time monitoring, every call accounted for."
    >
      <LoginForm />
    </AuthShell>
  );
}
