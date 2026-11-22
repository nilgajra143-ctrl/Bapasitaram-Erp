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
  Wrench,
  Pencil,
  Trash2,
  X,
  Download,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  EXPENSE_CATEGORIES,
  type CompanySettings,
  type DriverPayment,
  type ErpUserRole,
  type ExpenseCategory,
  type MaintenanceRecord,
  type Trip,
  type UserPermissions,
  type Vehicle,
} from '../types/erp';
import {
  clampNum,
  clampStr,
  exportSheetsToExcel,
  formatDateIN,
  formatINR,
  formatNumberIN,
  generateSafeDocId,
  getTodayISO,
} from '../utils/formatters';
import {
  calculateDieselAmount,
  resolveEffectiveDieselRate,
} from '../utils/erpHelpers';
import { recordAuditLog } from '../utils/auditLogger';
import { ConfirmDialog } from './ConfirmDialog';

interface ExpensesViewProps {
  userId: string;
  actorRole: ErpUserRole;
  permissions: UserPermissions;
  companySettings: CompanySettings | null;
  vehicles: Vehicle[];
  trips: Trip[];
  maintenanceRecords: MaintenanceRecord[];
  driverPayments: DriverPayment[];
  loading: boolean;
}

interface MaintenanceFormState {
  expenseDate: string;
  vehicleId: string;
  category: ExpenseCategory;
  vendorName: string;
  description: string;
  dieselQuantity: string;
  dieselRate: string;
  amount: string;
  billNo: string;
  odometerKm: string;
  notes: string;
}

