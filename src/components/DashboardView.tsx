import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  Truck,
  Users,
  IndianRupee,
  ArrowUpRight,
  AlertTriangle,
  PlusSquare,
  CheckCircle2,
  CalendarRange,
  BellRing,
  MessageCircle,
  FileCheck2,
  ReceiptText,
  Wallet,
  Activity,
  Route,
  Clock,
  Wrench,
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
  type LorryReceipt,
  type MaintenanceRecord,
  type NavSection,
  type NotificationPreference,
  type Party,
  type PartyPayment,
  type Trip,
  type UserPermissions,
  type Vehicle,
} from '../types/erp';
import {
  clampStr,
  formatDateIN,
  formatINR,
  generateSafeDocId,
  getTodayISO,
} from '../utils/formatters';
import {
  BILL_HEADER_LEFT_TRUCK_REG,
  BILL_HEADER_RIGHT_TRUCK_REG,
} from '../utils/billHeaderHelpers';
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
  partyPayments?: PartyPayment[];
  trips: Trip[];
  lorryReceipts?: LorryReceipt[];
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

function normalizeRegKey(value: string): string {
  return (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  userId,
  userEmail,
  userDisplayName,
  permissions,
  vehicles,
  parties,
  partyPayments = [],
  trips,
  lorryReceipts = [],
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

  const todayISO = getTodayISO();

  const metrics = useMemo(() => {
    const activeTripsList = trips.filter((t) => t.tripStatus !== 'Cancelled');
    const todaysTripsList = activeTripsList.filter((t) => t.tripDate === todayISO);
    const todaysFreight = round2(todaysTripsList.reduce((sum, t) => sum + t.freightAmount, 0));

    const totalFreight = round2(activeTripsList.reduce((sum, t) => sum + t.freightAmount, 0));
    const tripAdvanceReceived = round2(
      activeTripsList.reduce((sum, t) => sum + t.advanceReceived, 0)
    );
    const tripHisabBalance = round2(
      activeTripsList.reduce((sum, t) => {
        const hasExplicit =
          typeof t.balanceAmount === 'number' && Number.isFinite(t.balanceAmount);
        return sum + (hasExplicit ? t.balanceAmount : Math.max(0, t.freightAmount - t.advanceReceived));
      }, 0)
    );

    let separatePaymentsReceived = 0;
    let deductionsTotal = 0;
    for (const p of partyPayments) {
      const amt = Number(p.amount) || 0;
      if (p.paymentType === 'Deduction') {
        deductionsTotal += amt;
      } else {
        separatePaymentsReceived += amt;
      }
    }
    separatePaymentsReceived = round2(separatePaymentsReceived);
    const partyPaymentsTotal = round2(separatePaymentsReceived + deductionsTotal);

    const amountReceived = round2(tripAdvanceReceived + separatePaymentsReceived);
    const balanceDue = round2(tripHisabBalance - partyPaymentsTotal);

    const pendingBillsList = bills.filter(
      (b) => b.status === 'Draft' || b.status === 'Issued'
    );
    const pendingBillsAmount = round2(
      pendingBillsList.reduce((sum, b) => sum + (Number(b.netPayable) || 0), 0)
    );
    const issuedBillsCount = pendingBillsList.filter((b) => b.status === 'Issued').length;

    const totalTripExpenses = round2(activeTripsList.reduce((sum, t) => sum + t.totalExpense, 0));
    const totalMaintenance = round2(maintenanceRecords.reduce((sum, m) => sum + m.amount, 0));
    const totalExpenses = round2(totalTripExpenses + totalMaintenance);
    const netProfit = round2(totalFreight - totalExpenses);
    const totalDriverPaid = round2(
      driverPayments
        .filter(
          (p) =>
            p.paymentType === 'Salary Paid' ||
            p.paymentType === 'Advance' ||
            p.paymentType === 'Allowance'
        )
        .reduce((sum, p) => sum + p.amount, 0)
    );

    const availableVehicles = vehicles.filter((v) => v.status === 'Available').length;
    const onTripVehicles = vehicles.filter((v) => v.status === 'On Trip').length;
    const maintenanceVehicles = vehicles.filter((v) => v.status === 'Maintenance').length;
    const inTransitTrips = trips.filter((t) => t.tripStatus === 'In Transit').length;
    const settledTrips = trips.filter((t) => t.tripStatus === 'Settled').length;

    return {
      todaysTripCount: todaysTripsList.length,
      todaysFreight,
      pendingBillsCount: pendingBillsList.length,
      pendingBillsAmount,
      issuedBillsCount,
      totalFreight,
      tripAdvanceReceived,
      separatePaymentsReceived,
      amountReceived,
      balanceDue,
      totalTripExpenses,
      totalMaintenance,
      totalExpenses,
      totalDriverPaid,
      netProfit,
      availableVehicles,
      onTripVehicles,
      maintenanceVehicles,
      inTransitTrips,
      settledTrips,
      activeTripCount: activeTripsList.length,
    };
  }, [vehicles, trips, partyPayments, bills, maintenanceRecords, driverPayments, todayISO]);

  // Fleet Status for primary vehicles GJ12 BV6552 and GJ12 CT4312 (real recorded ERP data only)
  const featuredFleetUnits = useMemo(() => {
    const targets = [
      {
        label: BILL_HEADER_LEFT_TRUCK_REG,
        key: normalizeRegKey(BILL_HEADER_LEFT_TRUCK_REG),
        thumbDataUrl: companySettings?.billHeaderLeftTruckDataUrl || '',
      },
      {
        label: BILL_HEADER_RIGHT_TRUCK_REG,
        key: normalizeRegKey(BILL_HEADER_RIGHT_TRUCK_REG),
        thumbDataUrl: companySettings?.billHeaderRightTruckDataUrl || '',
      },
    ];

    return targets.map((target) => {
      const matchedVehicle = vehicles.find(
        (v) => normalizeRegKey(v.registrationNumber) === target.key
      );

      const unitTrips = trips.filter((t) => {
        if (t.tripStatus === 'Cancelled') return false;
        if (matchedVehicle && t.vehicleId === matchedVehicle.id) return true;
        return normalizeRegKey(t.vehicleNumber) === target.key;
      });

      const unitMaintenance = maintenanceRecords.filter((m) => {
        if (matchedVehicle && m.vehicleId === matchedVehicle.id) return true;
        return normalizeRegKey(m.vehicleNumber) === target.key;
      });

      const matchedDriver = matchedVehicle
        ? drivers.find((d) => d.assignedVehicleId === matchedVehicle.id)
        : undefined;

      const latestTrip = unitTrips[0] || null;
      const hasActiveInTransit = unitTrips.some((t) => t.tripStatus === 'In Transit');
      const todaysUnitTrips = unitTrips.filter((t) => t.tripDate === todayISO).length;
      const totalFreight = round2(unitTrips.reduce((s, t) => s + t.freightAmount, 0));
      const totalExp = round2(
        unitTrips.reduce((s, t) => s + t.totalExpense, 0) +
          unitMaintenance.reduce((s, m) => s + m.amount, 0)
      );
      const netProfit = round2(totalFreight - totalExp);

      const resolvedStatus: Vehicle['status'] | 'Unregistered' = matchedVehicle
        ? matchedVehicle.status
        : hasActiveInTransit
        ? 'On Trip'
        : unitTrips.length > 0
        ? 'Available'
        : 'Unregistered';

      return {
        regLabel: matchedVehicle?.registrationNumber || target.label,
        canonicalLabel: target.label,
        vehicle: matchedVehicle || null,
        status: resolvedStatus,
        driverName:
          matchedDriver?.driverName || latestTrip?.driverName || 'Unassigned',
        latestTrip,
        tripCount: unitTrips.length,
        todaysUnitTrips,
        totalFreight,
        netProfit,
        thumbDataUrl: target.thumbDataUrl,
      };
    });
  }, [vehicles, trips, maintenanceRecords, drivers, companySettings, todayISO]);

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

  // Recent Activity across Trips, Lorry Receipts, Party Payments, Bills, Driver Payments & Maintenance
  const recentActivity = useMemo(() => {
    const items: {
      id: string;
      date: string;
      type: 'Trip' | 'Lorry Receipt' | 'Party Payment' | 'Bill' | 'Driver Payment' | 'Maintenance';
      reference: string;
      partyOrVehicle: string;
      amount: number;
      isCredit?: boolean;
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

    lorryReceipts.slice(0, 6).forEach((lr) => {
      items.push({
        id: `lr-${lr.id}`,
        date: lr.lrDate,
        type: 'Lorry Receipt',
        reference: lr.lrNumber,
        partyOrVehicle: `${lr.consignorName} · ${lr.vehicleNumber}`,
        amount: lr.totalFreightAmount,
        section: 'lorry-receipts',
      });
    });

    partyPayments.slice(0, 6).forEach((pp) => {
      items.push({
        id: `pp-${pp.id}`,
        date: pp.paymentDate,
        type: 'Party Payment',
        reference: `${pp.paymentMode}${pp.referenceNo ? ` · ${pp.referenceNo}` : ''}`,
        partyOrVehicle: pp.partyName,
        amount: pp.amount,
        isCredit: true,
        section: 'parties',
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
          reference: `${b.billNumber} (${b.status})`,
          partyOrVehicle: b.partyName,
          amount: b.netPayable,
          section: 'billing',
        });
      });

    driverPayments.slice(0, 5).forEach((p) => {
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

    maintenanceRecords.slice(0, 5).forEach((m) => {
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

    return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  }, [trips, lorryReceipts, partyPayments, bills, driverPayments, maintenanceRecords]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-36 bg-[#111827] border border-slate-800 rounded-lg p-6 animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 bg-white border border-slate-300 rounded-lg p-5 animate-pulse">
              <div className="h-3.5 w-24 bg-slate-200 rounded" />
              <div className="mt-4 h-7 w-36 bg-slate-200 rounded" />
              <div className="mt-3 h-3 w-28 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
        <div className="h-56 bg-[#111827] border border-slate-800 rounded-lg p-6 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. Operations Overview + Quick Actions Command Deck */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg overflow-hidden text-white">
        <div className="h-1 bg-orange-600 w-full" aria-hidden="true" />
        <div className="p-5 sm:p-6 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-5">
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono text-slate-400">
              <span className="text-orange-400 font-semibold">BAPASITARAM ENTERPRISE</span>
              <span aria-hidden="true">/</span>
              <span>{formatDateIN(todayISO)}</span>
              <span aria-hidden="true">/</span>
              <span className="text-emerald-400">
                {metrics.activeTripCount} Active Trips · {metrics.settledTrips} Settled
              </span>
            </div>
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-wide uppercase text-white leading-tight">
              Operations Overview
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
              Live fleet readiness, container trip dispatch, freight billing, and INR ledger balances computed directly from recorded ERP entries.
            </p>
          </div>

          {/* Quick Actions: Trip Entry, LR, Bill & Payment */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {permissions.canEditTrips && (
              <button
                type="button"
                onClick={onOpenNewTrip}
                className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[42px] text-xs sm:text-sm font-semibold text-white bg-orange-600 hover:bg-orange-500 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <PlusSquare className="w-4 h-4 shrink-0" />
                <span>Trip Entry</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('lorry-receipts')}
              className="inline-flex items-center gap-2 px-3.5 py-2.5 min-h-[42px] text-xs sm:text-sm font-semibold text-slate-100 bg-[#1a2434] hover:bg-[#243146] border border-slate-700 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <FileCheck2 className="w-4 h-4 shrink-0 text-orange-400" />
              <span>Lorry Receipt (LR)</span>
            </button>
            {permissions.canManageBilling && (
              <button
                type="button"
                onClick={() => onNavigate('billing')}
                className="inline-flex items-center gap-2 px-3.5 py-2.5 min-h-[42px] text-xs sm:text-sm font-semibold text-slate-100 bg-[#1a2434] hover:bg-[#243146] border border-slate-700 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <ReceiptText className="w-4 h-4 shrink-0 text-orange-400" />
                <span>Bill</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('parties')}
              className="inline-flex items-center gap-2 px-3.5 py-2.5 min-h-[42px] text-xs sm:text-sm font-semibold text-slate-100 bg-[#1a2434] hover:bg-[#243146] border border-slate-700 rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              <Wallet className="w-4 h-4 shrink-0 text-emerald-400" />
              <span>Payment</span>
            </button>
          </div>
        </div>
      </section>

      {/* 2. Primary Industrial Command KPI Grid: Today's Trips, Pending Bills, Amount Received, Balance Due */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-300 rounded-lg overflow-hidden">
          <div className="h-1 bg-orange-600 w-full" aria-hidden="true" />
          <div className="p-5">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Today&apos;s Trips</span>
              <Route className="w-4 h-4 text-orange-600" />
            </div>
            <div className="mt-2.5 font-mono text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
              {metrics.todaysTripCount}
            </div>
            <div className="mt-2 text-xs text-slate-600 tabular-nums">
              {metrics.inTransitTrips} in transit · Today freight{' '}
              <span className="font-mono font-semibold text-slate-900">
                {formatINR(metrics.todaysFreight, true)}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onNavigate(permissions.canManageBilling ? 'billing' : 'trip-history')}
          className="bg-white border border-slate-300 hover:border-slate-400 rounded-lg overflow-hidden text-left transition-colors cursor-pointer"
        >
          <div className="h-1 bg-slate-800 w-full" aria-hidden="true" />
          <div className="p-5">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Pending Bills</span>
              <ReceiptText className="w-4 h-4 text-slate-700" />
            </div>
            <div className="mt-2.5 font-mono text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
              {metrics.pendingBillsCount}
            </div>
            <div className="mt-2 text-xs text-slate-600 tabular-nums">
              Value:{' '}
              <span className="font-mono font-semibold text-slate-900">
                {formatINR(metrics.pendingBillsAmount, true)}
              </span>
              {metrics.issuedBillsCount > 0 && (
                <span className="text-orange-700 font-semibold">
                  {' '}
                  · {metrics.issuedBillsCount} issued
                </span>
              )}
            </div>
          </div>
        </button>

        <div className="bg-white border border-slate-300 rounded-lg overflow-hidden">
          <div className="h-1 bg-emerald-600 w-full" aria-hidden="true" />
          <div className="p-5">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Amount Received</span>
              <IndianRupee className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="mt-2.5 font-mono text-2xl sm:text-3xl font-bold text-emerald-700 tabular-nums">
              {formatINR(metrics.amountReceived, true)}
            </div>
            <div className="mt-2 text-xs text-slate-600 tabular-nums">
              Trip adv: {formatINR(metrics.tripAdvanceReceived, true)} · Ledger:{' '}
              {formatINR(metrics.separatePaymentsReceived, true)}
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-300 rounded-lg overflow-hidden">
          <div className="h-1 bg-orange-600 w-full" aria-hidden="true" />
          <div className="p-5">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Balance Due</span>
              <Clock className="w-4 h-4 text-orange-600" />
            </div>
            <div
              className={`mt-2.5 font-mono text-2xl sm:text-3xl font-bold tabular-nums ${
                metrics.balanceDue > 0 ? 'text-orange-700' : 'text-emerald-700'
              }`}
            >
              {formatINR(metrics.balanceDue, true)}
            </div>
            <div className="mt-2 text-xs text-slate-600 tabular-nums">
              Freight: {formatINR(metrics.totalFreight, true)} · Op. Profit:{' '}
              <span
                className={
                  metrics.netProfit >= 0
                    ? 'text-emerald-700 font-semibold'
                    : 'text-red-600 font-semibold'
                }
              >
                {formatINR(metrics.netProfit, true)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Fleet Status Control Bay — GJ12 BV6552 & GJ12 CT4312 */}
      <section className="bg-[#111827] border border-slate-800 rounded-lg overflow-hidden text-white">
        <div className="px-5 py-4 bg-[#0b111c] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-orange-500" />
              <h3 className="font-display text-lg font-bold tracking-wide uppercase text-white">
                Fleet Status — {BILL_HEADER_LEFT_TRUCK_REG} &amp; {BILL_HEADER_RIGHT_TRUCK_REG}
              </h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
              Total Fleet: {vehicles.length} units · {metrics.availableVehicles} Available ·{' '}
              {metrics.onTripVehicles} On Trip · {metrics.maintenanceVehicles} Maintenance ·{' '}
              {parties.length} Parties · {drivers.length} Drivers
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('vehicles')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#1a2434] hover:bg-[#243146] border border-slate-700 rounded-md cursor-pointer"
          >
            <span>All Vehicles</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-orange-400" />
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {featuredFleetUnits.map((unit) => {
            const isAvailable = unit.status === 'Available';
            const isOnTrip = unit.status === 'On Trip';
            const isMaint = unit.status === 'Maintenance';

            const statusBarClass = isAvailable
              ? 'bg-emerald-500'
              : isOnTrip
              ? 'bg-orange-500'
              : isMaint
              ? 'bg-red-500'
              : 'bg-slate-500';

            const statusTextClass = isAvailable
              ? 'text-emerald-400'
              : isOnTrip
              ? 'text-orange-400'
              : isMaint
              ? 'text-red-400'
              : 'text-slate-400';

            return (
              <div
                key={unit.canonicalLabel}
                onClick={() => onNavigate('vehicles')}
                className="bg-[#182232] hover:bg-[#1d293c] border border-slate-700/90 rounded-md p-4 transition-colors cursor-pointer space-y-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {unit.thumbDataUrl ? (
                      <div className="w-16 h-12 rounded bg-white border border-slate-600 p-0.5 flex items-center justify-center shrink-0 overflow-hidden">
                        <img
                          src={unit.thumbDataUrl}
                          alt={`Fleet truck ${unit.canonicalLabel}`}
                          className="max-w-full max-h-full w-auto h-auto object-contain block"
                        />
                      </div>
                    ) : (
                      <div className="w-12 h-12 rounded bg-[#0f172a] border border-slate-700 flex items-center justify-center shrink-0">
                        <Truck className="w-5 h-5 text-orange-500" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="font-mono text-base sm:text-lg font-bold tracking-wider text-white">
                        {unit.regLabel}
                      </div>
                      <div className="text-xs text-slate-400 truncate">
                        {unit.vehicle
                          ? `${unit.vehicle.vehicleType}${unit.vehicle.makeModel ? ` · ${unit.vehicle.makeModel}` : ''}`
                          : 'Primary Fleet Unit'}
                      </div>
                    </div>
                  </div>

                  {/* Industrial Status Indicator (color + solid bar + explicit text label) */}
                  <div className="text-right shrink-0">
                    <div className="inline-flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wide">
                      <span className={`w-2.5 h-2.5 rounded-xs ${statusBarClass}`} aria-hidden="true" />
                      <span className={statusTextClass}>
                        {unit.status === 'Unregistered' ? 'Standby' : unit.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Driver: <span className="text-slate-200">{unit.driverName}</span>
                    </div>
                  </div>
                </div>

                {/* Operational Readout Grid */}
                <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-700/80 text-xs">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-400">
                      Total Trips
                    </div>
                    <div className="font-mono font-bold text-sm text-white mt-0.5 tabular-nums">
                      {unit.tripCount}
                      {unit.todaysUnitTrips > 0 && (
                        <span className="text-orange-400 text-[11px] font-medium ml-1">
                          (+{unit.todaysUnitTrips} today)
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-400">
                      Freight Earned
                    </div>
                    <div className="font-mono font-bold text-sm text-slate-100 mt-0.5 tabular-nums">
                      {formatINR(unit.totalFreight, true)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400">
                      Net Profit
                    </div>
                    <div
                      className={`font-mono font-bold text-sm mt-0.5 tabular-nums ${
                        unit.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {formatINR(unit.netProfit, true)}
                    </div>
                  </div>
                </div>

                <div className="pt-2.5 border-t border-slate-700/60 flex items-center justify-between gap-2 text-xs text-slate-300">
                  {unit.latestTrip ? (
                    <>
                      <span className="truncate">
                        Last Route:{' '}
                        <span className="text-white font-medium">
                          {unit.latestTrip.origin} → {unit.latestTrip.destination}
                        </span>
                      </span>
                      <span className="font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0">
                        {unit.latestTrip.lrNumber} · {formatDateIN(unit.latestTrip.tripDate)}
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-400">
                      No trips recorded for {unit.canonicalLabel} yet.
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 4. Vehicle-Wise Profit & Monthly/Yearly Reports Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <section className="bg-white border border-slate-300 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-slate-50">
            <div>
              <h3 className="font-display text-lg font-bold tracking-wide uppercase text-slate-900">
                Vehicle-Wise Profit
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                Freight income minus trip &amp; maintenance expenses
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('vehicles')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-orange-700 hover:text-orange-800 cursor-pointer"
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
                  <tr>
                    <th className="py-2.5 px-4">Vehicle</th>
                    <th className="py-2.5 px-4 text-right">Trips</th>
                    <th className="py-2.5 px-4 text-right">Freight</th>
                    <th className="py-2.5 px-4 text-right">Expenses</th>
                    <th className="py-2.5 px-4 text-right">Net Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
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

        <section className="bg-white border border-slate-300 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap bg-slate-50">
            <div className="flex items-center gap-2">
              <CalendarRange className="w-4 h-4 text-slate-700" />
              <h3 className="font-display text-lg font-bold tracking-wide uppercase text-slate-900">
                Monthly &amp; Yearly Summary
              </h3>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="flex items-center gap-1 p-0.5 bg-slate-200 rounded-md">
                {(['monthly', 'yearly'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPeriodMode(m)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded capitalize cursor-pointer ${
                      periodMode === m
                        ? 'bg-[#111827] text-white'
                        : 'text-slate-700 hover:text-slate-900'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="text-xs font-semibold text-orange-700 hover:text-orange-800 cursor-pointer"
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
                  <tr>
                    <th className="py-2.5 px-4">Period</th>
                    <th className="py-2.5 px-4 text-right">Trips</th>
                    <th className="py-2.5 px-4 text-right">Freight</th>
                    <th className="py-2.5 px-4 text-right">Received</th>
                    <th className="py-2.5 px-4 text-right">Net Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {periodSummary.map((p) => (
                    <tr key={p.period} className="hover:bg-slate-50">
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                        {p.period}
                      </td>
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

      {/* 5. Bottom Split: Recent Activity + Vehicle Document Expiry Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <section className="lg:col-span-2 bg-white border border-slate-300 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-slate-50">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-orange-600" />
              <div>
                <h3 className="font-display text-lg font-bold tracking-wide uppercase text-slate-900">
                  Recent Activity
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  Latest recorded trips, lorry receipts, bills, party payments, and maintenance logs
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('trip-history')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-orange-700 hover:text-orange-800 whitespace-nowrap cursor-pointer"
            >
              <span>All Trips</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {recentActivity.length === 0 ? (
            <div className="p-8 sm:p-10 text-center">
              <Users className="w-8 h-8 text-slate-300 mx-auto" />
              <h4 className="mt-3 text-sm font-semibold text-slate-900">No activity recorded yet</h4>
              <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">
                Record trips, lorry receipts, bills, or party payments to view real-time operational activity here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr>
                    <th className="py-2.5 px-4 whitespace-nowrap">Date</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Module &amp; Ref</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Account / Vehicle</th>
                    <th className="py-2.5 px-4 whitespace-nowrap text-right">Amount (INR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {recentActivity.map((tx) => (
                    <tr
                      key={tx.id}
                      onClick={() => onNavigate(tx.section)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <td className="py-2.5 px-4 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                        {formatDateIN(tx.date)}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                          {tx.type === 'Maintenance' && <Wrench className="w-3 h-3 text-slate-500" />}
                          <span>{tx.type}</span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{tx.reference}</div>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="text-slate-800 truncate max-w-[260px]">
                          {tx.partyOrVehicle}
                        </div>
                      </td>
                      <td
                        className={`py-2.5 px-4 text-right font-mono font-semibold tabular-nums whitespace-nowrap ${
                          tx.isCredit ? 'text-emerald-700' : 'text-slate-900'
                        }`}
                      >
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
        <section className="bg-white border border-slate-300 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-slate-50">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <BellRing className="w-4 h-4 text-orange-600 shrink-0" />
                <h3 className="font-display text-base font-bold tracking-wide uppercase text-slate-900 truncate">
                  Vehicle Document Expiry Alerts
                </h3>
              </div>
              <div className="text-[11px] text-slate-600 mt-0.5">{expiryScopeSummary}</div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('expiry-alerts')}
              className="text-xs font-semibold text-orange-700 hover:text-orange-800 whitespace-nowrap shrink-0 cursor-pointer"
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
              <ul className="divide-y divide-slate-200">
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
                        <div className="text-xs text-slate-600">
                          {alert.documentType} · {formatDateIN(alert.expiryDate)}
                        </div>
                        {permissions.isAdmin && alert.recipients.length > 0 && (
                          <div className="text-[10px] text-slate-500 mt-0.5 truncate">
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
                              ? 'text-orange-700'
                              : 'text-slate-700'
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
              <ul className="divide-y divide-slate-200">
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
                      <div className="text-xs text-slate-600">
                        {rec.documentType} · {formatDateIN(rec.expiryDate)}
                      </div>
                    </div>
                    <span
                      className={`text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                        rec.triggerType === 'overdue'
                          ? 'text-red-600'
                          : rec.triggerType === 'on_expiry'
                          ? 'text-orange-700'
                          : 'text-slate-700'
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
                className="mt-3 w-full py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-md cursor-pointer"
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
