import React, { useMemo, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  Plus,
  Search,
  UserCheck,
  Pencil,
  Trash2,
  X,
  IndianRupee,
  Eye,
  AlertTriangle,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  DRIVER_PAYMENT_TYPES,
  DRIVER_STATUSES,
  PAYMENT_MODES,
  type Driver,
  type DriverPayment,
  type DriverPaymentType,
  type DriverStatus,
  type ErpUserRole,
  type PaymentMode,
  type Trip,
  type UserPermissions,
  type Vehicle,
} from '../types/erp';
import {
  clampNum,
  clampStr,
  formatDateIN,
  formatINR,
  generateSafeDocId,
  getDaysUntilExpiry,
  getTodayISO,
} from '../utils/formatters';
import { recordAuditLog } from '../utils/auditLogger';
import { ConfirmDialog } from './ConfirmDialog';

interface DriversViewProps {
  userId: string;
  actorRole: ErpUserRole;
  permissions: UserPermissions;
  drivers: Driver[];
  driverPayments: DriverPayment[];
  vehicles: Vehicle[];
  trips: Trip[];
  loading: boolean;
}

interface DriverFormState {
  driverName: string;
  phone: string;
  licenseNumber: string;
  licenseExpiry: string;
  assignedVehicleId: string;
  monthlySalary: string;
  openingBalance: string;
  status: DriverStatus;
  notes: string;
}

const EMPTY_DRIVER_FORM: DriverFormState = {
  driverName: '',
  phone: '',
  licenseNumber: '',
  licenseExpiry: '',
  assignedVehicleId: '',
  monthlySalary: '',
  openingBalance: '0',
  status: 'Active',
  notes: '',
};

interface PaymentFormState {
  driverId: string;
  vehicleId: string;
  paymentDate: string;
  paymentType: DriverPaymentType;
  amount: string;
  paymentMode: PaymentMode;
  referenceNo: string;
  notes: string;
}

