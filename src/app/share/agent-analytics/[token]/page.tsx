import { redirect } from "next/navigation";

// Back-compat shim. The public share moved to /share/reporting/<token> when the
// page was renamed from "Agent Analytics" to "Reporting". Any link already
// handed out under the old path keeps working via this permanent redirect.
// Safe to delete once the old link is no longer in circulation.
export const metadata = { robots: { index: false, follow: false } };

export default async function LegacyShareRedirect({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  redirect(`/share/reporting/${token}`);
}
