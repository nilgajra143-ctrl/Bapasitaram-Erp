import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Gauge,
  PlusSquare,
  Route,
  Truck,
  Building2,
  IdCard,
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
  MapPinned,
  Cpu,
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
      { id: 'dashboard', label: 'Command Dashboard', icon: Gauge },
      {
        id: 'trip-entry',
        label: 'Trip Entry',
        icon: PlusSquare,
        visible: (p) => p.canEditTrips,
      },
      { id: 'trip-history', label: 'Trip History', icon: Route },
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
      { id: 'vehicles', label: 'Fleet Vehicles', icon: Truck },
      { id: 'expiry-alerts', label: 'Expiry Alerts', icon: BellRing },
      { id: 'parties', label: 'Parties & Ledger', icon: Building2 },
      { id: 'drivers', label: 'Drivers', icon: IdCard },
      { id: 'expenses', label: 'Expenses & Maint.', icon: Wrench },
    ],
  },
  {
    heading: 'Maps & Intelligence',
    items: [
      { id: 'route-map', label: 'Route Map & Stops', icon: MapPinned },
      { id: 'ai-assistant', label: 'ERP AI Assistant', icon: Cpu },
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
  dashboard: 'Operations Command Center',
  'trip-entry': 'Trip Dispatch Entry',
  'trip-history': 'Trip History Ledger',
  'lorry-receipts': 'Lorry Receipt (LR)',
  vehicles: 'Fleet Vehicle Control',
  'expiry-alerts': 'Vehicle Document Expiry Alerts',
  parties: 'Party Ledger & Payments',
  drivers: 'Driver Operations',
  expenses: 'Expenses & Maintenance',
  billing: 'Freight Billing & Invoices',
  reports: 'Business Reports & P&L',
  'route-map': 'Route Map & Fleet Stops',
  'ai-assistant': 'ERP AI Assistant',
  'excel-import': 'Excel Import Utility',
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
    <div className="flex flex-col h-full bg-[#0b111c] text-slate-100">
      {/* Industrial Brand Header */}
      <div className="px-4 py-4 bg-[#111827] border-b border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-orange-600 border border-orange-400/40 flex items-center justify-center shrink-0">
            <Truck className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="font-display text-xl font-bold tracking-wider text-white uppercase leading-none truncate">
              BAPASITARAM
            </div>
            <div className="text-[11px] font-medium text-slate-400 truncate mt-1">
              Enterprise Transport ERP
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close navigation menu"
          className="lg:hidden p-2 text-slate-400 hover:text-white rounded-md cursor-pointer min-h-[40px] min-w-[40px] flex items-center justify-center"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Grouped Industrial Navigation Rail */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter(
            (item) => !item.visible || item.visible(permissions)
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={group.heading} className="space-y-1">
              <div className="px-3 pb-1 text-[11px] font-display font-bold uppercase tracking-widest text-slate-500">
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
                    className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 min-h-[40px] rounded-md text-sm font-medium transition-colors cursor-pointer whitespace-nowrap border ${
                      isActive
                        ? 'bg-[#1a2434] text-white border-slate-700'
                        : 'text-slate-300 border-transparent hover:bg-[#141c28] hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <Icon
                        className={`w-4 h-4 shrink-0 ${
                          isActive ? 'text-orange-500' : 'text-slate-400'
                        }`}
                      />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {isActive && (
                      <span
                        className="w-1.5 h-4 rounded-xs bg-orange-500 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Operator Profile & Sign Out */}
      <div className="p-4 bg-[#111827] border-t border-slate-800 space-y-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-md bg-[#1d2736] border border-slate-700 flex items-center justify-center shrink-0 font-mono text-xs font-bold text-orange-400">
            {(user.displayName || user.email || 'A').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white truncate">
              {user.displayName || (permissions.role === 'admin' ? 'Administrator' : 'Staff User')}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 truncate">
              {(isSuperAdmin || permissions.role === 'admin') && (
                <Shield className="w-3 h-3 text-emerald-500 shrink-0" />
              )}
              <span className="truncate">{user.email}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onSignOut}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 min-h-[40px] text-xs font-semibold text-slate-200 bg-[#1a2434] hover:bg-slate-800 hover:text-white rounded-md border border-slate-700 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#e9edf3] flex">
      {/* Desktop Fixed Sidebar (260px) */}
      <aside className="hidden lg:block w-[260px] shrink-0 border-r border-slate-800 sticky top-0 h-screen no-print">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div
            className="fixed inset-0 bg-slate-950/75"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[85vw] h-full z-10 shadow-2xl border-r border-slate-800">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Industrial Command Header */}
        <header className="sticky top-0 z-30 bg-[#111827] border-b-2 border-orange-600 px-4 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-300 hover:text-white rounded-md cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2.5 min-w-0 text-sm">
              <span className="hidden sm:inline font-mono text-xs font-semibold tracking-wide text-slate-400 whitespace-nowrap">
                BAPASITARAM ENTERPRISE
              </span>
              <span className="hidden sm:inline text-slate-600" aria-hidden="true">
                /
              </span>
              <h1 className="font-display text-xl sm:text-2xl font-bold tracking-wide uppercase text-white truncate">
                {SECTION_TITLES[activeSection]}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {onOpenChecklist && (
              <button
                type="button"
                onClick={onOpenChecklist}
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] bg-[#1a2434] hover:bg-[#243146] text-slate-200 border border-slate-700 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ClipboardCheck className="w-4 h-4 shrink-0 text-emerald-500" />
                <span className="hidden sm:inline">Phase 1 Checklist</span>
                <span className="sm:hidden">Checklist</span>
                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                  ({checklistCompletedCount}/10)
                </span>
              </button>
            )}
            {activeSection !== 'trip-entry' && permissions.canEditTrips && (
              <button
                type="button"
                onClick={onNewTripClick}
                className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 min-h-[40px] bg-orange-600 hover:bg-orange-500 text-white text-xs sm:text-sm font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <PlusSquare className="w-4 h-4 shrink-0" />
                <span>New Trip</span>
              </button>
            )}
          </div>
        </header>

        <main className="erp-industrial-workspace flex-1 p-4 sm:p-6 lg:p-8 max-w-[1480px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
