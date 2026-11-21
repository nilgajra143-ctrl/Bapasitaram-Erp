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
  Truck,
  Pencil,
  Trash2,
  X,
  Phone,
  AlertTriangle,
  Eye,
  CheckCircle2,
  Wrench,
} from 'lucide-react';
import { db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
  type DriverPayment,
  type ErpUserRole,
  type MaintenanceRecord,
  type Trip,
  type UserPermissions,
  type Vehicle,
  type VehicleStatus,
  type VehicleType,
} from '../types/erp';
import {
  clampNum,
  clampStr,
  formatDateIN,
  formatINR,
  formatNumberIN,
  generateSafeDocId,
  getDaysUntilExpiry,
} from '../utils/formatters';
import { extractReadableFirestoreError, findDuplicateVehicle } from '../utils/erpHelpers';
import { recordAuditLog } from '../utils/auditLogger';
import { ConfirmDialog } from './ConfirmDialog';

interface VehiclesViewProps {
  userId: string;
  actorRole: ErpUserRole;
  permissions: UserPermissions;
  vehicles: Vehicle[];
  trips: Trip[];
  maintenanceRecords: MaintenanceRecord[];
  driverPayments: DriverPayment[];
  loading: boolean;
}

interface VehicleFormState {
  registrationNumber: string;
  vehicleType: VehicleType;
  makeModel: string;
  capacityTons: string;
  driverName: string;
  driverPhone: string;
  fitnessExpiry: string;
  insuranceExpiry: string;
  pucExpiry: string;
  taxExpiry: string;
  permitExpiry: string;
  status: VehicleStatus;
  notes: string;
}

const EMPTY_FORM: VehicleFormState = {
  registrationNumber: '',
  vehicleType: 'Truck',
  makeModel: '',
  capacityTons: '',
  driverName: '',
  driverPhone: '',
  fitnessExpiry: '',
  insuranceExpiry: '',
  pucExpiry: '',
  taxExpiry: '',
  permitExpiry: '',
  status: 'Available',
  notes: '',
};

