import React from 'react';
import type { Bill, CompanySettings } from '../types/erp';
import { formatDateIN, formatINR } from '../utils/formatters';
import {
  BILL_HEADER_COMPANY_NAME,
  BILL_HEADER_CONTACT_LEFT,
  BILL_HEADER_CONTACT_RIGHT,
  BILL_HEADER_DEVOTIONAL_LINE,
  BILL_HEADER_LEFT_TRUCK_REG,
  BILL_HEADER_RIGHT_TRUCK_REG,
  resolveVerifiedBillBankDetails,
  resolveVerifiedCompanyAddress,
} from '../utils/billHeaderHelpers';

interface BillFormatBDocumentProps {
  bill: Bill;
  companySettings: CompanySettings | null;
  companyNameOverride?: string;
  addressOverride?: string;
  gstinOverride?: string;
  panOverride?: string;
  termsOverride?: string;
}

export const BillFormatBDocument: React.FC<BillFormatBDocumentProps> = ({
  bill,
  companySettings,
  companyNameOverride,
  addressOverride,
  gstinOverride,
  panOverride,
  termsOverride,
}) => {
  const companyName = (
    companyNameOverride ||
    companySettings?.companyName ||
    BILL_HEADER_COMPANY_NAME
  ).trim();
  const verifiedAddress = resolveVerifiedCompanyAddress(companySettings, addressOverride);
  const gstin = (gstinOverride ?? companySettings?.gstin ?? '').trim();
  const pan = (panOverride ?? companySettings?.pan ?? '').trim();
  const terms = (termsOverride ?? companySettings?.terms ?? '').trim();
  const verifiedBankDetails = resolveVerifiedBillBankDetails(bill, companySettings);

  const logoDataUrl = companySettings?.logoDataUrl || '';
  const leftTruckDataUrl = companySettings?.billHeaderLeftTruckDataUrl || '';
  const rightTruckDataUrl = companySettings?.billHeaderRightTruckDataUrl || '';

  const hisabAdjustment =
    Math.round((bill.netPayable - (bill.freightTotal - bill.advanceTotal)) * 100) / 100;

  return (
    <div className="p-6 sm:p-7 space-y-5 text-slate-900 bg-white">
      {/* Approved BAPASITARAM ENTERPRISE Royal Blue, White & Red Bill Header (Format B) */}
      <header className="border-2 border-blue-900 rounded-lg overflow-hidden bg-white">
        {/* Top Royal Blue Devotional & Contact Bar */}
        <div className="bg-blue-900 text-white px-4 py-2 grid grid-cols-12 items-center gap-2">
          <div className="col-span-3 font-mono text-[11px] sm:text-xs font-semibold tracking-wide text-left whitespace-nowrap">
            Mo: {BILL_HEADER_CONTACT_LEFT}
          </div>
          <div className="col-span-6 text-center text-xs sm:text-sm font-bold tracking-wide leading-tight">
            {BILL_HEADER_DEVOTIONAL_LINE}
          </div>
          <div className="col-span-3 font-mono text-[11px] sm:text-xs font-semibold tracking-wide text-right whitespace-nowrap">
            Mo: {BILL_HEADER_CONTACT_RIGHT}
          </div>
        </div>

        {/* Crisp Red Brand Accent Stripe */}
        <div className="h-1 bg-red-600 w-full" />

        {/* 3-Column Truck + Center Brand Header (A4 Portrait Fit — Zero Stretching or Cutting) */}
        <div className="px-3 sm:px-4 py-3.5 grid grid-cols-12 items-center gap-3 bg-white">
          {/* Left Vehicle: GJ12 BV6552 */}
          <div className="col-span-3 flex flex-col items-center justify-center">
            <div className="w-full h-24 rounded-md border border-blue-200 bg-slate-50 flex items-center justify-center overflow-hidden p-1">
              {leftTruckDataUrl ? (
                <img
                  src={leftTruckDataUrl}
                  alt={`Bapasitaram Enterprise Truck ${BILL_HEADER_LEFT_TRUCK_REG}`}
                  className="max-w-full max-h-full w-auto h-auto object-contain block"
                />
              ) : (
                <div className="text-center px-1.5 py-1">
                  <div className="font-mono text-[10px] font-bold text-blue-900">
                    {BILL_HEADER_LEFT_TRUCK_REG}
                  </div>
                  <div className="text-[9px] text-slate-500 leading-tight mt-0.5">
                    Upload real truck photo in Admin Settings
                  </div>
                </div>
              )}
            </div>
            <div className="mt-1 px-2 py-0.5 rounded bg-blue-900 text-white font-mono text-[10px] font-bold tracking-wider">
              {BILL_HEADER_LEFT_TRUCK_REG}
            </div>
          </div>

          {/* Center Company Logo, Name & Verified Admin Address */}
          <div className="col-span-6 text-center space-y-1 px-1">
            {logoDataUrl && (
              <div className="flex justify-center pb-0.5">
                <img
                  src={logoDataUrl}
                  alt={`${companyName} Logo`}
                  className="max-h-12 max-w-[140px] w-auto h-auto object-contain block"
                />
              </div>
            )}
            <h1 className="font-display text-lg sm:text-xl font-extrabold tracking-tight text-blue-900 uppercase leading-tight">
              {companyName}
            </h1>
            <div className="flex items-center justify-center gap-2">
              <span className="h-0.5 w-8 bg-red-600 rounded-full" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-red-600">
                RELIABLE TRANSPORT • TRUSTED SERVICE
              </span>
              <span className="h-0.5 w-8 bg-red-600 rounded-full" />
            </div>

            {verifiedAddress && (
              <p className="text-[11px] text-slate-700 leading-snug pt-0.5">
                {verifiedAddress}
              </p>
            )}

            {(gstin || pan) && (
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 font-mono text-[10px] font-semibold text-blue-950 pt-0.5">
                {gstin && <span>GSTIN: {gstin}</span>}
                {pan && <span>PAN: {pan}</span>}
              </div>
            )}
          </div>

          {/* Right Vehicle: GJ12 CT4312 */}
          <div className="col-span-3 flex flex-col items-center justify-center">
            <div className="w-full h-24 rounded-md border border-blue-200 bg-slate-50 flex items-center justify-center overflow-hidden p-1">
              {rightTruckDataUrl ? (
                <img
                  src={rightTruckDataUrl}
                  alt={`Bapasitaram Enterprise Truck ${BILL_HEADER_RIGHT_TRUCK_REG}`}
                  className="max-w-full max-h-full w-auto h-auto object-contain block"
                />
              ) : (
                <div className="text-center px-1.5 py-1">
                  <div className="font-mono text-[10px] font-bold text-blue-900">
                    {BILL_HEADER_RIGHT_TRUCK_REG}
                  </div>
                  <div className="text-[9px] text-slate-500 leading-tight mt-0.5">
                    Upload real truck photo in Admin Settings
                  </div>
                </div>
              )}
            </div>
            <div className="mt-1 px-2 py-0.5 rounded bg-blue-900 text-white font-mono text-[10px] font-bold tracking-wider">
              {BILL_HEADER_RIGHT_TRUCK_REG}
            </div>
          </div>
        </div>
      </header>

      {/* Modern Minimal Bill Meta + Bill To Row */}
      <div className="grid grid-cols-12 gap-4 text-xs">
        <div className="col-span-8 p-3.5 border border-blue-200 rounded-lg bg-white space-y-1">
          <div className="text-[10px] uppercase tracking-wider font-bold text-red-600">
            Bill To (Party)
          </div>
          <div className="text-sm font-bold text-slate-900">{bill.partyName}</div>
          {bill.partyAddress && (
            <div className="text-slate-700 leading-snug">{bill.partyAddress}</div>
          )}
          {bill.partyGstin && (
            <div className="font-mono text-[11px] font-medium text-blue-950">
              GSTIN: {bill.partyGstin}
            </div>
          )}
        </div>

        <div className="col-span-4 p-3.5 border border-blue-900/25 rounded-lg bg-blue-50/40 flex flex-col justify-between">
          <div className="text-[10px] uppercase tracking-wider font-bold text-blue-900 border-b border-blue-200 pb-1">
            Freight Bill
          </div>
          <div className="space-y-1 pt-1.5 font-mono">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-600">Bill No:</span>
              <span className="text-xs font-bold text-blue-950">{bill.billNumber}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-600">Date:</span>
              <span className="text-xs font-semibold text-slate-900">
                {formatDateIN(bill.billDate)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-600">Trips:</span>
              <span className="text-xs font-semibold text-slate-900">
                {bill.lineItems.length}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Modern Minimal Line Items Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-[11px] border border-blue-900/30">
          <thead>
            <tr className="bg-blue-900 text-white font-semibold">
              <th className="py-2 px-2 border-r border-blue-800">Sr</th>
              <th className="py-2 px-2 border-r border-blue-800">Date</th>
              <th className="py-2 px-2 border-r border-blue-800">LR No</th>
              <th className="py-2 px-2 border-r border-blue-800">Vehicle No</th>
              <th className="py-2 px-2 border-r border-blue-800">Container</th>
              <th className="py-2 px-2 border-r border-blue-800">From → To</th>
              <th className="py-2 px-2 border-r border-blue-800 text-right">Rate</th>
              <th className="py-2 px-2 border-r border-blue-800 text-right">Amount Received</th>
              <th className="py-2 px-2 text-right">Balance Due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {bill.lineItems.map((item, idx) => (
              <tr key={`${item.tripId}-${idx}`} className={idx % 2 === 1 ? 'bg-slate-50/60' : 'bg-white'}>
                <td className="py-1.5 px-2 border-r border-slate-200 font-mono">
                  {item.srNo || idx + 1}
                </td>
                <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                  {formatDateIN(item.tripDate)}
                </td>
                <td className="py-1.5 px-2 border-r border-slate-200 font-mono">
                  {item.lrNumber}
                </td>
                <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                  {item.vehicleNumber}
                </td>
                <td className="py-1.5 px-2 border-r border-slate-200 font-mono break-words">
                  {item.containerNo || '—'}
                </td>
                <td className="py-1.5 px-2 border-r border-slate-200 break-words">
                  {item.origin} → {item.destination}
                </td>
                <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap">
                  {formatINR(item.rate)}
                </td>
                <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap">
                  {formatINR(item.jama)}
                </td>
                <td className="py-1.5 px-2 text-right font-mono font-semibold text-blue-950 tabular-nums whitespace-nowrap">
                  {formatINR(item.hisab)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-blue-50 border-t-2 border-blue-900 font-bold text-blue-950">
            <tr>
              <td className="py-2 px-2 border-r border-blue-200" colSpan={6}>
                Total ({bill.lineItems.length} {bill.lineItems.length === 1 ? 'Trip' : 'Trips'})
              </td>
              <td className="py-2 px-2 border-r border-blue-200 text-right font-mono tabular-nums whitespace-nowrap">
                {formatINR(bill.freightTotal)}
              </td>
              <td className="py-2 px-2 border-r border-blue-200 text-right font-mono tabular-nums whitespace-nowrap">
                {formatINR(bill.advanceTotal)}
              </td>
              <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                {formatINR(bill.netPayable)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Footer Totals, Words, Conditional Verified Bank Details & Blank Signatory Box */}
      <div className="grid grid-cols-12 gap-5 pt-1 items-start">
        <div className="col-span-7 space-y-3 text-xs">
          <div className="p-3 border border-slate-200 rounded-lg bg-slate-50/70">
            <div className="text-[10px] uppercase tracking-wider font-bold text-blue-900">
              Amount Chargeable (In Words)
            </div>
            <div className="font-semibold text-slate-900 mt-1">{bill.amountInWords}</div>
          </div>

          {verifiedBankDetails && (
            <div className="p-3 border border-blue-200 rounded-lg bg-white">
              <div className="text-[10px] uppercase tracking-wider font-bold text-blue-900 mb-1">
                Verified Bank Details
              </div>
              <div className="font-mono text-[11px] text-slate-800 leading-relaxed">
                {verifiedBankDetails}
              </div>
            </div>
          )}

          {bill.notes && (
            <div className="text-[11px] text-slate-700">
              <span className="font-semibold text-slate-900">Remarks:</span> {bill.notes}
            </div>
          )}

          {terms && (
            <div className="text-[10px] text-slate-500 leading-snug">
              <span className="font-semibold text-slate-700">Terms:</span> {terms}
            </div>
          )}
        </div>

        <div className="col-span-5 space-y-4">
          <div className="border-2 border-blue-900 rounded-lg overflow-hidden text-xs">
            <div className="p-3 space-y-1.5 bg-white">
              <div className="flex justify-between gap-2">
                <span className="text-slate-600">Freight Total</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatINR(bill.freightTotal)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-600">Less: Amount Received</span>
                <span className="font-mono text-slate-800 tabular-nums">
                  {formatINR(bill.advanceTotal)}
                </span>
              </div>
              {Math.abs(hisabAdjustment) >= 0.01 && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-600">Balance Due Adjustment</span>
                  <span className="font-mono text-slate-800 tabular-nums">
                    {formatINR(hisabAdjustment)}
                  </span>
                </div>
              )}
            </div>
            <div className="px-3 py-2.5 bg-blue-900 text-white flex justify-between items-center gap-2 font-bold text-sm">
              <span>Total Payable</span>
              <span className="font-mono tabular-nums">{formatINR(bill.netPayable)}</span>
            </div>
          </div>

          <div className="pt-6 text-right text-xs">
            <div className="font-bold text-blue-900">For {companyName}</div>
            <div className="mt-10 border-t border-slate-400 inline-block pt-1 px-6 text-[11px] text-slate-600">
              Authorized Signatory
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
