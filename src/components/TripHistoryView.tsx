import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deleteDoc, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  Search,
  Download,
  ClipboardList,
  PlusCircle,
  Eye,
  Pencil,
  Trash2,
  X,
  Printer,
  CheckCircle2,
  FileText,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  PAYMENT_STATUSES,
  TRIP_STATUSES,
  type PaymentStatus,
  type Trip,
  type TripStatus,
} from '../types/erp';
import {
  exportTripsToCSV,
  exportTripsToExcel,
  formatDateIN,
  formatINR,
  formatNumberIN,
} from '../utils/formatters';
import {
  downloadElementAsA4Pdf,
  renderElementToA4Pdf,
  triggerPrintPreview,
  type RenderedA4PdfResult,
} from '../utils/pdfExport';
import { recordAuditLog } from '../utils/auditLogger';
import type { UserPermissions } from '../types/erp';
import { ConfirmDialog } from './ConfirmDialog';
import { PdfPreviewModal } from './PdfPreviewModal';

interface TripHistoryViewProps {
  userId: string;
  permissions: UserPermissions;
  trips: Trip[];
  loading: boolean;
  onNewTrip: () => void;
  onEditTrip: (trip: Trip) => void;
}

export const TripHistoryView: React.FC<TripHistoryViewProps> = ({
  userId,
  permissions,
  trips,
  loading,
  onNewTrip,
  onEditTrip,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | TripStatus>('All');
  const [paymentFilter, setPaymentFilter] = useState<'All' | PaymentStatus>('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [inspectTrip, setInspectTrip] = useState<Trip | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Trip | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const lrPrintRef = useRef<HTMLDivElement | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [renderedPdfPreview, setRenderedPdfPreview] = useState<RenderedA4PdfResult | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('printing-modal-active', Boolean(inspectTrip));
    return () => {
      document.body.classList.remove('printing-modal-active');
    };
  }, [inspectTrip]);

  const handlePreviewLrPdf = async () => {
    if (!inspectTrip || !lrPrintRef.current) return;
    setPdfError(null);
    setPdfBusy(true);
    try {
      const rendered = await renderElementToA4Pdf(
        lrPrintRef.current,
        `LR-Voucher-${inspectTrip.lrNumber}-${inspectTrip.vehicleNumber}.pdf`,
        'portrait'
      );
      setRenderedPdfPreview(rendered);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Unable to render PDF preview.');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleDownloadLrPdf = async () => {
    if (!inspectTrip || !lrPrintRef.current) return;
    setPdfError(null);
    setPdfBusy(true);
    try {
      await downloadElementAsA4Pdf(
        lrPrintRef.current,
        `LR-Voucher-${inspectTrip.lrNumber}-${inspectTrip.vehicleNumber}.pdf`,
        'portrait'
      );
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Unable to generate PDF voucher.');
    } finally {
      setPdfBusy(false);
    }
  };

  const filteredTrips = useMemo(() => {
    const q = search.trim().toLowerCase();
    return trips.filter((t) => {
      if (statusFilter !== 'All' && t.tripStatus !== statusFilter) return false;
      if (paymentFilter !== 'All' && t.paymentStatus !== paymentFilter) return false;
      if (dateFrom && t.tripDate < dateFrom) return false;
      if (dateTo && t.tripDate > dateTo) return false;
      if (!q) return true;
      return (
        (t.srNo || '').toLowerCase().includes(q) ||
        t.lrNumber.toLowerCase().includes(q) ||
        (t.containerNo || '').toLowerCase().includes(q) ||
        t.vehicleNumber.toLowerCase().includes(q) ||
        t.partyName.toLowerCase().includes(q) ||
        t.origin.toLowerCase().includes(q) ||
        t.destination.toLowerCase().includes(q) ||
        t.driverName.toLowerCase().includes(q) ||
        t.material.toLowerCase().includes(q) ||
        t.notes.toLowerCase().includes(q)
      );
    });
  }, [trips, search, statusFilter, paymentFilter, dateFrom, dateTo]);

  const totals = useMemo(() => {
    const active = filteredTrips.filter((t) => t.tripStatus !== 'Cancelled');
    return {
      count: filteredTrips.length,
      freight: active.reduce((s, t) => s + t.freightAmount, 0),
      advance: active.reduce((s, t) => s + t.advanceReceived, 0),
      balance: active.reduce((s, t) => s + t.balanceAmount, 0),
      expenses: active.reduce((s, t) => s + t.totalExpense, 0),
      dieselQty: active.reduce((s, t) => s + (t.dieselQuantity ?? 0), 0),
    };
  }, [filteredTrips]);

  const handleMarkSettledAndPaid = async (trip: Trip) => {
    setUpdatingId(trip.id);
    try {
      await updateDoc(doc(db, 'trips', trip.id), {
        advanceReceived: trip.freightAmount,
        balanceAmount: 0,
        paymentStatus: 'Paid',
        tripStatus: 'Settled',
        podReceived: true,
        updatedAt: serverTimestamp(),
      });
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: 'UPDATE',
        module: 'Trips',
        recordId: trip.id,
        summary: `Settled trip LR ${trip.lrNumber} (${formatINR(trip.freightAmount)})`,
      });
      if (inspectTrip?.id === trip.id) {
        setInspectTrip({
          ...trip,
          advanceReceived: trip.freightAmount,
          balanceAmount: 0,
          paymentStatus: 'Paid',
          tripStatus: 'Settled',
          podReceived: true,
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `trips/${trip.id}`);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, 'trips', deleteTarget.id));
      await recordAuditLog({
        ownerId: userId,
        actorRole: permissions.role,
        action: 'DELETE',
        module: 'Trips',
        recordId: deleteTarget.id,
        summary: `Deleted trip LR ${deleteTarget.lrNumber} (${deleteTarget.vehicleNumber})`,
      });
      if (inspectTrip?.id === deleteTarget.id) setInspectTrip(null);
      setDeleteTarget(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `trips/${deleteTarget.id}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Filter & Export Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 no-print">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search LR No, vehicle, party, origin, destination..."
              className="w-full pl-9 pr-3 py-2 min-h-[40px] text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <span>From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="px-2.5 py-1.5 font-mono text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
              <span>To</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="px-2.5 py-1.5 font-mono text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            {permissions.canExportData && (
              <>
                <button
                  type="button"
                  onClick={() => exportTripsToExcel(filteredTrips)}
                  disabled={filteredTrips.length === 0}
                  className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Download className="w-4 h-4" />
                  <span>Export Excel</span>
                </button>
                <button
                  type="button"
                  onClick={() => exportTripsToCSV(filteredTrips)}
                  disabled={filteredTrips.length === 0}
                  className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Download className="w-4 h-4" />
                  <span>CSV</span>
                </button>
              </>
            )}

            {permissions.canEditTrips && (
              <button
                type="button"
                onClick={onNewTrip}
                className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <PlusCircle className="w-4 h-4" />
                <span>New Trip</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
            {(['All', ...TRIP_STATUSES] as const).map((status) => (
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

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto self-start sm:self-auto">
            {(['All', ...PAYMENT_STATUSES] as const).map((ps) => (
              <button
                key={ps}
                type="button"
                onClick={() => setPaymentFilter(ps)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  paymentFilter === ps
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {ps === 'All' ? 'All Payments' : ps}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Filtered INR Totals Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 no-print">
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
          <div className="text-[11px] font-medium text-slate-500">Trips Shown</div>
          <div className="mt-1 font-mono text-base font-semibold text-slate-900 tabular-nums">
            {totals.count}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
          <div className="text-[11px] font-medium text-slate-500">Freight Billed</div>
          <div className="mt-1 font-mono text-base font-semibold text-slate-900 tabular-nums">
            {formatINR(totals.freight)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
          <div className="text-[11px] font-medium text-slate-500">Advance Received</div>
          <div className="mt-1 font-mono text-base font-semibold text-slate-900 tabular-nums">
            {formatINR(totals.advance)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
          <div className="text-[11px] font-medium text-slate-500">Balance Receivable</div>
          <div className="mt-1 font-mono text-base font-semibold text-amber-700 tabular-nums">
            {formatINR(totals.balance)}
          </div>
        </div>
        <div className="col-span-2 lg:col-span-1 bg-white border border-slate-200 rounded-xl px-4 py-3">
          <div className="text-[11px] font-medium text-slate-500">Trip Expenses</div>
          <div className="mt-1 font-mono text-base font-semibold text-slate-900 tabular-nums">
            {formatINR(totals.expenses)}
          </div>
        </div>
      </div>

      {/* Trip Ledger Table / Mobile Cards */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden no-print">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : trips.length === 0 ? (
          <div className="p-10 sm:p-14 text-center">
            <ClipboardList className="w-9 h-9 text-slate-300 mx-auto" />
            <h3 className="mt-3 text-base font-semibold text-slate-900">
              No Trip History Found
            </h3>
            <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
              Recorded dispatches, Lorry Receipt numbers, INR freight amounts, and expense breakdowns will appear in this ledger.
            </p>
            <button
              type="button"
              onClick={onNewTrip}
              className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              <PlusCircle className="w-4 h-4" />
              <span>Record First Trip</span>
            </button>
          </div>
        ) : filteredTrips.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No trips match the active search or date/status filters.
          </div>
        ) : (
          <>
            {/* Desktop Table (Aligned with Excel Columns) */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500">
                    <th className="py-3 px-3 whitespace-nowrap">Sr / Date</th>
                    <th className="py-3 px-3 whitespace-nowrap">Vehicle &amp; Container</th>
                    <th className="py-3 px-3 whitespace-nowrap">Party &amp; Route (From → To)</th>
                    <th className="py-3 px-3 whitespace-nowrap text-right">Rate (₹)</th>
                    <th className="py-3 px-3 whitespace-nowrap text-right">Diesel Qty / Amt</th>
                    <th className="py-3 px-3 whitespace-nowrap text-right">Toll / Kharcha</th>
                    <th className="py-3 px-3 whitespace-nowrap text-right">Jama / Hisab</th>
                    <th className="py-3 px-3 whitespace-nowrap">Status</th>
                    <th className="py-3 px-3 whitespace-nowrap text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredTrips.map((t, idx) => (
                    <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-3 whitespace-nowrap">
                        <div className="font-mono text-xs font-semibold text-slate-900">
                          #{t.srNo || idx + 1} · {t.lrNumber}
                        </div>
                        <div className="text-[11px] text-slate-500 tabular-nums">
                          {formatDateIN(t.tripDate)}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-mono text-xs font-medium text-slate-900">
                          {t.vehicleNumber}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 truncate max-w-[150px]">
                          {t.containerNo || t.driverName || '—'}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="text-xs font-medium text-slate-900 truncate max-w-[200px]">
                          {t.partyName}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate max-w-[220px]">
                          {t.origin} → {t.destination}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                        {formatINR(t.freightAmount)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        <div className="text-slate-800">{formatNumberIN(t.dieselQuantity ?? 0)} L</div>
                        <div className="text-[11px] text-slate-500">{formatINR(t.dieselExpense)}</div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        <div className="text-slate-700">Toll: {formatINR(t.tollExpense, true)}</div>
                        <div className="text-[11px] text-slate-500">Kharcha: {formatINR(t.otherExpense + t.driverAllowance, true)}</div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        <div className="text-slate-700">Jama: {formatINR(t.advanceReceived, true)}</div>
                        <div
                          className={
                            t.balanceAmount > 0 ? 'text-amber-700 font-semibold' : 'text-emerald-700 font-semibold'
                          }
                        >
                          Hisab: {formatINR(t.balanceAmount, true)}
                        </div>
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap text-xs">
                        <div
                          className={`font-medium ${
                            t.tripStatus === 'Settled'
                              ? 'text-emerald-700'
                              : t.tripStatus === 'In Transit'
                              ? 'text-blue-700'
                              : t.tripStatus === 'Cancelled'
                              ? 'text-red-600'
                              : 'text-slate-800'
                          }`}
                        >
                          {t.tripStatus}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {t.paymentStatus} · {t.podReceived ? 'POD Yes' : 'POD Pending'}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setInspectTrip(t)}
                            aria-label={`View LR ${t.lrNumber}`}
                            title="View LR Statement"
                            className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {permissions.canEditTrips && (
                            <button
                              type="button"
                              onClick={() => onEditTrip(t)}
                              aria-label={`Edit LR ${t.lrNumber}`}
                              title="Edit Trip"
                              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                          )}
                          {permissions.canDeleteRecords && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(t)}
                              aria-label={`Delete LR ${t.lrNumber}`}
                              title="Delete Trip"
                              className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
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

            {/* Mobile / Tablet Card List */}
            <div className="lg:hidden divide-y divide-slate-200">
              {filteredTrips.map((t) => (
                <div key={t.id} className="p-4 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono text-sm font-semibold text-slate-900">
                        {t.lrNumber} · {t.vehicleNumber}
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatDateIN(t.tripDate)} · {t.partyName}
                      </div>
                    </div>
                    <span
                      className={`text-xs font-semibold shrink-0 ${
                        t.tripStatus === 'Settled'
                          ? 'text-emerald-700'
                          : t.tripStatus === 'In Transit'
                          ? 'text-blue-700'
                          : t.tripStatus === 'Cancelled'
                          ? 'text-red-600'
                          : 'text-slate-700'
                      }`}
                    >
                      {t.tripStatus}
                    </span>
                  </div>

                  <div className="text-xs text-slate-700">
                    {t.origin} → {t.destination}
                    {t.material ? ` · ${t.material}` : ''}
                    {t.weightTons > 0 ? ` (${t.weightTons} MT)` : ''}
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
                    <span className="font-mono font-semibold text-slate-900">
                      Freight: {formatINR(t.freightAmount)}
                    </span>
                    <span className="font-mono text-amber-700">
                      Bal: {formatINR(t.balanceAmount)} ({t.paymentStatus})
                    </span>
                  </div>

                  <div className="pt-1 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setInspectTrip(t)}
                      className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                    >
                      Statement
                    </button>
                    {permissions.canEditTrips && (
                      <button
                        type="button"
                        onClick={() => onEditTrip(t)}
                        className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                      >
                        Edit
                      </button>
                    )}
                    {permissions.canDeleteRecords && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(t)}
                        className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg cursor-pointer"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* LR / Trip Statement Modal */}
      {inspectTrip && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 print-modal-root"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lr-statement-title"
        >
          <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col print-modal-sheet">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between no-print">
              <h2 id="lr-statement-title" className="font-display text-lg font-semibold text-slate-900">
                Trip &amp; LR Statement — {inspectTrip.lrNumber}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setPdfError(null);
                  setInspectTrip(null);
                }}
                aria-label="Close statement"
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {pdfError && (
              <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 no-print">
                {pdfError}
              </div>
            )}

            <div id="lr-voucher-a4-content" ref={lrPrintRef} className="p-6 overflow-y-auto space-y-6 text-sm bg-white">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <div className="font-display text-lg font-bold text-slate-900">
                    BAPASITARAM ENTERPRISE
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Lorry Receipt &amp; Trip Settlement Voucher
                  </div>
                </div>
                <div className="sm:text-right font-mono text-xs space-y-1">
                  <div className="font-semibold text-slate-900">LR No: {inspectTrip.lrNumber}</div>
                  <div className="text-slate-600">Date: {formatDateIN(inspectTrip.tripDate)}</div>
                  <div className="text-slate-600">Status: {inspectTrip.tripStatus}</div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                  <div className="text-slate-500 font-medium">Party Account</div>
                  <div className="text-sm font-semibold text-slate-900">
                    {inspectTrip.partyName}
                  </div>
                  <div className="text-slate-600">
                    Route: {inspectTrip.origin} → {inspectTrip.destination}
                  </div>
                  <div className="text-slate-600">
                    Cargo: {inspectTrip.material || 'General Goods'}{' '}
                    {inspectTrip.weightTons > 0 ? `(${inspectTrip.weightTons} MT)` : ''}
                  </div>
                </div>

                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                  <div className="text-slate-500 font-medium">Vehicle &amp; Driver</div>
                  <div className="font-mono text-sm font-semibold text-slate-900">
                    {inspectTrip.vehicleNumber}
                  </div>
                  <div className="text-slate-600">
                    Container No: {inspectTrip.containerNo || '—'} · Driver: {inspectTrip.driverName || '—'}
                  </div>
                  <div className="text-slate-600">
                    POD Status: {inspectTrip.podReceived ? 'Received' : 'Pending'}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-xs font-semibold text-slate-700 mb-2">
                    Freight Settlement (INR)
                  </h4>
                  <dl className="space-y-2 text-xs border-t border-slate-200 pt-2">
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Rate / Total Freight</dt>
                      <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                        {formatINR(inspectTrip.freightAmount)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Jama (Advance Received)</dt>
                      <dd className="font-mono text-slate-800 tabular-nums">
                        {formatINR(inspectTrip.advanceReceived)}
                      </dd>
                    </div>
                    <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold">
                      <dt className="text-slate-800">Hisab (Balance)</dt>
                      <dd className="font-mono text-slate-900 tabular-nums">
                        {formatINR(inspectTrip.balanceAmount)}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-slate-700 mb-2">
                    Operating Expenses (INR &amp; Fuel Liters)
                  </h4>
                  <dl className="space-y-2 text-xs border-t border-slate-200 pt-2">
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Diesel Quantity</dt>
                      <dd className="font-mono text-slate-800 tabular-nums">
                        {formatNumberIN(inspectTrip.dieselQuantity ?? 0)} L
                        {typeof inspectTrip.dieselRate === 'number' && inspectTrip.dieselRate > 0
                          ? ` @ ₹${formatNumberIN(inspectTrip.dieselRate)}/L`
                          : ''}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Diesel Amount</dt>
                      <dd className="font-mono text-slate-800 tabular-nums">
                        {formatINR(inspectTrip.dieselExpense)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Toll</dt>
                      <dd className="font-mono text-slate-800 tabular-nums">
                        {formatINR(inspectTrip.tollExpense)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Driver Allowance</dt>
                      <dd className="font-mono text-slate-800 tabular-nums">
                        {formatINR(inspectTrip.driverAllowance)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Kharcha / Other Expense</dt>
                      <dd className="font-mono text-slate-800 tabular-nums">
                        {formatINR(inspectTrip.otherExpense)}
                      </dd>
                    </div>
                    <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold">
                      <dt className="text-slate-800">Total Expense</dt>
                      <dd className="font-mono text-slate-900 tabular-nums">
                        {formatINR(inspectTrip.totalExpense)}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              {inspectTrip.notes && (
                <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <span className="font-semibold text-slate-800">Remarks: </span>
                  {inspectTrip.notes}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 no-print">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handlePreviewLrPdf}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Rendering...' : 'Preview A4 PDF'}</span>
                </button>
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handleDownloadLrPdf}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Generating PDF...' : 'Download PDF'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => triggerPrintPreview()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Voucher</span>
                </button>
                {permissions.canEditTrips && (
                  <button
                    type="button"
                    onClick={() => {
                      const t = inspectTrip;
                      setInspectTrip(null);
                      onEditTrip(t);
                    }}
                    className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
                  >
                    Edit Trip
                  </button>
                )}
              </div>

              {permissions.canEditTrips &&
                inspectTrip.tripStatus !== 'Settled' &&
                inspectTrip.tripStatus !== 'Cancelled' && (
                  <button
                    type="button"
                    disabled={updatingId === inspectTrip.id}
                    onClick={() => handleMarkSettledAndPaid(inspectTrip)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-60"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      {updatingId === inspectTrip.id
                        ? 'Settling...'
                        : 'Mark Settled & Paid'}
                    </span>
                  </button>
                )}
            </div>
          </div>
        </div>
      )}

      <PdfPreviewModal
        preview={renderedPdfPreview}
        title={inspectTrip ? `LR Statement — ${inspectTrip.lrNumber}` : 'LR Statement A4 PDF'}
        onDownload={() => renderedPdfPreview?.pdf.save(renderedPdfPreview.fileName)}
        onPrint={() => triggerPrintPreview()}
        onClose={() => setRenderedPdfPreview(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Trip Record"
        description={`Permanently delete trip LR ${deleteTarget?.lrNumber || ''} (${formatINR(
          deleteTarget?.freightAmount || 0
        )})? This action cannot be undone.`}
        confirmLabel="Delete Trip"
        destructive
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
