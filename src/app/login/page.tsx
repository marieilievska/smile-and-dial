import { AuthShell } from "@/components/auth/auth-shell";

import { LoginForm } from "./login-form";

/** Why the user was sent here, keyed by the `notice` search param. Only
 *  known keys render — anything else is ignored, so the URL can't inject
 *  arbitrary copy into the page. */
const NOTICES: Record<string, string> = {
  deactivated:
    "Your account has been deactivated. Contact an admin if you think that's a mistake.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string | string[] }>;
}) {
  const { notice } = await searchParams;
  const noticeText =
    typeof notice === "string" ? (NOTICES[notice] ?? null) : null;

  return (
    <AuthShell
      panelHeadline="AI calling, supervised by humans."
      panelSubcopy="Outbound campaigns, real-time monitoring, every call accounted for."
    >
      <LoginForm notice={noticeText} />
    </AuthShell>
  );
}
