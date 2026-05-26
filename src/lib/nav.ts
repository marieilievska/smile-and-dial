import {
  Activity,
  Ban,
  BarChart3,
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
  /** When true, the item is hidden from members and shown only to admins. */
  adminOnly?: boolean;
};

export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  workflow: "Workflow",
  operations: "Operations",
  admin: "Admin",
};

/** Primary sidebar navigation. Grouped for scanability — daily-use items
 *  (Workflow) sit above campaign-level reporting (Operations) above
 *  rarely-touched admin surfaces. */
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
    label: "Callbacks",
    href: "/callbacks",
    icon: PhoneCall,
    section: "workflow",
  },
  { label: "Goals", href: "/goals", icon: Target, section: "workflow" },
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
  { label: "DNC", href: "/dnc", icon: Ban, section: "operations" },
  { label: "Costs", href: "/costs", icon: DollarSign, section: "operations" },
  {
    label: "System Health",
    href: "/system-health",
    icon: Activity,
    section: "admin",
    adminOnly: true,
  },
  { label: "Settings", href: "/settings", icon: Settings, section: "admin" },
];
