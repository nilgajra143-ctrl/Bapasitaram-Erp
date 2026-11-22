import React, { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  BellRing,
  Building2,
  Camera,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  FileCheck2,
  Gauge,
  IndianRupee,
  LayoutGrid,
  LogOut,
  PlusCircle,
  ReceiptText,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
  Truck,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import type {
  CompanySettings,
  NavSection,
  Party,
  PartyPayment,
  PendingContainerPhoto,
  Trip,
  TripContainerPhoto,
  UserPermissions,
} from '../types/erp';
import {
  deriveTripNumber,
  type ContainerPhotoTripMetadata,
  type PreparedContainerPhoto,
} from '../utils/containerPhotoHelpers';
import { registerAndroidBackButtonHandler } from '../utils/capacitorPlatform';
import { formatDateIN } from '../utils/formatters';
import { AddPaymentModal } from './AddPaymentModal';
import { ContainerPhotoCard } from './ContainerPhotoCard';

interface MobileAppShellProps {
  user: User;
  isSuperAdmin: boolean;
  permissions: UserPermissions;
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  onSignOut: () => void;
  onNewTripClick: () => void;
  isOnline: boolean;
  syncingPhotos: boolean;
  pendingContainerPhotos: PendingContainerPhoto[];
  onSyncPendingPhotos: () => Promise<void>;
  parties: Party[];
  trips: Trip[];
  partyPayments: PartyPayment[];
  tripContainerPhotos: TripContainerPhoto[];
  companySettings: CompanySettings | null;
  onUploadContainerPhoto: (
    prepared: PreparedContainerPhoto,
    metadata: ContainerPhotoTripMetadata
  ) => Promise<{ syncedImmediately: boolean }>;
  onDeleteContainerPhoto: (photo: TripContainerPhoto) => Promise<void>;
  onDiscardPendingPhoto: (tripId: string) => Promise<void>;
  children: React.ReactNode;
}

const SECTION_TITLE_MAP: Record<NavSection, string> = {
  dashboard: 'Dashboard',
  'trip-entry': 'Trip Entry',
  'trip-history': 'Trip History',
  'lorry-receipts': 'LR Management',
  billing: 'Bill Management',
  parties: 'Party Ledger',
  vehicles: 'Vehicle Details',
  drivers: 'Driver Details',
  'expiry-alerts': 'Expiry Alerts',
  expenses: 'Expenses',
  reports: 'Reports',
  'route-map': 'Route Map',
  'excel-import': 'Excel Import',
  'ai-assistant': 'ERP Assistant',
  security: 'Security & Backup',
};

interface MobileModuleEntry {
  id: string;
  label: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  kind: 'nav' | 'payment' | 'rear-photo';
  navTarget?: NavSection;
  visible: boolean;
  badgeText?: string;
}

export const MobileAppShell: React.FC<MobileAppShellProps> = ({
  user,
  isSuperAdmin,
  permissions,
  activeSection,
  onNavigate,
  onSignOut,
  onNewTripClick,
  isOnline,
  syncingPhotos,
  pendingContainerPhotos,
  onSyncPendingPhotos,
  parties,
  trips,
  partyPayments,
  tripContainerPhotos,
  companySettings,
  onUploadContainerPhoto,
  onDeleteContainerPhoto,
  onDiscardPendingPhoto,
  children,
}) => {
  const [modulesSheetOpen, setModulesSheetOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);
  const [photoTripSearch, setPhotoTripSearch] = useState('');
  const [selectedPhotoTripId, setSelectedPhotoTripId] = useState<string>('');
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const canRecordPayment =
    permissions.isAdmin ||
    permissions.canManageBilling ||
    permissions.canManageMasters ||
    permissions.canEditTrips;

  const canCapturePhoto = permissions.isAdmin || permissions.canEditTrips;

  // Keep selected trip for mobile rear-photo sheet synced with latest available trip
  useEffect(() => {
    if (trips.length === 0) {
      setSelectedPhotoTripId('');
      return;
    }
    const exists = trips.some((t) => t.id === selectedPhotoTripId);
    if (!exists) {
      setSelectedPhotoTripId(trips[0].id);
    }
  }, [trips, selectedPhotoTripId]);

  // Android hardware Back button handling: close sheets/modals first, then return to Dashboard
  useEffect(() => {
    return registerAndroidBackButtonHandler(() => {
      if (paymentModalOpen) {
        setPaymentModalOpen(false);
        return true;
      }
      if (photoSheetOpen) {
        setPhotoSheetOpen(false);
        return true;
      }
      if (modulesSheetOpen) {
        setModulesSheetOpen(false);
        return true;
      }
      if (activeSection !== 'dashboard') {
        onNavigate('dashboard');
        return true;
      }
      return false;
    });
  }, [paymentModalOpen, photoSheetOpen, modulesSheetOpen, activeSection, onNavigate]);

  const syncedPhotoByTripId = useMemo(() => {
    const map = new Map<string, TripContainerPhoto>();
    tripContainerPhotos.forEach((p) => map.set(p.tripId, p));
    return map;
  }, [tripContainerPhotos]);

  const pendingPhotoByTripId = useMemo(() => {
    const map = new Map<string, PendingContainerPhoto>();
    pendingContainerPhotos.forEach((p) => map.set(p.tripId, p));
    return map;
  }, [pendingContainerPhotos]);

  const filteredPhotoTrips = useMemo(() => {
    const q = photoTripSearch.trim().toLowerCase();
    if (!q) return trips.slice(0, 40);
    return trips
      .filter((t) =>
        [
          deriveTripNumber(t),
          t.lrNumber,
          t.vehicleNumber,
          t.containerNo || '',
          t.partyName,
          t.tripDate,
        ]
          .join(' ')
          .toLowerCase()
          .includes(q)
      )
      .slice(0, 40);
  }, [trips, photoTripSearch]);

  const selectedPhotoTrip = useMemo(() => {
    if (!selectedPhotoTripId) return trips[0] || null;
    return trips.find((t) => t.id === selectedPhotoTripId) || trips[0] || null;
  }, [trips, selectedPhotoTripId]);

  // All 11 core Android Mobile ERP modules with strict existing RBAC enforcement
  const coreMobileModules: MobileModuleEntry[] = useMemo(
    () => [
      {
        id: 'dashboard',
        label: 'Dashboard',
        subtitle: 'Operations overview, fleet status & KPIs',
        icon: Gauge,
        kind: 'nav',
        navTarget: 'dashboard',
        visible: true,
      },
      {
        id: 'trip-entry',
        label: 'Trip Entry',
        subtitle: 'Record new freight trip & rear container photo',
        icon: PlusCircle,
        kind: 'nav',
        navTarget: 'trip-entry',
        visible: permissions.canEditTrips,
      },
      {
        id: 'trip-history',
        label: 'Trip History',
        subtitle: 'Search, inspect & edit recorded trips',
        icon: Route,
        kind: 'nav',
        navTarget: 'trip-history',
        visible: true,
      },
      {
        id: 'lorry-receipts',
        label: 'LR Management',
        subtitle: 'Lorry receipts, A4 preview & WhatsApp share',
        icon: FileCheck2,
        kind: 'nav',
        navTarget: 'lorry-receipts',
        visible: true,
      },
      {
        id: 'billing',
        label: 'Bill Management',
        subtitle: 'Freight bills (Format A & B), PDF & share',
        icon: ReceiptText,
        kind: 'nav',
        navTarget: 'billing',
        visible: permissions.canManageBilling,
      },
      {
        id: 'payment-entry',
        label: 'Payment Entry',
        subtitle: 'Record party payment & send WhatsApp receipt',
        icon: IndianRupee,
        kind: 'payment',
        visible: canRecordPayment,
      },
      {
        id: 'parties',
        label: 'Party Ledger',
        subtitle: 'Balances, payments & downloadable statements',
        icon: Building2,
        kind: 'nav',
        navTarget: 'parties',
        visible: true,
      },
      {
        id: 'vehicles',
        label: 'Vehicle Details',
        subtitle: 'Truck master, documents & vehicle ledger',
        icon: Truck,
        kind: 'nav',
        navTarget: 'vehicles',
        visible: true,
      },
      {
        id: 'drivers',
        label: 'Driver Details',
        subtitle: 'Driver roster, license expiry & payments',
        icon: Users,
        kind: 'nav',
        navTarget: 'drivers',
        visible: true,
      },
      {
        id: 'expiry-alerts',
        label: 'Vehicle Document Expiry Alerts',
        subtitle: '5-day reminders, overdue alerts & WhatsApp',
        icon: BellRing,
        kind: 'nav',
        navTarget: 'expiry-alerts',
        visible: true,
      },
      {
        id: 'container-rear-photo',
        label: 'Container Rear Photo Capture',
        subtitle: '1 rear-door photo per trip with offline queue',
        icon: Camera,
        kind: 'rear-photo',
        visible: true,
        badgeText:
          pendingContainerPhotos.length > 0
            ? `${pendingContainerPhotos.length} Pending`
            : undefined,
      },
    ],
    [
      permissions.canEditTrips,
      permissions.canManageBilling,
      canRecordPayment,
      pendingContainerPhotos.length,
    ]
  );

  const handleModuleSelect = (item: MobileModuleEntry) => {
    setModulesSheetOpen(false);
    if (item.kind === 'payment') {
      setPaymentModalOpen(true);
      return;
    }
    if (item.kind === 'rear-photo') {
      setPhotoSheetOpen(true);
      return;
    }
    if (item.navTarget === 'trip-entry') {
      onNewTripClick();
      return;
    }
    if (item.navTarget) {
      onNavigate(item.navTarget);
    }
  };

  const handleTriggerSync = async () => {
    if (!isOnline) {
      setSyncNotice(
        'Device is offline. Queued rear container photos and Firestore cache remain safe and will auto-sync once internet returns.'
      );
      return;
    }
    setSyncNotice(null);
    await onSyncPendingPhotos();
  };

  const handleMobilePhotoPrepared = async (prepared: PreparedContainerPhoto) => {
    if (!selectedPhotoTrip) return;
    const metadata: ContainerPhotoTripMetadata = {
      tripId: selectedPhotoTrip.id,
      tripNumber: deriveTripNumber(selectedPhotoTrip),
      lrNumber: selectedPhotoTrip.lrNumber || deriveTripNumber(selectedPhotoTrip),
      vehicleNumber: selectedPhotoTrip.vehicleNumber || '',
      containerNumber: selectedPhotoTrip.containerNo || '',
    };
    await onUploadContainerPhoto(prepared, metadata);
  };

  const roleLabel = isSuperAdmin
    ? 'Super Admin'
    : permissions.isAdmin
    ? 'Admin'
    : permissions.recipientRole === 'driver'
    ? 'Driver'
    : 'Office Staff';

  const activeTitle = SECTION_TITLE_MAP[activeSection] || 'Bapasitaram ERP';

  return (
    <div className="android-mobile-shell min-h-screen bg-[#f1f5f9] text-slate-900 flex flex-col">
      {/* Compact Android Top App Bar (52px + safe-area top) */}
      <header className="sticky top-0 z-40 bg-[#111827] text-white border-b-2 border-orange-600 pt-safe no-print">
        <div className="h-[52px] px-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {activeSection !== 'dashboard' ? (
              <button
                type="button"
                onClick={() => onNavigate('dashboard')}
                aria-label="Back to Dashboard"
                className="min-h-[44px] min-w-[44px] -ml-1 flex items-center justify-center rounded-md text-slate-200 hover:bg-slate-800 active:bg-slate-700 cursor-pointer"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            ) : (
              <div className="w-8 h-8 rounded bg-orange-600 flex items-center justify-center shrink-0 ml-0.5">
                <Truck className="w-4 h-4 text-white" />
              </div>
            )}

            <div className="min-w-0 leading-tight">
              <div className="font-display text-lg font-bold tracking-wide uppercase text-white truncate">
                {activeTitle}
              </div>
              <div className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 truncate">
                Bapasitaram ERP
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {(!isOnline || pendingContainerPhotos.length > 0) && (
              <button
                type="button"
                onClick={() => void handleTriggerSync()}
                aria-label={isOnline ? 'Sync pending offline photos' : 'Offline status'}
                className={`min-h-[44px] px-2.5 rounded-md text-[11px] font-bold flex items-center gap-1.5 cursor-pointer ${
                  isOnline
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'bg-red-500/20 text-red-200 border border-red-500/40'
                }`}
              >
                {isOnline ? (
                  <RefreshCw className={`w-3.5 h-3.5 ${syncingPhotos ? 'animate-spin' : ''}`} />
                ) : (
                  <CloudOff className="w-3.5 h-3.5" />
                )}
                <span>
                  {isOnline
                    ? syncingPhotos
                      ? 'Sync'
                      : `${pendingContainerPhotos.length}`
                    : 'Offline'}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setPhotoSheetOpen(true)}
              aria-label="Container Rear Photo Capture"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-slate-200 hover:bg-slate-800 active:bg-slate-700 cursor-pointer"
            >
              <Camera className="w-5 h-5" />
            </button>

            {canRecordPayment && (
              <button
                type="button"
                onClick={() => setPaymentModalOpen(true)}
                className="min-h-[44px] px-3 rounded-md bg-orange-600 hover:bg-orange-500 active:bg-orange-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <IndianRupee className="w-3.5 h-3.5" />
                <span>Pay</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Non-blocking Offline / Sync Notice Banner */}
      {syncNotice && (
        <div className="bg-amber-50 border-b border-amber-300 px-3.5 py-2.5 flex items-start justify-between gap-2 text-xs text-amber-950 no-print">
          <span>{syncNotice}</span>
          <button
            type="button"
            onClick={() => setSyncNotice(null)}
            aria-label="Dismiss offline notice"
            className="p-1 text-amber-800 hover:text-amber-950 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Mobile Workspace */}
      <main className="erp-industrial-workspace flex-1 px-3 py-3.5 pb-24 max-w-full overflow-x-hidden">
        {children}
      </main>

      {/* Fixed 5-Slot Thumb-Zone Bottom Tab Bar */}
      <nav
        aria-label="Mobile ERP Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 bg-[#0b111c]/95 backdrop-blur-md border-t border-slate-800 pb-safe no-print"
      >
        <div className="grid grid-cols-5 h-16">
          <button
            type="button"
            onClick={() => onNavigate('dashboard')}
            className={`flex flex-col items-center justify-center gap-1 min-h-[44px] cursor-pointer ${
              activeSection === 'dashboard'
                ? 'text-orange-500 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Gauge className="w-5 h-5" />
            <span className="text-[11px] leading-none">Home</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('trip-history')}
            className={`flex flex-col items-center justify-center gap-1 min-h-[44px] cursor-pointer ${
              activeSection === 'trip-history' || activeSection === 'trip-entry'
                ? 'text-orange-500 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Route className="w-5 h-5" />
            <span className="text-[11px] leading-none">Trips</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('lorry-receipts')}
            className={`flex flex-col items-center justify-center gap-1 min-h-[44px] cursor-pointer ${
              activeSection === 'lorry-receipts'
                ? 'text-orange-500 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCheck2 className="w-5 h-5" />
            <span className="text-[11px] leading-none">LR</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('parties')}
            className={`flex flex-col items-center justify-center gap-1 min-h-[44px] cursor-pointer ${
              activeSection === 'parties'
                ? 'text-orange-500 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Building2 className="w-5 h-5" />
            <span className="text-[11px] leading-none">Ledger</span>
          </button>

          <button
            type="button"
            onClick={() => setModulesSheetOpen(true)}
            aria-expanded={modulesSheetOpen}
            className={`flex flex-col items-center justify-center gap-1 min-h-[44px] cursor-pointer ${
              modulesSheetOpen
                ? 'text-orange-500 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutGrid className="w-5 h-5" />
            <span className="text-[11px] leading-none">Modules</span>
          </button>
        </div>
      </nav>

      {/* Slide-up "All Mobile Modules" Android Bottom Sheet */}
      {modulesSheetOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 flex items-end justify-center no-print"
          role="dialog"
          aria-modal="true"
          aria-label="All Mobile ERP Modules"
        >
          <div className="w-full max-w-lg bg-[#111827] text-white rounded-t-2xl border-t border-slate-700 max-h-[88vh] flex flex-col pb-safe">
            <div className="pt-3 pb-2 px-4 border-b border-slate-800">
              <div className="w-10 h-1.5 bg-slate-600 rounded-full mx-auto mb-3" />
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-xl font-bold uppercase tracking-wide text-white">
                    ERP Mobile Modules
                  </h2>
                  <p className="text-xs text-slate-400">
                    {user.displayName || user.email} · {roleLabel}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setModulesSheetOpen(false)}
                  aria-label="Close modules menu"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Connection & Offline Sync Summary */}
            <div className="px-4 py-2.5 bg-[#0b111c] border-b border-slate-800 flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                {isOnline ? (
                  <Wifi className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <CloudOff className="w-4 h-4 text-amber-400 shrink-0" />
                )}
                <span className="text-slate-200 truncate">
                  {isOnline
                    ? pendingContainerPhotos.length > 0
                      ? `Online · ${pendingContainerPhotos.length} photo(s) syncing`
                      : 'Online · Firestore live sync active'
                    : `Offline · ${pendingContainerPhotos.length} photo(s) queued safely`}
                </span>
              </div>
              {pendingContainerPhotos.length > 0 && isOnline && (
                <button
                  type="button"
                  onClick={() => void handleTriggerSync()}
                  className="px-2.5 py-1.5 rounded bg-orange-600 text-white font-semibold text-xs shrink-0 cursor-pointer"
                >
                  {syncingPhotos ? 'Syncing...' : 'Sync Now'}
                </button>
              )}
            </div>

            {/* 11 Mobile Modules List */}
            <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-1.5">
              {coreMobileModules
                .filter((m) => m.visible)
                .map((item) => {
                  const Icon = item.icon;
                  const isCurrent =
                    item.kind === 'nav' && item.navTarget === activeSection;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleModuleSelect(item)}
                      className={`w-full min-h-[54px] px-3.5 py-2.5 rounded-lg border text-left flex items-center justify-between gap-3 cursor-pointer ${
                        isCurrent
                          ? 'bg-orange-600/15 border-orange-500 text-white'
                          : 'bg-slate-900/80 border-slate-800 text-slate-100 hover:bg-slate-800/80'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${
                            isCurrent
                              ? 'bg-orange-600 text-white'
                              : 'bg-slate-800 text-orange-400'
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-white truncate">
                            {item.label}
                          </div>
                          <div className="text-xs text-slate-400 truncate">
                            {item.subtitle}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {item.badgeText && (
                          <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[11px] font-semibold">
                            {item.badgeText}
                          </span>
                        )}
                        <ChevronRight className="w-4 h-4 text-slate-500" />
                      </div>
                    </button>
                  );
                })}

              {permissions.isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setModulesSheetOpen(false);
                    onNavigate('security');
                  }}
                  className="w-full min-h-[50px] px-3.5 py-2 rounded-lg border border-slate-800 bg-slate-900/50 text-left flex items-center justify-between gap-3 hover:bg-slate-800/70 cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-md bg-slate-800 text-emerald-400 flex items-center justify-center shrink-0">
                      <ShieldCheck className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white truncate">
                        Security, Users &amp; Backup
                      </div>
                      <div className="text-xs text-slate-400 truncate">
                        Admin roles, audit trail &amp; JSON backup
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
                </button>
              )}
            </div>

            {/* Sign Out Footer */}
            <div className="px-4 py-3 border-t border-slate-800 bg-[#0b111c]">
              <button
                type="button"
                onClick={() => {
                  setModulesSheetOpen(false);
                  onSignOut();
                }}
                className="w-full min-h-[48px] rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer"
              >
                <LogOut className="w-4 h-4 text-orange-400" />
                <span>Sign Out ({user.email})</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dedicated Mobile Container Rear Photo Capture Sheet */}
      {photoSheetOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 flex items-end justify-center no-print"
          role="dialog"
          aria-modal="true"
          aria-label="Container Rear Photo Capture"
        >
          <div className="w-full max-w-lg bg-white text-slate-900 rounded-t-2xl border-t border-slate-300 max-h-[92vh] flex flex-col pb-safe">
            <div className="pt-3 pb-2.5 px-4 bg-[#111827] text-white rounded-t-2xl">
              <div className="w-10 h-1.5 bg-slate-600 rounded-full mx-auto mb-3" />
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-xl font-bold uppercase tracking-wide text-white">
                    Container Rear Photo Capture
                  </h2>
                  <p className="text-xs text-slate-300">
                    1 rear-door photo per trip · Works offline &amp; auto-syncs
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPhotoSheetOpen(false)}
                  aria-label="Close container photo capture"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-slate-200 hover:bg-slate-800 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {trips.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-5 text-center space-y-2">
                  <p className="text-sm font-semibold text-slate-800">
                    No trips available yet
                  </p>
                  <p className="text-xs text-slate-600">
                    Create a Trip Entry first to attach a rear-side shipping container doors photo.
                  </p>
                  {permissions.canEditTrips && (
                    <button
                      type="button"
                      onClick={() => {
                        setPhotoSheetOpen(false);
                        onNewTripClick();
                      }}
                      className="mt-2 min-h-[44px] px-4 rounded-md bg-orange-600 text-white text-xs font-bold cursor-pointer"
                    >
                      Open Trip Entry
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <label
                      htmlFor="mobile-photo-trip-search"
                      className="block text-xs font-bold uppercase tracking-wider text-slate-700"
                    >
                      Select Trip (Linked to Trip No, LR, Vehicle &amp; Container)
                    </label>
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        id="mobile-photo-trip-search"
                        type="search"
                        value={photoTripSearch}
                        onChange={(e) => setPhotoTripSearch(e.target.value)}
                        placeholder="Search LR, Vehicle, Container or Party..."
                        className="w-full min-h-[44px] pl-9 pr-3 py-2 rounded-md border border-slate-300 text-base bg-white text-slate-900"
                      />
                    </div>
                    <select
                      aria-label="Choose trip for container rear photo"
                      value={selectedPhotoTrip?.id || ''}
                      onChange={(e) => setSelectedPhotoTripId(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 rounded-md border border-slate-300 text-base bg-white text-slate-900"
                    >
                      {filteredPhotoTrips.map((t) => {
                        const hasSynced = syncedPhotoByTripId.has(t.id);
                        const hasPending = pendingPhotoByTripId.has(t.id);
                        const statusTag = hasPending
                          ? '[Queued]'
                          : hasSynced
                          ? '[Photo Saved]'
                          : '[No Photo]';
                        return (
                          <option key={t.id} value={t.id}>
                            {`${statusTag} LR ${t.lrNumber || deriveTripNumber(t)} · ${t.vehicleNumber} · ${
                              t.containerNo || 'No Container'
                            } (${formatDateIN(t.tripDate)})`}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {selectedPhotoTrip && (
                    <ContainerPhotoCard
                      tripNumber={deriveTripNumber(selectedPhotoTrip)}
                      lrNumber={
                        selectedPhotoTrip.lrNumber ||
                        deriveTripNumber(selectedPhotoTrip)
                      }
                      vehicleNumber={selectedPhotoTrip.vehicleNumber}
                      containerNumber={selectedPhotoTrip.containerNo || ''}
                      syncedPhoto={
                        syncedPhotoByTripId.get(selectedPhotoTrip.id) || null
                      }
                      pendingPhoto={
                        pendingPhotoByTripId.get(selectedPhotoTrip.id) || null
                      }
                      permissions={permissions}
                      isOnline={isOnline}
                      syncing={syncingPhotos}
                      canCapture={canCapturePhoto}
                      onCapturePrepared={handleMobilePhotoPrepared}
                      onDeleteSynced={onDeleteContainerPhoto}
                      onDiscardPending={onDiscardPendingPhoto}
                      onSyncNow={onSyncPendingPhotos}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reusable Payment Entry Modal (zero duplicated financial logic) */}
      <AddPaymentModal
        open={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        userId={user.uid}
        actorRole={permissions.role}
        parties={parties}
        trips={trips}
        partyPayments={partyPayments}
        companyName={companySettings?.companyName || 'BAPASITARAM ENTERPRISE'}
      />
    </div>
  );
};
