import React, { useMemo, useRef, useState } from 'react';
import { Download, Printer, BarChart3, FileText } from 'lucide-react';
import type {
  Driver,
  DriverPayment,
  MaintenanceRecord,
  Party,
  Trip,
  UserPermissions,
  Vehicle,
} from '../types/erp';
import {
  exportSheetsToExcel,
  formatDateIN,
  formatINR,
  formatNumberIN,
  getTodayISO,
} from '../utils/formatters';
import {
  downloadElementAsA4Pdf,
  renderElementToA4Pdf,
  triggerPrintPreview,
  type RenderedA4PdfResult,
} from '../utils/pdfExport';
import { PdfPreviewModal } from './PdfPreviewModal';

interface ReportsViewProps {
  permissions: UserPermissions;
  vehicles: Vehicle[];
  parties: Party[];
  trips: Trip[];
  drivers: Driver[];
  driverPayments: DriverPayment[];
  maintenanceRecords: MaintenanceRecord[];
}

type ReportTab =
  | 'period'
  | 'vehicle-pnl'
  | 'party-outstanding'
  | 'driver-payments'
  | 'diesel-toll'
  | 'maintenance';

export const ReportsView: React.FC<ReportsViewProps> = ({
  permissions,
  vehicles,
  parties,
  trips,
  drivers,
  driverPayments,
  maintenanceRecords,
}) => {
  const [activeTab, setActiveTab] = useState<ReportTab>('period');
  const [granularity, setGranularity] = useState<'daily' | 'monthly' | 'yearly'>('monthly');
  const reportPrintRef = useRef<HTMLDivElement | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [renderedPdfPreview, setRenderedPdfPreview] = useState<RenderedA4PdfResult | null>(null);

  const reportTitles: Record<ReportTab, string> = {
    period: `Period Financial Summary (${granularity.charAt(0).toUpperCase() + granularity.slice(1)})`,
    'vehicle-pnl': 'Vehicle-wise Profit & Loss Report',
    'party-outstanding': 'Party Outstanding Balance Report',
    'driver-payments': 'Driver Salary & Advance Ledger Report',
    'diesel-toll': 'Diesel & Toll Expense Ledger',
    maintenance: 'Vehicle Maintenance & Repairs Report',
  };

  const handlePreviewReportPdf = async () => {
    if (!reportPrintRef.current) return;
    setPdfError(null);
    setPdfBusy(true);
    try {
      const rendered = await renderElementToA4Pdf(
        reportPrintRef.current,
        `Bapasitaram-${activeTab}-${getTodayISO()}.pdf`,
        'landscape'
      );
      setRenderedPdfPreview(rendered);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Unable to render PDF preview.');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleDownloadReportPdf = async () => {
    if (!reportPrintRef.current) return;
    setPdfError(null);
    setPdfBusy(true);
    try {
      await downloadElementAsA4Pdf(
        reportPrintRef.current,
        `Bapasitaram-${activeTab}-${getTodayISO()}.pdf`,
        'landscape'
      );
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Unable to generate PDF report.');
    } finally {
      setPdfBusy(false);
    }
  };

  const activeTrips = useMemo(
    () => trips.filter((t) => t.tripStatus !== 'Cancelled'),
    [trips]
  );

  // 1. Daily / Monthly / Yearly Summary
  const periodRows = useMemo(() => {
    const map = new Map<
      string,
      {
        period: string;
        trips: number;
        freight: number;
        received: number;
        outstanding: number;
        tripExpense: number;
        maintenance: number;
        netProfit: number;
      }
    >();

    const keyFor = (dateStr: string) => {
      if (!dateStr) return 'Unknown';
      if (granularity === 'daily') return dateStr.slice(0, 10);
      if (granularity === 'monthly') return dateStr.slice(0, 7);
      return dateStr.slice(0, 4);
    };

    activeTrips.forEach((t) => {
      const k = keyFor(t.tripDate);
      const curr = map.get(k) || {
        period: k,
        trips: 0,
        freight: 0,
        received: 0,
        outstanding: 0,
        tripExpense: 0,
        maintenance: 0,
        netProfit: 0,
      };
      curr.trips += 1;
      curr.freight += t.freightAmount;
      curr.received += t.advanceReceived;
      curr.outstanding += t.balanceAmount;
      curr.tripExpense += t.totalExpense;
      map.set(k, curr);
    });

    maintenanceRecords.forEach((m) => {
      const k = keyFor(m.expenseDate);
      const curr = map.get(k) || {
        period: k,
        trips: 0,
        freight: 0,
        received: 0,
        outstanding: 0,
        tripExpense: 0,
        maintenance: 0,
        netProfit: 0,
      };
      curr.maintenance += m.amount;
      map.set(k, curr);
    });

    return Array.from(map.values())
      .map((r) => ({ ...r, netProfit: r.freight - r.tripExpense - r.maintenance }))
      .sort((a, b) => b.period.localeCompare(a.period));
  }, [activeTrips, maintenanceRecords, granularity]);

  // 2. Vehicle-wise P&L
  const vehiclePnlRows = useMemo(() => {
    const map = new Map<
      string,
      {
        vehicleNumber: string;
        trips: number;
        income: number;
        dieselQty: number;
        dieselAmt: number;
        toll: number;
        kharcha: number;
        maintenance: number;
        netProfit: number;
      }
    >();

    vehicles.forEach((v) =>
      map.set(v.id, {
        vehicleNumber: v.registrationNumber,
        trips: 0,
        income: 0,
        dieselQty: 0,
        dieselAmt: 0,
        toll: 0,
        kharcha: 0,
        maintenance: 0,
        netProfit: 0,
      })
    );

    activeTrips.forEach((t) => {
      const curr = map.get(t.vehicleId) || {
        vehicleNumber: t.vehicleNumber,
        trips: 0,
        income: 0,
        dieselQty: 0,
        dieselAmt: 0,
        toll: 0,
        kharcha: 0,
        maintenance: 0,
        netProfit: 0,
      };
      curr.trips += 1;
      curr.income += t.freightAmount;
      curr.dieselQty += t.dieselQuantity ?? 0;
      curr.dieselAmt += t.dieselExpense;
      curr.toll += t.tollExpense;
      curr.kharcha += t.otherExpense + t.driverAllowance;
      map.set(t.vehicleId, curr);
    });

    maintenanceRecords.forEach((m) => {
      const curr = map.get(m.vehicleId) || {
        vehicleNumber: m.vehicleNumber,
        trips: 0,
        income: 0,
        dieselQty: 0,
        dieselAmt: 0,
        toll: 0,
        kharcha: 0,
        maintenance: 0,
        netProfit: 0,
      };
      curr.maintenance += m.amount;
      if (m.category === 'Diesel') curr.dieselQty += m.dieselQuantity;
      map.set(m.vehicleId, curr);
    });

    return Array.from(map.values())
      .map((r) => ({
        ...r,
        netProfit: r.income - (r.dieselAmt + r.toll + r.kharcha + r.maintenance),
      }))
      .sort((a, b) => b.netProfit - a.netProfit);
  }, [vehicles, activeTrips, maintenanceRecords]);

  // 3. Party Outstanding
  const partyRows = useMemo(() => {
    const map = new Map<
      string,
      { partyName: string; gstin: string; termsDays: number; trips: number; billed: number; received: number; outstanding: number }
    >();
    parties.forEach((p) =>
      map.set(p.id, {
        partyName: p.partyName,
        gstin: p.gstin,
        termsDays: p.paymentTermsDays,
        trips: 0,
        billed: 0,
        received: 0,
        outstanding: 0,
      })
    );
    activeTrips.forEach((t) => {
      const curr = map.get(t.partyId) || {
        partyName: t.partyName,
        gstin: '',
        termsDays: 0,
        trips: 0,
        billed: 0,
        received: 0,
        outstanding: 0,
      };
      curr.trips += 1;
      curr.billed += t.freightAmount;
      curr.received += t.advanceReceived;
      curr.outstanding += t.balanceAmount;
      map.set(t.partyId, curr);
    });
    return Array.from(map.values()).sort((a, b) => b.outstanding - a.outstanding);
  }, [parties, activeTrips]);

  // 4. Driver Payment Report
  const driverRows = useMemo(() => {
    return drivers.map((d) => {
      const list = driverPayments.filter((p) => p.driverId === d.id);
      const salaryDue = list.filter((p) => p.paymentType === 'Salary Due').reduce((s, p) => s + p.amount, 0);
      const allowances = list.filter((p) => p.paymentType === 'Allowance').reduce((s, p) => s + p.amount, 0);
      const salaryPaid = list.filter((p) => p.paymentType === 'Salary Paid').reduce((s, p) => s + p.amount, 0);
      const advances = list.filter((p) => p.paymentType === 'Advance').reduce((s, p) => s + p.amount, 0);
      const deductions = list.filter((p) => p.paymentType === 'Deduction').reduce((s, p) => s + p.amount, 0);
      const remaining = d.openingBalance + salaryDue + allowances - salaryPaid - advances - deductions;
      return {
        driverName: d.driverName,
        vehicle: d.assignedVehicleNumber || 'Unassigned',
        opening: d.openingBalance,
        salaryDue,
        allowances,
        salaryPaid,
        advances,
        deductions,
        remaining,
      };
    });
  }, [drivers, driverPayments]);

  // 5. Diesel & Toll Ledger Rows
  const dieselTollRows = useMemo(() => {
    const rows: {
      date: string;
      source: string;
      vehicleNumber: string;
      dieselQty: number;
      dieselAmt: number;
      toll: number;
      note: string;
    }[] = [];

    activeTrips.forEach((t) => {
      if ((t.dieselQuantity ?? 0) > 0 || t.dieselExpense > 0 || t.tollExpense > 0) {
        rows.push({
          date: t.tripDate,
          source: `Trip ${t.lrNumber}`,
          vehicleNumber: t.vehicleNumber,
          dieselQty: t.dieselQuantity ?? 0,
          dieselAmt: t.dieselExpense,
          toll: t.tollExpense,
          note: `${t.origin} → ${t.destination}`,
        });
      }
    });

    maintenanceRecords.forEach((m) => {
      if (m.category === 'Diesel' || m.category === 'Toll') {
        rows.push({
          date: m.expenseDate,
          source: m.category,
          vehicleNumber: m.vehicleNumber,
          dieselQty: m.category === 'Diesel' ? m.dieselQuantity : 0,
          dieselAmt: m.category === 'Diesel' ? m.amount : 0,
          toll: m.category === 'Toll' ? m.amount : 0,
          note: m.description,
        });
      }
    });

    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [activeTrips, maintenanceRecords]);

  const periodTotals = useMemo(
    () =>
      periodRows.reduce(
        (acc, r) => ({
          trips: acc.trips + r.trips,
          freight: acc.freight + r.freight,
          received: acc.received + r.received,
          outstanding: acc.outstanding + r.outstanding,
          tripExpense: acc.tripExpense + r.tripExpense,
          maintenance: acc.maintenance + r.maintenance,
          netProfit: acc.netProfit + r.netProfit,
        }),
        { trips: 0, freight: 0, received: 0, outstanding: 0, tripExpense: 0, maintenance: 0, netProfit: 0 }
      ),
    [periodRows]
  );

  const vehiclePnlTotals = useMemo(
    () =>
      vehiclePnlRows.reduce(
        (acc, r) => ({
          trips: acc.trips + r.trips,
          income: acc.income + r.income,
          dieselQty: acc.dieselQty + r.dieselQty,
          dieselAmt: acc.dieselAmt + r.dieselAmt,
          toll: acc.toll + r.toll,
          kharcha: acc.kharcha + r.kharcha,
          maintenance: acc.maintenance + r.maintenance,
          netProfit: acc.netProfit + r.netProfit,
        }),
        { trips: 0, income: 0, dieselQty: 0, dieselAmt: 0, toll: 0, kharcha: 0, maintenance: 0, netProfit: 0 }
      ),
    [vehiclePnlRows]
  );

  const partyTotals = useMemo(
    () =>
      partyRows.reduce(
        (acc, r) => ({
          trips: acc.trips + r.trips,
          billed: acc.billed + r.billed,
          received: acc.received + r.received,
          outstanding: acc.outstanding + r.outstanding,
        }),
        { trips: 0, billed: 0, received: 0, outstanding: 0 }
      ),
    [partyRows]
  );

  const dieselTollTotals = useMemo(
    () =>
      dieselTollRows.reduce(
        (acc, r) => ({
          dieselQty: acc.dieselQty + r.dieselQty,
          dieselAmt: acc.dieselAmt + r.dieselAmt,
          toll: acc.toll + r.toll,
        }),
        { dieselQty: 0, dieselAmt: 0, toll: 0 }
      ),
    [dieselTollRows]
  );

  const handleExportCurrentReport = () => {
    const sheets = [
      {
        name: `Period (${granularity})`,
        rows: periodRows.map((r) => ({
          Period: r.period,
          Trips: r.trips,
          'Freight (INR)': r.freight,
          'Received (INR)': r.received,
          'Outstanding (INR)': r.outstanding,
          'Trip Expense (INR)': r.tripExpense,
          'Maintenance (INR)': r.maintenance,
          'Net Profit (INR)': r.netProfit,
        })),
      },
      {
        name: 'Vehicle P&L',
        rows: vehiclePnlRows.map((r) => ({
          'Vehicle No': r.vehicleNumber,
          Trips: r.trips,
          'Income (INR)': r.income,
          'Diesel Qty (L)': r.dieselQty,
          'Diesel Amt (INR)': r.dieselAmt,
          'Toll (INR)': r.toll,
          'Kharcha & Bhatta (INR)': r.kharcha,
          'Maintenance (INR)': r.maintenance,
          'Net Profit (INR)': r.netProfit,
        })),
      },
      {
        name: 'Party Outstanding',
        rows: partyRows.map((r) => ({
          'Party Name': r.partyName,
          GSTIN: r.gstin,
          'Credit Terms (Days)': r.termsDays,
          Trips: r.trips,
          'Total Billed (INR)': r.billed,
          'Received (INR)': r.received,
          'Outstanding (INR)': r.outstanding,
        })),
      },
      {
        name: 'Driver Payments',
        rows: driverRows.map((r) => ({
          Driver: r.driverName,
          Vehicle: r.vehicle,
          'Opening (INR)': r.opening,
          'Salary Due (INR)': r.salaryDue,
          'Allowances (INR)': r.allowances,
          'Salary Paid (INR)': r.salaryPaid,
          'Advances (INR)': r.advances,
          'Deductions (INR)': r.deductions,
          'Remaining Payable (INR)': r.remaining,
        })),
      },
      {
        name: 'Diesel & Toll',
        rows: dieselTollRows.map((r) => ({
          Date: r.date,
          Source: r.source,
          'Vehicle No': r.vehicleNumber,
          'Diesel Qty (L)': r.dieselQty,
          'Diesel Amt (INR)': r.dieselAmt,
          'Toll (INR)': r.toll,
          Note: r.note,
        })),
      },
      {
        name: 'Maintenance',
        rows: maintenanceRecords.map((m) => ({
          Date: m.expenseDate,
          'Vehicle No': m.vehicleNumber,
          Category: m.category,
          Description: m.description,
          Vendor: m.vendorName,
          'Bill No': m.billNo,
          'Amount (INR)': m.amount,
        })),
      },
    ];
    exportSheetsToExcel(sheets, `bapasitaram-erp-reports-${getTodayISO()}.xlsx`);
  };

  return (
    <div className="space-y-5">
      {/* Header & Exports */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 no-print">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {(
            [
              { id: 'period', label: 'Daily / Monthly / Yearly' },
              { id: 'vehicle-pnl', label: 'Vehicle P&L' },
              { id: 'party-outstanding', label: 'Party Outstanding' },
              { id: 'driver-payments', label: 'Driver Payments' },
              { id: 'diesel-toll', label: 'Diesel & Toll' },
              { id: 'maintenance', label: 'Maintenance' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                activeTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={pdfBusy}
            onClick={handlePreviewReportPdf}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer disabled:opacity-60"
          >
            <FileText className="w-4 h-4" />
            <span>{pdfBusy ? 'Rendering...' : 'Preview A4 PDF'}</span>
          </button>
          <button
            type="button"
            disabled={pdfBusy}
            onClick={handleDownloadReportPdf}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer disabled:opacity-60"
          >
            <Download className="w-4 h-4" />
            <span>{pdfBusy ? 'Generating PDF...' : 'Download PDF'}</span>
          </button>
          <button
            type="button"
            onClick={() => triggerPrintPreview()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            <span>Print</span>
          </button>
          {permissions.canExportData && (
            <button
              type="button"
              onClick={handleExportCurrentReport}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Export All Reports (.xlsx)</span>
            </button>
          )}
        </div>
      </div>

      {pdfError && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 no-print">
          {pdfError}
        </div>
      )}

      {/* Report Content Card */}
      <div
        id="reports-a4-content"
        ref={reportPrintRef}
        className="bg-white border border-slate-200 rounded-xl overflow-hidden print-area-card"
      >
        <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-display text-sm font-bold text-slate-900">
              BAPASITARAM ENTERPRISE
            </div>
            <div className="text-xs font-medium text-slate-600">{reportTitles[activeTab]}</div>
          </div>
          <div className="text-right font-mono text-[11px] text-slate-500">
            Generated: {formatDateIN(getTodayISO())}
          </div>
        </div>
        {activeTab === 'period' && (
          <div>
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-slate-600" />
                <h3 className="text-sm font-semibold text-slate-900">Period Financial Summary</h3>
              </div>
              <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg no-print">
                {(['daily', 'monthly', 'yearly'] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGranularity(g)}
                    className={`px-2.5 py-1 text-xs font-medium rounded capitalize cursor-pointer ${
                      granularity === g ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            {periodRows.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">No trip or expense records yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                      <th className="py-3 px-4">Period</th>
                      <th className="py-3 px-4 text-right">Trips</th>
                      <th className="py-3 px-4 text-right">Freight (INR)</th>
                      <th className="py-3 px-4 text-right">Received (INR)</th>
                      <th className="py-3 px-4 text-right">Outstanding</th>
                      <th className="py-3 px-4 text-right">Trip Expense</th>
                      <th className="py-3 px-4 text-right">Maintenance</th>
                      <th className="py-3 px-4 text-right">Net Profit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {periodRows.map((r) => (
                      <tr key={r.period}>
                        <td className="py-3 px-4 font-mono font-semibold text-slate-900">{r.period}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">{r.trips}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.freight)}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700">{formatINR(r.received)}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-700">{formatINR(r.outstanding)}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.tripExpense)}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.maintenance)}</td>
                        <td className={`py-3 px-4 text-right font-mono font-semibold tabular-nums ${r.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {formatINR(r.netProfit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-semibold text-slate-900">
                    <tr>
                      <td className="py-3 px-4">Total</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{periodTotals.trips}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(periodTotals.freight)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700">{formatINR(periodTotals.received)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-700">{formatINR(periodTotals.outstanding)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(periodTotals.tripExpense)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(periodTotals.maintenance)}</td>
                      <td className={`py-3 px-4 text-right font-mono tabular-nums ${periodTotals.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {formatINR(periodTotals.netProfit)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'vehicle-pnl' && (
          <div className="overflow-x-auto">
            {vehiclePnlRows.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">No vehicle records yet.</div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-3 px-4">Vehicle No</th>
                    <th className="py-3 px-4 text-right">Trips</th>
                    <th className="py-3 px-4 text-right">Income</th>
                    <th className="py-3 px-4 text-right">Diesel Qty (L)</th>
                    <th className="py-3 px-4 text-right">Diesel Amt</th>
                    <th className="py-3 px-4 text-right">Toll</th>
                    <th className="py-3 px-4 text-right">Kharcha &amp; Bhatta</th>
                    <th className="py-3 px-4 text-right">Maintenance</th>
                    <th className="py-3 px-4 text-right">Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vehiclePnlRows.map((r) => (
                    <tr key={r.vehicleNumber}>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">{r.vehicleNumber}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{r.trips}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.income)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatNumberIN(r.dieselQty)} L</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.dieselAmt)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.toll)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.kharcha)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.maintenance)}</td>
                      <td className={`py-3 px-4 text-right font-mono font-semibold tabular-nums ${r.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {formatINR(r.netProfit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-semibold text-slate-900">
                  <tr>
                    <td className="py-3 px-4">Fleet Total</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{vehiclePnlTotals.trips}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(vehiclePnlTotals.income)}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatNumberIN(vehiclePnlTotals.dieselQty)} L</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(vehiclePnlTotals.dieselAmt)}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(vehiclePnlTotals.toll)}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(vehiclePnlTotals.kharcha)}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(vehiclePnlTotals.maintenance)}</td>
                    <td className={`py-3 px-4 text-right font-mono tabular-nums ${vehiclePnlTotals.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                      {formatINR(vehiclePnlTotals.netProfit)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}

        {activeTab === 'party-outstanding' && (
          <div className="overflow-x-auto">
            {partyRows.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">No party records yet.</div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-3 px-4">Party Name</th>
                    <th className="py-3 px-4">GSTIN</th>
                    <th className="py-3 px-4 text-right">Terms (Days)</th>
                    <th className="py-3 px-4 text-right">Trips</th>
                    <th className="py-3 px-4 text-right">Total Billed</th>
                    <th className="py-3 px-4 text-right">Received</th>
                    <th className="py-3 px-4 text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {partyRows.map((r) => (
                    <tr key={r.partyName}>
                      <td className="py-3 px-4 font-semibold text-slate-900">{r.partyName}</td>
                      <td className="py-3 px-4 font-mono text-slate-600">{r.gstin || '—'}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{r.termsDays}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{r.trips}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.billed)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700">{formatINR(r.received)}</td>
                      <td className={`py-3 px-4 text-right font-mono font-semibold tabular-nums ${r.outstanding > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                        {formatINR(r.outstanding)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-semibold text-slate-900">
                  <tr>
                    <td className="py-3 px-4" colSpan={3}>Total Party Accounts ({partyRows.length})</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{partyTotals.trips}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(partyTotals.billed)}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700">{formatINR(partyTotals.received)}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-700">{formatINR(partyTotals.outstanding)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}

        {activeTab === 'driver-payments' && (
          <div className="overflow-x-auto">
            {driverRows.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">No drivers registered yet.</div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-3 px-4">Driver</th>
                    <th className="py-3 px-4">Vehicle</th>
                    <th className="py-3 px-4 text-right">Opening</th>
                    <th className="py-3 px-4 text-right">Salary Due + Allow</th>
                    <th className="py-3 px-4 text-right">Paid + Advances</th>
                    <th className="py-3 px-4 text-right">Deductions</th>
                    <th className="py-3 px-4 text-right">Remaining Payable</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {driverRows.map((r) => (
                    <tr key={r.driverName}>
                      <td className="py-3 px-4 font-semibold text-slate-900">{r.driverName}</td>
                      <td className="py-3 px-4 font-mono text-slate-600">{r.vehicle}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.opening)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.salaryDue + r.allowances)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700">{formatINR(r.salaryPaid + r.advances)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.deductions)}</td>
                      <td className={`py-3 px-4 text-right font-mono font-semibold tabular-nums ${r.remaining > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                        {formatINR(r.remaining)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'diesel-toll' && (
          <div className="overflow-x-auto">
            {dieselTollRows.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">No diesel or toll entries recorded yet.</div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Source</th>
                    <th className="py-3 px-4">Vehicle</th>
                    <th className="py-3 px-4 text-right">Diesel Qty (L)</th>
                    <th className="py-3 px-4 text-right">Diesel Amt (INR)</th>
                    <th className="py-3 px-4 text-right">Toll (INR)</th>
                    <th className="py-3 px-4">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dieselTollRows.map((r, i) => (
                    <tr key={`${r.date}-${r.source}-${i}`}>
                      <td className="py-3 px-4 font-mono whitespace-nowrap">{formatDateIN(r.date)}</td>
                      <td className="py-3 px-4 font-mono text-slate-900">{r.source}</td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">{r.vehicleNumber}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatNumberIN(r.dieselQty)} L</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.dieselAmt)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(r.toll)}</td>
                      <td className="py-3 px-4 text-slate-600">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-semibold text-slate-900">
                  <tr>
                    <td className="py-3 px-4" colSpan={3}>Total Diesel &amp; Toll ({dieselTollRows.length} entries)</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatNumberIN(dieselTollTotals.dieselQty)} L</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(dieselTollTotals.dieselAmt)}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(dieselTollTotals.toll)}</td>
                    <td className="py-3 px-4" />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}

        {activeTab === 'maintenance' && (
          <div className="overflow-x-auto">
            {maintenanceRecords.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">No maintenance records logged yet.</div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Vehicle</th>
                    <th className="py-3 px-4">Category</th>
                    <th className="py-3 px-4">Description</th>
                    <th className="py-3 px-4">Vendor / Bill</th>
                    <th className="py-3 px-4 text-right">Amount (INR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {maintenanceRecords.map((m) => (
                    <tr key={m.id}>
                      <td className="py-3 px-4 font-mono whitespace-nowrap">{formatDateIN(m.expenseDate)}</td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">{m.vehicleNumber}</td>
                      <td className="py-3 px-4 font-medium text-slate-900">{m.category}</td>
                      <td className="py-3 px-4 text-slate-700">{m.description}</td>
                      <td className="py-3 px-4 text-slate-600">{m.vendorName || '—'} {m.billNo ? `· #${m.billNo}` : ''}</td>
                      <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums">{formatINR(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <PdfPreviewModal
        preview={renderedPdfPreview}
        title={reportTitles[activeTab]}
        onDownload={() => renderedPdfPreview?.pdf.save(renderedPdfPreview.fileName)}
        onPrint={() => triggerPrintPreview()}
        onClose={() => setRenderedPdfPreview(null)}
      />
    </div>
  );
};
