import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import {
  LayoutDashboard,
  PlusCircle,
  ClipboardList,
  Truck,
  Users,
  UserCheck,
  Wrench,
  ReceiptText,
  BarChart3,
  FileSpreadsheet,
  ShieldCheck,
  LogOut,
  Menu,
  X,
  Shield,
  ClipboardCheck,
  MapPin,
  Sparkles,
  FileCheck2,
  BellRing,
} from 'lucide-react';
import type { NavSection, UserPermissions } from '../types/erp';

interface LayoutShellProps {
  user: User;
  isSuperAdmin: boolean;
  permissions: UserPermissions;
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  onSignOut: () => void;
  onNewTripClick: () => void;
  onOpenChecklist?: () => void;
  checklistCompletedCount?: number;
  children: React.ReactNode;
}

interface NavGroup {
  heading: string;
  items: {
    id: NavSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    visible?: (p: UserPermissions) => boolean;
  }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      {
        id: 'trip-entry',
        label: 'Trip Entry',
        icon: PlusCircle,
        visible: (p) => p.canEditTrips,
      },
      { id: 'trip-history', label: 'Trip History', icon: ClipboardList },
      { id: 'lorry-receipts', label: 'Lorry Receipt (LR)', icon: FileCheck2 },
      {
        id: 'billing',
        label: 'Billing & Invoices',
        icon: ReceiptText,
        visible: (p) => p.canManageBilling,
      },
    ],
  },
  {
    heading: 'Fleet & Masters',
    items: [
      { id: 'vehicles', label: 'Vehicles', icon: Truck },
      { id: 'expiry-alerts', label: 'Expiry Alerts', icon: BellRing },
      { id: 'parties', label: 'Parties', icon: Users },
      { id: 'drivers', label: 'Drivers', icon: UserCheck },
      { id: 'expenses', label: 'Expenses & Maint.', icon: Wrench },
    ],
  },
  {
    heading: 'Maps & Intelligence',
    items: [
      { id: 'route-map', label: 'Route Map & Stops', icon: MapPin },
      { id: 'ai-assistant', label: 'ERP AI Assistant', icon: Sparkles },
    ],
  },
  {
    heading: 'Reports & System',
    items: [
      { id: 'reports', label: 'Reports & P&L', icon: BarChart3 },
      {
        id: 'excel-import',
        label: 'Excel Import',
        icon: FileSpreadsheet,
        visible: (p) => p.canImportExcel,
      },
      { id: 'security', label: 'Security & Backup', icon: ShieldCheck },
    ],
  },
];

const SECTION_TITLES: Record<NavSection, string> = {
  dashboard: 'Company Dashboard',
  'trip-entry': 'Trip Entry Form',
  'trip-history': 'Trip History',
  'lorry-receipts': 'Lorry Receipt (LR)',
  vehicles: 'Vehicle Management',
  'expiry-alerts': 'Vehicle Document Expiry Alerts',
  parties: 'Party Management',
  drivers: 'Driver Management',
  expenses: 'Expense & Maintenance Management',
  billing: 'Billing & Invoices',
  reports: 'Business Reports & Analytics',
  'route-map': 'Route Map & Fleet Stops',
  'ai-assistant': 'ERP AI Assistant',
  'excel-import': 'Excel Import',
  security: 'Users, Security & Backup',
};

export const LayoutShell: React.FC<LayoutShellProps> = ({
  user,
  isSuperAdmin,
  permissions,
  activeSection,
  onNavigate,
  onSignOut,
  onNewTripClick,
  onOpenChecklist,
  checklistCompletedCount = 0,
  children,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSelectNav = (id: NavSection) => {
    onNavigate(id);
    setMobileMenuOpen(false);
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100">
      {/* Brand Header */}
      <div className="px-5 py-5 border-b border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
            <Truck className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="font-display text-sm font-semibold tracking-tight text-white truncate">
              BAPASITARAM
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              Enterprise Transport ERP
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close navigation menu"
          className="lg:hidden p-2 text-slate-400 hover:text-white rounded-lg cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Grouped Navigation Links */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter(
            (item) => !item.visible || item.visible(permissions)
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={group.heading} className="space-y-1">
              <div className="px-3.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {group.heading}
              </div>
              {visibleItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectNav(item.id)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2 min-h-[40px] rounded-lg text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      isActive
                        ? 'bg-white text-slate-900'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* User Profile & Sign Out */}
      <div className="p-4 border-t border-slate-800 space-y-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0 text-xs font-semibold text-white">
            {(user.displayName || user.email || 'A').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white truncate">
              {user.displayName || (permissions.role === 'admin' ? 'Administrator' : 'Staff User')}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 truncate">
              {(isSuperAdmin || permissions.role === 'admin') && (
                <Shield className="w-3 h-3 text-amber-400 shrink-0" />
              )}
              <span className="truncate">{user.email}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onSignOut}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 min-h-[40px] text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-800 hover:text-white rounded-lg border border-slate-700 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5 shrink-0" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Fixed Sidebar (256px) */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200 sticky top-0 h-screen no-print">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[85vw] h-full z-10 shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb/Title on left, max 1 primary CTA on right */}
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 min-w-0 text-sm">
              <span className="hidden sm:inline text-slate-400 whitespace-nowrap">
                BAPASITARAM ENTERPRISE
              </span>
              <span className="hidden sm:inline text-slate-300" aria-hidden="true">
                /
              </span>
              <h1 className="font-display text-base sm:text-lg font-semibold text-slate-900 truncate">
                {SECTION_TITLES[activeSection]}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onOpenChecklist && (
              <button
                type="button"
                onClick={onOpenChecklist}
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ClipboardCheck className="w-4 h-4 shrink-0 text-emerald-700" />
                <span className="hidden sm:inline">Phase 1 Checklist</span>
                <span className="sm:hidden">Checklist</span>
                <span className="font-mono text-[11px] text-slate-500">
                  ({checklistCompletedCount}/10)
                </span>
              </button>
            )}
            {activeSection !== 'trip-entry' && permissions.canEditTrips && (
              <button
                type="button"
                onClick={onNewTripClick}
                className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 min-h-[40px] bg-slate-900 hover:bg-slate-800 text-white text-xs sm:text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <PlusCircle className="w-4 h-4 shrink-0" />
                <span>New Trip</span>
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
