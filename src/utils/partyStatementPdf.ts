import { jsPDF } from 'jspdf';
import type { Bill, CompanySettings, Party, PartyPayment, Trip } from '../types/erp';
import {
  buildDateWisePartyStatement,
  computePartyLedgerSummary,
  matchesStatementPaymentMethod,
  normalizeNameKey,
  type DateWiseStatementResult,
  type PartyLedgerSummary,
  type StatementPaymentMethodFilter,
} from './erpHelpers';
import {
  formatDateIN,
  formatINR,
  formatNumberIN,
  getTodayISO,
  rupeesInWords,
} from './formatters';
import { downloadElementAsA4Pdf, sanitizePdfFileName } from './pdfExport';

export interface PartyStatementPdfInput {
  party: Party;
  trips: Trip[];
  partyPayments: PartyPayment[];
  bills?: Bill[];
  companySettings?: CompanySettings | null;
  fromDate?: string;
  toDate?: string;
  paymentMethodFilter?: StatementPaymentMethodFilter;
}

export interface PartyStatementReportData {
  party: Party;
  companyName: string;
  companyAddress: string;
  companyMetaLine: string;
  bankSummaryLine: string;
  generatedDate: string;
  fromDate: string;
  toDate: string;
  paymentMethodFilter: StatementPaymentMethodFilter;
  partyTrips: Trip[];
  payments: PartyPayment[];
  filteredPaymentsTotal: number;
  partyBills: Bill[];
  summary: PartyLedgerSummary;
  dateWise: DateWiseStatementResult;
  fileName: string;
}

export interface BuiltPartyStatementPdf {
  pdf: jsPDF;
  fileName: string;
  pageCount: number;
  summary: PartyLedgerSummary;
  reportData: PartyStatementReportData;
}

const DEVANAGARI_REGEX = /[\u0900-\u097F]/;

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function getEffectiveTripBalance(t: Trip): number {
  const freight = Number(t.freightAmount) || 0;
  const jama = Number(t.advanceReceived) || 0;
  if (typeof t.balanceAmount === 'number' && Number.isFinite(t.balanceAmount)) {
    return round2(t.balanceAmount);
  }
  return round2(freight - jama);
}

/**
 * Formats an INR currency value using ASCII-safe "Rs." for standard vector PDF fonts.
 */
export function formatPdfInr(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const prefix = safe < 0 ? '-Rs. ' : 'Rs. ';
  return `${prefix}${formatNumberIN(Math.abs(safe), 2)}`;
}

/**
 * Sanitizes Unicode arrows/dashes/symbols so standard Helvetica PDF font renders cleanly.
 */