export const VehiclesView: React.FC<VehiclesViewProps> = ({
  userId,
  actorRole,
  permissions,
  vehicles,
  trips,
  maintenanceRecords,
  driverPayments,
  loading,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | VehicleStatus>('All');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [form, setForm] = useState<VehicleFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [inspectVehicle, setInspectVehicle] = useState<Vehicle | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Vehicle | null>(null);
  const [deleting, setDeleting] = useState(false);

  const financialsByVehicle = useMemo(() => {
    const map = new Map<
      string,
      {
        tripCount: number;
        freightIncome: number;
        tripExpense: number;
        maintenanceExpense: number;
        driverPaid: number;
        dieselQty: number;
        netProfit: number;
      }
    >();

    const ensure = (vId: string) => {
      let item = map.get(vId);
      if (!item) {
        item = {
          tripCount: 0,
          freightIncome: 0,
          tripExpense: 0,
          maintenanceExpense: 0,
          driverPaid: 0,
          dieselQty: 0,
          netProfit: 0,
        };
        map.set(vId, item);
      }
      return item;
    };

    trips
      .filter((t) => t.tripStatus !== 'Cancelled')
      .forEach((t) => {
        const curr = ensure(t.vehicleId);
        curr.tripCount += 1;
        curr.freightIncome += t.freightAmount;
        curr.tripExpense += t.totalExpense;
        curr.dieselQty += t.dieselQuantity ?? 0;
      });

    maintenanceRecords.forEach((m) => {
      const curr = ensure(m.vehicleId);
      curr.maintenanceExpense += m.amount;
      if (m.category === 'Diesel') {
        curr.dieselQty += m.dieselQuantity;
      }
    });

    driverPayments.forEach((p) => {
      if (!p.vehicleId) return;
      if (p.paymentType === 'Salary Paid' || p.paymentType === 'Advance' || p.paymentType === 'Allowance') {
        const curr = ensure(p.vehicleId);
        curr.driverPaid += p.amount;
      }
    });

    map.forEach((curr) => {
      curr.netProfit = curr.freightIncome - curr.tripExpense - curr.maintenanceExpense;
    });

    return map;
  }, [trips, maintenanceRecords, driverPayments]);

  const filteredVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (statusFilter !== 'All' && v.status !== statusFilter) return false;
      if (!q) return true;
      return (
        v.registrationNumber.toLowerCase().includes(q) ||
        v.driverName.toLowerCase().includes(q) ||
        v.makeModel.toLowerCase().includes(q) ||
        v.vehicleType.toLowerCase().includes(q)
      );
    });
  }, [vehicles, search, statusFilter]);

  const inspectData = useMemo(() => {
    if (!inspectVehicle) return null;
    const vTrips = trips.filter((t) => t.vehicleId === inspectVehicle.id);
    const vMaint = maintenanceRecords.filter((m) => m.vehicleId === inspectVehicle.id);
    const vDriverPayments = driverPayments.filter((p) => p.vehicleId === inspectVehicle.id);
    const summary = financialsByVehicle.get(inspectVehicle.id) || {
      tripCount: 0,
      freightIncome: 0,
      tripExpense: 0,
      maintenanceExpense: 0,
      driverPaid: 0,
      dieselQty: 0,
      netProfit: 0,
    };
    const docs = [
      { label: 'Fitness', date: inspectVehicle.fitnessExpiry },
      { label: 'Insurance', date: inspectVehicle.insuranceExpiry },
      { label: 'PUC', date: inspectVehicle.pucExpiry || '' },
      { label: 'Road Tax', date: inspectVehicle.taxExpiry || '' },
      { label: 'Permit', date: inspectVehicle.permitExpiry },
    ];
    return { vTrips, vMaint, vDriverPayments, summary, docs };
  }, [inspectVehicle, trips, maintenanceRecords, driverPayments, financialsByVehicle]);

  const openAddDrawer = () => {
    setEditingVehicle(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (v: Vehicle) => {
    setEditingVehicle(v);
    setForm({
      registrationNumber: v.registrationNumber,
      vehicleType: v.vehicleType,
      makeModel: v.makeModel,
      capacityTons: v.capacityTons ? String(v.capacityTons) : '',
      driverName: v.driverName,
      driverPhone: v.driverPhone,
      fitnessExpiry: v.fitnessExpiry,
      insuranceExpiry: v.insuranceExpiry,
      pucExpiry: v.pucExpiry || '',
      taxExpiry: v.taxExpiry || '',
      permitExpiry: v.permitExpiry,
      status: v.status,
      notes: v.notes,
    });
    setFormError(null);
    setDrawerOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const regNo = clampStr(form.registrationNumber.toUpperCase(), BLUEPRINT_LIMITS.VEHICLE_REG_MAX);
    if (
      regNo.length < BLUEPRINT_LIMITS.VEHICLE_REG_MIN ||
      !BLUEPRINT_LIMITS.REG_NO_PATTERN.test(regNo)
    ) {
      setFormError(
        'Enter a valid vehicle registration number (4-20 uppercase letters, numbers, spaces, or hyphens, e.g. GJ-03-BW-4521).'
      );
      return;
    }

    const dupVehicle = findDuplicateVehicle(vehicles, regNo, editingVehicle?.id);
    if (dupVehicle) {
      setFormError(
        `Duplicate Vehicle: Registration number "${dupVehicle.registrationNumber}" is already registered in your fleet.`
      );
      return;
    }

    const payload = {
      registrationNumber: regNo,
      vehicleType: form.vehicleType,
      makeModel: clampStr(form.makeModel, BLUEPRINT_LIMITS.MAKE_MODEL_MAX),
      capacityTons: clampNum(form.capacityTons || '0', 0, BLUEPRINT_LIMITS.CAPACITY_MAX),
      driverName: clampStr(form.driverName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX),
      driverPhone: clampStr(form.driverPhone, BLUEPRINT_LIMITS.PHONE_MAX),
      fitnessExpiry: clampStr(form.fitnessExpiry, BLUEPRINT_LIMITS.DATE_MAX),
      insuranceExpiry: clampStr(form.insuranceExpiry, BLUEPRINT_LIMITS.DATE_MAX),
      pucExpiry: clampStr(form.pucExpiry, BLUEPRINT_LIMITS.DATE_MAX),
      taxExpiry: clampStr(form.taxExpiry, BLUEPRINT_LIMITS.DATE_MAX),
      permitExpiry: clampStr(form.permitExpiry, BLUEPRINT_LIMITS.DATE_MAX),
      status: form.status,
      notes: clampStr(form.notes, BLUEPRINT_LIMITS.NOTES_MAX),
    };

    setSaving(true);
    try {
      if (editingVehicle) {
        const ref = doc(db, 'vehicles', editingVehicle.id);
        await updateDoc(ref, {
          ...payload,
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: editingVehicle.ownerId || userId,
          actorRole,
          action: 'UPDATE',
          module: 'Vehicles',
          recordId: editingVehicle.id,
          summary: `Updated vehicle ${payload.registrationNumber} (${payload.status})`,
        });
      } else {
        const newId = generateSafeDocId('veh');
        const ref = doc(collection(db, 'vehicles'), newId);
        await setDoc(ref, {
          ...payload,
          ownerId: userId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: userId,
          actorRole,
          action: 'CREATE',
          module: 'Vehicles',
          recordId: newId,
          summary: `Registered vehicle ${payload.registrationNumber} (${payload.vehicleType})`,
        });
      }
      setSaveBanner(
        editingVehicle
          ? `Vehicle "${payload.registrationNumber}" updated successfully.`
          : `Vehicle "${payload.registrationNumber}" registered — now available in Trip Entry and Expenses.`
      );
      setActionError(null);
      setDrawerOpen(false);
    } catch (error) {
      setFormError(
        extractReadableFirestoreError(
          error,
          editingVehicle ? 'Update Vehicle' : 'Register New Vehicle'
        )
      );
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteDoc(doc(db, 'vehicles', deleteTarget.id));
      await recordAuditLog({
        ownerId: deleteTarget.ownerId || userId,
        actorRole,
        action: 'DELETE',
        module: 'Vehicles',
        recordId: deleteTarget.id,
        summary: `Removed vehicle ${deleteTarget.registrationNumber}`,
      });
      if (inspectVehicle?.id === deleteTarget.id) {
        setInspectVehicle(null);
      }
      setSaveBanner(`Vehicle "${deleteTarget.registrationNumber}" removed.`);
      setDeleteTarget(null);
    } catch (error) {
      setActionError(extractReadableFirestoreError(error, 'Delete Vehicle'));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const renderComplianceFlag = (v: Vehicle) => {
    const dates = [
      v.fitnessExpiry,
      v.insuranceExpiry,
      v.pucExpiry || '',
      v.taxExpiry || '',
      v.permitExpiry,
    ].filter(Boolean);
    if (dates.length === 0) return <span className="text-slate-400">Not set</span>;
    const minDays = dates
      .map((d) => getDaysUntilExpiry(d))
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b)[0];
    if (minDays === undefined) return <span className="text-slate-400">Not set</span>;
    if (minDays < 0) {
      return (
        <span className="inline-flex items-center gap-1 text-red-600 font-medium">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Expired</span>
        </span>
      );
    }
    if (minDays <= 30) {
      return (
        <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Due in {minDays}d</span>
        </span>
      );
    }
    return <span className="text-emerald-700">Valid</span>;
  };

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reg no, driver, make..."
              className="w-full pl-9 pr-3 py-2 min-h-[40px] text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
            {(['All', ...VEHICLE_STATUSES] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  statusFilter === status
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>

        {permissions.canManageMasters && (
          <button
            type="button"
            onClick={openAddDrawer}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add New Vehicle</span>
          </button>
        )}
      </div>

      {saveBanner && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs sm:text-sm text-emerald-900 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{saveBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setSaveBanner(null)}
            className="p-1 text-emerald-700 hover:text-emerald-950 cursor-pointer"
            aria-label="Dismiss notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionError && (
        <div role="alert" className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Vehicle Table / Mobile List */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : vehicles.length === 0 ? (
          <div className="p-10 sm:p-14 text-center">
            <Truck className="w-9 h-9 text-slate-300 mx-auto" />
            <h3 className="mt-3 text-base font-semibold text-slate-900">
              No Fleet Vehicles Registered
            </h3>
            <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
              Register your trucks, trailers, or containers with driver details and Fitness, Insurance, PUC, Tax, and Permit expiry dates.
            </p>
            {permissions.canManageMasters && (
              <button
                type="button"
                onClick={openAddDrawer}
                className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Add New Vehicle</span>
              </button>
            )}
          </div>
        ) : filteredVehicles.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No vehicles match your search or selected status filter.
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500">
                    <th className="py-3 px-4 whitespace-nowrap">Registration No.</th>
                    <th className="py-3 px-4 whitespace-nowrap">Type &amp; Model</th>
                    <th className="py-3 px-4 whitespace-nowrap">Assigned Driver</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Trips</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Income (INR)</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Total Exp (INR)</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Net Profit (INR)</th>
                    <th className="py-3 px-4 whitespace-nowrap">Compliance</th>
                    <th className="py-3 px-4 whitespace-nowrap">Status</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredVehicles.map((v) => {
                    const fin = financialsByVehicle.get(v.id);
                    const totalExp = (fin?.tripExpense || 0) + (fin?.maintenanceExpense || 0);
                    const netProfit = fin?.netProfit || 0;
                    return (
                      <tr key={v.id} className="hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono text-xs font-semibold text-slate-900">
                            {v.registrationNumber}
                          </div>
                          {v.capacityTons > 0 && (
                            <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                              {v.capacityTons} MT
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-xs font-medium text-slate-900">{v.vehicleType}</div>
                          <div className="text-xs text-slate-500 truncate max-w-[150px]">
                            {v.makeModel || '—'}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-xs font-medium text-slate-800">
                            {v.driverName || 'Unassigned'}
                          </div>
                          {v.driverPhone && (
                            <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                              {v.driverPhone}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs text-slate-700 tabular-nums">
                          {fin?.tripCount || 0}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                          {formatINR(fin?.freightIncome || 0, true)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                          {formatINR(totalExp, true)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs font-semibold tabular-nums whitespace-nowrap">
                          <span className={netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                            {formatINR(netProfit, true)}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs whitespace-nowrap">
                          {renderComplianceFlag(v)}
                        </td>
                        <td className="py-3 px-4 text-xs whitespace-nowrap">
                          <span
                            className={`font-medium ${
                              v.status === 'Available'
                                ? 'text-emerald-700'
                                : v.status === 'On Trip'
                                ? 'text-blue-700'
                                : v.status === 'Maintenance'
                                ? 'text-amber-700'
                                : 'text-slate-500'
                            }`}
                          >
                            {v.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setInspectVehicle(v)}
                              aria-label={`Inspect ledger for ${v.registrationNumber}`}
                              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {permissions.canManageMasters && (
                              <button
                                type="button"
                                onClick={() => openEditDrawer(v)}
                                aria-label={`Edit ${v.registrationNumber}`}
                                className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                            )}
                            {permissions.canDeleteRecords && (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(v)}
                                aria-label={`Delete ${v.registrationNumber}`}
                                className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
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

            {/* Mobile Card List */}
            <div className="md:hidden divide-y divide-slate-200">
              {filteredVehicles.map((v) => {
                const fin = financialsByVehicle.get(v.id);
                const totalExp = (fin?.tripExpense || 0) + (fin?.maintenanceExpense || 0);
                const netProfit = fin?.netProfit || 0;
                return (
                  <div key={v.id} className="p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-sm font-semibold text-slate-900">
                          {v.registrationNumber}
                        </div>
                        <div className="text-xs text-slate-500">
                          {v.vehicleType} {v.makeModel ? `· ${v.makeModel}` : ''}{' '}
                          {v.capacityTons > 0 ? `· ${v.capacityTons} MT` : ''}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-semibold ${
                          v.status === 'Available'
                            ? 'text-emerald-700'
                            : v.status === 'On Trip'
                            ? 'text-blue-700'
                            : v.status === 'Maintenance'
                            ? 'text-amber-700'
                            : 'text-slate-500'
                        }`}
                      >
                        {v.status}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                      <span>Driver: {v.driverName || 'Unassigned'}</span>
                      {v.driverPhone && (
                        <span className="inline-flex items-center gap-1 font-mono">
                          <Phone className="w-3 h-3" />
                          {v.driverPhone}
                        </span>
                      )}
                      <span>Compliance: {renderComplianceFlag(v)}</span>
                    </div>

                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs tabular-nums">
                      <span className="text-slate-500">{fin?.tripCount || 0} trips</span>
                      <span className="font-mono font-medium text-slate-900">
                        Inc: {formatINR(fin?.freightIncome || 0, true)} · Exp: {formatINR(totalExp, true)} · Net:{' '}
                        <span className={netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                          {formatINR(netProfit, true)}
                        </span>
                      </span>
                    </div>

                    {(v.fitnessExpiry || v.insuranceExpiry || v.pucExpiry || v.taxExpiry || v.permitExpiry) && (
                      <div className="text-[11px] text-slate-500 tabular-nums">
                        Fit: {formatDateIN(v.fitnessExpiry)} · Ins: {formatDateIN(v.insuranceExpiry)} · PUC:{' '}
                        {formatDateIN(v.pucExpiry || '')} · Tax: {formatDateIN(v.taxExpiry || '')} · Permit:{' '}
                        {formatDateIN(v.permitExpiry)}
                      </div>
                    )}

                    <div className="pt-2 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setInspectVehicle(v)}
                        className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                      >
                        Ledger &amp; Trips
                      </button>
                      {permissions.canManageMasters && (
                        <button
                          type="button"
                          onClick={() => openEditDrawer(v)}
                          className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                        >
                          Edit
                        </button>
                      )}
                      {permissions.canDeleteRecords && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(v)}
                          className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg cursor-pointer"
                        >
                          Delete
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

      {/* Add / Edit Slide-Over Drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vehicle-drawer-title"
        >
          <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 id="vehicle-drawer-title" className="font-display text-lg font-semibold text-slate-900">
                {editingVehicle ? 'Edit Vehicle' : 'Add Fleet Vehicle'}
              </h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close form"
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-5 flex-1">
              {formError && (
                <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Registration Number *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={BLUEPRINT_LIMITS.VEHICLE_REG_MAX}
                    value={form.registrationNumber}
                    onChange={(e) =>
                      setForm({ ...form, registrationNumber: e.target.value.toUpperCase() })
                    }
                    placeholder="GJ-03-BW-4521"
                    className="w-full px-3 py-2.5 text-sm font-mono uppercase bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Vehicle Type *
                  </label>
                  <select
                    value={form.vehicleType}
                    onChange={(e) =>
                      setForm({ ...form, vehicleType: e.target.value as VehicleType })
                    }
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  >
                    {VEHICLE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Make &amp; Model
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.MAKE_MODEL_MAX}
                    value={form.makeModel}
                    onChange={(e) => setForm({ ...form, makeModel: e.target.value })}
                    placeholder="Tata Prima 5530.S"
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Capacity (Metric Tons)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max={BLUEPRINT_LIMITS.CAPACITY_MAX}
                    step="0.5"
                    value={form.capacityTons}
                    onChange={(e) => setForm({ ...form, capacityTons: e.target.value })}
                    placeholder="25"
                    className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Driver Name
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.DRIVER_NAME_MAX}
                    value={form.driverName}
                    onChange={(e) => setForm({ ...form, driverName: e.target.value })}
                    placeholder="Rameshbhai Patel"
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Driver Phone
                  </label>
                  <input
                    type="tel"
                    maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                    value={form.driverPhone}
                    onChange={(e) => setForm({ ...form, driverPhone: e.target.value })}
                    placeholder="+91 98250 00000"
                    className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-slate-200">
                <h3 className="text-xs font-semibold text-slate-700 mb-3">
                  Document Expiry Dates (Compliance Alerts)
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Fitness Expiry</label>
                    <input
                      type="date"
                      value={form.fitnessExpiry}
                      onChange={(e) => setForm({ ...form, fitnessExpiry: e.target.value })}
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Insurance Expiry</label>
                    <input
                      type="date"
                      value={form.insuranceExpiry}
                      onChange={(e) => setForm({ ...form, insuranceExpiry: e.target.value })}
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">PUC Expiry</label>
                    <input
                      type="date"
                      value={form.pucExpiry}
                      onChange={(e) => setForm({ ...form, pucExpiry: e.target.value })}
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Road Tax Expiry</label>
                    <input
                      type="date"
                      value={form.taxExpiry}
                      onChange={(e) => setForm({ ...form, taxExpiry: e.target.value })}
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-600 mb-1">Permit Expiry</label>
                    <input
                      type="date"
                      value={form.permitExpiry}
                      onChange={(e) => setForm({ ...form, permitExpiry: e.target.value })}
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Operational Status
                </label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as VehicleStatus })}
                  className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                >
                  {VEHICLE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Notes</label>
                <textarea
                  rows={3}
                  maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Chassis details, route restrictions, or maintenance remarks..."
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  disabled={saving}
                  className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Saving...' : editingVehicle ? 'Update Vehicle' : 'Save Vehicle'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Vehicle Ledger & History Drawer */}
      {inspectVehicle && inspectData && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vehicle-ledger-title"
        >
          <div className="w-full max-w-3xl bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <div>
                <h2 id="vehicle-ledger-title" className="font-mono text-lg font-semibold text-slate-900">
                  {inspectVehicle.registrationNumber}
                </h2>
                <p className="text-xs text-slate-500">
                  {inspectVehicle.vehicleType} {inspectVehicle.makeModel ? `· ${inspectVehicle.makeModel}` : ''} · Driver:{' '}
                  {inspectVehicle.driverName || 'Unassigned'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectVehicle(null)}
                aria-label="Close vehicle ledger"
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Income & Expense Summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Freight Income</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                    {formatINR(inspectData.summary.freightIncome)}
                  </div>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Trip Expenses</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                    {formatINR(inspectData.summary.tripExpense)}
                  </div>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Maintenance / Misc</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                    {formatINR(inspectData.summary.maintenanceExpense)}
                  </div>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Net Vehicle Profit</div>
                  <div
                    className={`mt-1 font-mono text-sm font-semibold tabular-nums ${
                      inspectData.summary.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                    }`}
                  >
                    {formatINR(inspectData.summary.netProfit)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-3 bg-white border border-slate-200 rounded-lg">
                  <span className="text-slate-500">Diesel Consumed:</span>{' '}
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {formatNumberIN(inspectData.summary.dieselQty)} L
                  </span>
                </div>
                <div className="p-3 bg-white border border-slate-200 rounded-lg">
                  <span className="text-slate-500">Driver Payments Logged:</span>{' '}
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {formatINR(inspectData.summary.driverPaid)}
                  </span>
                </div>
                <div className="p-3 bg-white border border-slate-200 rounded-lg">
                  <span className="text-slate-500">Active Trips:</span>{' '}
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {inspectData.summary.tripCount}
                  </span>
                </div>
              </div>

              {/* Compliance Documents Matrix */}
              <div>
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2.5">
                  Compliance Documents (Fitness / Insurance / PUC / Tax / Permit)
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  {inspectData.docs.map((d) => {
                    const days = getDaysUntilExpiry(d.date);
                    return (
                      <div key={d.label} className="p-3 border border-slate-200 rounded-lg bg-white">
                        <div className="text-[11px] font-medium text-slate-500">{d.label}</div>
                        <div className="mt-1 font-mono text-xs text-slate-900 tabular-nums">
                          {formatDateIN(d.date)}
                        </div>
                        <div className="mt-1 text-[11px] font-medium">
                          {days === null ? (
                            <span className="text-slate-400">Not set</span>
                          ) : days < 0 ? (
                            <span className="text-red-600">Expired {Math.abs(days)}d</span>
                          ) : days <= 30 ? (
                            <span className="text-amber-700">Due {days}d</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <CheckCircle2 className="w-3 h-3" /> Valid
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Vehicle-wise Trip History */}
              <div>
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2.5">
                  Vehicle Trip History ({inspectData.vTrips.length})
                </h3>
                {inspectData.vTrips.length === 0 ? (
                  <p className="text-xs text-slate-500 p-4 border border-slate-200 rounded-lg">
                    No trips recorded for this vehicle yet.
                  </p>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                          <th className="py-2 px-3 whitespace-nowrap">Date / LR</th>
                          <th className="py-2 px-3 whitespace-nowrap">Party &amp; Route</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Rate</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Expense</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Hisab</th>
                          <th className="py-2 px-3 whitespace-nowrap">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inspectData.vTrips.map((t) => (
                          <tr key={t.id}>
                            <td className="py-2 px-3 whitespace-nowrap">
                              <div className="font-mono text-slate-900">{formatDateIN(t.tripDate)}</div>
                              <div className="text-[11px] font-mono text-slate-500">{t.lrNumber}</div>
                            </td>
                            <td className="py-2 px-3">
                              <div className="font-medium text-slate-900 truncate max-w-[180px]">{t.partyName}</div>
                              <div className="text-[11px] text-slate-500 truncate max-w-[180px]">
                                {t.origin} → {t.destination}
                              </div>
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-900">
                              {formatINR(t.freightAmount)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700">
                              {formatINR(t.totalExpense)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-amber-700">
                              {formatINR(t.balanceAmount)}
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap">{t.tripStatus}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Vehicle Maintenance & Repair History */}
              <div>
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5" />
                  <span>Maintenance &amp; Operational Expenses ({inspectData.vMaint.length})</span>
                </h3>
                {inspectData.vMaint.length === 0 ? (
                  <p className="text-xs text-slate-500 p-4 border border-slate-200 rounded-lg">
                    No standalone maintenance or repair records logged for this vehicle.
                  </p>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                          <th className="py-2 px-3 whitespace-nowrap">Date</th>
                          <th className="py-2 px-3 whitespace-nowrap">Category &amp; Description</th>
                          <th className="py-2 px-3 whitespace-nowrap">Vendor / Bill</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Amount (INR)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inspectData.vMaint.map((m) => (
                          <tr key={m.id}>
                            <td className="py-2 px-3 font-mono whitespace-nowrap">
                              {formatDateIN(m.expenseDate)}
                            </td>
                            <td className="py-2 px-3">
                              <div className="font-medium text-slate-900">{m.category}</div>
                              <div className="text-[11px] text-slate-500">{m.description}</div>
                            </td>
                            <td className="py-2 px-3">
                              <div className="text-slate-800">{m.vendorName || '—'}</div>
                              {m.billNo && <div className="text-[11px] font-mono text-slate-500">#{m.billNo}</div>}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-medium tabular-nums text-slate-900">
                              {formatINR(m.amount)}
                            </td>
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
        open={Boolean(deleteTarget)}
        title="Delete Vehicle"
        description={`Remove vehicle ${deleteTarget?.registrationNumber || ''} from your fleet directory? Existing historical trips referencing this registration number will remain intact.`}
        confirmLabel="Delete Vehicle"
        destructive
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
