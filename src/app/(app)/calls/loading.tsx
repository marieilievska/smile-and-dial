import { TablePageSkeleton } from "@/components/skeletons/page-skeletons";

export default function Loading() {
  return <TablePageSkeleton tiles={3} rows={10} action={false} />;
}
