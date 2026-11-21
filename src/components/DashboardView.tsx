import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  Truck,
  Users,
  ClipboardList,
  IndianRupee,
  ArrowUpRight,
  AlertTriangle,
  PlusCircle,
  CheckCircle2,
  CalendarRange,
  BellRing,
  MessageCircle,
} from 'lucide-react';
import { db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type Bill,
  type CompanySettings,
  type Driver,
  type DriverPayment,
  type ErpUser,
  type ExpiryNotificationRecord,
  type MaintenanceRecord,
  type NavSection,
  type NotificationPreference,
  type Party,
  type Trip,
  type UserPermissions,
  type Vehicle,
} from '../types/erp';
import { clampStr, formatDateIN, formatINR, generateSafeDocId } from '../utils/formatters';
import {
  buildExpiryDedupKey,
  buildExpiryWhatsAppMessage,
  buildVehicleDocumentExpiryAlerts,
  filterNotificationHistoryForUser,
  formatRecipientRoleLabel,
  hasDuplicateExpiryNotification,
  hasValidRecipientPhone,
  resolveAuthorizedVehiclesForUser,
  type AuthorizedExpiryRecipient,
  type VehicleDocumentExpiryAlert,
} from '../utils/expiryNotifications';
import { WhatsAppShareModal } from './WhatsAppShareModal';

