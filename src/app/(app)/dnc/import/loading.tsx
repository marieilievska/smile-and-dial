import { WizardPageSkeleton } from "@/components/skeletons/page-skeletons";

/** Loading shell for the DNC import wizard -- previously inherited the DNC
 *  table skeleton. */
export default function DncImportLoading() {
  return <WizardPageSkeleton />;
}
