import { AuthShell } from "@/components/auth/auth-shell";

import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      panelHeadline="Locked out for a sec?"
      panelSubcopy="Drop your email and we'll send a fresh link."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