interface DashboardViewProps {
  userId: string;
  userEmail: string;
  userDisplayName: string;
  permissions: UserPermissions;
  vehicles: Vehicle[];
  parties: Party[];
  trips: Trip[];
  drivers: Driver[];
  driverPayments: DriverPayment[];
  maintenanceRecords: MaintenanceRecord[];
  bills: Bill[];
  erpUsers: ErpUser[];
  notificationPreferences: NotificationPreference[];
  expiryNotifications: ExpiryNotificationRecord[];
  companySettings: CompanySettings | null;
  loading: boolean;
  onNavigate: (section: NavSection) => void;
  onOpenNewTrip: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  userId,
  userEmail,
  userDisplayName,
  permissions,
  vehicles,
  parties,
  trips,
  drivers,
  driverPayments,
  maintenanceRecords,
  bills,
  erpUsers,
  notificationPreferences,
  expiryNotifications,
  companySettings,
  loading,
  onNavigate,
  onOpenNewTrip,
}) => {
  const [periodMode, setPeriodMode] = useState<'monthly' | 'yearly'>('monthly');
  const [whatsappShareTarget, setWhatsappShareTarget] = useState<{
    alert: VehicleDocumentExpiryAlert;
    recipient: AuthorizedExpiryRecipient;
    message: string;
  } | null>(null);
  const loggedDedupKeysRef = useRef<Set<string>>(new Set());

  const metrics = useMemo(() => {
    const activeTripsList = trips.filter((t) => t.tripStatus !== 'Cancelled');
    const totalFreight = activeTripsList.reduce((sum, t) => sum + t.freightAmount, 0);
    const totalReceived = activeTripsList.reduce((sum, t) => sum + t.advanceReceived, 0);
    const totalBalance = activeTripsList.reduce((sum, t) => sum + t.balanceAmount, 0);
    const totalTripExpenses = activeTripsList.reduce((sum, t) => sum + t.totalExpense, 0);
    const totalMaintenance = maintenanceRecords.reduce((sum, m) => sum + m.amount, 0);
    const totalExpenses = totalTripExpenses + totalMaintenance;
    const netProfit = totalFreight - totalExpenses;
    const totalDriverPaid = driverPayments
      .filter((p) => p.paymentType === 'Salary Paid' || p.paymentType === 'Advance' || p.paymentType === 'Allowance')
      .reduce((sum, p) => sum + p.amount, 0);

    const availableVehicles = vehicles.filter((v) => v.status === 'Available').length;
    const onTripVehicles = vehicles.filter((v) => v.status === 'On Trip').length;
    const inTransitTrips = trips.filter((t) => t.tripStatus === 'In Transit').length;
    const settledTrips = trips.filter((t) => t.tripStatus === 'Settled').length;

    return {
      totalFreight,
      totalReceived,
      totalBalance,
      totalTripExpenses,
      totalMaintenance,
      totalExpenses,
      totalDriverPaid,
      netProfit,
      availableVehicles,
      onTripVehicles,
      inTransitTrips,
      settledTrips,
      activeTripCount: activeTripsList.length,
    };
  }, [vehicles, trips, maintenanceRecords, driverPayments]);

  // Vehicle-wise profit & expense summary
  const vehicleProfitRows = useMemo(() => {
    const map = new Map<
      string,
      {
        vehicleId: string;
        vehicleNumber: string;
        trips: number;
        income: number;
        tripExpenses: number;
        maintenance: number;
        profit: number;
      }
    >();

    vehicles.forEach((v) => {
      map.set(v.id, {
        vehicleId: v.id,
        vehicleNumber: v.registrationNumber,
        trips: 0,
        income: 0,
        tripExpenses: 0,
        maintenance: 0,
        profit: 0,
      });
    });

    trips
      .filter((t) => t.tripStatus !== 'Cancelled')
      .forEach((t) => {
        const prev = map.get(t.vehicleId) || {
          vehicleId: t.vehicleId,
          vehicleNumber: t.vehicleNumber,
          trips: 0,
          income: 0,
          tripExpenses: 0,
          maintenance: 0,
          profit: 0,
        };
        prev.trips += 1;
        prev.income += t.freightAmount;
        prev.tripExpenses += t.totalExpense;
        map.set(t.vehicleId, prev);
      });

    maintenanceRecords.forEach((m) => {
      const prev = map.get(m.vehicleId) || {
        vehicleId: m.vehicleId,
        vehicleNumber: m.vehicleNumber,
        trips: 0,
        income: 0,
        tripExpenses: 0,
        maintenance: 0,
        profit: 0,
      };
      prev.maintenance += m.amount;
      map.set(m.vehicleId, prev);
    });

    return Array.from(map.values())
      .map((r) => ({ ...r, profit: r.income - r.tripExpenses - r.maintenance }))
      .filter((r) => r.trips > 0 || r.maintenance > 0)
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 6);
  }, [vehicles, trips, maintenanceRecords]);

  // Monthly / Yearly breakdown summary
  const periodSummary = useMemo(() => {
    const map = new Map<
      string,
      {
        period: string;
        trips: number;
        freight: number;
        received: number;
        expenses: number;
        netProfit: number;
      }
    >();

    const keyFor = (dateStr: string) => {
      if (!dateStr) return 'Unknown';
      return periodMode === 'monthly' ? dateStr.slice(0, 7) : dateStr.slice(0, 4);
    };

    trips
      .filter((t) => t.tripStatus !== 'Cancelled')
      .forEach((t) => {
        const key = keyFor(t.tripDate);
        const curr = map.get(key) || {
          period: key,
          trips: 0,
          freight: 0,
          received: 0,
          expenses: 0,
          netProfit: 0,
        };
        curr.trips += 1;
        curr.freight += t.freightAmount;
        curr.received += t.advanceReceived;
        curr.expenses += t.totalExpense;
        map.set(key, curr);
      });

    maintenanceRecords.forEach((m) => {
      const key = keyFor(m.expenseDate);
      const curr = map.get(key) || {
        period: key,
        trips: 0,
        freight: 0,
        received: 0,
        expenses: 0,
        netProfit: 0,
      };
      curr.expenses += m.amount;
      map.set(key, curr);
    });

    return Array.from(map.values())
      .map((r) => ({ ...r, netProfit: r.freight - r.expenses }))
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, 6);
  }, [trips, maintenanceRecords, periodMode]);

  // Strictly recipient-scoped Vehicle Document Expiry Alerts (5 days before, expiry day, overdue until renewal)
  const authorizedVehicles = useMemo(
    () => resolveAuthorizedVehiclesForUser({ vehicles, drivers, permissions }),
    [vehicles, drivers, permissions]
  );

  const vehicleExpiryAlerts = useMemo(
    () =>
      buildVehicleDocumentExpiryAlerts({
        vehicles,
        drivers,
        erpUsers,
        preferences: notificationPreferences,
        permissions,
        activeUserEmail: userEmail,
        activeUserId: userId,
        activeUserName: userDisplayName || (permissions.isAdmin ? 'Administrator' : 'ERP User'),
        adminUser: permissions.isAdmin
          ? {
              userId,
              email: userEmail,
              displayName: userDisplayName || 'Administrator',
            }
          : null,
        companySettings,
        respectActiveUserPreferences: true,
      }),
    [
      vehicles,
      drivers,
      erpUsers,
      notificationPreferences,
      permissions,
      userEmail,
      userId,
      userDisplayName,
      companySettings,
    ]
  );

  const pushedRecipientAlerts = useMemo(() => {
    if (permissions.isAdmin || vehicleExpiryAlerts.length > 0) return [];
    const authorizedIds = new Set(authorizedVehicles.map((v) => v.id));
    const scoped = filterNotificationHistoryForUser({
      history: expiryNotifications,
      permissions,
      userId,
      userEmail,
      authorizedVehicleIds: authorizedIds,
    });
    const emailLower = userEmail.trim().toLowerCase();
    return scoped
      .filter(
        (h) =>
          h.recipientEmail.trim().toLowerCase() === emailLower &&
          h.deliveryStatus !== 'Acknowledged'
      )
      .slice(0, 6);
  }, [
    permissions,
    vehicleExpiryAlerts.length,
    authorizedVehicles,
    expiryNotifications,
    userId,
    userEmail,
  ]);

  // Deduplicated automatic In-App dashboard notification history logging (never duplicates)
  useEffect(() => {
    if (loading || !userId || vehicleExpiryAlerts.length === 0) return;

    const activeRecipientRole = permissions.isAdmin ? 'admin' : permissions.recipientRole;
    const activeRecipientName =
      userDisplayName || (permissions.isAdmin ? 'Administrator' : 'ERP User');
    const cleanEmail = userEmail.trim().toLowerCase();
    const activePref = notificationPreferences.find(
      (p) =>
        p.id === userId ||
        p.userId === userId ||
        (cleanEmail && p.email.trim().toLowerCase() === cleanEmail)
    );
    if (activePref && !activePref.inAppEnabled) return;

    const toPersist = vehicleExpiryAlerts.slice(0, 12).filter((alert) => {
      const dedupKey = buildExpiryDedupKey({
        vehicleId: alert.vehicleId,
        documentType: alert.documentType,
        expiryDate: alert.expiryDate,
        recipientRole: activeRecipientRole,
        recipientId: userId,
        triggerType: alert.triggerType,
        channel: 'In-App',
      });
      if (loggedDedupKeysRef.current.has(dedupKey)) return false;
      if (hasDuplicateExpiryNotification(expiryNotifications, dedupKey)) {
        loggedDedupKeysRef.current.add(dedupKey);
        return false;
      }
      return true;
    });

    if (toPersist.length === 0) return;

    toPersist.forEach((alert) => {
      const dedupKey = buildExpiryDedupKey({
        vehicleId: alert.vehicleId,
        documentType: alert.documentType,
        expiryDate: alert.expiryDate,
        recipientRole: activeRecipientRole,
        recipientId: userId,
        triggerType: alert.triggerType,
        channel: 'In-App',
      });
      loggedDedupKeysRef.current.add(dedupKey);
      const docId = generateSafeDocId('ntf');
      void setDoc(doc(collection(db, 'expiryNotifications'), docId), {
        dedupKey,
        vehicleId: alert.vehicleId,
        vehicleNumber: clampStr(alert.vehicleNumber, BLUEPRINT_LIMITS.VEHICLE_REG_MAX),
        documentType: alert.documentType,
        expiryDate: clampStr(alert.expiryDate, BLUEPRINT_LIMITS.DATE_MAX),
        triggerType: alert.triggerType,
        recipientRole: activeRecipientRole,
        recipientId: clampStr(userId, 128),
        recipientName: clampStr(activeRecipientName, 120),
        recipientEmail: clampStr(cleanEmail, BLUEPRINT_LIMITS.EMAIL_MAX),
        recipientPhone: clampStr(activePref?.phone || '', BLUEPRINT_LIMITS.PHONE_MAX),
        channel: 'In-App',
        deliveryStatus: 'Displayed',
        statusNote: clampStr(`Displayed in ERP dashboard (${alert.triggerLabel})`, 300),
        ownerId: userId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch(() => {
        // Non-blocking audit log; remove from session cache so next reload can retry if transient
        loggedDedupKeysRef.current.delete(dedupKey);
      });
    });
  }, [
    loading,
    userId,
    userEmail,
    userDisplayName,
    permissions.isAdmin,
    permissions.recipientRole,
    vehicleExpiryAlerts,
    notificationPreferences,
    expiryNotifications,
  ]);

  const expiryScopeSummary = permissions.isAdmin
    ? 'Admin · All Fleet Vehicles'
    : permissions.recipientRole === 'driver'
    ? 'Driver · Assigned Vehicle Only'
    : permissions.expiryAlertScope === 'all'
    ? 'Office Staff · All Authorized Vehicles'
    : permissions.expiryAlertScope === 'none'
    ? 'Office Staff · Restricted'
    : `Office Staff · ${permissions.assignedVehicleIds.length} Assigned`;

  // Recent Transactions across Trips, Bills, Driver Payments, Maintenance
  const recentTransactions = useMemo(() => {
    const items: {
      id: string;
      date: string;
      type: 'Trip' | 'Driver Payment' | 'Maintenance' | 'Bill';
      reference: string;
      partyOrVehicle: string;
      amount: number;
      section: NavSection;
    }[] = [];

    trips.slice(0, 8).forEach((t) => {
      items.push({
        id: `trp-${t.id}`,
        date: t.tripDate,
        type: 'Trip',
        reference: t.lrNumber,
        partyOrVehicle: `${t.partyName} · ${t.vehicleNumber}`,
        amount: t.freightAmount,
        section: 'trip-history',
      });
    });

    driverPayments.slice(0, 6).forEach((p) => {
      items.push({
        id: `dp-${p.id}`,
        date: p.paymentDate,
        type: 'Driver Payment',
        reference: p.paymentType,
        partyOrVehicle: `${p.driverName}${p.vehicleNumber ? ` · ${p.vehicleNumber}` : ''}`,
        amount: p.amount,
        section: 'drivers',
      });
    });

    maintenanceRecords.slice(0, 6).forEach((m) => {
      items.push({
        id: `mnt-${m.id}`,
        date: m.expenseDate,
        type: 'Maintenance',
        reference: m.category,
        partyOrVehicle: `${m.vehicleNumber} · ${m.description}`,
        amount: m.amount,
        section: 'expenses',
      });
    });

    bills
      .filter((b) => b.status !== 'Cancelled')
      .slice(0, 6)
      .forEach((b) => {
        items.push({
          id: `bil-${b.id}`,
          date: b.billDate,
          type: 'Bill',
          reference: b.billNumber,
          partyOrVehicle: b.partyName,
          amount: b.netPayable,
          section: 'billing',
        });
      });

    return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  }, [trips, driverPayments, maintenanceRecords, bills]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 bg-white border border-slate-200 rounded-xl p-5 animate-pulse">
              <div className="h-3.5 w-24 bg-slate-200 rounded" />
              <div className="mt-4 h-7 w-36 bg-slate-200 rounded" />
              <div className="mt-3 h-3 w-28 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
        <div className="h-64 bg-white border border-slate-200 rounded-xl p-6 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Executive Welcome / Quick Action Strip */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="font-display text-lg sm:text-xl font-semibold text-slate-900">
            BAPASITARAM ENTERPRISE Overview
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Live fleet, party ledger, trip operations, maintenance, and billing metrics calculated strictly from recorded entries in INR.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {permissions.canManageBilling && (
            <button
              type="button"
              onClick={() => onNavigate('billing')}
              className="px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Billing
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('reports')}
            className="px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            Reports
          </button>
          {permissions.canImportExcel && (
            <button
              type="button"
              onClick={() => onNavigate('excel-import')}
              className="px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Import Excel
            </button>
          )}
          {permissions.canEditTrips && (
            <button
              type="button"
              onClick={onOpenNewTrip}
              className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <PlusCircle className="w-4 h-4 shrink-0" />
              <span>Record Trip</span>
            </button>
          )}
        </div>
      </div>

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Total Trips &amp; Freight</span>
            <IndianRupee className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {formatINR(metrics.totalFreight)}
          </div>
          <div className="mt-2 text-xs text-slate-500 tabular-nums">
            {metrics.activeTripCount} active {metrics.activeTripCount === 1 ? 'trip' : 'trips'} · {metrics.settledTrips} settled
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Received &amp; Outstanding</span>
            <ClipboardList className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {formatINR(metrics.totalBalance)}
          </div>
          <div className="mt-2 text-xs text-slate-500 tabular-nums">
            Total received (Jama): <span className="text-emerald-700 font-medium">{formatINR(metrics.totalReceived)}</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Total Expenses &amp; Net Profit</span>
            <IndianRupee className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {formatINR(metrics.totalExpenses)}
          </div>
          <div className="mt-2 text-xs text-slate-600 tabular-nums">
            Op. profit:{' '}
            <span className={metrics.netProfit >= 0 ? 'text-emerald-700 font-medium' : 'text-red-600 font-medium'}>
              {formatINR(metrics.netProfit)}
            </span>
            {metrics.totalDriverPaid > 0 && (
              <span className="text-slate-500"> · Driver pay: {formatINR(metrics.totalDriverPaid, true)}</span>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Fleet, Parties &amp; Drivers</span>
            <Truck className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {vehicles.length}V · {parties.length}P · {drivers.length}D
          </div>
          <div className="mt-2 text-xs text-slate-500 tabular-nums">
            {metrics.availableVehicles} avail · {metrics.onTripVehicles} on trip · {metrics.inTransitTrips} in transit
          </div>
        </div>
      </div>

      {/* Vehicle-wise Profit & Monthly/Yearly Reports Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Vehicle-wise Profit Table */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Vehicle-Wise Profit</h3>
              <p className="text-xs text-slate-500 mt-0.5">Freight income minus trip &amp; maintenance expenses</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('vehicles')}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
            >
              <span>Fleet</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {vehicleProfitRows.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No vehicle trip or maintenance financials recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-4">Vehicle</th>
                    <th className="py-2.5 px-4 text-right">Trips</th>
                    <th className="py-2.5 px-4 text-right">Freight</th>
                    <th className="py-2.5 px-4 text-right">Expenses</th>
                    <th className="py-2.5 px-4 text-right">Net Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vehicleProfitRows.map((row) => (
                    <tr key={row.vehicleId} className="hover:bg-slate-50">
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                        {row.vehicleNumber}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                        {row.trips}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900">
                        {formatINR(row.income, true)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                        {formatINR(row.tripExpenses + row.maintenance, true)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono font-semibold tabular-nums">
                        <span className={row.profit >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                          {formatINR(row.profit, true)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Monthly & Yearly Financial Summary */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CalendarRange className="w-4 h-4 text-slate-500" />
              <h3 className="text-base font-semibold text-slate-900">Monthly &amp; Yearly Summary</h3>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
                {(['monthly', 'yearly'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPeriodMode(m)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize cursor-pointer ${
                      periodMode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
              >
                Full Reports →
              </button>
            </div>
          </div>
          {periodSummary.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Record trips or expenses to generate {periodMode} performance totals.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-4">Period</th>
                    <th className="py-2.5 px-4 text-right">Trips</th>
                    <th className="py-2.5 px-4 text-right">Freight</th>
                    <th className="py-2.5 px-4 text-right">Received</th>
                    <th className="py-2.5 px-4 text-right">Net Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {periodSummary.map((p) => (
                    <tr key={p.period} className="hover:bg-slate-50">
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{p.period}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                        {p.trips}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900">
                        {formatINR(p.freight, true)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700">
                        {formatINR(p.received, true)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono font-semibold tabular-nums">
                        <span className={p.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                          {formatINR(p.netProfit, true)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Bottom Split: Recent Transactions + Compliance Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <section className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Recent Transactions</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Latest trips, bills, driver payments, and vehicle maintenance entries
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('trip-history')}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-slate-900 whitespace-nowrap cursor-pointer"
            >
              <span>All Trips</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {recentTransactions.length === 0 ? (
            <div className="p-8 sm:p-10 text-center">
              <Users className="w-8 h-8 text-slate-300 mx-auto" />
              <h4 className="mt-3 text-sm font-semibold text-slate-900">No transactions recorded yet</h4>
              <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">
                Add vehicles, parties, or drivers and record dispatches or expenses to see real-time transaction activity here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-4 whitespace-nowrap">Date</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Module &amp; Ref</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Account / Vehicle</th>
                    <th className="py-2.5 px-4 whitespace-nowrap text-right">Amount (INR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {recentTransactions.map((tx) => (
                    <tr
                      key={tx.id}
                      onClick={() => onNavigate(tx.section)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <td className="py-2.5 px-4 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                        {formatDateIN(tx.date)}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <div className="font-semibold text-slate-900">{tx.type}</div>
                        <div className="font-mono text-[11px] text-slate-500">{tx.reference}</div>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="text-slate-800 truncate max-w-[260px]">{tx.partyOrVehicle}</div>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {formatINR(tx.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Vehicle Document Expiry Alerts (Role-Scoped: 5d / Today / Overdue) */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <BellRing className="w-4 h-4 text-slate-700 shrink-0" />
                <h3 className="text-sm font-semibold text-slate-900 truncate">
                  Vehicle Document Expiry Alerts
                </h3>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">{expiryScopeSummary}</div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('expiry-alerts')}
              className="text-xs font-medium text-slate-700 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Alerts &amp; Prefs →
            </button>
          </div>
          <div className="p-5">
            {vehicleExpiryAlerts.length === 0 && pushedRecipientAlerts.length === 0 ? (
              <div className="flex items-start gap-2.5 text-xs text-emerald-700">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  {permissions.expiryAlertScope === 'none' && !permissions.isAdmin
                    ? 'No vehicle expiry alerts are assigned to your account.'
                    : 'No overdue, same-day, or 5-day vehicle document expiries for your authorized vehicles.'}
                </span>
              </div>
            ) : vehicleExpiryAlerts.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {vehicleExpiryAlerts.slice(0, 7).map((alert) => {
                  const primaryWhatsAppRecipient =
                    alert.recipients.find((r) => hasValidRecipientPhone(r.recipientPhone)) ||
                    alert.recipients[0];
                  return (
                    <li
                      key={alert.id}
                      className="py-2.5 first:pt-0 last:pb-0 flex items-start justify-between gap-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => onNavigate('expiry-alerts')}
                        className="min-w-0 text-left flex-1 hover:opacity-80 cursor-pointer"
                      >
                        <div className="font-mono text-xs font-semibold text-slate-900 truncate">
                          {alert.vehicleNumber}
                        </div>
                        <div className="text-xs text-slate-500">
                          {alert.documentType} · {formatDateIN(alert.expiryDate)}
                        </div>
                        {permissions.isAdmin && alert.recipients.length > 0 && (
                          <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                            Recipients:{' '}
                            {alert.recipients
                              .map((r) => formatRecipientRoleLabel(r.recipientRole))
                              .join(', ')}
                          </div>
                        )}
                      </button>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap ${
                            alert.triggerType === 'overdue'
                              ? 'text-red-600'
                              : alert.triggerType === 'on_expiry'
                              ? 'text-amber-700'
                              : 'text-blue-700'
                          }`}
                        >
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>
                            {alert.triggerType === 'overdue'
                              ? `Overdue ${Math.abs(alert.daysLeft)}d`
                              : alert.triggerType === 'on_expiry'
                              ? 'Today'
                              : `${alert.daysLeft}d left`}
                          </span>
                        </span>
                        {primaryWhatsAppRecipient &&
                          hasValidRecipientPhone(primaryWhatsAppRecipient.recipientPhone) && (
                            <button
                              type="button"
                              title={`Share WhatsApp reminder to ${primaryWhatsAppRecipient.recipientName}`}
                              aria-label={`Share WhatsApp reminder for ${alert.vehicleNumber} ${alert.documentType}`}
                              onClick={() =>
                                setWhatsappShareTarget({
                                  alert,
                                  recipient: primaryWhatsAppRecipient,
                                  message: buildExpiryWhatsAppMessage({
                                    alert,
                                    recipient: primaryWhatsAppRecipient,
                                    companyName:
                                      companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
                                  }),
                                })
                              }
                              className="p-1.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer"
                            >
                              <MessageCircle className="w-3.5 h-3.5" />
                            </button>
                          )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="divide-y divide-slate-100">
                {pushedRecipientAlerts.map((rec) => (
                  <li
                    key={rec.id}
                    onClick={() => onNavigate('expiry-alerts')}
                    className="py-2.5 first:pt-0 last:pb-0 flex items-start justify-between gap-2.5 cursor-pointer hover:bg-slate-50 rounded"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-semibold text-slate-900 truncate">
                        {rec.vehicleNumber}
                      </div>
                      <div className="text-xs text-slate-500">
                        {rec.documentType} · {formatDateIN(rec.expiryDate)}
                      </div>
                    </div>
                    <span
                      className={`text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                        rec.triggerType === 'overdue'
                          ? 'text-red-600'
                          : rec.triggerType === 'on_expiry'
                          ? 'text-amber-700'
                          : 'text-blue-700'
                      }`}
                    >
                      {rec.triggerType === 'overdue'
                        ? 'Overdue'
                        : rec.triggerType === 'on_expiry'
                        ? 'Today'
                        : '5-Day Notice'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {vehicleExpiryAlerts.length > 7 && (
              <button
                type="button"
                onClick={() => onNavigate('expiry-alerts')}
                className="mt-3 w-full py-1.5 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg cursor-pointer"
              >
                View all {vehicleExpiryAlerts.length} vehicle expiry alerts →
              </button>
            )}
          </div>
        </section>
      </div>

      <WhatsAppShareModal
        open={Boolean(whatsappShareTarget)}
        onClose={() => setWhatsappShareTarget(null)}
        title={
          whatsappShareTarget
            ? `Vehicle Expiry Reminder — ${whatsappShareTarget.alert.vehicleNumber} (${whatsappShareTarget.alert.documentType})`
            : 'Vehicle Expiry Reminder'
        }
        subtitle="Review recipient mobile number and prepared document expiry reminder — press Send manually in WhatsApp."
        partyName={
          whatsappShareTarget
            ? `${whatsappShareTarget.recipient.recipientName} (${formatRecipientRoleLabel(
                whatsappShareTarget.recipient.recipientRole
              )})`
            : ''
        }
        partyPhone={whatsappShareTarget?.recipient.recipientPhone || ''}
        initialMessage={whatsappShareTarget?.message || ''}
      />
    </div>
  );
};
