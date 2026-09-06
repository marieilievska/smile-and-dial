import { DetailPageSkeleton } from "@/components/skeletons/page-skeletons";

/** Loading shell for a lead's detail page.
 *
 *  This route DID have a fallback before -- but the wrong one. With no
 *  loading.tsx of its own it inherited the nearest ancestor's, which is the
 *  Leads TABLE skeleton, so opening a lead flashed a table silhouette and
 *  then jumped to a detail layout. */
export default function LeadDetailLoading() {
  return <DetailPageSkeleton />;
}
