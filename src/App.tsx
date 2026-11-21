/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  auth,
  BOOTSTRAP_ADMIN_EMAIL,
  db,
  handleFirestoreError,
  OperationType,
} from './firebase';
import type {
  AuditLog,
  Bill,
  CompanySettings,
  Driver,
  DriverPayment,
  ErpUser,
  ExpiryAlertScope,
  ExpiryNotificationRecord,
  ExpiryRecipientRole,
  ImportBatch,
  ImportedSheetRow,
  LorryReceipt,
  MaintenanceRecord,
  NavSection,
  NotificationPreference,
  Party,
  PartyPayment,
  Trip,
  UserPermissions,
  Vehicle,
} from './types/erp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AdminLogin } from './components/AdminLogin';
import { LayoutShell } from './components/LayoutShell';
import { DashboardView } from './components/DashboardView';
import { VehiclesView } from './components/VehiclesView';
import { ExpiryNotificationsView } from './components/ExpiryNotificationsView';
import { PartiesView } from './components/PartiesView';
import { DriversView } from './components/DriversView';
import { ExpensesView } from './components/ExpensesView';
import { BillingView } from './components/BillingView';
import { LorryReceiptsView } from './components/LorryReceiptsView';
import { ReportsView } from './components/ReportsView';
import { SecurityBackupView } from './components/SecurityBackupView';
import { TripEntryView } from './components/TripEntryView';
import { TripHistoryView } from './components/TripHistoryView';
import { ExcelImportView } from './components/ExcelImportView';
import { RouteMapView } from './components/RouteMapView';
import { ErpAssistantView } from './components/ErpAssistantView';
import {
  loadChecklistCompletion,
  Phase1ChecklistDrawer,
} from './components/Phase1ChecklistDrawer';

