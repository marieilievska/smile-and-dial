import { TablePageSkeleton } from "@/components/skeletons/page-skeletons";

export default function Loading() {
  return <TablePageSkeleton tiles={4} rows={10} />;
}
