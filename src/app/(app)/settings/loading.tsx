import { SettingsPageSkeleton } from "@/components/skeletons/page-skeletons";

/** Loading shell for the WHOLE settings segment.
 *
 *  One file, thirteen pages: a loading.tsx wraps its own page AND every
 *  segment below it in the same Suspense boundary, so this covers Lists,
 *  Goals, Knowledge bases, Email/Text templates, Agents (and the agent
 *  builder routes), Custom fields, Twilio numbers, Integrations, Overview,
 *  Users and API keys. Before it, none of them had a boundary anywhere up the
 *  tree -- there is no (app)/loading.tsx -- so every settings page rendered
 *  the chrome and then an empty content column until the server was done.
 *
 *  It renders inside settings/layout.tsx, so the left rail stays put and only
 *  the content column swaps. */
export default function SettingsLoading() {
  return <SettingsPageSkeleton />;
}
