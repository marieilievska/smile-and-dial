import { DashboardSkeleton } from "@/components/skeletons/page-skeletons";

/** Loading shell for /reporting. The tab row is part of the silhouette --
 *  it renders above the content on every tab -- so the skeleton carries it
 *  and the page doesn't jump when the real tabs land. Reporting was one of
 *  the slowest routes measured (4.7s) and had no boundary at all. */
export default function ReportingLoading() {
  return <DashboardSkeleton tiles={4} tabs={3} />;
}
