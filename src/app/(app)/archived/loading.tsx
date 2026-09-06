import { TablePageSkeleton } from "@/components/skeletons/page-skeletons";

/** Loading shell for /archived. No stat strip on this page, so the skeleton
 *  goes straight from the header to the table. Had no boundary anywhere up
 *  the tree before. */
export default function ArchivedLoading() {
  return <TablePageSkeleton tiles={0} rows={6} action={false} />;
}
