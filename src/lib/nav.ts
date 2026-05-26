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

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** When true, the item is hidden from members and shown only to admins. */
  adminOnly?: boolean;
};

/** Primary sidebar navigation. "Today" is the default landing page —
 *  the rest of the order follows BUILD_PLAN.md Section 5. */
export const navItems: NavItem[] = [
  { label: "Today", href: "/today", icon: LayoutDashboard },
  { label: "Leads", href: "/leads", icon: Users },
  { label: "Calls", href: "/calls", icon: Phone },
  { label: "Callbacks", href: "/callbacks", icon: PhoneCall },
  { label: "Goals", href: "/goals", icon: Target },
  { label: "Campaigns", href: "/campaigns", icon: Megaphone },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
  { label: "DNC", href: "/dnc", icon: Ban },
  { label: "Costs", href: "/costs", icon: DollarSign },
  {
    label: "System Health",
    href: "/system-health",
    icon: Activity,
    adminOnly: true,
  },
  { label: "Settings", href: "/settings", icon: Settings },
];
