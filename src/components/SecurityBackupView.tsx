import React, { useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  ShieldCheck,
  UserPlus,
  Download,
  Upload,
  Cloud,
  History,
  Trash2,
  WifiOff,
  CheckCircle2,
  AlertTriangle,
  Archive,
  Lock,
  Search,
  Shield,
} from 'lucide-react';
import { db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type AuditLog,
  type Bill,
  type CompanySettings,
  type Driver,
  type DriverPayment,
  type ErpUser,
  type ErpUserRole,
  type ErpUserStatus,
  type ExpiryAlertScope,
  type ExpiryRecipientRole,
  type ImportedSheetRow,
  type MaintenanceRecord,
  type Party,
  type PartyPayment,
  type Trip,
  type UserPermissions,
  type Vehicle,
} from '../types/erp';
import {
  clampStr,
  exportSheetsToExcel,
  formatDateIN,
  formatINR,
  generateSafeDocId,
  getTodayISO,
} from '../utils/formatters';
import {
  classifyCleanupRecords,
  extractReadableFirestoreError,
  sanitizeBackupRecordForRestore,
  type CleanupCollectionName,
  type RestoreCollectionName,
} from '../utils/erpHelpers';
import { recordAuditLog } from '../utils/auditLogger';
import { ConfirmDialog } from './ConfirmDialog';

interface SecurityBackupViewProps {
  userId: string;
  userEmail: string;
  isSuperAdmin: boolean;
  permissions: UserPermissions;
  erpUsers: ErpUser[];
  auditLogs: AuditLog[];
  vehicles: Vehicle[];
  parties: Party[];
  partyPayments: PartyPayment[];
  trips: Trip[];
  drivers: Driver[];
  driverPayments: DriverPayment[];
  maintenanceRecords: MaintenanceRecord[];
  bills: Bill[];
  importedSheetRows: ImportedSheetRow[];
  companySettings: CompanySettings | null;
}

interface BackupPayload {
  schemaVersion: number;
  exportedAt: string;
  company: string;
  vehicles: Record<string, unknown>[];
  parties: Record<string, unknown>[];
  partyPayments?: Record<string, unknown>[];
  drivers: Record<string, unknown>[];
  trips: Record<string, unknown>[];
  driverPayments: Record<string, unknown>[];
  maintenanceRecords: Record<string, unknown>[];
  bills: Record<string, unknown>[];
  companySettings: Record<string, unknown>[];
}

