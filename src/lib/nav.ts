import {
  Archive,
  Ban,
  BarChart3,
  Bot,
  DollarSign,
  LayoutDashboard,
  Megaphone,
  Phone,
  PhoneCall,
  Settings,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavSection = "workflow" | "operations" | "admin";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  section: NavSection;
  /** When set, the item is shown ONLY to the user whose email matches this
   *  value (everyone else never sees it). Used for the access-gated
   *  Archived storage entry. */
  restrictToEmail?: string;
};

/** The single account allowed to see (and reach) the Archived storage page.
 *  Imported by both the nav filter and the page guard so they can't drift. */
export const ARCHIVED_OWNER_EMAIL = "aicoach@referrizer.com";

export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  workflow: "Workflow",
  operations: "Operations",
  admin: "Manage",
};

/** Primary sidebar navigation. Grouped for scanability — daily-use items
 *  (Workflow) sit above campaign-level reporting (Operations) above
 *  rarely-touched admin surfaces.
 *
 *  EVERY TIER SEES EVERY ITEM, deliberately. There used to be an `adminOnly`
 *  flag here that nothing set; it was removed rather than wired up, for two
 *  reasons.
 *
 *  First, hiding a nav item is not access control. The URL still works. What
 *  actually protects a row is RLS plus the per-page guards, and a flag that
 *  LOOKS like a permission invites someone to reach for it instead of the
 *  thing that works.
 *
 *  Second, nothing here should be hidden. A member is a builder — they run
 *  calls on their own leads, agents, numbers and campaigns — so their own
 *  Costs, Analytics, Reporting and Do-not-call are all genuinely theirs to
 *  read, scoped by RLS to their own rows. The one place the admin tier really
 *  does get more is the Administration group inside Settings (Users, API
 *  keys), and settings-nav.tsx gates that on canManageUsers().
 *
 *  Per-item restriction still exists where it is genuinely needed —
 *  `restrictToEmail`, used by Archived. */
export const navItems: NavItem[] = [
  {
    label: "Today",
    href: "/today",
    icon: LayoutDashboard,
    section: "workflow",
  },
  { label: "Leads", href: "/leads", icon: Users, section: "workflow" },
  { label: "Calls", href: "/calls", icon: Phone, section: "workflow" },
  {
    label: "Archived",
    href: "/archived",
    icon: Archive,
    section: "workflow",
    restrictToEmail: ARCHIVED_OWNER_EMAIL,
  },
  {
    label: "Callbacks",
    href: "/callbacks",
    icon: PhoneCall,
    section: "workflow",
  },
  { label: "Pipeline", href: "/goals", icon: Target, section: "workflow" },
  {
    label: "Campaigns",
    href: "/campaigns",
    icon: Megaphone,
    section: "operations",
  },
  {
    label: "Analytics",
    href: "/analytics",
    icon: BarChart3,
    section: "operations",
  },
  {
    // Not adminOnly since #447: members see Reporting scoped by RLS to their
    // own leads. Leaving the flag on would have hidden the link from exactly
    // the people the page was opened for — reachable only by typing the URL.
    label: "Reporting",
    href: "/reporting",
    icon: Bot,
    section: "operations",
  },
  { label: "Do not call", href: "/dnc", icon: Ban, section: "operations" },
  { label: "Costs", href: "/costs", icon: DollarSign, section: "operations" },
  { label: "Settings", href: "/settings", icon: Settings, section: "admin" },
];
