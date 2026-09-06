import { WizardPageSkeleton } from "@/components/skeletons/page-skeletons";

/** Loading shell for the leads import wizard. Like the lead detail page this
 *  inherited the Leads table skeleton, which is the wrong silhouette for a
 *  dropzone. */
export default function LeadsImportLoading() {
  return <WizardPageSkeleton />;
}