export const SecurityBackupView: React.FC<SecurityBackupViewProps> = ({
  userId,
  userEmail,
  isSuperAdmin,
  permissions,
  erpUsers,
  auditLogs,
  vehicles,
  parties,
  partyPayments,
  trips,
  drivers,
  driverPayments,
  maintenanceRecords,
  bills,
  importedSheetRows,
  companySettings,
}) => {
  const [activeTab, setActiveTab] = useState<'rbac' | 'backup' | 'audit'>('rbac');

  // RBAC User creation
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newRole, setNewRole] = useState<ErpUserRole>('employee');
  const [newRecipientRole, setNewRecipientRole] = useState<ExpiryRecipientRole>('office_staff');
  const [newExpiryScope, setNewExpiryScope] = useState<ExpiryAlertScope>('assigned');
  const [newPerms, setNewPerms] = useState({
    canEditTrips: true,
    canDeleteRecords: false,
    canManageBilling: true,
    canImportExcel: false,
    canExportData: true,
    canManageMasters: false,
  });
  const [userError, setUserError] = useState<string | null>(null);
  const [savingUser, setSavingUser] = useState(false);
  const [deleteUserTarget, setDeleteUserTarget] = useState<ErpUser | null>(null);

  // Restore state
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{
    fileName: string;
    payload: BackupPayload;
    newCounts: {
      vehicles: number;
      parties: number;
      partyPayments: number;
      drivers: number;
      trips: number;
      driverPayments: number;
      maintenanceRecords: number;
      bills: number;
      companySettings: number;
    };
    skippedExisting: number;
  } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  // Verified Backup & Safe Old/Test Data Cleanup state
  const [verifiedBackup, setVerifiedBackup] = useState<{
    exportedAt: string;
    totalCount: number;
    summaryText: string;
  } | null>(null);
  const [cleanupScanned, setCleanupScanned] = useState(false);
  const [cleanupFilter, setCleanupFilter] = useState<
    'suspected-test' | 'regular-non-excel' | 'protected-excel'
  >('suspected-test');
  const [cleanupSearch, setCleanupSearch] = useState('');
  const [selectedCleanupKeys, setSelectedCleanupKeys] = useState<Set<string>>(new Set());
  const [cleanupConfirmMode, setCleanupConfirmMode] = useState<'archive' | 'delete' | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  // Audit filter
  const [auditSearch, setAuditSearch] = useState('');

  const filteredAuditLogs = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return auditLogs.slice(0, 100);
    return auditLogs
      .filter(
        (l) =>
          l.actorEmail.toLowerCase().includes(q) ||
          l.module.toLowerCase().includes(q) ||
          l.action.toLowerCase().includes(q) ||
          l.summary.toLowerCase().includes(q)
      )
      .slice(0, 100);
  }, [auditLogs, auditSearch]);

  const classifiedRecords = useMemo(() => {
    if (!cleanupScanned) return [];
    return classifyCleanupRecords({
      vehicles,
      parties,
      partyPayments,
      trips,
      drivers,
      driverPayments,
      maintenanceRecords,
      bills,
      importedSheetRows,
    });
  }, [
    cleanupScanned,
    vehicles,
    parties,
    partyPayments,
    trips,
    drivers,
    driverPayments,
    maintenanceRecords,
    bills,
    importedSheetRows,
  ]);

  const cleanupCounts = useMemo(() => {
    return {
      suspected: classifiedRecords.filter((r) => r.classification === 'suspected-test').length,
      regular: classifiedRecords.filter((r) => r.classification === 'regular-non-excel').length,
      protectedExcel: classifiedRecords.filter((r) => r.classification === 'protected-excel').length,
    };
  }, [classifiedRecords]);

  const visibleCleanupRecords = useMemo(() => {
    const q = cleanupSearch.trim().toLowerCase();
    return classifiedRecords.filter((r) => {
      if (r.classification !== cleanupFilter) return false;
      if (!q) return true;
      return (
        r.label.toLowerCase().includes(q) ||
        r.collection.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q)
      );
    });
  }, [classifiedRecords, cleanupFilter, cleanupSearch]);

  const selectedCleanupItems = useMemo(
    () =>
      classifiedRecords.filter(
        (r) =>
          selectedCleanupKeys.has(r.key) &&
          !r.isExcelLinked &&
          r.classification !== 'protected-excel'
      ),
    [classifiedRecords, selectedCleanupKeys]
  );

  const selectedCleanupConfirmationSummary = useMemo(() => {
    const byCol = new Map<CleanupCollectionName, number>();
    selectedCleanupItems.forEach((item) => {
      byCol.set(item.collection, (byCol.get(item.collection) || 0) + 1);
    });
    const breakdown = Array.from(byCol.entries())
      .map(([col, count]) => `${col}: ${count}`)
      .join(', ');
    const previewLabels = selectedCleanupItems
      .map((item, idx) => {
        const parts = [`${idx + 1}. [${item.collection}] ${item.label}`];
        if (item.date) parts.push(formatDateIN(item.date));
        if (item.amount !== 0) parts.push(formatINR(item.amount));
        return parts.join(' · ');
      })
      .join('\n');
    return { breakdown, previewLabels, remaining: '' };
  }, [selectedCleanupItems]);

  const handleCreateErpUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserError(null);
    const email = clampStr(newEmail.toLowerCase(), BLUEPRINT_LIMITS.EMAIL_MAX);
    const displayName = clampStr(newName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX);
    if (!email.includes('@') || email.length < 5) {
      setUserError('Enter a valid Google email address.');
      return;
    }
    if (!displayName) {
      setUserError('Display name is required.');
      return;
    }
    if (erpUsers.some((u) => u.email.toLowerCase() === email)) {
      setUserError('This email is already registered in ERP Users.');
      return;
    }

    const docId = generateSafeDocId('usr');
    const cleanPhone = clampStr(newPhone, BLUEPRINT_LIMITS.PHONE_MAX);
    const effectiveRecipientRole: ExpiryRecipientRole =
      newRole === 'admin' ? 'admin' : newRecipientRole;
    const effectiveScope: ExpiryAlertScope =
      newRole === 'admin'
        ? 'all'
        : effectiveRecipientRole === 'driver'
        ? 'assigned'
        : newExpiryScope;
    setSavingUser(true);
    try {
      await setDoc(doc(collection(db, 'erpUsers'), docId), {
        email,
        displayName,
        role: newRole,
        recipientRole: effectiveRecipientRole,
        phone: cleanPhone,
        expiryAlertScope: effectiveScope,
        assignedVehicleIds: [],
        assignedDriverId: '',
        status: 'Active' as ErpUserStatus,
        canEditTrips: newRole === 'admin' ? true : newPerms.canEditTrips,
        canDeleteRecords: newRole === 'admin',
        canManageBilling: newRole === 'admin' ? true : newPerms.canManageBilling,
        canImportExcel: newRole === 'admin' ? true : newPerms.canImportExcel,
        canExportData: newRole === 'admin' ? true : newPerms.canExportData,
        canManageMasters: newRole === 'admin' ? true : newPerms.canManageMasters,
        addedBy: userId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: 'CREATE',
        module: 'Security & RBAC',
        recordId: docId,
        summary: `Added ${newRole} (${effectiveRecipientRole}) user ${email}`,
      });
      setNewEmail('');
      setNewName('');
      setNewPhone('');
      setNewRecipientRole('office_staff');
      setNewExpiryScope('assigned');
    } catch (error) {
      setUserError(extractReadableFirestoreError(error, 'Create ERP User'));
    } finally {
      setSavingUser(false);
    }
  };

  const handleToggleUserStatus = async (u: ErpUser) => {
    const nextStatus: ErpUserStatus = u.status === 'Active' ? 'Suspended' : 'Active';
    setUserError(null);
    try {
      await updateDoc(doc(db, 'erpUsers', u.id), {
        displayName: u.displayName,
        role: u.role,
        status: nextStatus,
        canEditTrips: u.canEditTrips,
        canDeleteRecords: u.canDeleteRecords,
        canManageBilling: u.canManageBilling,
        canImportExcel: u.canImportExcel,
        canExportData: u.canExportData,
        canManageMasters: u.canManageMasters,
        updatedAt: serverTimestamp(),
      });
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: 'UPDATE',
        module: 'Security & RBAC',
        recordId: u.id,
        summary: `Set ${u.email} status to ${nextStatus}`,
      });
    } catch (error) {
      setUserError(extractReadableFirestoreError(error, 'Update User Status'));
    }
  };

  const handleTogglePermission = async (
    u: ErpUser,
    field:
      | 'canEditTrips'
      | 'canDeleteRecords'
      | 'canManageBilling'
      | 'canImportExcel'
      | 'canExportData'
      | 'canManageMasters'
  ) => {
    if (!isSuperAdmin) return;
    if (field === 'canDeleteRecords' && u.role !== 'admin') {
      setUserError('Permanent deletion is permanently disabled for ordinary users (Admin only).');
      return;
    }
    setUserError(null);
    try {
      await updateDoc(doc(db, 'erpUsers', u.id), {
        displayName: u.displayName,
        role: u.role,
        status: u.status,
        canEditTrips: field === 'canEditTrips' ? !u.canEditTrips : u.canEditTrips,
        canDeleteRecords: u.role === 'admin' ? true : false,
        canManageBilling: field === 'canManageBilling' ? !u.canManageBilling : u.canManageBilling,
        canImportExcel: field === 'canImportExcel' ? !u.canImportExcel : u.canImportExcel,
        canExportData: field === 'canExportData' ? !u.canExportData : u.canExportData,
        canManageMasters: field === 'canManageMasters' ? !u.canManageMasters : u.canManageMasters,
        updatedAt: serverTimestamp(),
      });
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: 'UPDATE',
        module: 'Security & RBAC',
        recordId: u.id,
        summary: `Updated ${field} permission for ${u.email}`,
      });
    } catch (error) {
      setUserError(extractReadableFirestoreError(error, 'Update User Permission'));
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteUserTarget || !isSuperAdmin) return;
    setUserError(null);
    try {
      await deleteDoc(doc(db, 'erpUsers', deleteUserTarget.id));
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: 'DELETE',
        module: 'Security & RBAC',
        recordId: deleteUserTarget.id,
        summary: `Removed ERP user access for ${deleteUserTarget.email}`,
      });
      setDeleteUserTarget(null);
    } catch (error) {
      setUserError(extractReadableFirestoreError(error, 'Remove ERP User'));
    }
  };

  const handleDownloadJsonBackup = async () => {
    const stripTimestamps = <T extends { createdAt?: unknown; updatedAt?: unknown }>(list: T[]) =>
      list.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest);

    const payload: BackupPayload = {
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      company: 'BAPASITARAM ENTERPRISE',
      vehicles: stripTimestamps(vehicles),
      parties: stripTimestamps(parties),
      partyPayments: stripTimestamps(partyPayments),
      drivers: stripTimestamps(drivers),
      trips: stripTimestamps(trips),
      driverPayments: stripTimestamps(driverPayments),
      maintenanceRecords: stripTimestamps(maintenanceRecords),
      bills: stripTimestamps(bills),
      companySettings: companySettings ? stripTimestamps([companySettings]) : [],
    };

    const jsonText = JSON.stringify(payload, null, 2);
    const verifiedParsed = JSON.parse(jsonText) as BackupPayload;
    const verifiedTotalCount =
      verifiedParsed.vehicles.length +
      verifiedParsed.parties.length +
      (verifiedParsed.partyPayments?.length || 0) +
      verifiedParsed.drivers.length +
      verifiedParsed.trips.length +
      verifiedParsed.driverPayments.length +
      verifiedParsed.maintenanceRecords.length +
      verifiedParsed.bills.length;

    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bapasitaram-erp-backup-${getTodayISO()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setVerifiedBackup({
      exportedAt: payload.exportedAt,
      totalCount: verifiedTotalCount,
      summaryText: `${vehicles.length} vehicles, ${parties.length} parties, ${partyPayments.length} party payments, ${trips.length} trips, ${drivers.length} drivers, ${driverPayments.length} driver payments, ${maintenanceRecords.length} maintenance, ${bills.length} bills`,
    });

    await recordAuditLog({
      ownerId: userId,
      actorRole: permissions.role,
      action: 'BACKUP',
      module: 'Backup & Restore',
      recordId: `backup-${getTodayISO()}`,
      summary: `Exported & verified JSON backup (${verifiedTotalCount} total records)`,
    });
  };

  const handleDownloadExcelBackup = async () => {
    exportSheetsToExcel(
      [
        { name: 'Vehicles', rows: vehicles.map(({ createdAt: _c, updatedAt: _u, ...r }) => r) },
        { name: 'Parties', rows: parties.map(({ createdAt: _c, updatedAt: _u, ...r }) => r) },
        {
          name: 'PartyPayments',
          rows: partyPayments.map(({ createdAt: _c, updatedAt: _u, ...r }) => r),
        },
        { name: 'Drivers', rows: drivers.map(({ createdAt: _c, updatedAt: _u, ...r }) => r) },
        {
          name: 'Trips',
          rows: trips.map(({ createdAt: _c, updatedAt: _u, ...r }) => r),
        },
        {
          name: 'DriverPayments',
          rows: driverPayments.map(({ createdAt: _c, updatedAt: _u, ...r }) => r),
        },
        {
          name: 'Maintenance',
          rows: maintenanceRecords.map(({ createdAt: _c, updatedAt: _u, ...r }) => r),
        },
        {
          name: 'Bills',
          rows: bills.map(({ createdAt: _c, updatedAt: _u, lineItems: _li, tripIds: _ti, ...r }) => ({
            ...r,
            tripCount: _ti.length,
          })),
        },
      ],
      `bapasitaram-erp-full-backup-${getTodayISO()}.xlsx`
    );

    await recordAuditLog({
      ownerId: userId,
      actorRole: permissions.role,
      action: 'BACKUP',
      module: 'Backup & Restore',
      recordId: `xlsx-${getTodayISO()}`,
      summary: 'Exported multi-sheet Excel backup workbook',
    });
  };

  const handleRestoreFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setRestoreError(null);
    setRestoreSuccess(null);
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupPayload;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.vehicles) || !Array.isArray(parsed.trips)) {
        setRestoreError('Invalid backup JSON structure.');
        return;
      }

      const existingVehIds = new Set(vehicles.map((v) => v.id));
      const existingPartyIds = new Set(parties.map((p) => p.id));
      const existingPpIds = new Set(partyPayments.map((pp) => pp.id));
      const existingDriverIds = new Set(drivers.map((d) => d.id));
      const existingTripIds = new Set(trips.map((t) => t.id));
      const existingDpIds = new Set(driverPayments.map((d) => d.id));
      const existingMaintIds = new Set(maintenanceRecords.map((m) => m.id));
      const existingBillIds = new Set(bills.map((b) => b.id));

      const countInsertable = (
        colName: RestoreCollectionName,
        rows: Record<string, unknown>[] | undefined,
        skipSet: Set<string>
      ) =>
        (rows || []).filter(
          (r) =>
            typeof r.id === 'string' &&
            BLUEPRINT_LIMITS.ID_PATTERN.test(r.id) &&
            !skipSet.has(r.id) &&
            sanitizeBackupRecordForRestore(colName, r, userId) !== null
        );

      const newVeh = countInsertable('vehicles', parsed.vehicles, existingVehIds);
      const newPty = countInsertable('parties', parsed.parties, existingPartyIds);
      const newPp = countInsertable('partyPayments', parsed.partyPayments, existingPpIds);
      const newDrv = countInsertable('drivers', parsed.drivers, existingDriverIds);
      const newTrp = countInsertable('trips', parsed.trips, existingTripIds);
      const newDp = countInsertable('driverPayments', parsed.driverPayments, existingDpIds);
      const newMnt = countInsertable('maintenanceRecords', parsed.maintenanceRecords, existingMaintIds);
      const newBil = countInsertable('bills', parsed.bills, existingBillIds);
      const settingsToRestore =
        !companySettings && Array.isArray(parsed.companySettings) && parsed.companySettings.length > 0
          ? sanitizeBackupRecordForRestore('companySettings', parsed.companySettings[0], userId)
            ? 1
            : 0
          : 0;

      const totalFile =
        parsed.vehicles.length +
        (parsed.parties?.length || 0) +
        (parsed.partyPayments?.length || 0) +
        (parsed.drivers?.length || 0) +
        parsed.trips.length +
        (parsed.driverPayments?.length || 0) +
        (parsed.maintenanceRecords?.length || 0) +
        (parsed.bills?.length || 0) +
        (parsed.companySettings?.length || 0);
      const totalNew =
        newVeh.length +
        newPty.length +
        newPp.length +
        newDrv.length +
        newTrp.length +
        newDp.length +
        newMnt.length +
        newBil.length +
        settingsToRestore;

      setPendingRestore({
        fileName: file.name,
        payload: parsed,
        newCounts: {
          vehicles: newVeh.length,
          parties: newPty.length,
          partyPayments: newPp.length,
          drivers: newDrv.length,
          trips: newTrp.length,
          driverPayments: newDp.length,
          maintenanceRecords: newMnt.length,
          bills: newBil.length,
          companySettings: settingsToRestore,
        },
        skippedExisting: Math.max(0, totalFile - totalNew),
      });
    } catch {
      setRestoreError('Failed to read backup file. Please upload a valid JSON backup exported from this ERP.');
    }
    if (restoreInputRef.current) restoreInputRef.current.value = '';
  };

  const handleConfirmNonOverwritingRestore = async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const p = pendingRestore.payload;
      const existingIds = {
        vehicles: new Set(vehicles.map((v) => v.id)),
        parties: new Set(parties.map((x) => x.id)),
        partyPayments: new Set(partyPayments.map((x) => x.id)),
        drivers: new Set(drivers.map((x) => x.id)),
        trips: new Set(trips.map((x) => x.id)),
        driverPayments: new Set(driverPayments.map((x) => x.id)),
        maintenanceRecords: new Set(maintenanceRecords.map((x) => x.id)),
        bills: new Set(bills.map((x) => x.id)),
      };

      const writeChunked = async (
        colName: Exclude<RestoreCollectionName, 'companySettings'>,
        rows: Record<string, unknown>[],
        skipSet: Set<string>
      ) => {
        const toInsert = rows
          .filter(
            (r) =>
              typeof r.id === 'string' &&
              BLUEPRINT_LIMITS.ID_PATTERN.test(r.id) &&
              !skipSet.has(r.id)
          )
          .map((r) => ({
            id: String(r.id),
            sanitized: sanitizeBackupRecordForRestore(colName, r, userId),
          }))
          .filter(
            (item): item is { id: string; sanitized: Record<string, unknown> } =>
              item.sanitized !== null
          );

        for (let i = 0; i < toInsert.length; i += 400) {
          const chunk = toInsert.slice(i, i + 400);
          const batch = writeBatch(db);
          chunk.forEach(({ id, sanitized }) => {
            batch.set(doc(collection(db, colName), id), {
              ...sanitized,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          });
          await batch.commit();
        }
        return toInsert.length;
      };

      // Topological parent-first order so Firestore exists() rules pass
      const c1 = await writeChunked('vehicles', p.vehicles || [], existingIds.vehicles);
      const c2 = await writeChunked('parties', p.parties || [], existingIds.parties);
      const c2b = await writeChunked('partyPayments', p.partyPayments || [], existingIds.partyPayments);
      const c3 = await writeChunked('drivers', p.drivers || [], existingIds.drivers);
      const c4 = await writeChunked('trips', p.trips || [], existingIds.trips);
      const c5 = await writeChunked('driverPayments', p.driverPayments || [], existingIds.driverPayments);
      const c6 = await writeChunked('maintenanceRecords', p.maintenanceRecords || [], existingIds.maintenanceRecords);
      const c7 = await writeChunked('bills', p.bills || [], existingIds.bills);

      let c8 = 0;
      if (!companySettings && Array.isArray(p.companySettings) && p.companySettings.length > 0) {
        const rawSetting = p.companySettings[0];
        const settingId =
          typeof rawSetting?.id === 'string' && BLUEPRINT_LIMITS.ID_PATTERN.test(rawSetting.id)
            ? rawSetting.id
            : userId;
        const sanitizedSetting = sanitizeBackupRecordForRestore('companySettings', rawSetting, userId);
        if (sanitizedSetting) {
          await setDoc(doc(collection(db, 'companySettings'), settingId), {
            ...sanitizedSetting,
            updatedAt: serverTimestamp(),
          });
          c8 = 1;
        }
      }

      const totalRestored = c1 + c2 + c2b + c3 + c4 + c5 + c6 + c7 + c8;
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: 'RESTORE',
        module: 'Backup & Restore',
        recordId: `restore-${getTodayISO()}`,
        summary: `Non-overwriting restore from ${pendingRestore.fileName}: added ${totalRestored} missing records, skipped ${pendingRestore.skippedExisting} existing records`,
      });

      setRestoreSuccess(
        `Restore complete: ${totalRestored} missing records added safely. ${pendingRestore.skippedExisting} existing records were preserved untouched.`
      );
      setPendingRestore(null);
    } catch (error) {
      setRestoreError(extractReadableFirestoreError(error, 'Backup Restore'));
    } finally {
      setRestoring(false);
    }
  };

  const toggleCleanupSelection = (key: string, isProtected: boolean) => {
    if (isProtected) return;
    setSelectedCleanupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleCleanupExecute = async () => {
    if (
      !cleanupConfirmMode ||
      selectedCleanupItems.length === 0 ||
      !isSuperAdmin ||
      !permissions.isAdmin ||
      !permissions.canDeleteRecords
    ) {
      return;
    }
    if (cleanupConfirmMode === 'delete' && !verifiedBackup) {
      setCleanupError('Create and verify a complete JSON backup before permanent deletion.');
      setCleanupConfirmMode(null);
      return;
    }

    setCleanupBusy(true);
    setCleanupError(null);
    setCleanupResult(null);

    try {
      // Final defense-in-depth guard: never archive or delete Excel-linked records here
      const safeTargets = selectedCleanupItems.filter(
        (item) => !item.isExcelLinked && item.classification !== 'protected-excel'
      );

      for (let i = 0; i < safeTargets.length; i += 400) {
        const chunk = safeTargets.slice(i, i + 400);
        const batch = writeBatch(db);

        chunk.forEach((item) => {
          const ref = doc(db, item.collection, item.id);
          if (cleanupConfirmMode === 'delete') {
            batch.delete(ref);
          } else {
            if (item.collection === 'trips') {
              batch.update(ref, {
                tripStatus: 'Cancelled',
                updatedAt: serverTimestamp(),
              });
            } else if (item.collection === 'bills') {
              batch.update(ref, {
                status: 'Cancelled',
                updatedAt: serverTimestamp(),
              });
            } else if (
              item.collection === 'vehicles' ||
              item.collection === 'parties' ||
              item.collection === 'drivers'
            ) {
              batch.update(ref, {
                status: 'Inactive',
                updatedAt: serverTimestamp(),
              });
            } else if (item.collection === 'driverPayments') {
              const existing = driverPayments.find((d) => d.id === item.id);
              const existingNotes = existing?.notes || '';
              const nextNotes = existingNotes.startsWith('[ARCHIVED]')
                ? existingNotes
                : clampStr(`[ARCHIVED] ${existingNotes}`, BLUEPRINT_LIMITS.NOTES_MAX);
              batch.update(ref, { notes: nextNotes, updatedAt: serverTimestamp() });
            } else if (item.collection === 'partyPayments') {
              const existing = partyPayments.find((pp) => pp.id === item.id);
              const existingNotes = existing?.notes || '';
              const nextNotes = existingNotes.startsWith('[ARCHIVED]')
                ? existingNotes
                : clampStr(`[ARCHIVED] ${existingNotes}`, BLUEPRINT_LIMITS.NOTES_MAX);
              batch.update(ref, { notes: nextNotes, updatedAt: serverTimestamp() });
            } else if (item.collection === 'maintenanceRecords') {
              const existing = maintenanceRecords.find((m) => m.id === item.id);
              const existingNotes = existing?.notes || '';
              const nextNotes = existingNotes.startsWith('[ARCHIVED]')
                ? existingNotes
                : clampStr(`[ARCHIVED] ${existingNotes}`, BLUEPRINT_LIMITS.NOTES_MAX);
              batch.update(ref, { notes: nextNotes, updatedAt: serverTimestamp() });
            }
          }
        });

        await batch.commit();
      }

      const actionLabel = cleanupConfirmMode === 'delete' ? 'Permanently deleted' : 'Safely archived';
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: cleanupConfirmMode === 'delete' ? 'DELETE' : 'UPDATE',
        module: 'Data Cleanup',
        recordId: `cleanup-${getTodayISO()}`,
        summary: `${actionLabel} ${safeTargets.length} selected non-Excel record(s): ${selectedCleanupConfirmationSummary.breakdown}`,
      });

      setCleanupResult(
        `${actionLabel} ${safeTargets.length} record(s) (${selectedCleanupConfirmationSummary.breakdown}). All Excel-imported records remain untouched.`
      );
      setSelectedCleanupKeys(new Set());
      setCleanupConfirmMode(null);
    } catch (error) {
      setCleanupError(
        extractReadableFirestoreError(
          error,
          cleanupConfirmMode === 'delete' ? 'Permanent Delete' : 'Archive Records'
        )
      );
      setCleanupConfirmMode(null);
    } finally {
      setCleanupBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Sub-navigation */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('rbac')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'rbac' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Users &amp; Permissions (RBAC)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('backup')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'backup' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Backup, Restore &amp; Offline Plan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('audit')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'audit' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Audit History ({auditLogs.length})
          </button>
        </div>

        <div className="text-xs text-slate-600">
          Signed in as <span className="font-mono font-semibold text-slate-900">{userEmail}</span> · Role:{' '}
          <span className="font-semibold text-slate-900 uppercase">{permissions.role}</span>
        </div>
      </div>

      {activeTab === 'rbac' && (
        <div className="space-y-5">
          {/* Current User Permissions Overview */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck className="w-4 h-4 text-slate-700" />
              <h3 className="text-sm font-semibold text-slate-900">Your Active Session Permissions</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
              {[
                { label: 'Edit Trips', enabled: permissions.canEditTrips },
                { label: 'Delete Records', enabled: permissions.canDeleteRecords },
                { label: 'Manage Billing', enabled: permissions.canManageBilling },
                { label: 'Import Excel', enabled: permissions.canImportExcel },
                { label: 'Export Reports', enabled: permissions.canExportData },
                { label: 'Manage Masters', enabled: permissions.canManageMasters },
              ].map((p) => (
                <div key={p.label} className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="text-slate-500">{p.label}</div>
                  <div className={`mt-1 font-semibold ${p.enabled ? 'text-emerald-700' : 'text-slate-400'}`}>
                    {p.enabled ? 'Allowed' : 'Restricted'}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 leading-relaxed">
              <span className="font-semibold text-slate-800">Security Posture Note:</span>{' '}
              Firestore Security Rules enforce verified Google sign-in, schema allowlists, bounded numeric ranges, ownership isolation, and immutable audit logs. No application is 100% immune to all threats — periodically review employee permissions, check Audit History, and re-run rules validation after configuration changes.
            </div>
          </div>

          {isSuperAdmin ? (
            <>
              {/* Add Employee Form */}
              <form onSubmit={handleCreateErpUser} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-slate-700" />
                  <h3 className="text-sm font-semibold text-slate-900">Add Admin / Employee Account</h3>
                </div>
                {userError && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                    {userError}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input
                    type="email"
                    required
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="employee@gmail.com"
                    className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Full Name"
                    className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as ErpUserRole)}
                    className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="employee">Employee (Scoped Permissions)</option>
                    <option value="admin">Admin (Full Permissions)</option>
                  </select>
                </div>

                {newRole === 'employee' && (
                  <div className="space-y-3 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          Expiry Alert Role
                        </label>
                        <select
                          value={newRecipientRole}
                          onChange={(e) =>
                            setNewRecipientRole(e.target.value as ExpiryRecipientRole)
                          }
                          className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                        >
                          <option value="office_staff">Office Staff</option>
                          <option value="driver">Driver (Assigned Vehicle Only)</option>
                        </select>
                      </div>
                      {newRecipientRole === 'office_staff' && (
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            Vehicle Expiry Alert Scope
                          </label>
                          <select
                            value={newExpiryScope}
                            onChange={(e) =>
                              setNewExpiryScope(e.target.value as ExpiryAlertScope)
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                          >
                            <option value="assigned">Assigned Vehicles Only</option>
                            <option value="all">All Fleet Vehicles</option>
                            <option value="none">No Expiry Alerts</option>
                          </select>
                        </div>
                      )}
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          Real Mobile Number (Optional)
                        </label>
                        <input
                          type="tel"
                          value={newPhone}
                          onChange={(e) => setNewPhone(e.target.value)}
                          placeholder="+91..."
                          maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-4 text-xs text-slate-700">
                      {(
                        [
                          ['canEditTrips', 'Edit Trips'],
                          ['canManageBilling', 'Manage Billing'],
                          ['canExportData', 'Export Data'],
                          ['canManageMasters', 'Manage Vehicles/Parties/Drivers'],
                          ['canImportExcel', 'Import Excel'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newPerms[key]}
                            onChange={(e) => setNewPerms({ ...newPerms, [key]: e.target.checked })}
                            className="w-4 h-4 accent-slate-900"
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                      <span
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500"
                        title="Permanent record deletion is disabled for ordinary users across Trips, LR, Bills, Payments, Party Ledger, Vehicles, Drivers, and Expenses."
                      >
                        <Lock className="w-3.5 h-3.5 text-slate-400" />
                        <span>Delete Records (Disabled for Ordinary Users)</span>
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Assign specific vehicles or link a Driver profile in <span className="font-semibold text-slate-700">Expiry Alerts → Recipient Access Control</span> after creating the user.
                    </p>
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={savingUser}
                    className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                  >
                    {savingUser ? 'Saving...' : 'Grant Access'}
                  </button>
                </div>
              </form>

              {/* Users List */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                {erpUsers.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    No additional employee or admin profiles configured yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                          <th className="py-3 px-4">User</th>
                          <th className="py-3 px-4">Role &amp; Status</th>
                          <th className="py-3 px-4">Permissions</th>
                          <th className="py-3 px-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {erpUsers.map((u) => (
                          <tr key={u.id}>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900">{u.displayName}</div>
                              <div className="font-mono text-slate-500">{u.email}</div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="uppercase font-semibold text-slate-800">{u.role}</div>
                              <div className="text-[11px] text-slate-500">
                                Expiry:{' '}
                                {u.role === 'admin'
                                  ? 'Admin (All Fleet)'
                                  : u.recipientRole === 'driver'
                                  ? 'Driver (Assigned)'
                                  : `Staff (${u.expiryAlertScope || 'assigned'}${
                                      (u.expiryAlertScope || 'assigned') === 'assigned'
                                        ? ` · ${(u.assignedVehicleIds || []).length}V`
                                        : ''
                                    })`}
                              </div>
                              <button
                                type="button"
                                onClick={() => handleToggleUserStatus(u)}
                                className={`text-[11px] font-medium underline cursor-pointer ${
                                  u.status === 'Active' ? 'text-emerald-700' : 'text-red-600'
                                }`}
                              >
                                {u.status} (Toggle)
                              </button>
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex flex-wrap gap-2">
                                {(
                                  [
                                    ['canEditTrips', 'Trips'],
                                    ['canManageMasters', 'Masters'],
                                    ['canManageBilling', 'Billing'],
                                    ['canImportExcel', 'Import'],
                                    ['canExportData', 'Export'],
                                    ['canDeleteRecords', 'Delete'],
                                  ] as const
                                ).map(([field, label]) => {
                                  const isLockedDeleteForEmployee =
                                    field === 'canDeleteRecords' && u.role !== 'admin';
                                  const effectiveEnabled = isLockedDeleteForEmployee ? false : u[field];
                                  return (
                                    <button
                                      key={field}
                                      type="button"
                                      disabled={u.role === 'admin' || isLockedDeleteForEmployee}
                                      title={
                                        isLockedDeleteForEmployee
                                          ? 'Permanent deletion is disabled for ordinary users (Admin only)'
                                          : undefined
                                      }
                                      onClick={() => handleTogglePermission(u, field)}
                                      className={`px-2 py-1 rounded border text-[11px] font-medium cursor-pointer ${
                                        effectiveEnabled
                                          ? 'bg-slate-900 text-white border-slate-900'
                                          : 'bg-white text-slate-500 border-slate-200'
                                      } disabled:opacity-60 disabled:cursor-not-allowed`}
                                    >
                                      {isLockedDeleteForEmployee ? `${label} (Locked)` : label}
                                    </button>
                                  );
                                })}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => setDeleteUserTarget(u)}
                                className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                                aria-label="Remove user"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl p-5 text-xs text-slate-600">
              Only the primary Administrator can add or modify ERP user roles and permissions.
            </div>
          )}
        </div>
      )}

      {activeTab === 'backup' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Local Backup & Non-Overwriting Restore */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-semibold text-slate-900">Local Backup &amp; Safe Restore</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Export your complete Firestore ERP records (Vehicles, Parties, Drivers, Trips, Driver Payments, Maintenance, Bills, Company Settings) to JSON or Excel. Restoring from JSON strictly skips existing IDs and never overwrites or deletes existing records.
              </p>

              {verifiedBackup && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-700" />
                  <div>
                    <div className="font-semibold">
                      Complete Backup Verified ({verifiedBackup.totalCount} records)
                    </div>
                    <div className="text-[11px] text-emerald-800 mt-0.5">
                      {verifiedBackup.summaryText}
                    </div>
                  </div>
                </div>
              )}

              {restoreError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {restoreError}
                </div>
              )}
              {restoreSuccess && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{restoreSuccess}</span>
                </div>
              )}

              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={handleDownloadJsonBackup}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Download Full JSON Backup</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadExcelBackup}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Download Excel Backup (.xlsx)</span>
                </button>
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleRestoreFilePick}
                  className="hidden"
                />
                {isSuperAdmin && (
                  <button
                    type="button"
                    onClick={() => restoreInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Restore from JSON Backup</span>
                  </button>
                )}
              </div>

              {pendingRestore && (
                <div className="p-4 border border-amber-200 bg-amber-50 rounded-xl space-y-3 text-xs">
                  <div className="flex items-start gap-2 font-semibold text-amber-900">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>Restore Preview: {pendingRestore.fileName}</span>
                  </div>
                  <div className="text-amber-900">
                    New records to insert: Vehicles ({pendingRestore.newCounts.vehicles}), Parties ({pendingRestore.newCounts.parties}), Party Payments ({pendingRestore.newCounts.partyPayments}), Drivers ({pendingRestore.newCounts.drivers}), Trips ({pendingRestore.newCounts.trips}), Driver Payments ({pendingRestore.newCounts.driverPayments}), Maintenance ({pendingRestore.newCounts.maintenanceRecords}), Bills ({pendingRestore.newCounts.bills}){pendingRestore.newCounts.companySettings > 0 ? ', Company Settings (1)' : ''}.
                  </div>
                  <div className="text-amber-800">
                    Existing records preserved untouched (skipped): {pendingRestore.skippedExisting}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingRestore(null)}
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-700 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={restoring}
                      onClick={handleConfirmNonOverwritingRestore}
                      className="px-3.5 py-1.5 bg-slate-900 text-white rounded-lg font-medium cursor-pointer disabled:opacity-60"
                    >
                      {restoring ? 'Restoring...' : 'Confirm Safe Restore'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Google Drive Backup & Offline Persistent Cache */}
            <div className="space-y-4">
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-2.5">
                <div className="flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-slate-700" />
                  <h3 className="text-sm font-semibold text-slate-900">Google Drive Backup Readiness</h3>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Your local JSON &amp; multi-sheet Excel backups are active immediately. Direct cloud upload to Google Drive requires enabling 1P Google Drive OAuth consent for your project (no mock tokens are used). Ask whenever you want to authorize Google Drive OAuth backup.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-2.5">
                <div className="flex items-center gap-2">
                  <WifiOff className="w-4 h-4 text-emerald-700" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    IndexedDB Persistent Cache (Active)
                  </h3>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Firestore IndexedDB multi-tab persistent local cache is enabled. All saved records stay persisted across browser close and reopen, with deterministic document IDs preventing duplicate syncs on reconnect.
                </p>
              </div>
            </div>
          </div>

          {/* Admin-Only Safe Old & Test Data Audit / Cleanup */}
          {isSuperAdmin && permissions.isAdmin && permissions.canDeleteRecords && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-200 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Archive className="w-4 h-4 text-slate-700" />
                    <h3 className="text-base font-semibold text-slate-900">
                      Safe Old &amp; Test Data Cleanup
                    </h3>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    Requires a verified JSON backup first. Automatically protects Excel-imported records from bulk deletion and lets you inspect exact records before archiving or deleting.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleDownloadJsonBackup}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>
                      {verifiedBackup ? 'Re-Verify Backup' : '1. Create & Verify Backup'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCleanupScanned(true);
                      setCleanupResult(null);
                      setCleanupError(null);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>{cleanupScanned ? 'Refresh Scan' : '2. Scan ERP Records'}</span>
                  </button>
                </div>
              </div>

              {cleanupError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {cleanupError}
                </div>
              )}
              {cleanupResult && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{cleanupResult}</span>
                </div>
              )}

              {cleanupScanned && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <button
                      type="button"
                      onClick={() => setCleanupFilter('suspected-test')}
                      className={`p-3.5 rounded-xl border text-left cursor-pointer ${
                        cleanupFilter === 'suspected-test'
                          ? 'border-amber-400 bg-amber-50'
                          : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                      }`}
                    >
                      <div className="text-slate-600 font-medium">Suspected Test / Demo</div>
                      <div className="mt-1 font-mono text-lg font-bold text-amber-800">
                        {cleanupCounts.suspected}
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setCleanupFilter('regular-non-excel')}
                      className={`p-3.5 rounded-xl border text-left cursor-pointer ${
                        cleanupFilter === 'regular-non-excel'
                          ? 'border-slate-900 bg-slate-100'
                          : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                      }`}
                    >
                      <div className="text-slate-600 font-medium">Other Manual Entries</div>
                      <div className="mt-1 font-mono text-lg font-bold text-slate-900">
                        {cleanupCounts.regular}
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setCleanupFilter('protected-excel')}
                      className={`p-3.5 rounded-xl border text-left cursor-pointer ${
                        cleanupFilter === 'protected-excel'
                          ? 'border-emerald-500 bg-emerald-50'
                          : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-emerald-800 font-medium">
                        <Shield className="w-3.5 h-3.5" />
                        <span>Protected Excel Records</span>
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold text-emerald-800">
                        {cleanupCounts.protectedExcel}
                      </div>
                    </button>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <input
                      type="text"
                      value={cleanupSearch}
                      onChange={(e) => setCleanupSearch(e.target.value)}
                      placeholder="Filter scanned records..."
                      className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg max-w-xs w-full"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      {cleanupFilter !== 'protected-excel' && visibleCleanupRecords.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            const next = new Set(selectedCleanupKeys);
                            const allSelected = visibleCleanupRecords.every((r) => next.has(r.key));
                            visibleCleanupRecords.forEach((r) => {
                              if (!r.isExcelLinked) {
                                if (allSelected) next.delete(r.key);
                                else next.add(r.key);
                              }
                            });
                            setSelectedCleanupKeys(next);
                          }}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                        >
                          Toggle Select Visible ({visibleCleanupRecords.length})
                        </button>
                      )}
                      {selectedCleanupItems.length > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={() => setCleanupConfirmMode('archive')}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-lg cursor-pointer"
                          >
                            <Archive className="w-3.5 h-3.5" />
                            <span>Archive Selected ({selectedCleanupItems.length})</span>
                          </button>
                          <button
                            type="button"
                            disabled={!verifiedBackup}
                            title={
                              verifiedBackup
                                ? 'Delete selected non-Excel records after final confirmation'
                                : 'Create & Verify Backup first to unlock permanent deletion'
                            }
                            onClick={() => setCleanupConfirmMode('delete')}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete Selected ({selectedCleanupItems.length})</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {!verifiedBackup && selectedCleanupItems.length > 0 && (
                    <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Permanent deletion stays locked until you click &quot;1. Create &amp; Verify Backup&quot; in this session. You can always use Archive Selected non-destructively.
                      </span>
                    </div>
                  )}

                  {visibleCleanupRecords.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500 border border-slate-200 rounded-xl">
                      No records found under this classification.
                    </div>
                  ) : (
                    <div className="border border-slate-200 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                          <tr>
                            <th className="py-2.5 px-3 w-10">Pick</th>
                            <th className="py-2.5 px-3">Collection</th>
                            <th className="py-2.5 px-3">Record</th>
                            <th className="py-2.5 px-3">Date</th>
                            <th className="py-2.5 px-3 text-right">Amount</th>
                            <th className="py-2.5 px-3">Classification Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {visibleCleanupRecords.map((item) => {
                            const checked = selectedCleanupKeys.has(item.key);
                            return (
                              <tr
                                key={item.key}
                                className={
                                  item.isExcelLinked
                                    ? 'bg-emerald-50/40'
                                    : checked
                                    ? 'bg-amber-50/50'
                                    : 'hover:bg-slate-50'
                                }
                              >
                                <td className="py-2.5 px-3">
                                  {item.isExcelLinked ? (
                                    <Lock
                                      className="w-3.5 h-3.5 text-emerald-700"
                                      aria-label="Protected Excel record"
                                    />
                                  ) : (
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() =>
                                        toggleCleanupSelection(item.key, item.isExcelLinked)
                                      }
                                      className="w-4 h-4 accent-slate-900 cursor-pointer"
                                    />
                                  )}
                                </td>
                                <td className="py-2.5 px-3 font-mono text-slate-600">
                                  {item.collection}
                                </td>
                                <td className="py-2.5 px-3 font-medium text-slate-900">
                                  {item.label}
                                </td>
                                <td className="py-2.5 px-3 font-mono text-slate-600 whitespace-nowrap">
                                  {item.date ? formatDateIN(item.date) : '—'}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                                  {item.amount !== 0 ? formatINR(item.amount) : '—'}
                                </td>
                                <td className="py-2.5 px-3 text-slate-600">{item.reason}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <History className="w-4 h-4 text-slate-600" />
              <span>Immutable Audit Trail</span>
            </div>
            <input
              type="text"
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              placeholder="Filter by user, action, module..."
              className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg max-w-xs w-full"
            />
          </div>
          {filteredAuditLogs.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No audit log entries recorded yet. All create, update, delete, import, bill, and backup actions are recorded automatically.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">Actor</th>
                    <th className="py-2.5 px-4">Action</th>
                    <th className="py-2.5 px-4">Module</th>
                    <th className="py-2.5 px-4">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredAuditLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="py-2.5 px-4 font-mono whitespace-nowrap text-slate-600">
                        {log.createdAt && typeof log.createdAt.toDate === 'function'
                          ? formatDateIN(log.createdAt.toDate().toISOString().slice(0, 10))
                          : 'Just now'}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="font-mono text-slate-800">{log.actorEmail}</div>
                        <div className="text-[11px] uppercase text-slate-500">{log.actorRole}</div>
                      </td>
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{log.action}</td>
                      <td className="py-2.5 px-4 text-slate-800">{log.module}</td>
                      <td className="py-2.5 px-4 text-slate-700">{log.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteUserTarget)}
        title="Remove ERP User Access"
        description={`Revoke ERP permissions profile for ${deleteUserTarget?.email || ''}?`}
        confirmLabel="Remove User"
        destructive
        busy={false}
        onConfirm={handleDeleteUser}
        onCancel={() => setDeleteUserTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(cleanupConfirmMode)}
        title={
          cleanupConfirmMode === 'delete'
            ? `Permanently Delete ${selectedCleanupItems.length} Record(s)?`
            : `Safely Archive ${selectedCleanupItems.length} Record(s)?`
        }
        description={
          cleanupConfirmMode === 'delete'
            ? `Verified Backup: ${verifiedBackup?.totalCount ?? 0} records exported.\nCollections affected: ${selectedCleanupConfirmationSummary.breakdown}\n\n${selectedCleanupConfirmationSummary.previewLabels}${selectedCleanupConfirmationSummary.remaining}\n\nThis permanently removes the selected non-Excel records. Proceed?`
            : `Collections affected: ${selectedCleanupConfirmationSummary.breakdown}\n\n${selectedCleanupConfirmationSummary.previewLabels}${selectedCleanupConfirmationSummary.remaining}\n\nRecords will be marked Inactive/Cancelled/Archived without deleting any financial history.`
        }
        confirmLabel={
          cleanupConfirmMode === 'delete'
            ? `Delete ${selectedCleanupItems.length} Records`
            : `Archive ${selectedCleanupItems.length} Records`
        }
        destructive={cleanupConfirmMode === 'delete'}
        busy={cleanupBusy}
        onConfirm={handleCleanupExecute}
        onCancel={() => setCleanupConfirmMode(null)}
      />
    </div>
  );
};