export const ExpensesView: React.FC<ExpensesViewProps> = ({
  userId,
  actorRole,
  permissions,
  companySettings,
  vehicles,
  trips,
  maintenanceRecords,
  driverPayments,
  loading,
}) => {
  const effectiveDieselRate = resolveEffectiveDieselRate(
    companySettings?.defaultDieselRate,
    null
  );
  const [activeTab, setActiveTab] = useState<'maintenance' | 'vehicle-summary'>('maintenance');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | ExpenseCategory>('All');
  const [vehicleFilter, setVehicleFilter] = useState<string>('All');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<MaintenanceRecord | null>(null);
  const [form, setForm] = useState<MaintenanceFormState>({
    expenseDate: getTodayISO(),
    vehicleId: vehicles[0]?.id || '',
    category: 'Maintenance & Repair',
    vendorName: '',
    description: '',
    dieselQuantity: '0',
    dieselRate: String(effectiveDieselRate),
    amount: '',
    billNo: '',
    odometerKm: '0',
    notes: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MaintenanceRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Unified Totals across Trips + Maintenance + Driver Payments
  const expenseSummary = useMemo(() => {
    const activeTrips = trips.filter((t) => t.tripStatus !== 'Cancelled');
    const tripDieselQty = activeTrips.reduce((s, t) => s + (t.dieselQuantity ?? 0), 0);
    const tripDieselAmt = activeTrips.reduce((s, t) => s + t.dieselExpense, 0);
    const tripToll = activeTrips.reduce((s, t) => s + t.tollExpense, 0);
    const tripKharcha = activeTrips.reduce((s, t) => s + t.otherExpense, 0);
    const tripBhatta = activeTrips.reduce((s, t) => s + t.driverAllowance, 0);

    const maintDieselQty = maintenanceRecords
      .filter((m) => m.category === 'Diesel')
      .reduce((s, m) => s + m.dieselQuantity, 0);
    const maintTotal = maintenanceRecords.reduce((s, m) => s + m.amount, 0);

    const driverPaidTotal = driverPayments
      .filter((p) => p.paymentType === 'Salary Paid' || p.paymentType === 'Advance' || p.paymentType === 'Allowance')
      .reduce((s, p) => s + p.amount, 0);

    return {
      totalDieselQty: tripDieselQty + maintDieselQty,
      totalDieselAmt: tripDieselAmt + maintenanceRecords.filter((m) => m.category === 'Diesel').reduce((s, m) => s + m.amount, 0),
      totalToll: tripToll + maintenanceRecords.filter((m) => m.category === 'Toll').reduce((s, m) => s + m.amount, 0),
      totalKharcha: tripKharcha + tripBhatta,
      maintTotal,
      driverPaidTotal,
      grandTotal: tripDieselAmt + tripToll + tripKharcha + tripBhatta + maintTotal + driverPaidTotal,
    };
  }, [trips, maintenanceRecords, driverPayments]);

  // Vehicle-wise breakdown
  const vehicleBreakdown = useMemo(() => {
    const map = new Map<
      string,
      {
        vehicleNumber: string;
        dieselQty: number;
        dieselAmt: number;
        toll: number;
        kharcha: number;
        driverPaid: number;
        maintenance: number;
        total: number;
      }
    >();

    const ensure = (vId: string, vNo: string) => {
      let item = map.get(vId);
      if (!item) {
        item = {
          vehicleNumber: vNo,
          dieselQty: 0,
          dieselAmt: 0,
          toll: 0,
          kharcha: 0,
          driverPaid: 0,
          maintenance: 0,
          total: 0,
        };
        map.set(vId, item);
      }
      return item;
    };

    vehicles.forEach((v) => ensure(v.id, v.registrationNumber));

    trips
      .filter((t) => t.tripStatus !== 'Cancelled')
      .forEach((t) => {
        const curr = ensure(t.vehicleId, t.vehicleNumber);
        curr.dieselQty += t.dieselQuantity ?? 0;
        curr.dieselAmt += t.dieselExpense;
        curr.toll += t.tollExpense;
        curr.kharcha += t.otherExpense + t.driverAllowance;
      });

    maintenanceRecords.forEach((m) => {
      const curr = ensure(m.vehicleId, m.vehicleNumber);
      if (m.category === 'Diesel') {
        curr.dieselQty += m.dieselQuantity;
        curr.dieselAmt += m.amount;
      } else if (m.category === 'Toll') {
        curr.toll += m.amount;
      } else {
        curr.maintenance += m.amount;
      }
    });

    driverPayments.forEach((p) => {
      if (!p.vehicleId) return;
      if (p.paymentType === 'Salary Paid' || p.paymentType === 'Advance' || p.paymentType === 'Allowance') {
        const curr = ensure(p.vehicleId, p.vehicleNumber || p.vehicleId);
        curr.driverPaid += p.amount;
      }
    });

    return Array.from(map.values())
      .map((r) => ({
        ...r,
        total: r.dieselAmt + r.toll + r.kharcha + r.driverPaid + r.maintenance,
      }))
      .sort((a, b) => b.total - a.total);
  }, [vehicles, trips, maintenanceRecords, driverPayments]);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    return maintenanceRecords.filter((m) => {
      if (categoryFilter !== 'All' && m.category !== categoryFilter) return false;
      if (vehicleFilter !== 'All' && m.vehicleId !== vehicleFilter) return false;
      if (!q) return true;
      return (
        m.vehicleNumber.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.vendorName.toLowerCase().includes(q) ||
        m.billNo.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
      );
    });
  }, [maintenanceRecords, categoryFilter, vehicleFilter, search]);

  const openAddDrawer = () => {
    setEditingRecord(null);
    setForm({
      expenseDate: getTodayISO(),
      vehicleId: vehicles[0]?.id || '',
      category: 'Maintenance & Repair',
      vendorName: '',
      description: '',
      dieselQuantity: '0',
      dieselRate: String(effectiveDieselRate),
      amount: '',
      billNo: '',
      odometerKm: '0',
      notes: '',
    });
    setFormError(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (m: MaintenanceRecord) => {
    setEditingRecord(m);
    const inferredRate =
      m.category === 'Diesel' && m.dieselQuantity > 0 && m.amount > 0
        ? Math.round((m.amount / m.dieselQuantity) * 100) / 100
        : effectiveDieselRate;
    setForm({
      expenseDate: m.expenseDate,
      vehicleId: m.vehicleId,
      category: m.category,
      vendorName: m.vendorName,
      description: m.description,
      dieselQuantity: String(m.dieselQuantity || 0),
      dieselRate: String(inferredRate),
      amount: String(m.amount),
      billNo: m.billNo,
      odometerKm: String(m.odometerKm || 0),
      notes: m.notes,
    });
    setFormError(null);
    setDrawerOpen(true);
  };

  const handleDieselLitresChange = (rawQty: string) => {
    const qtyNum = clampNum(rawQty || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX);
    const rateNum = clampNum(form.dieselRate || String(effectiveDieselRate), 0, BLUEPRINT_LIMITS.DIESEL_RATE_MAX);
    const calcAmt = qtyNum > 0 ? String(calculateDieselAmount(qtyNum, rateNum)) : form.amount;
    setForm((prev) => ({
      ...prev,
      dieselQuantity: rawQty,
      amount: qtyNum > 0 ? calcAmt : prev.amount,
    }));
  };

  const handleDieselRateChange = (rawRate: string) => {
    if (!permissions.isAdmin) return;
    const rateNum = clampNum(rawRate || '0', 0, BLUEPRINT_LIMITS.DIESEL_RATE_MAX);
    const qtyNum = clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX);
    setForm((prev) => ({
      ...prev,
      dieselRate: rawRate,
      amount: qtyNum > 0 ? String(calculateDieselAmount(qtyNum, rateNum)) : prev.amount,
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const veh = vehicles.find((v) => v.id === form.vehicleId);
    if (!veh) {
      setFormError('Please select a registered vehicle.');
      return;
    }

    const description = clampStr(form.description, BLUEPRINT_LIMITS.DESCRIPTION_MAX);
    if (!description) {
      setFormError('Please provide an expense or repair description.');
      return;
    }

    const amount = clampNum(form.amount || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    if (amount <= 0) {
      setFormError('Expense amount must be greater than zero.');
      return;
    }

    const payload = {
      expenseDate: clampStr(form.expenseDate || getTodayISO(), BLUEPRINT_LIMITS.DATE_MAX),
      vehicleId: veh.id,
      vehicleNumber: veh.registrationNumber,
      category: form.category,
      vendorName: clampStr(form.vendorName, BLUEPRINT_LIMITS.VENDOR_MAX),
      description,
      dieselQuantity: clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX),
      amount,
      billNo: clampStr(form.billNo, BLUEPRINT_LIMITS.BILL_NO_MAX),
      odometerKm: clampNum(form.odometerKm || '0', 0, 10000000),
      notes: clampStr(form.notes, BLUEPRINT_LIMITS.NOTES_MAX),
    };

    setSaving(true);
    try {
      if (editingRecord) {
        await updateDoc(doc(db, 'maintenanceRecords', editingRecord.id), {
          expenseDate: payload.expenseDate,
          vehicleNumber: payload.vehicleNumber,
          category: payload.category,
          vendorName: payload.vendorName,
          description: payload.description,
          dieselQuantity: payload.dieselQuantity,
          amount: payload.amount,
          billNo: payload.billNo,
          odometerKm: payload.odometerKm,
          notes: payload.notes,
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: editingRecord.ownerId || userId,
          actorRole,
          action: 'UPDATE',
          module: 'Expenses & Maintenance',
          recordId: editingRecord.id,
          summary: `Updated ${payload.category} (${formatINR(amount)}) for ${payload.vehicleNumber}`,
        });
      } else {
        const newId = generateSafeDocId('mnt');
        await setDoc(doc(collection(db, 'maintenanceRecords'), newId), {
          ...payload,
          ownerId: userId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: userId,
          actorRole,
          action: 'CREATE',
          module: 'Expenses & Maintenance',
          recordId: newId,
          summary: `Logged ${payload.category} (${formatINR(amount)}) for ${payload.vehicleNumber}`,
        });
      }
      setDrawerOpen(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unable to save expense record.';
      setFormError(msg);
      console.error('Maintenance save error:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || !permissions.isAdmin || !permissions.canDeleteRecords) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, 'maintenanceRecords', deleteTarget.id));
      await recordAuditLog({
        ownerId: deleteTarget.ownerId || userId,
        actorRole,
        action: 'DELETE',
        module: 'Expenses & Maintenance',
        recordId: deleteTarget.id,
        summary: `Removed ${deleteTarget.category} (${formatINR(deleteTarget.amount)}) for ${deleteTarget.vehicleNumber}`,
      });
      setDeleteTarget(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `maintenanceRecords/${deleteTarget.id}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleExportExpenses = () => {
    exportSheetsToExcel(
      [
        {
          name: 'Maintenance & Expenses',
          rows: filteredRecords.map((m) => ({
            Date: m.expenseDate,
            'Vehicle No': m.vehicleNumber,
            Category: m.category,
            Description: m.description,
            Vendor: m.vendorName,
            'Bill No': m.billNo,
            'Diesel Qty (L)': m.dieselQuantity,
            'Amount (INR)': m.amount,
            'Odometer (Km)': m.odometerKm,
            Notes: m.notes,
          })),
        },
        {
          name: 'Vehicle Expense Summary',
          rows: vehicleBreakdown.map((v) => ({
            'Vehicle No': v.vehicleNumber,
            'Diesel Qty (L)': v.dieselQty,
            'Diesel Amount (INR)': v.dieselAmt,
            'Toll (INR)': v.toll,
            'Trip Kharcha & Bhatta (INR)': v.kharcha,
            'Driver Payments (INR)': v.driverPaid,
            'Maintenance & Other (INR)': v.maintenance,
            'Total Expense (INR)': v.total,
          })),
        },
      ],
      `bapasitaram-expenses-${getTodayISO()}.xlsx`
    );
  };

  return (
    <div className="space-y-5">
      {/* KPI Totals */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Total Diesel (Qty &amp; Amt)</div>
          <div className="mt-1.5 font-mono text-lg font-semibold text-slate-900 tabular-nums">
            {formatINR(expenseSummary.totalDieselAmt)}
          </div>
          <div className="mt-1 text-xs font-mono text-slate-500 tabular-nums">
            {formatNumberIN(expenseSummary.totalDieselQty)} Liters
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Total Toll &amp; Trip Kharcha</div>
          <div className="mt-1.5 font-mono text-lg font-semibold text-slate-900 tabular-nums">
            {formatINR(expenseSummary.totalToll + expenseSummary.totalKharcha)}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            Toll: {formatINR(expenseSummary.totalToll, true)} · Kharcha: {formatINR(expenseSummary.totalKharcha, true)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Maintenance &amp; Driver Pay</div>
          <div className="mt-1.5 font-mono text-lg font-semibold text-slate-900 tabular-nums">
            {formatINR(expenseSummary.maintTotal + expenseSummary.driverPaidTotal)}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            Maint: {formatINR(expenseSummary.maintTotal, true)} · Drivers: {formatINR(expenseSummary.driverPaidTotal, true)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Combined Fleet Expenses</div>
          <div className="mt-1.5 font-mono text-lg font-semibold text-slate-900 tabular-nums">
            {formatINR(expenseSummary.grandTotal)}
          </div>
          <div className="mt-1 text-xs text-slate-500">Trips + Maintenance + Driver Payments</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setActiveTab('maintenance')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                activeTab === 'maintenance' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Maintenance &amp; Direct Entries
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('vehicle-summary')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                activeTab === 'vehicle-summary' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Vehicle-Wise Expense Report
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {permissions.canExportData && (
            <button
              type="button"
              onClick={handleExportExpenses}
              className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium rounded-lg cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Export Excel</span>
            </button>
          )}
          {(permissions.canEditTrips || permissions.canManageMasters) && (
            <button
              type="button"
              onClick={openAddDrawer}
              disabled={vehicles.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              <span>Add Expense / Repair</span>
            </button>
          )}
        </div>
      </div>

      {activeTab === 'maintenance' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search description, vendor, bill..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg"
              />
            </div>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as 'All' | ExpenseCategory)}
              className="px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg"
            >
              <option value="All">All Categories</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={vehicleFilter}
              onChange={(e) => setVehicleFilter(e.target.value)}
              className="px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg"
            >
              <option value="All">All Vehicles</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.registrationNumber}
                </option>
              ))}
            </select>
          </div>

          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="p-10 sm:p-14 text-center">
              <Wrench className="w-9 h-9 text-slate-300 mx-auto" />
              <h3 className="mt-3 text-base font-semibold text-slate-900">
                No Standalone Maintenance or Expense Entries
              </h3>
              <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
                Log workshop repairs, tyres, spare parts, RTO tax, or off-trip diesel &amp; toll expenses linked directly to your vehicles.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Vehicle</th>
                    <th className="py-3 px-4">Category &amp; Description</th>
                    <th className="py-3 px-4">Vendor / Bill</th>
                    <th className="py-3 px-4 text-right">Diesel Qty (L)</th>
                    <th className="py-3 px-4 text-right">Amount (INR)</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredRecords.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono whitespace-nowrap">{formatDateIN(m.expenseDate)}</td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {m.vehicleNumber}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{m.category}</div>
                        <div className="text-slate-500">{m.description}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-800">{m.vendorName || '—'}</div>
                        {m.billNo && <div className="font-mono text-slate-500">#{m.billNo}</div>}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {m.dieselQuantity > 0 ? `${formatNumberIN(m.dieselQuantity)} L` : '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900">
                        {formatINR(m.amount)}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {(permissions.canEditTrips || permissions.canManageMasters) && (
                            <button
                              type="button"
                              onClick={() => openEditDrawer(m)}
                              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                              aria-label="Edit expense"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                          )}
                          {permissions.isAdmin && permissions.canDeleteRecords && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(m)}
                              className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                              aria-label="Delete expense"
                              title="Delete Expense (Admin Only)"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {vehicleBreakdown.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No vehicle expense records yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 font-semibold text-slate-500">
                    <th className="py-3 px-4">Vehicle No</th>
                    <th className="py-3 px-4 text-right">Diesel Qty (L)</th>
                    <th className="py-3 px-4 text-right">Diesel Amt</th>
                    <th className="py-3 px-4 text-right">Toll</th>
                    <th className="py-3 px-4 text-right">Trip Kharcha &amp; Bhatta</th>
                    <th className="py-3 px-4 text-right">Driver Pay</th>
                    <th className="py-3 px-4 text-right">Maintenance</th>
                    <th className="py-3 px-4 text-right">Total Expense</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vehicleBreakdown.map((v) => (
                    <tr key={v.vehicleNumber} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">{v.vehicleNumber}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatNumberIN(v.dieselQty)} L
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                        {formatINR(v.dieselAmt)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatINR(v.toll)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatINR(v.kharcha)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatINR(v.driverPaid)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatINR(v.maintenance)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900">
                        {formatINR(v.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Maintenance Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                {editingRecord ? 'Edit Expense / Maintenance' : 'Log Expense / Maintenance'}
              </h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4 flex-1">
              {formError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Vehicle *</label>
                  <select
                    required
                    disabled={Boolean(editingRecord)}
                    value={form.vehicleId}
                    onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white disabled:bg-slate-100"
                  >
                    <option value="">Select vehicle...</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.registrationNumber}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Date *</label>
                  <input
                    type="date"
                    required
                    value={form.expenseDate}
                    onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Category *</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value as ExpenseCategory })}
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {EXPENSE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
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
                    readOnly={form.category === 'Diesel' && clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX) > 0}
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    className={`w-full px-3 py-2.5 text-sm font-mono border border-slate-200 rounded-lg ${
                      form.category === 'Diesel' && clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX) > 0
                        ? 'bg-slate-100 text-slate-900 cursor-not-allowed'
                        : 'bg-white'
                    }`}
                  />
                </div>
              </div>

              {form.category === 'Diesel' && (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Diesel Quantity (Litres)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.dieselQuantity}
                        onChange={(e) => handleDieselLitresChange(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Diesel Rate (₹ / Litre)
                      </label>
                      <input
                        type="number"
                        min="0"
                        max={BLUEPRINT_LIMITS.DIESEL_RATE_MAX}
                        step="0.01"
                        readOnly={!permissions.isAdmin}
                        value={form.dieselRate}
                        onChange={(e) => handleDieselRateChange(e.target.value)}
                        className={`w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg ${
                          permissions.isAdmin ? 'bg-white' : 'bg-slate-100 text-slate-700 cursor-not-allowed'
                        }`}
                      />
                    </div>
                  </div>
                  <div className="text-[11px] font-mono text-slate-600">
                    {clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX) > 0
                      ? `Auto-Calculated: ${formatNumberIN(
                          clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX)
                        )} L × ₹${clampNum(
                          form.dieselRate || String(effectiveDieselRate),
                          0,
                          BLUEPRINT_LIMITS.DIESEL_RATE_MAX
                        ).toFixed(2)}/L = ${formatINR(
                          calculateDieselAmount(
                            clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX),
                            clampNum(
                              form.dieselRate || String(effectiveDieselRate),
                              0,
                              BLUEPRINT_LIMITS.DIESEL_RATE_MAX
                            )
                          )
                        )}`
                      : `Enter litres to auto-calculate at ₹${effectiveDieselRate.toFixed(2)}/L (kept separate from Amount).`}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Description *</label>
                <input
                  type="text"
                  required
                  maxLength={BLUEPRINT_LIMITS.DESCRIPTION_MAX}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Engine service, tyre replacement, pump fill..."
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Vendor / Garage</label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.VENDOR_MAX}
                    value={form.vendorName}
                    onChange={(e) => setForm({ ...form, vendorName: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Bill / Voucher No</label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.BILL_NO_MAX}
                    value={form.billNo}
                    onChange={(e) => setForm({ ...form, billNo: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Odometer (Km)</label>
                  <input
                    type="number"
                    min="0"
                    value={form.odometerKm}
                    onChange={(e) => setForm({ ...form, odometerKm: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Notes</label>
                <textarea
                  rows={2}
                  maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
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
                  disabled={saving}
                  className="px-5 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Saving...' : editingRecord ? 'Update Record' : 'Save Expense'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Maintenance Record"
        description={`Delete ${deleteTarget?.category || ''} expense of ${formatINR(deleteTarget?.amount || 0)}?`}
        confirmLabel="Delete Record"
        destructive
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