function toPdfSafeText(raw: string): string {
  return (raw || '')
    .replace(/₹/g, 'Rs. ')
    .replace(/→/g, '->')
    .replace(/[—–]/g, '-')
    .replace(/·/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildPartyStatementFileName(
  partyName: string,
  dateISO = getTodayISO(),
  paymentMethodFilter: StatementPaymentMethodFilter = 'All'
): string {
  const cleanName =
    partyName
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'Party';
  const methodSuffix = paymentMethodFilter !== 'All' ? `-${paymentMethodFilter}` : '';
  return sanitizePdfFileName(`Party-Statement-${cleanName}${methodSuffix}-${dateISO}.pdf`);
}

export function buildPartyStatementReportData(
  input: PartyStatementPdfInput
): PartyStatementReportData {
  const {
    party,
    trips,
    partyPayments,
    bills = [],
    companySettings = null,
    fromDate = '',
    toDate = '',
    paymentMethodFilter = 'All',
  } = input;

  const fallbackNameKey = normalizeNameKey(party.partyName);
  const cleanFrom = fromDate.trim();
  const cleanTo = toDate.trim();

  const matchesParty = (recordPartyId: string, recordPartyName: string) =>
    recordPartyId === party.id ||
    (!recordPartyId &&
      fallbackNameKey !== '' &&
      normalizeNameKey(recordPartyName) === fallbackNameKey);

  const partyTrips = trips
    .filter((t) => {
      if (t.tripStatus === 'Cancelled') return false;
      if (!matchesParty(t.partyId, t.partyName)) return false;
      if (cleanFrom && t.tripDate && t.tripDate < cleanFrom) return false;
      if (cleanTo && t.tripDate && t.tripDate > cleanTo) return false;
      return true;
    })
    .slice()
    .sort((a, b) => a.tripDate.localeCompare(b.tripDate));

  const payments = partyPayments
    .filter((pp) => {
      if (!matchesParty(pp.partyId, pp.partyName)) return false;
      if (!matchesStatementPaymentMethod(pp.paymentMode, paymentMethodFilter)) return false;
      if (cleanFrom && pp.paymentDate && pp.paymentDate < cleanFrom) return false;
      if (cleanTo && pp.paymentDate && pp.paymentDate > cleanTo) return false;
      return true;
    })
    .slice()
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));

  const filteredPaymentsTotal = round2(
    payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0)
  );

  const partyBills = bills
    .filter((b) => {
      if (b.status === 'Cancelled') return false;
      if (!matchesParty(b.partyId, b.partyName)) return false;
      if (cleanFrom && b.billDate && b.billDate < cleanFrom) return false;
      if (cleanTo && b.billDate && b.billDate > cleanTo) return false;
      return true;
    })
    .slice()
    .sort((a, b) => a.billDate.localeCompare(b.billDate));

  const summary = computePartyLedgerSummary(party.id, trips, partyPayments, party.partyName);
  const dateWise = buildDateWisePartyStatement(
    party.id,
    trips,
    partyPayments,
    cleanFrom,
    cleanTo,
    party.partyName,
    paymentMethodFilter
  );

  const companyName = companySettings?.companyName || 'BAPASITARAM ENTERPRISE';
  const companyAddress = companySettings?.address || '';
  const companyMetaLine = [
    companySettings?.gstin && `GSTIN: ${companySettings.gstin}`,
    companySettings?.pan && `PAN: ${companySettings.pan}`,
    companySettings?.phone && `Ph: ${companySettings.phone}`,
  ]
    .filter(Boolean)
    .join('  |  ');

  const bankSummaryLine = [
    companySettings?.bankName && `Bank: ${companySettings.bankName}`,
    companySettings?.accountHolderName && `A/c Name: ${companySettings.accountHolderName}`,
    companySettings?.accountNumber && `A/c No: ${companySettings.accountNumber}`,
    companySettings?.ifscCode && `IFSC: ${companySettings.ifscCode}`,
    companySettings?.branchName && `Branch: ${companySettings.branchName}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const generatedDate = getTodayISO();

  return {
    party,
    companyName,
    companyAddress,
    companyMetaLine,
    bankSummaryLine,
    generatedDate,
    fromDate: cleanFrom,
    toDate: cleanTo,
    paymentMethodFilter,
    partyTrips,
    payments,
    filteredPaymentsTotal,
    partyBills,
    summary,
    dateWise,
    fileName: buildPartyStatementFileName(party.partyName, generatedDate, paymentMethodFilter),
  };
}

export function reportContainsDevanagari(report: PartyStatementReportData): boolean {
  const sampleTexts = [
    report.companyName,
    report.companyAddress,
    report.party.partyName,
    report.party.address,
    report.party.contactPerson,
    ...report.partyTrips.flatMap((t) => [t.origin, t.destination, t.notes, t.material || '']),
    ...report.payments.flatMap((p) => [p.notes, p.referenceNo]),
  ];
  return sampleTexts.some((txt) => Boolean(txt) && DEVANAGARI_REGEX.test(txt));
}

interface PdfTableColumn {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

/**
 * Generates a crisp multi-page A4 vector PDF summarizing all freight bills, payments,
 * chronological running ledger, and calculated outstanding balance for a party.
 */
export function createPartyStatementPdfDocument(
  input: PartyStatementPdfInput
): BuiltPartyStatementPdf {
  const report = buildPartyStatementReportData(input);
  const { party, summary, dateWise, partyTrips, payments, partyBills } = report;

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: false,
  });

  const pageWidth = pdf.internal.pageSize.getWidth(); // 210mm
  const pageHeight = pdf.internal.pageSize.getHeight(); // 297mm
  const margin = 12;
  const contentWidth = pageWidth - margin * 2; // 186mm
  const bottomLimit = pageHeight - 16;

  let y = margin;

  const ensureSpace = (neededMm: number) => {
    if (y + neededMm > bottomLimit) {
      pdf.addPage();
      y = margin;
    }
  };

  // --- Header Banner ---
  pdf.setTextColor(15, 23, 42);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.text(toPdfSafeText(report.companyName), margin, y + 5);

  pdf.setFontSize(11);
  pdf.setTextColor(51, 65, 85);
  pdf.text('PARTY ACCOUNT STATEMENT', pageWidth - margin, y + 4.5, { align: 'right' });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(71, 85, 105);

  let leftHeaderY = y + 9.5;
  if (report.companyAddress) {
    const addrLines = pdf.splitTextToSize(toPdfSafeText(report.companyAddress), 112);
    pdf.text(addrLines, margin, leftHeaderY);
    leftHeaderY += addrLines.length * 3.8;
  }
  if (report.companyMetaLine) {
    pdf.text(toPdfSafeText(report.companyMetaLine), margin, leftHeaderY);
    leftHeaderY += 3.8;
  }

  let rightHeaderY = y + 9.5;
  pdf.text(`Generated: ${formatDateIN(report.generatedDate)}`, pageWidth - margin, rightHeaderY, {
    align: 'right',
  });
  rightHeaderY += 3.8;
  if (report.fromDate || report.toDate) {
    const periodLabel = `Period: ${report.fromDate ? formatDateIN(report.fromDate) : 'Start'} to ${
      report.toDate ? formatDateIN(report.toDate) : 'Today'
    }`;
    pdf.text(toPdfSafeText(periodLabel), pageWidth - margin, rightHeaderY, { align: 'right' });
    rightHeaderY += 3.8;
  }
  if (report.paymentMethodFilter !== 'All') {
    pdf.text(
      `Payment Method Filter: ${report.paymentMethodFilter}`,
      pageWidth - margin,
      rightHeaderY,
      { align: 'right' }
    );
    rightHeaderY += 3.8;
  }
  pdf.text(`Credit Terms: ${party.paymentTermsDays ?? 0} days`, pageWidth - margin, rightHeaderY, {
    align: 'right',
  });
  rightHeaderY += 3.8;

  y = Math.max(leftHeaderY, rightHeaderY) + 2;
  pdf.setDrawColor(15, 23, 42);
  pdf.setLineWidth(0.6);
  pdf.line(margin, y, pageWidth - margin, y);
  y += 5;

  // --- Two-Column Party Info + Account Summary Box ---
  const boxGap = 4;
  const boxWidth = (contentWidth - boxGap) / 2;

  const partyLines: string[] = [
    toPdfSafeText(party.partyName),
    toPdfSafeText(party.partyType),
  ];
  if (party.gstin) partyLines.push(`GSTIN: ${toPdfSafeText(party.gstin)}`);
  const fullAddress = [party.address, [party.city, party.state].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(', ');
  if (fullAddress) {
    const wrappedAddr = pdf.splitTextToSize(toPdfSafeText(fullAddress), boxWidth - 8) as string[];
    partyLines.push(...wrappedAddr.slice(0, 2));
  }
  const contactLine = [party.contactPerson, party.phone].filter(Boolean).join(' | ');
  if (contactLine) partyLines.push(toPdfSafeText(contactLine));
  if (party.email) partyLines.push(toPdfSafeText(party.email));

  const summaryRows: Array<{ label: string; value: string; bold?: boolean; highlight?: boolean }> = [
    {
      label: `Total Freight Bills (${summary.tripCount} trips)`,
      value: formatPdfInr(summary.totalFreight),
    },
    {
      label: 'Payments Received (Jama + Receipts)',
      value: `- ${formatPdfInr(summary.tripAdvanceReceived + summary.paymentsReceivedTotal)}`,
    },
    {
      label: 'Advance Payments Logged',
      value: `- ${formatPdfInr(summary.ledgerAdvancesTotal)}`,
    },
  ];
  if (summary.deductionsTotal > 0) {
    summaryRows.push({
      label: 'Deductions / TDS',
      value: `- ${formatPdfInr(summary.deductionsTotal)}`,
    });
  }
  if (report.paymentMethodFilter !== 'All') {
    summaryRows.push({
      label: `Filtered ${report.paymentMethodFilter} Payments (${payments.length})`,
      value: formatPdfInr(report.filteredPaymentsTotal),
    });
  }
  summaryRows.push({
    label: summary.netOutstanding < 0 ? 'Outstanding Balance (Adv. Credit)' : 'Calculated Outstanding Balance',
    value: `${formatPdfInr(summary.netOutstanding)}${summary.netOutstanding < 0 ? ' Cr' : ''}`,
    bold: true,
    highlight: true,
  });

  const leftBoxHeight = 10 + partyLines.length * 4.2 + 3;
  const rightBoxHeight = 10 + summaryRows.length * 5.2 + 4;
  const cardHeight = Math.max(leftBoxHeight, rightBoxHeight, 34);

  ensureSpace(cardHeight + 4);

  // Left box: Party details
  pdf.setDrawColor(203, 213, 225);
  pdf.setFillColor(248, 250, 252);
  pdf.setLineWidth(0.3);
  pdf.roundedRect(margin, y, boxWidth, cardHeight, 1.5, 1.5, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(100, 116, 139);
  pdf.text('ACCOUNT HOLDER', margin + 4, y + 5.5);

  let py = y + 10.5;
  partyLines.forEach((line, idx) => {
    pdf.setFont('helvetica', idx === 0 ? 'bold' : 'normal');
    pdf.setFontSize(idx === 0 ? 10 : 8.2);
    pdf.setTextColor(idx === 0 ? 15 : 51, idx === 0 ? 23 : 65, idx === 0 ? 42 : 85);
    pdf.text(line, margin + 4, py);
    py += idx === 0 ? 4.8 : 4.1;
  });

  // Right box: Account Summary
  const rightBoxX = margin + boxWidth + boxGap;
  pdf.setDrawColor(203, 213, 225);
  pdf.setFillColor(255, 255, 255);
  pdf.roundedRect(rightBoxX, y, boxWidth, cardHeight, 1.5, 1.5, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(100, 116, 139);
  pdf.text('ACCOUNT SUMMARY', rightBoxX + 4, y + 5.5);

  let sy = y + 10.5;
  summaryRows.forEach((row) => {
    if (row.highlight) {
      pdf.setDrawColor(148, 163, 184);
      pdf.setLineWidth(0.3);
      pdf.line(rightBoxX + 4, sy - 3.2, rightBoxX + boxWidth - 4, sy - 3.2);
      sy += 1.2;
    }
    pdf.setFont('helvetica', row.bold ? 'bold' : 'normal');
    pdf.setFontSize(row.bold ? 9 : 8.2);
    if (row.highlight) {
      pdf.setTextColor(summary.netOutstanding > 0 ? 180 : 4, summary.netOutstanding > 0 ? 83 : 120, summary.netOutstanding > 0 ? 9 : 87);
    } else {
      pdf.setTextColor(30, 41, 59);
    }
    pdf.text(row.label, rightBoxX + 4, sy);
    pdf.text(row.value, rightBoxX + boxWidth - 4, sy, { align: 'right' });
    sy += 5;
  });

  y += cardHeight + 6;

  // --- Reusable Table Renderer ---
  const drawSectionHeading = (title: string) => {
    ensureSpace(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9.5);
    pdf.setTextColor(15, 23, 42);
    pdf.text(toPdfSafeText(title), margin, y);
    y += 2.5;
  };

  const drawTableHeader = (columns: PdfTableColumn[]) => {
    const headerHeight = 6.5;
    pdf.setFillColor(241, 245, 249);
    pdf.setDrawColor(203, 213, 225);
    pdf.setLineWidth(0.25);
    pdf.rect(margin, y, contentWidth, headerHeight, 'FD');

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7.5);
    pdf.setTextColor(51, 65, 85);

    let cx = margin;
    columns.forEach((col) => {
      const textX = col.align === 'right' ? cx + col.width - 1.8 : cx + 1.8;
      pdf.text(col.label, textX, y + 4.3, { align: col.align === 'right' ? 'right' : 'left' });
      cx += col.width;
    });
    y += headerHeight;
  };

  const drawTable = (
    columns: PdfTableColumn[],
    rows: string[][],
    footerRow?: string[],
    emptyMessage = 'No records available.'
  ) => {
    ensureSpace(14);
    drawTableHeader(columns);

    if (rows.length === 0) {
      const emptyH = 7;
      pdf.setDrawColor(226, 232, 240);
      pdf.setFillColor(255, 255, 255);
      pdf.rect(margin, y, contentWidth, emptyH, 'FD');
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 116, 139);
      pdf.text(emptyMessage, margin + 3, y + 4.5);
      y += emptyH + 5;
      return;
    }

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);

    rows.forEach((row, rowIdx) => {
      const cellLines = row.map((cell, idx) => {
        const col = columns[idx];
        const maxW = Math.max(8, col.width - 3.6);
        return pdf.splitTextToSize(toPdfSafeText(cell || '-'), maxW) as string[];
      });
      const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowHeight = Math.max(6, maxLines * 3.5 + 2.6);

      if (y + rowHeight > bottomLimit) {
        pdf.addPage();
        y = margin;
        drawTableHeader(columns);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
      }

      if (rowIdx % 2 === 1) {
        pdf.setFillColor(250, 250, 252);
        pdf.rect(margin, y, contentWidth, rowHeight, 'F');
      }
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.2);
      pdf.rect(margin, y, contentWidth, rowHeight, 'S');

      pdf.setTextColor(15, 23, 42);
      let cx = margin;
      cellLines.forEach((lines, idx) => {
        const col = columns[idx];
        const textX = col.align === 'right' ? cx + col.width - 1.8 : cx + 1.8;
        lines.forEach((line, lineIdx) => {
          pdf.text(line, textX, y + 4 + lineIdx * 3.5, {
            align: col.align === 'right' ? 'right' : 'left',
          });
        });
        cx += col.width;
      });

      y += rowHeight;
    });

    if (footerRow) {
      const footerH = 7;
      if (y + footerH > bottomLimit) {
        pdf.addPage();
        y = margin;
        drawTableHeader(columns);
      }
      pdf.setFillColor(241, 245, 249);
      pdf.setDrawColor(148, 163, 184);
      pdf.setLineWidth(0.3);
      pdf.rect(margin, y, contentWidth, footerH, 'FD');

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7.8);
      pdf.setTextColor(15, 23, 42);
      let cx = margin;
      footerRow.forEach((cell, idx) => {
        const col = columns[idx];
        if (cell) {
          const textX = col.align === 'right' ? cx + col.width - 1.8 : cx + 1.8;
          pdf.text(toPdfSafeText(cell), textX, y + 4.7, {
            align: col.align === 'right' ? 'right' : 'left',
          });
        }
        cx += col.width;
      });
      y += footerH;
    }

    y += 5.5;
  };

  // --- Section 1: Freight Bills / Trip-Wise Summary ---
  drawSectionHeading(`1. Freight Bills & Trip Summary (${partyTrips.length} Active Trips)`);
  const tripCols: PdfTableColumn[] = [
    { label: 'Date', width: 22 },
    { label: 'LR / Container', width: 32 },
    { label: 'Vehicle & Route', width: 54 },
    { label: 'Freight Bill', width: 26, align: 'right' },
    { label: 'Trip Jama', width: 26, align: 'right' },
    { label: 'Trip Hisab', width: 26, align: 'right' },
  ];
  const filteredTripFreight = round2(
    partyTrips.reduce((acc, t) => acc + (Number(t.freightAmount) || 0), 0)
  );
  const filteredTripJama = round2(
    partyTrips.reduce((acc, t) => acc + (Number(t.advanceReceived) || 0), 0)
  );
  const filteredTripHisab = round2(
    partyTrips.reduce((acc, t) => acc + getEffectiveTripBalance(t), 0)
  );

  drawTable(
    tripCols,
    partyTrips.map((t) => [
      formatDateIN(t.tripDate),
      t.containerNo ? `${t.lrNumber} (${t.containerNo})` : t.lrNumber,
      `${t.vehicleNumber} | ${t.origin} -> ${t.destination}`,
      formatPdfInr(Number(t.freightAmount) || 0),
      formatPdfInr(Number(t.advanceReceived) || 0),
      formatPdfInr(getEffectiveTripBalance(t)),
    ]),
    partyTrips.length > 0
      ? [
          'TOTAL',
          `${partyTrips.length} Trips`,
          '',
          formatPdfInr(filteredTripFreight),
          formatPdfInr(filteredTripJama),
          formatPdfInr(filteredTripHisab),
        ]
      : undefined,
    'No active freight trips recorded for this party in the selected period.'
  );

  // Optional Generated Formal Invoices Table if partyBills exist
  if (partyBills.length > 0) {
    drawSectionHeading(`Generated Freight Invoices (${partyBills.length})`);
    const billCols: PdfTableColumn[] = [
      { label: 'Bill No', width: 34 },
      { label: 'Bill Date', width: 26 },
      { label: 'Trips', width: 18, align: 'right' },
      { label: 'Freight Total', width: 34, align: 'right' },
      { label: 'Status', width: 32 },
      { label: 'Net Payable', width: 42, align: 'right' },
    ];
    const billsFreightTotal = round2(
      partyBills.reduce((acc, b) => acc + (Number(b.freightTotal) || 0), 0)
    );
    const billsNetTotal = round2(
      partyBills.reduce((acc, b) => acc + (Number(b.netPayable) || 0), 0)
    );
    drawTable(
      billCols,
      partyBills.map((b) => [
        b.billNumber,
        formatDateIN(b.billDate),
        String(b.tripIds?.length || 0),
        formatPdfInr(Number(b.freightTotal) || 0),
        b.status,
        formatPdfInr(Number(b.netPayable) || 0),
      ]),
      ['TOTAL', `${partyBills.length} Bills`, '', formatPdfInr(billsFreightTotal), '', formatPdfInr(billsNetTotal)]
    );
  }

  // --- Section 2: Payments & Advances Received ---
  drawSectionHeading(`2. Payments & Advances Received (${payments.length} Entries)`);
  const payCols: PdfTableColumn[] = [
    { label: 'Date', width: 22 },
    { label: 'Type', width: 30 },
    { label: 'Method', width: 26 },
    { label: 'Ref / Linked Trip', width: 42 },
    { label: 'Notes', width: 38 },
    { label: 'Amount', width: 28, align: 'right' },
  ];
  const filteredPaymentsTotal = round2(
    payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0)
  );
  drawTable(
    payCols,
    payments.map((pp) => [
      formatDateIN(pp.paymentDate),
      pp.paymentType,
      pp.paymentMode,
      [pp.referenceNo, pp.tripLrNumber ? `Trip ${pp.tripLrNumber}` : ''].filter(Boolean).join(' | ') || '-',
      pp.notes || '-',
      formatPdfInr(Number(pp.amount) || 0),
    ]),
    payments.length > 0
      ? [
          'TOTAL',
          `${payments.length} Vouchers`,
          '',
          '',
          '',
          formatPdfInr(filteredPaymentsTotal),
        ]
      : undefined,
    'No separate payment vouchers recorded against this party ledger.'
  );

  // --- Section 3: Chronological Running Balance Reconciliation ---
  const isMethodFiltered = report.paymentMethodFilter !== 'All';
  drawSectionHeading(
    isMethodFiltered
      ? `3. Date-Wise ${report.paymentMethodFilter} Reconciliation (${dateWise.rows.length} Entries)`
      : `3. Date-Wise Ledger Reconciliation (${dateWise.rows.length} Entries)`
  );
  const ledgerCols: PdfTableColumn[] = [
    { label: 'Date', width: 22 },
    { label: 'Particulars', width: 58 },
    { label: 'LR / Ref', width: 32 },
    { label: 'Debit (Bill)', width: 24, align: 'right' },
    { label: 'Credit (Paid)', width: 24, align: 'right' },
    { label: isMethodFiltered ? 'Cumul. Paid' : 'Balance', width: 26, align: 'right' },
  ];
  const ledgerRows: string[][] = [];
  if (report.fromDate) {
    ledgerRows.push([
      formatDateIN(report.fromDate),
      isMethodFiltered ? `Prior ${report.paymentMethodFilter} Receipts` : 'Opening Balance Brought Forward',
      '-',
      '-',
      '-',
      formatPdfInr(dateWise.openingBalance),
    ]);
  }
  dateWise.rows.forEach((row) => {
    ledgerRows.push([
      formatDateIN(row.date),
      row.note ? `${row.particulars} (${row.note})` : row.particulars,
      row.reference || '-',
      row.debit > 0 ? formatPdfInr(row.debit) : '-',
      row.credit > 0 ? formatPdfInr(row.credit) : '-',
      formatPdfInr(row.runningBalance),
    ]);
  });
  drawTable(
    ledgerCols,
    ledgerRows,
    [
      'CLOSING',
      isMethodFiltered
        ? `Total ${report.paymentMethodFilter} Receipts Reconciled`
        : 'Period Totals & Outstanding Balance',
      '',
      formatPdfInr(dateWise.periodDebit),
      formatPdfInr(dateWise.periodCredit),
      `${formatPdfInr(dateWise.closingBalance)}${!isMethodFiltered && dateWise.closingBalance < 0 ? ' Cr' : ''}`,
    ],
    isMethodFiltered
      ? `No ${report.paymentMethodFilter} payments found in the selected period.`
      : 'No ledger entries found in the selected period.'
  );

  // --- Footer Block: Amount in Words, Bank Details & Signatory ---
  ensureSpace(32);
  const footerStartY = y;

  let leftFootY = footerStartY;
  if (summary.netOutstanding > 0) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(71, 85, 105);
    pdf.text('Outstanding Balance in Words:', margin, leftFootY);
    leftFootY += 4;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.2);
    pdf.setTextColor(15, 23, 42);
    const wordsLines = pdf.splitTextToSize(rupeesInWords(summary.netOutstanding), 118) as string[];
    pdf.text(wordsLines, margin, leftFootY);
    leftFootY += wordsLines.length * 3.8 + 2.5;
  }

  if (report.bankSummaryLine) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(71, 85, 105);
    pdf.text('Bank Details for Payment:', margin, leftFootY);
    leftFootY += 4;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.8);
    pdf.setTextColor(30, 41, 59);
    const bankLines = pdf.splitTextToSize(toPdfSafeText(report.bankSummaryLine), 118) as string[];
    pdf.text(bankLines, margin, leftFootY);
    leftFootY += bankLines.length * 3.6;
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8.5);
  pdf.setTextColor(15, 23, 42);
  pdf.text(`For ${toPdfSafeText(report.companyName)}`, pageWidth - margin, footerStartY + 2, {
    align: 'right',
  });
  pdf.setDrawColor(148, 163, 184);
  pdf.setLineWidth(0.3);
  pdf.line(pageWidth - margin - 42, footerStartY + 18, pageWidth - margin, footerStartY + 18);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Authorized Signatory', pageWidth - margin - 21, footerStartY + 22, { align: 'center' });

  // --- Page Numbers on Every Page ---
  const pageCount = pdf.getNumberOfPages();
  for (let p = 1; p <= pageCount; p += 1) {
    pdf.setPage(p);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(100, 116, 139);
    pdf.text(
      `${toPdfSafeText(report.companyName)} | Party Statement: ${toPdfSafeText(party.partyName)}`,
      margin,
      pageHeight - 8
    );
    pdf.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
  }

  return {
    pdf,
    fileName: report.fileName,
    pageCount,
    summary,
    reportData: report,
  };
}

function escapeHtml(raw: string): string {
  return (raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildOffscreenDevanagariStatementNode(report: PartyStatementReportData): HTMLDivElement {
  const { party, summary, partyTrips, payments, dateWise } = report;
  const container = document.createElement('div');
  container.style.padding = '24px';
  container.style.backgroundColor = '#ffffff';
  container.style.color = '#0f172a';
  container.style.fontFamily =
    '"Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, sans-serif';
  container.style.fontSize = '11px';

  const tripRowsHtml =
    partyTrips.length === 0
      ? '<tr><td colspan="6" style="padding:8px;text-align:center;color:#64748b;">No active trips recorded.</td></tr>'
      : partyTrips
          .map(
            (t) => `
          <tr>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;white-space:nowrap;">${escapeHtml(formatDateIN(t.tripDate))}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;">${escapeHtml(t.lrNumber)}${t.containerNo ? ` (${escapeHtml(t.containerNo)})` : ''}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;">${escapeHtml(t.vehicleNumber)} · ${escapeHtml(t.origin)} → ${escapeHtml(t.destination)}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;text-align:right;white-space:nowrap;">${escapeHtml(formatINR(Number(t.freightAmount) || 0))}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;text-align:right;white-space:nowrap;">${escapeHtml(formatINR(Number(t.advanceReceived) || 0))}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;text-align:right;font-weight:600;white-space:nowrap;">${escapeHtml(formatINR(getEffectiveTripBalance(t)))}</td>
          </tr>`
          )
          .join('');

  const paymentRowsHtml =
    payments.length === 0
      ? '<tr><td colspan="6" style="padding:8px;text-align:center;color:#64748b;">No separate payment vouchers recorded.</td></tr>'
      : payments
          .map(
            (pp) => `
          <tr>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;white-space:nowrap;">${escapeHtml(formatDateIN(pp.paymentDate))}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;">${escapeHtml(pp.paymentType)}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;">${escapeHtml(pp.paymentMode)}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;">${escapeHtml(pp.referenceNo || '—')}${pp.tripLrNumber ? ` (${escapeHtml(pp.tripLrNumber)})` : ''}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;">${escapeHtml(pp.notes || '—')}</td>
            <td style="padding:5px 6px;border:1px solid #cbd5e1;text-align:right;font-weight:600;white-space:nowrap;">${escapeHtml(formatINR(Number(pp.amount) || 0))}</td>
          </tr>`
          )
          .join('');

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;border-bottom:2px solid #0f172a;padding-bottom:10px;margin-bottom:14px;">
      <div>
        <div style="font-size:20px;font-weight:700;">${escapeHtml(report.companyName)}</div>
        ${report.companyAddress ? `<div style="color:#475569;margin-top:2px;">${escapeHtml(report.companyAddress)}</div>` : ''}
        ${report.companyMetaLine ? `<div style="color:#475569;margin-top:2px;">${escapeHtml(report.companyMetaLine)}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:13px;font-weight:700;text-transform:uppercase;">Party Account Statement</div>
        <div style="color:#475569;margin-top:2px;">Generated: ${escapeHtml(formatDateIN(report.generatedDate))}</div>
        <div style="color:#475569;">Credit Terms: ${party.paymentTermsDays ?? 0} days</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
      <div style="border:1px solid #cbd5e1;border-radius:6px;padding:10px;background:#f8fafc;">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;">Account Holder</div>
        <div style="font-size:14px;font-weight:700;margin-top:3px;">${escapeHtml(party.partyName)}</div>
        <div style="color:#475569;">${escapeHtml(party.partyType)}</div>
        ${party.gstin ? `<div>GSTIN: ${escapeHtml(party.gstin)}</div>` : ''}
        ${party.phone ? `<div>Phone: ${escapeHtml(party.phone)}</div>` : ''}
      </div>
      <div style="border:1px solid #cbd5e1;border-radius:6px;padding:10px;">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Account Summary</div>
        <div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Total Freight Bills (${summary.tripCount} trips)</span><strong>${escapeHtml(formatINR(summary.totalFreight))}</strong></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Payments Received (Jama + Receipts)</span><span style="color:#047857;">- ${escapeHtml(formatINR(summary.tripAdvanceReceived + summary.paymentsReceivedTotal))}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Advance Payments Logged</span><span style="color:#047857;">- ${escapeHtml(formatINR(summary.ledgerAdvancesTotal))}</span></div>
        ${summary.deductionsTotal > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span>Deductions / TDS</span><span>- ${escapeHtml(formatINR(summary.deductionsTotal))}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;border-top:1px solid #94a3b8;padding-top:5px;margin-top:5px;font-size:13px;font-weight:700;"><span>Calculated Outstanding Balance</span><span>${escapeHtml(formatINR(summary.netOutstanding))}${summary.netOutstanding < 0 ? ' Cr' : ''}</span></div>
      </div>
    </div>
    <div style="font-weight:700;text-transform:uppercase;margin-bottom:6px;">1. Freight Bills &amp; Trip Summary (${partyTrips.length})</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <thead><tr style="background:#f1f5f9;">
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">Date</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">LR / Container</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">Vehicle &amp; Route</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:right;">Freight</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:right;">Trip Jama</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:right;">Trip Hisab</th>
      </tr></thead>
      <tbody>${tripRowsHtml}</tbody>
      <tfoot><tr style="background:#f1f5f9;font-weight:700;">
        <td colspan="3" style="padding:6px;border:1px solid #cbd5e1;">Active Trip Totals (${summary.tripCount})</td>
        <td style="padding:6px;border:1px solid #cbd5e1;text-align:right;">${escapeHtml(formatINR(summary.totalFreight))}</td>
        <td style="padding:6px;border:1px solid #cbd5e1;text-align:right;">${escapeHtml(formatINR(summary.tripAdvanceReceived))}</td>
        <td style="padding:6px;border:1px solid #cbd5e1;text-align:right;">${escapeHtml(formatINR(summary.tripHisabBalance))}</td>
      </tr></tfoot>
    </table>
    <div style="font-weight:700;text-transform:uppercase;margin-bottom:6px;">2. Payments &amp; Advances Received (${payments.length})</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <thead><tr style="background:#f1f5f9;">
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">Date</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">Type</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">Method</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">Ref / Trip</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:left;">Notes</th>
        <th style="padding:6px;border:1px solid #cbd5e1;text-align:right;">Amount</th>
      </tr></thead>
      <tbody>${paymentRowsHtml}</tbody>
      <tfoot><tr style="background:#f1f5f9;font-weight:700;">
        <td colspan="5" style="padding:6px;border:1px solid #cbd5e1;">Total Payments &amp; Adjustments (${payments.length})</td>
        <td style="padding:6px;border:1px solid #cbd5e1;text-align:right;">${escapeHtml(formatINR(summary.partyPaymentsTotal))}</td>
      </tr></tfoot>
    </table>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px;">
      <div style="max-width:65%;">
        ${summary.netOutstanding > 0 ? `<div><strong>Outstanding in Words:</strong> ${escapeHtml(rupeesInWords(summary.netOutstanding))}</div>` : ''}
        ${report.bankSummaryLine ? `<div style="margin-top:6px;color:#334155;"><strong>Bank Details:</strong> ${escapeHtml(report.bankSummaryLine)}</div>` : ''}
        <div style="margin-top:6px;color:#64748b;">Ledger Closing Balance: ${escapeHtml(formatINR(dateWise.closingBalance))}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-weight:700;">For ${escapeHtml(report.companyName)}</div>
        <div style="margin-top:28px;border-top:1px solid #94a3b8;padding-top:4px;">Authorized Signatory</div>
      </div>
    </div>
  `;
  return container;
}

/**
 * Downloads the Party Statement PDF directly from the party details view.
 * Uses crisp vector jsPDF output by default, and seamlessly switches to Noto Sans Devanagari
 * A4 rendering when Hindi text is present in the statement.
 */
export async function downloadPartyStatementPdf(
  input: PartyStatementPdfInput
): Promise<{ fileName: string; summary: PartyLedgerSummary }> {
  const report = buildPartyStatementReportData(input);

  if (reportContainsDevanagari(report) && typeof document !== 'undefined') {
    const node = buildOffscreenDevanagariStatementNode(report);
    await downloadElementAsA4Pdf(node, report.fileName, 'portrait');
    return { fileName: report.fileName, summary: report.summary };
  }

  const built = createPartyStatementPdfDocument(input);
  built.pdf.save(built.fileName);
  return { fileName: built.fileName, summary: built.summary };
}