export const DriversView: React.FC<DriversViewProps> = ({
  userId,
  actorRole,
  permissions,
  drivers,
  driverPayments,
  vehicles,
  trips,
  loading,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | DriverStatus>('All');

  // Driver CRUD drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null);
  const [driverForm, setDriverForm] = useState<DriverFormState>(EMPTY_DRIVER_FORM);
  const [driverError, setDriverError] = useState<string | null>(null);
  const [savingDriver, setSavingDriver] = useState(false);

  // Payment entry drawer
  const [paymentDrawerOpen, setPaymentDrawerOpen] = useState(false);
  const [paymentForm, setPaymentForm] = useState<PaymentFormState>({
    driverId: '',
    vehicleId: '',
    paymentDate: getTodayISO(),
    paymentType: 'Salary Paid',
    amount: '',
    paymentMode: 'Cash',
    referenceNo: '',
    notes: '',
  });
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);

  // Ledger inspection drawer
  const [inspectDriver, setInspectDriver] = useState<Driver | null>(null);

  // Delete confirmations
  const [deleteDriverTarget, setDeleteDriverTarget] = useState<Driver | null>(null);
  const [deletePaymentTarget, setDeletePaymentTarget] = useState<DriverPayment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const ledgerByDriver = useMemo(() => {
    const map = new Map<
      string,
      {
        salaryDue: number;
        salaryPaid: number;
        advances: number;
        allowances: number;
        deductions: number;
        tripBhatta: number;
        remainingPayable: number;
        paymentCount: number;
      }
    >();

    drivers.forEach((d) => {
      map.set(d.id, {
        salaryDue: 0,
        salaryPaid: 0,
        advances: 0,
        allowances: 0,
        deductions: 0,
        tripBhatta: 0,
        remainingPayable: d.openingBalance || 0,
        paymentCount: 0,
      });
    });

    driverPayments.forEach((p) => {
      const curr = map.get(p.driverId);
      if (!curr) return;
      curr.paymentCount += 1;
      if (p.paymentType === 'Salary Due') {
        curr.salaryDue += p.amount;
        curr.remainingPayable += p.amount;
      } else if (p.paymentType === 'Allowance') {
        curr.allowances += p.amount;
        curr.remainingPayable += p.amount;
      } else if (p.paymentType === 'Salary Paid') {
        curr.salaryPaid += p.amount;
        curr.remainingPayable -= p.amount;
      } else if (p.paymentType === 'Advance') {
        curr.advances += p.amount;
        curr.remainingPayable -= p.amount;
      } else if (p.paymentType === 'Deduction') {
        curr.deductions += p.amount;
        curr.remainingPayable -= p.amount;
      }
    });

    // Reference trip driver bhatta by matching driver name (informational & displayed separately)
    const nameToId = new Map<string, string>();
    drivers.forEach((d) => nameToId.set(d.driverName.trim().toLowerCase(), d.id));
    trips
      .filter((t) => t.tripStatus !== 'Cancelled' && t.driverAllowance > 0)
      .forEach((t) => {
        const matchedId = nameToId.get(t.driverName.trim().toLowerCase());
        if (matchedId) {
          const curr = map.get(matchedId);
          if (curr) curr.tripBhatta += t.driverAllowance;
        }
      });

    return map;
  }, [drivers, driverPayments, trips]);

  const totals = useMemo(() => {
    let salaryDue = 0;
    let totalPaid = 0;
    let remainingPayable = 0;
    ledgerByDriver.forEach((l) => {
      salaryDue += l.salaryDue + l.allowances;
      totalPaid += l.salaryPaid + l.advances;
      remainingPayable += l.remainingPayable;
    });
    return { salaryDue, totalPaid, remainingPayable };
  }, [ledgerByDriver]);

  const filteredDrivers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return drivers.filter((d) => {
      if (statusFilter !== 'All' && d.status !== statusFilter) return false;
      if (!q) return true;
      return (
        d.driverName.toLowerCase().includes(q) ||
        d.phone.toLowerCase().includes(q) ||
        d.licenseNumber.toLowerCase().includes(q) ||
        d.assignedVehicleNumber.toLowerCase().includes(q)
      );
    });
  }, [drivers, search, statusFilter]);

  const inspectLedger = useMemo(() => {
    if (!inspectDriver) return null;
    const payments = driverPayments.filter((p) => p.driverId === inspectDriver.id);
    const summary = ledgerByDriver.get(inspectDriver.id);
    return { payments, summary };
  }, [inspectDriver, driverPayments, ledgerByDriver]);

  const openAddDriver = () => {
    setEditingDriver(null);
    setDriverForm(EMPTY_DRIVER_FORM);
    setDriverError(null);
    setDrawerOpen(true);
  };

  const openEditDriver = (d: Driver) => {
    setEditingDriver(d);
    setDriverForm({
      driverName: d.driverName,
      phone: d.phone,
      licenseNumber: d.licenseNumber,
      licenseExpiry: d.licenseExpiry,
      assignedVehicleId: d.assignedVehicleId,
      monthlySalary: d.monthlySalary ? String(d.monthlySalary) : '',
      openingBalance: String(d.openingBalance ?? 0),
      status: d.status,
      notes: d.notes,
    });
    setDriverError(null);
    setDrawerOpen(true);
  };

  const openPaymentDrawer = (preselectDriver?: Driver) => {
    const target = preselectDriver || drivers[0];
    setPaymentForm({
      driverId: target?.id || '',
      vehicleId: target?.assignedVehicleId || '',
      paymentDate: getTodayISO(),
      paymentType: 'Salary Paid',
      amount: '',
      paymentMode: 'Cash',
      referenceNo: '',
      notes: '',
    });
    setPaymentError(null);
    setPaymentDrawerOpen(true);
  };

  const handleSaveDriver = async (e: React.FormEvent) => {
    e.preventDefault();
    setDriverError(null);

    const name = clampStr(driverForm.driverName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX);
    if (name.length < 2) {
      setDriverError('Driver name must be at least 2 characters.');
      return;
    }

    const assignedVehicle = vehicles.find((v) => v.id === driverForm.assignedVehicleId);
    const payload = {
      driverName: name,
      phone: clampStr(driverForm.phone, BLUEPRINT_LIMITS.PHONE_MAX),
      licenseNumber: clampStr(driverForm.licenseNumber.toUpperCase(), BLUEPRINT_LIMITS.LICENSE_MAX),
      licenseExpiry: clampStr(driverForm.licenseExpiry, BLUEPRINT_LIMITS.DATE_MAX),
      assignedVehicleId: assignedVehicle ? assignedVehicle.id : '',
      assignedVehicleNumber: assignedVehicle ? assignedVehicle.registrationNumber : '',
      monthlySalary: clampNum(driverForm.monthlySalary || '0', 0, 10000000),
      openingBalance: clampNum(driverForm.openingBalance || '0', -10000000, 10000000),
      status: driverForm.status,
      notes: clampStr(driverForm.notes, BLUEPRINT_LIMITS.NOTES_MAX),
    };

    setSavingDriver(true);
    try {
      if (editingDriver) {
        await updateDoc(doc(db, 'drivers', editingDriver.id), {
          ...payload,
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: editingDriver.ownerId || userId,
          actorRole,
          action: 'UPDATE',
          module: 'Drivers',
          recordId: editingDriver.id,
          summary: `Updated driver ${payload.driverName}`,
        });
      } else {
        const newId = generateSafeDocId('drv');
        await setDoc(doc(collection(db, 'drivers'), newId), {
          ...payload,
          ownerId: userId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: userId,
          actorRole,
          action: 'CREATE',
          module: 'Drivers',
          recordId: newId,
          summary: `Added driver ${payload.driverName}`,
        });
      }
      setDrawerOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingDriver ? OperationType.UPDATE : OperationType.CREATE,
        editingDriver ? `drivers/${editingDriver.id}` : 'drivers'
      );
    } finally {
      setSavingDriver(false);
    }
  };

  const handleSavePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setPaymentError(null);

    const drv = drivers.find((d) => d.id === paymentForm.driverId);
    if (!drv) {
      setPaymentError('Please select a registered driver.');
      return;
    }

    const amount = clampNum(paymentForm.amount || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    if (amount <= 0) {
      setPaymentError('Enter a payment amount greater than zero.');
      return;
    }

    const veh = vehicles.find((v) => v.id === paymentForm.vehicleId);
    const paymentId = generateSafeDocId('drvp');

    setSavingPayment(true);
    try {
      await setDoc(doc(collection(db, 'driverPayments'), paymentId), {
        driverId: drv.id,
        driverName: drv.driverName,
        vehicleId: veh ? veh.id : '',
        vehicleNumber: veh ? veh.registrationNumber : '',
        paymentDate: clampStr(paymentForm.paymentDate || getTodayISO(), BLUEPRINT_LIMITS.DATE_MAX),
        paymentType: paymentForm.paymentType,
        amount,
        paymentMode: paymentForm.paymentMode,
        referenceNo: clampStr(paymentForm.referenceNo, BLUEPRINT_LIMITS.REFERENCE_MAX),
        notes: clampStr(paymentForm.notes, BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId: userId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'CREATE',
        module: 'Driver Payments',
        recordId: paymentId,
        summary: `Logged ${paymentForm.paymentType} of ${formatINR(amount)} for ${drv.driverName}`,
      });
      setPaymentDrawerOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'driverPayments');
    } finally {
      setSavingPayment(false);
    }
  };

  const handleDeleteDriver = async () => {
    if (!deleteDriverTarget) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, 'drivers', deleteDriverTarget.id));
      await recordAuditLog({
        ownerId: deleteDriverTarget.ownerId || userId,
        actorRole,
        action: 'DELETE',
        module: 'Drivers',
        recordId: deleteDriverTarget.id,
        summary: `Removed driver ${deleteDriverTarget.driverName}`,
      });
      if (inspectDriver?.id === deleteDriverTarget.id) setInspectDriver(null);
      setDeleteDriverTarget(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `drivers/${deleteDriverTarget.id}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleDeletePayment = async () => {
    if (!deletePaymentTarget) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, 'driverPayments', deletePaymentTarget.id));
      await recordAuditLog({
        ownerId: deletePaymentTarget.ownerId || userId,
        actorRole,
        action: 'DELETE',
        module: 'Driver Payments',
        recordId: deletePaymentTarget.id,
        summary: `Deleted ${deletePaymentTarget.paymentType} entry (${formatINR(deletePaymentTarget.amount)}) for ${deletePaymentTarget.driverName}`,
      });
      setDeletePaymentTarget(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `driverPayments/${deletePaymentTarget.id}`);
    } finally {
      setDeleting(false);
    }
  };

  const renderLicenseFlag = (expiry: string) => {
    const days = getDaysUntilExpiry(expiry);
    if (days === null) return <span className="text-slate-400">Not set</span>;
    if (days < 0) {
      return (
        <span className="inline-flex items-center gap-1 text-red-600 font-medium">
          <AlertTriangle className="w-3.5 h-3.5" /> Expired
        </span>
      );
    }
    if (days <= 30) {
      return (
        <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
          <AlertTriangle className="w-3.5 h-3.5" /> Due {days}d
        </span>
      );
    }
    return <span className="text-emerald-700">{formatDateIN(expiry)}</span>;
  };

  return (
    <div className="space-y-5">
      {/* KPI Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Total Salary Due &amp; Allowances</div>
          <div className="mt-1.5 font-mono text-xl font-semibold text-slate-900 tabular-nums">
            {formatINR(totals.salaryDue)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Total Salary Paid &amp; Advances</div>
          <div className="mt-1.5 font-mono text-xl font-semibold text-emerald-700 tabular-nums">
            {formatINR(totals.totalPaid)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Net Remaining Payable</div>
          <div
            className={`mt-1.5 font-mono text-xl font-semibold tabular-nums ${
              totals.remainingPayable > 0 ? 'text-amber-700' : 'text-emerald-700'
            }`}
          >
            {formatINR(totals.remainingPayable)}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search driver, phone, license, vehicle..."
              className="w-full pl-9 pr-3 py-2 min-h-[40px] text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
            {(['All', ...DRIVER_STATUSES] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  statusFilter === s
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {drivers.length > 0 && (
            <button
              type="button"
              onClick={() => openPaymentDrawer()}
              className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              <IndianRupee className="w-4 h-4" />
              <span>Record Salary / Advance</span>
            </button>
          )}
          {permissions.canManageMasters && (
            <button
              type="button"
              onClick={openAddDriver}
              className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add Driver</span>
            </button>
          )}
        </div>
      </div>

      {/* Drivers Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : drivers.length === 0 ? (
          <div className="p-10 sm:p-14 text-center">
            <UserCheck className="w-9 h-9 text-slate-300 mx-auto" />
            <h3 className="mt-3 text-base font-semibold text-slate-900">
              No Drivers Registered Yet
            </h3>
            <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
              Add your fleet drivers with license expiry dates, monthly salary, and track advances, allowances, and remaining payable amounts.
            </p>
            {permissions.canManageMasters && (
              <button
                type="button"
                onClick={openAddDriver}
                className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Add First Driver</span>
              </button>
            )}
          </div>
        ) : filteredDrivers.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No drivers match your search or status filter.
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500">
                    <th className="py-3 px-4">Driver &amp; Phone</th>
                    <th className="py-3 px-4">License &amp; Expiry</th>
                    <th className="py-3 px-4">Assigned Vehicle</th>
                    <th className="py-3 px-4 text-right">Monthly Salary</th>
                    <th className="py-3 px-4 text-right">Paid / Advance</th>
                    <th className="py-3 px-4 text-right">Remaining Payable</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredDrivers.map((d) => {
                    const l = ledgerByDriver.get(d.id);
                    const totalPaid = (l?.salaryPaid || 0) + (l?.advances || 0);
                    const payable = l?.remainingPayable || 0;
                    return (
                      <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-4">
                          <div className="text-xs font-semibold text-slate-900">{d.driverName}</div>
                          <div className="font-mono text-[11px] text-slate-500">{d.phone || '—'}</div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className="font-mono text-slate-800">{d.licenseNumber || '—'}</div>
                          <div className="text-[11px]">{renderLicenseFlag(d.licenseExpiry)}</div>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-slate-800">
                          {d.assignedVehicleNumber || 'Unassigned'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-900">
                          {formatINR(d.monthlySalary)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-emerald-700">
                          {formatINR(totalPaid)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs font-semibold tabular-nums">
                          <span className={payable > 0 ? 'text-amber-700' : 'text-emerald-700'}>
                            {formatINR(payable)}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <span className={d.status === 'Active' ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                            {d.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openPaymentDrawer(d)}
                              title="Log Salary or Advance"
                              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                            >
                              <IndianRupee className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setInspectDriver(d)}
                              aria-label={`Inspect ledger for ${d.driverName}`}
                              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {permissions.canManageMasters && (
                              <button
                                type="button"
                                onClick={() => openEditDriver(d)}
                                aria-label={`Edit ${d.driverName}`}
                                className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                            )}
                            {permissions.canDeleteRecords && (
                              <button
                                type="button"
                                onClick={() => setDeleteDriverTarget(d)}
                                aria-label={`Delete ${d.driverName}`}
                                className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-slate-200">
              {filteredDrivers.map((d) => {
                const l = ledgerByDriver.get(d.id);
                const payable = l?.remainingPayable || 0;
                return (
                  <div key={d.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{d.driverName}</div>
                        <div className="text-xs text-slate-500 font-mono">
                          {d.phone || '—'} · {d.assignedVehicleNumber || 'No vehicle'}
                        </div>
                      </div>
                      <span className={`text-xs font-semibold ${d.status === 'Active' ? 'text-emerald-700' : 'text-slate-500'}`}>
                        {d.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100 tabular-nums">
                      <span className="text-slate-500">Salary: {formatINR(d.monthlySalary, true)}</span>
                      <span className={`font-mono font-semibold ${payable > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                        Payable: {formatINR(payable)}
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => openPaymentDrawer(d)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 rounded-lg cursor-pointer"
                      >
                        + Payment
                      </button>
                      <button
                        type="button"
                        onClick={() => setInspectDriver(d)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg cursor-pointer"
                      >
                        History
                      </button>
                      {permissions.canManageMasters && (
                        <button
                          type="button"
                          onClick={() => openEditDriver(d)}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg cursor-pointer"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Add/Edit Driver Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                {editingDriver ? 'Edit Driver' : 'Add Driver'}
              </h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDriver} className="p-6 space-y-4 flex-1">
              {driverError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {driverError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Driver Name *</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={BLUEPRINT_LIMITS.DRIVER_NAME_MAX}
                  value={driverForm.driverName}
                  onChange={(e) => setDriverForm({ ...driverForm, driverName: e.target.value })}
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Phone</label>
                  <input
                    type="tel"
                    maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                    value={driverForm.phone}
                    onChange={(e) => setDriverForm({ ...driverForm, phone: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Assigned Vehicle</label>
                  <select
                    value={driverForm.assignedVehicleId}
                    onChange={(e) => setDriverForm({ ...driverForm, assignedVehicleId: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="">Unassigned</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.registrationNumber}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Driving License No.</label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.LICENSE_MAX}
                    value={driverForm.licenseNumber}
                    onChange={(e) => setDriverForm({ ...driverForm, licenseNumber: e.target.value.toUpperCase() })}
                    className="w-full px-3 py-2.5 text-sm font-mono uppercase border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">License Expiry</label>
                  <input
                    type="date"
                    value={driverForm.licenseExpiry}
                    onChange={(e) => setDriverForm({ ...driverForm, licenseExpiry: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Monthly Salary (INR)</label>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    value={driverForm.monthlySalary}
                    onChange={(e) => setDriverForm({ ...driverForm, monthlySalary: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Opening Balance (INR)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={driverForm.openingBalance}
                    onChange={(e) => setDriverForm({ ...driverForm, openingBalance: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Status</label>
                <select
                  value={driverForm.status}
                  onChange={(e) => setDriverForm({ ...driverForm, status: e.target.value as DriverStatus })}
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {DRIVER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Notes</label>
                <textarea
                  rows={2}
                  maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                  value={driverForm.notes}
                  onChange={(e) => setDriverForm({ ...driverForm, notes: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingDriver}
                  className="px-5 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  {savingDriver ? 'Saving...' : editingDriver ? 'Update Driver' : 'Save Driver'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Driver Salary / Advance / Allowance Drawer */}
      {paymentDrawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                Record Driver Payment / Salary Entry
              </h2>
              <button
                type="button"
                onClick={() => setPaymentDrawerOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSavePayment} className="p-6 space-y-4 flex-1">
              {paymentError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {paymentError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Driver *</label>
                <select
                  required
                  value={paymentForm.driverId}
                  onChange={(e) => {
                    const drv = drivers.find((d) => d.id === e.target.value);
                    setPaymentForm({
                      ...paymentForm,
                      driverId: e.target.value,
                      vehicleId: drv?.assignedVehicleId || paymentForm.vehicleId,
                    });
                  }}
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="">Select driver...</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.driverName} {d.assignedVehicleNumber ? `(${d.assignedVehicleNumber})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Entry Type *</label>
                  <select
                    value={paymentForm.paymentType}
                    onChange={(e) =>
                      setPaymentForm({ ...paymentForm, paymentType: e.target.value as DriverPaymentType })
                    }
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {DRIVER_PAYMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Amount (INR) *</label>
                  <input
                    type="number"
                    required
                    min="1"
                    step="0.01"
                    value={paymentForm.amount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Date *</label>
                  <input
                    type="date"
                    required
                    value={paymentForm.paymentDate}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Payment Mode</label>
                  <select
                    value={paymentForm.paymentMode}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paymentMode: e.target.value as PaymentMode })}
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {PAYMENT_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Vehicle (Optional)</label>
                  <select
                    value={paymentForm.vehicleId}
                    onChange={(e) => setPaymentForm({ ...paymentForm, vehicleId: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="">None / General</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.registrationNumber}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Reference / Voucher No</label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.REFERENCE_MAX}
                    value={paymentForm.referenceNo}
                    onChange={(e) => setPaymentForm({ ...paymentForm, referenceNo: e.target.value })}
                    placeholder="UPI ref or voucher #"
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Notes</label>
                <textarea
                  rows={2}
                  maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                  value={paymentForm.notes}
                  onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                  placeholder="Monthly salary accrual, route advance, or bhatta details..."
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setPaymentDrawerOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingPayment}
                  className="px-5 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  {savingPayment ? 'Saving...' : 'Save Payment Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Driver Ledger & Payment History Drawer */}
      {inspectDriver && inspectLedger && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50" role="dialog" aria-modal="true">
          <div className="w-full max-w-2xl bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  {inspectDriver.driverName} — Payment Ledger
                </h2>
                <p className="text-xs text-slate-500">
                  Monthly Salary: {formatINR(inspectDriver.monthlySalary)} · Opening Bal:{' '}
                  {formatINR(inspectDriver.openingBalance)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectDriver(null)}
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {inspectLedger.summary && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    <div className="text-slate-500">Salary Due + Allowances</div>
                    <div className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                      {formatINR(inspectLedger.summary.salaryDue + inspectLedger.summary.allowances)}
                    </div>
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    <div className="text-slate-500">Paid + Advances + Deductions</div>
                    <div className="mt-1 font-mono font-semibold text-emerald-700 tabular-nums">
                      {formatINR(
                        inspectLedger.summary.salaryPaid +
                          inspectLedger.summary.advances +
                          inspectLedger.summary.deductions
                      )}
                    </div>
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl col-span-2 sm:col-span-1">
                    <div className="text-slate-500">Remaining Payable</div>
                    <div
                      className={`mt-1 font-mono font-semibold tabular-nums ${
                        inspectLedger.summary.remainingPayable > 0 ? 'text-amber-700' : 'text-emerald-700'
                      }`}
                    >
                      {formatINR(inspectLedger.summary.remainingPayable)}
                    </div>
                  </div>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                    Payment History ({inspectLedger.payments.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => openPaymentDrawer(inspectDriver)}
                    className="text-xs font-medium text-slate-900 hover:underline cursor-pointer"
                  >
                    + Add Entry
                  </button>
                </div>
                {inspectLedger.payments.length === 0 ? (
                  <p className="text-xs text-slate-500 p-4 border border-slate-200 rounded-lg">
                    No salary, advance, or allowance entries logged for this driver yet.
                  </p>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                          <th className="py-2 px-3">Date</th>
                          <th className="py-2 px-3">Type</th>
                          <th className="py-2 px-3">Mode / Ref</th>
                          <th className="py-2 px-3 text-right">Amount</th>
                          {permissions.canDeleteRecords && <th className="py-2 px-3 text-right">Action</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inspectLedger.payments.map((p) => (
                          <tr key={p.id}>
                            <td className="py-2 px-3 font-mono whitespace-nowrap">
                              {formatDateIN(p.paymentDate)}
                            </td>
                            <td className="py-2 px-3">
                              <div className="font-medium text-slate-900">{p.paymentType}</div>
                              {p.notes && <div className="text-[11px] text-slate-500">{p.notes}</div>}
                            </td>
                            <td className="py-2 px-3">
                              <div>{p.paymentMode}</div>
                              {p.referenceNo && <div className="font-mono text-[11px] text-slate-500">{p.referenceNo}</div>}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-medium tabular-nums text-slate-900">
                              {formatINR(p.amount)}
                            </td>
                            {permissions.canDeleteRecords && (
                              <td className="py-2 px-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => setDeletePaymentTarget(p)}
                                  className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                                  aria-label="Delete payment entry"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteDriverTarget)}
        title="Delete Driver"
        description={`Remove ${deleteDriverTarget?.driverName || ''} from the driver directory?`}
        confirmLabel="Delete Driver"
        destructive
        busy={deleting}
        onConfirm={handleDeleteDriver}
        onCancel={() => setDeleteDriverTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deletePaymentTarget)}
        title="Delete Driver Payment Entry"
        description={`Delete ${deletePaymentTarget?.paymentType || ''} entry of ${formatINR(deletePaymentTarget?.amount || 0)}?`}
        confirmLabel="Delete Entry"
        destructive
        busy={deleting}
        onConfirm={handleDeletePayment}
        onCancel={() => setDeletePaymentTarget(null)}
      />
    </div>
  );
};