function ErpAppContent() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [editingTrip, setEditingTrip] = useState<Trip | null>(null);
  const [preselectedPartyId, setPreselectedPartyId] = useState<string | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checklistCompletedCount, setChecklistCompletedCount] = useState(0);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [partyPayments, setPartyPayments] = useState<PartyPayment[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driverPayments, setDriverPayments] = useState<DriverPayment[]>([]);
  const [maintenanceRecords, setMaintenanceRecords] = useState<MaintenanceRecord[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [lorryReceipts, setLorryReceipts] = useState<LorryReceipt[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [erpUsers, setErpUsers] = useState<ErpUser[]>([]);
  const [notificationPreferences, setNotificationPreferences] = useState<
    NotificationPreference[]
  >([]);
  const [expiryNotifications, setExpiryNotifications] = useState<ExpiryNotificationRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [importBatches, setImportBatches] = useState<ImportBatch[]>([]);
  const [importedSheetRows, setImportedSheetRows] = useState<ImportedSheetRow[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const isSuperAdmin = Boolean(
    user && user.emailVerified && user.email === BOOTSTRAP_ADMIN_EMAIL
  );

  // 1. Auth State Observer
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser && !firebaseUser.emailVerified) {
        setAuthError(
          'Your Google account email is not verified. Please sign in with a verified Google account.'
        );
        await signOut(auth);
        setUser(null);
        setAuthReady(true);
        return;
      }
      setUser(firebaseUser);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setChecklistCompletedCount(0);
      return;
    }
    const saved = loadChecklistCompletion(user.uid);
    setChecklistCompletedCount(Object.values(saved).filter(Boolean).length);
  }, [user?.uid]);

  // 2. Real-time Firestore Listeners (no where+orderBy compound queries; sorted client-side)
  useEffect(() => {
    if (!authReady || !user || !user.emailVerified) {
      setVehicles([]);
      setParties([]);
      setPartyPayments([]);
      setTrips([]);
      setDrivers([]);
      setDriverPayments([]);
      setMaintenanceRecords([]);
      setBills([]);
      setLorryReceipts([]);
      setCompanySettings(null);
      setErpUsers([]);
      setNotificationPreferences([]);
      setExpiryNotifications([]);
      setAuditLogs([]);
      setImportBatches([]);
      setImportedSheetRows([]);
      setDataLoading(false);
      return;
    }

    setDataLoading(true);
    const readyFlags = {
      vehicles: false,
      parties: false,
      partyPayments: false,
      trips: false,
      drivers: false,
      driverPayments: false,
      maintenanceRecords: false,
      bills: false,
      lorryReceipts: false,
      companySettings: false,
      erpUsers: false,
      notificationPreferences: false,
      expiryNotifications: false,
      auditLogs: false,
      batches: false,
      rows: false,
    };

    const checkReady = () => {
      if (Object.values(readyFlags).every(Boolean)) {
        setDataLoading(false);
      }
    };

    const scopedQuery = (colName: string) =>
      isSuperAdmin
        ? query(collection(db, colName))
        : query(collection(db, colName), where('ownerId', '==', user.uid));

    const erpUsersQuery = isSuperAdmin
      ? query(collection(db, 'erpUsers'))
      : query(collection(db, 'erpUsers'), where('email', '==', user.email || ''));

    const getMillis = (ts: { toMillis?: () => number } | null | undefined): number =>
      ts && typeof ts.toMillis === 'function' ? ts.toMillis() : Date.now();

    const unsubVehicles = onSnapshot(
      scopedQuery('vehicles'),
      (snap) => {
        setVehicles(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Vehicle, 'id'>) }))
            .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        readyFlags.vehicles = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'vehicles')
    );

    const unsubParties = onSnapshot(
      scopedQuery('parties'),
      (snap) => {
        setParties(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Party, 'id'>) }))
            .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        readyFlags.parties = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'parties')
    );

    const unsubPartyPayments = onSnapshot(
      scopedQuery('partyPayments'),
      (snap) => {
        setPartyPayments(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<PartyPayment, 'id'>) }))
            .sort((a, b) => {
              const dateCmp = b.paymentDate.localeCompare(a.paymentDate);
              if (dateCmp !== 0) return dateCmp;
              return getMillis(b.createdAt) - getMillis(a.createdAt);
            })
        );
        readyFlags.partyPayments = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'partyPayments')
    );

    const unsubTrips = onSnapshot(
      scopedQuery('trips'),
      (snap) => {
        setTrips(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Trip, 'id'>) }))
            .sort((a, b) => {
              const dateCmp = b.tripDate.localeCompare(a.tripDate);
              if (dateCmp !== 0) return dateCmp;
              return getMillis(b.createdAt) - getMillis(a.createdAt);
            })
        );
        readyFlags.trips = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'trips')
    );

    const unsubDrivers = onSnapshot(
      scopedQuery('drivers'),
      (snap) => {
        setDrivers(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Driver, 'id'>) }))
            .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        readyFlags.drivers = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'drivers')
    );

    const unsubDriverPayments = onSnapshot(
      scopedQuery('driverPayments'),
      (snap) => {
        setDriverPayments(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<DriverPayment, 'id'>) }))
            .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
        );
        readyFlags.driverPayments = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'driverPayments')
    );

    const unsubMaintenance = onSnapshot(
      scopedQuery('maintenanceRecords'),
      (snap) => {
        setMaintenanceRecords(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<MaintenanceRecord, 'id'>) }))
            .sort((a, b) => b.expenseDate.localeCompare(a.expenseDate))
        );
        readyFlags.maintenanceRecords = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'maintenanceRecords')
    );

    const unsubBills = onSnapshot(
      scopedQuery('bills'),
      (snap) => {
        setBills(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Bill, 'id'>) }))
            .sort((a, b) => b.billDate.localeCompare(a.billDate))
        );
        readyFlags.bills = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'bills')
    );

    const unsubLorryReceipts = onSnapshot(
      scopedQuery('lorryReceipts'),
      (snap) => {
        setLorryReceipts(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<LorryReceipt, 'id'>) }))
            .sort((a, b) => {
              const dateCmp = b.lrDate.localeCompare(a.lrDate);
              if (dateCmp !== 0) return dateCmp;
              return getMillis(b.createdAt) - getMillis(a.createdAt);
            })
        );
        readyFlags.lorryReceipts = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'lorryReceipts')
    );

    const unsubSettings = onSnapshot(
      scopedQuery('companySettings'),
      (snap) => {
        const first = snap.docs[0];
        setCompanySettings(
          first ? { id: first.id, ...(first.data() as Omit<CompanySettings, 'id'>) } : null
        );
        readyFlags.companySettings = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'companySettings')
    );

    const unsubErpUsers = onSnapshot(
      erpUsersQuery,
      (snap) => {
        setErpUsers(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<ErpUser, 'id'>) }))
            .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        readyFlags.erpUsers = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'erpUsers')
    );

    const unsubNotificationPrefs = onSnapshot(
      scopedQuery('notificationPreferences'),
      (snap) => {
        setNotificationPreferences(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<NotificationPreference, 'id'>),
          }))
        );
        readyFlags.notificationPreferences = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'notificationPreferences')
    );

    let unsubExpiryNotifications = () => {};
    if (isSuperAdmin) {
      unsubExpiryNotifications = onSnapshot(
        query(collection(db, 'expiryNotifications')),
        (snap) => {
          setExpiryNotifications(
            snap.docs
              .map((d) => ({ id: d.id, ...(d.data() as Omit<ExpiryNotificationRecord, 'id'>) }))
              .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
          );
          readyFlags.expiryNotifications = true;
          checkReady();
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'expiryNotifications')
      );
    } else {
      let ownRows: ExpiryNotificationRecord[] = [];
      let emailRows: ExpiryNotificationRecord[] = [];
      let ownReady = false;
      let emailReady = false;

      const syncMerged = () => {
        const merged = new Map<string, ExpiryNotificationRecord>();
        ownRows.forEach((r) => merged.set(r.id, r));
        emailRows.forEach((r) => merged.set(r.id, r));
        setExpiryNotifications(
          Array.from(merged.values()).sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        if (ownReady && emailReady) {
          readyFlags.expiryNotifications = true;
          checkReady();
        }
      };

      const unsubOwnNotifs = onSnapshot(
        query(collection(db, 'expiryNotifications'), where('ownerId', '==', user.uid)),
        (snap) => {
          ownRows = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<ExpiryNotificationRecord, 'id'>),
          }));
          ownReady = true;
          syncMerged();
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'expiryNotifications')
      );

      const unsubRecipientNotifs = onSnapshot(
        query(
          collection(db, 'expiryNotifications'),
          where('recipientEmail', '==', user.email || '')
        ),
        (snap) => {
          emailRows = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<ExpiryNotificationRecord, 'id'>),
          }));
          emailReady = true;
          syncMerged();
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'expiryNotifications')
      );

      unsubExpiryNotifications = () => {
        unsubOwnNotifs();
        unsubRecipientNotifs();
      };
    }

    const unsubAuditLogs = onSnapshot(
      scopedQuery('auditLogs'),
      (snap) => {
        setAuditLogs(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLog, 'id'>) }))
            .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        readyFlags.auditLogs = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'auditLogs')
    );

    const unsubBatches = onSnapshot(
      scopedQuery('importBatches'),
      (snap) => {
        setImportBatches(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<ImportBatch, 'id'>) }))
            .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        readyFlags.batches = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'importBatches')
    );

    const unsubRows = onSnapshot(
      scopedQuery('importedSheetRows'),
      (snap) => {
        setImportedSheetRows(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<ImportedSheetRow, 'id'>) }))
            .sort((a, b) => getMillis(b.createdAt) - getMillis(a.createdAt))
        );
        readyFlags.rows = true;
        checkReady();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'importedSheetRows')
    );

    return () => {
      unsubVehicles();
      unsubParties();
      unsubPartyPayments();
      unsubTrips();
      unsubDrivers();
      unsubDriverPayments();
      unsubMaintenance();
      unsubBills();
      unsubLorryReceipts();
      unsubSettings();
      unsubErpUsers();
      unsubNotificationPrefs();
      unsubExpiryNotifications();
      unsubAuditLogs();
      unsubBatches();
      unsubRows();
    };
  }, [authReady, user, isSuperAdmin]);

  const userPermissions: UserPermissions = useMemo(() => {
    if (isSuperAdmin) {
      return {
        role: 'admin',
        recipientRole: 'admin',
        expiryAlertScope: 'all',
        assignedVehicleIds: [],
        assignedDriverId: '',
        isAdmin: true,
        isSuspended: false,
        canEditTrips: true,
        canDeleteRecords: true,
        canManageBilling: true,
        canImportExcel: true,
        canExportData: true,
        canManageMasters: true,
      };
    }

    const emailLower = (user?.email || '').toLowerCase();
    const matched = erpUsers.find((u) => u.email.toLowerCase() === emailLower);
    if (matched) {
      const isUserAdmin = matched.role === 'admin';
      const recipientRole: ExpiryRecipientRole = isUserAdmin
        ? 'admin'
        : matched.recipientRole || 'office_staff';
      const expiryAlertScope: ExpiryAlertScope = isUserAdmin
        ? 'all'
        : recipientRole === 'driver'
        ? 'assigned'
        : matched.expiryAlertScope || 'assigned';
      return {
        role: matched.role,
        recipientRole,
        expiryAlertScope,
        assignedVehicleIds: Array.isArray(matched.assignedVehicleIds)
          ? matched.assignedVehicleIds
          : [],
        assignedDriverId: matched.assignedDriverId || '',
        isAdmin: isUserAdmin,
        isSuspended: matched.status === 'Suspended',
        canEditTrips: isUserAdmin || matched.canEditTrips,
        canDeleteRecords: isUserAdmin || matched.canDeleteRecords,
        canManageBilling: isUserAdmin || matched.canManageBilling,
        canImportExcel: isUserAdmin || matched.canImportExcel,
        canExportData: isUserAdmin || matched.canExportData,
        canManageMasters: isUserAdmin || matched.canManageMasters,
      };
    }

    // Uninvited verified users receive read-only/restricted permissions and zero expiry alerts until authorized by Admin
    return {
      role: 'employee',
      recipientRole: 'office_staff',
      expiryAlertScope: 'none',
      assignedVehicleIds: [],
      assignedDriverId: '',
      isAdmin: false,
      isSuspended: false,
      canEditTrips: false,
      canDeleteRecords: false,
      canManageBilling: false,
      canImportExcel: false,
      canExportData: false,
      canManageMasters: false,
    };
  }, [isSuperAdmin, erpUsers, user?.email]);

  const handleSignOut = async () => {
    await signOut(auth);
    setActiveSection('dashboard');
    setEditingTrip(null);
    setPreselectedPartyId(null);
  };

  const handleNavigate = (section: NavSection) => {
    if (section !== 'trip-entry') {
      setEditingTrip(null);
    }
    setActiveSection(section);
  };

  const handleOpenNewTrip = () => {
    setEditingTrip(null);
    setActiveSection('trip-entry');
  };

  const handleEditTrip = (trip: Trip) => {
    setEditingTrip(trip);
    setActiveSection('trip-entry');
  };

  const handleGenerateBillForParty = (partyId: string) => {
    setPreselectedPartyId(partyId);
    setActiveSection('billing');
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <div className="font-display text-lg font-semibold text-slate-900">
            BAPASITARAM ENTERPRISE
          </div>
          <div className="text-xs text-slate-500">Loading ERP session...</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AdminLogin
        authError={authError}
        onClearError={() => setAuthError(null)}
      />
    );
  }

  if (userPermissions.isSuspended) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 text-center space-y-3">
          <h1 className="font-display text-lg font-semibold text-slate-900">
            ERP Access Suspended
          </h1>
          <p className="text-xs text-slate-600 leading-relaxed">
            Your account ({user.email}) is currently suspended by the BAPASITARAM ENTERPRISE administrator.
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg cursor-pointer"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <LayoutShell
      user={user}
      isSuperAdmin={isSuperAdmin}
      permissions={userPermissions}
      activeSection={activeSection}
      onNavigate={handleNavigate}
      onSignOut={handleSignOut}
      onNewTripClick={handleOpenNewTrip}
      onOpenChecklist={() => setChecklistOpen(true)}
      checklistCompletedCount={checklistCompletedCount}
    >
      {activeSection === 'dashboard' && (
        <DashboardView
          userId={user.uid}
          userEmail={user.email || ''}
          userDisplayName={user.displayName || ''}
          permissions={userPermissions}
          vehicles={vehicles}
          parties={parties}
          trips={trips}
          drivers={drivers}
          driverPayments={driverPayments}
          maintenanceRecords={maintenanceRecords}
          bills={bills}
          erpUsers={erpUsers}
          notificationPreferences={notificationPreferences}
          expiryNotifications={expiryNotifications}
          companySettings={companySettings}
          loading={dataLoading}
          onNavigate={handleNavigate}
          onOpenNewTrip={handleOpenNewTrip}
        />
      )}

      {activeSection === 'vehicles' && (
        <VehiclesView
          userId={user.uid}
          actorRole={userPermissions.role}
          permissions={userPermissions}
          vehicles={vehicles}
          trips={trips}
          maintenanceRecords={maintenanceRecords}
          driverPayments={driverPayments}
          loading={dataLoading}
        />
      )}

      {activeSection === 'expiry-alerts' && (
        <ExpiryNotificationsView
          userId={user.uid}
          userEmail={user.email || ''}
          userDisplayName={user.displayName || ''}
          actorRole={userPermissions.role}
          isSuperAdmin={isSuperAdmin}
          permissions={userPermissions}
          vehicles={vehicles}
          drivers={drivers}
          erpUsers={erpUsers}
          notificationPreferences={notificationPreferences}
          expiryNotifications={expiryNotifications}
          companySettings={companySettings}
          loading={dataLoading}
          onNavigate={handleNavigate}
        />
      )}

      {activeSection === 'parties' && (
        <PartiesView
          userId={user.uid}
          actorRole={userPermissions.role}
          permissions={userPermissions}
          parties={parties}
          partyPayments={partyPayments}
          trips={trips}
          bills={bills}
          companySettings={companySettings}
          loading={dataLoading}
          onGenerateBillForParty={handleGenerateBillForParty}
        />
      )}

      {activeSection === 'drivers' && (
        <DriversView
          userId={user.uid}
          actorRole={userPermissions.role}
          permissions={userPermissions}
          drivers={drivers}
          driverPayments={driverPayments}
          vehicles={vehicles}
          trips={trips}
          loading={dataLoading}
        />
      )}

      {activeSection === 'expenses' && (
        <ExpensesView
          userId={user.uid}
          actorRole={userPermissions.role}
          permissions={userPermissions}
          companySettings={companySettings}
          vehicles={vehicles}
          trips={trips}
          maintenanceRecords={maintenanceRecords}
          driverPayments={driverPayments}
          loading={dataLoading}
        />
      )}

      {activeSection === 'lorry-receipts' && (
        <LorryReceiptsView
          userId={user.uid}
          actorRole={userPermissions.role}
          permissions={userPermissions}
          lorryReceipts={lorryReceipts}
          vehicles={vehicles}
          parties={parties}
          trips={trips}
          drivers={drivers}
          companySettings={companySettings}
          loading={dataLoading}
        />
      )}

      {activeSection === 'billing' && (
        <BillingView
          userId={user.uid}
          actorRole={userPermissions.role}
          permissions={userPermissions}
          parties={parties}
          trips={trips}
          bills={bills}
          companySettings={companySettings}
          preselectedPartyId={preselectedPartyId}
          onClearPreselectedParty={() => setPreselectedPartyId(null)}
          loading={dataLoading}
        />
      )}

      {activeSection === 'reports' && (
        <ReportsView
          permissions={userPermissions}
          vehicles={vehicles}
          parties={parties}
          trips={trips}
          drivers={drivers}
          driverPayments={driverPayments}
          maintenanceRecords={maintenanceRecords}
        />
      )}

      {activeSection === 'route-map' && (
        <RouteMapView trips={trips} companySettings={companySettings} />
      )}

      {activeSection === 'ai-assistant' && (
        <ErpAssistantView
          user={user}
          vehicles={vehicles}
          parties={parties}
          partyPayments={partyPayments}
          trips={trips}
          drivers={drivers}
          bills={bills}
          companySettings={companySettings}
        />
      )}

      {activeSection === 'trip-entry' && (
        <TripEntryView
          userId={user.uid}
          actorRole={userPermissions.role}
          isSuperAdmin={isSuperAdmin}
          permissions={userPermissions}
          companySettings={companySettings}
          vehicles={vehicles}
          parties={parties}
          editingTrip={editingTrip}
          onCancelEdit={() => setEditingTrip(null)}
          onSuccessNavigate={handleNavigate}
        />
      )}

      {activeSection === 'trip-history' && (
        <TripHistoryView
          userId={user.uid}
          permissions={userPermissions}
          trips={trips}
          loading={dataLoading}
          onNewTrip={handleOpenNewTrip}
          onEditTrip={handleEditTrip}
        />
      )}

      {activeSection === 'excel-import' && (
        <ExcelImportView
          userId={user.uid}
          actorRole={userPermissions.role}
          isSuperAdmin={isSuperAdmin}
          permissions={userPermissions}
          vehicles={vehicles}
          parties={parties}
          trips={trips}
          importBatches={importBatches}
          importedSheetRows={importedSheetRows}
          loading={dataLoading}
        />
      )}

      {activeSection === 'security' && (
        <SecurityBackupView
          userId={user.uid}
          userEmail={user.email || ''}
          isSuperAdmin={isSuperAdmin}
          permissions={userPermissions}
          erpUsers={erpUsers}
          auditLogs={auditLogs}
          vehicles={vehicles}
          parties={parties}
          partyPayments={partyPayments}
          trips={trips}
          drivers={drivers}
          driverPayments={driverPayments}
          maintenanceRecords={maintenanceRecords}
          bills={bills}
          importedSheetRows={importedSheetRows}
          companySettings={companySettings}
        />
      )}

      <Phase1ChecklistDrawer
        open={checklistOpen}
        userId={user.uid}
        companySettings={companySettings}
        vehicleCount={vehicles.length}
        partyCount={parties.length}
        billCount={bills.length}
        onClose={() => setChecklistOpen(false)}
        onNavigate={handleNavigate}
        onProgressChange={setChecklistCompletedCount}
      />
    </LayoutShell>
  );
}

export default function App() {
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);

  useEffect(() => {
    const handleQuotaExceeded = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
  }, []);

  return (
    <ErrorBoundary>
      {mapsQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm no-print">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}
      <ErpAppContent />
    </ErrorBoundary>
  );
}
