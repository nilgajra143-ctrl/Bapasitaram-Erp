import type { jsPDF } from 'jspdf';
import type { Bill, CompanySettings, PartyPaymentType, PaymentMode } from '../types/erp';
import { formatDateIN, formatINR } from './formatters';

export interface NormalizedWhatsAppPhone {
  valid: boolean;
  digits: string;
  displayNumber: string;
  reason?: string;
}

/**
 * Normalizes a party's saved mobile number into WhatsApp's international digit-only format
 * (country code + subscriber number, without '+' or spaces).
 * Defaults 10-digit local Indian numbers to country code '91'.
 */
export function normalizeWhatsAppPhone(
  rawPhone: string | null | undefined,
  defaultCountryCode = '91'
): NormalizedWhatsAppPhone {
  const trimmed = (rawPhone || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      digits: '',
      displayNumber: '',
      reason: 'No mobile number is saved for this party.',
    };
  }

  const hasExplicitPlus = trimmed.startsWith('+');
  const digitsOnly = trimmed.replace(/\D/g, '');
  const cleanCountry = defaultCountryCode.replace(/\D/g, '') || '91';

  if (!digitsOnly || /^0+$/.test(digitsOnly)) {
    return {
      valid: false,
      digits: '',
      displayNumber: '',
      reason: 'Saved mobile number is invalid.',
    };
  }

  let normalized = '';

  if (hasExplicitPlus) {
    normalized = digitsOnly;
  } else if (digitsOnly.startsWith('00') && digitsOnly.length >= 12) {
    normalized = digitsOnly.slice(2);
  } else if (digitsOnly.length === 10) {
    normalized = `${cleanCountry}${digitsOnly}`;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    normalized = `${cleanCountry}${digitsOnly.slice(1)}`;
  } else if (digitsOnly.length >= 11 && digitsOnly.length <= 15) {
    normalized = digitsOnly;
  } else {
    return {
      valid: false,
      digits: '',
      displayNumber: '',
      reason: 'Saved mobile number must have 10 digits (or include country code, e.g. +91).',
    };
  }

  if (normalized.length < 10 || normalized.length > 15 || /^0+$/.test(normalized)) {
    return {
      valid: false,
      digits: '',
      displayNumber: '',
      reason: 'Saved mobile number length is invalid for WhatsApp.',
    };
  }

  // Format neatly for human verification before opening WhatsApp
  let displayNumber = `+${normalized}`;
  if (normalized.startsWith('91') && normalized.length === 12) {
    displayNumber = `+91 ${normalized.slice(2, 7)} ${normalized.slice(7)}`;
  }

  return {
    valid: true,
    digits: normalized,
    displayNumber,
  };
}

/**
 * Builds an official WhatsApp click-to-chat URL (`https://wa.me/<digits>?text=...`)
 * strictly bound to a validated recipient mobile number so messages cannot be sent
 * without an intended recipient.
 */
export function buildWhatsAppManualUrl(
  rawPhone: string | null | undefined,
  message: string,
  defaultCountryCode = '91'
): { url: string | null; phone: NormalizedWhatsAppPhone } {
  const phone = normalizeWhatsAppPhone(rawPhone, defaultCountryCode);
  if (!phone.valid || !phone.digits) {
    return { url: null, phone };
  }
  const encodedText = encodeURIComponent(message.trim());
  return {
    url: `https://wa.me/${phone.digits}?text=${encodedText}`,
    phone,
  };
}

function buildBankSummaryLines(companySettings?: CompanySettings | null): string {
  if (!companySettings) return '';
  const parts = [
    companySettings.bankName && `Bank: ${companySettings.bankName}`,
    companySettings.accountHolderName && `A/c Name: ${companySettings.accountHolderName}`,
    companySettings.accountNumber && `A/c No: ${companySettings.accountNumber}`,
    companySettings.ifscCode && `IFSC: ${companySettings.ifscCode}`,
    companySettings.branchName && `Branch: ${companySettings.branchName}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : '';
}

export interface PaymentReceiptMessageParams {
  companyName?: string;
  partyName: string;
  amount: number;
  paymentDate: string;
  paymentMode: PaymentMode | string;
  paymentType?: PartyPaymentType | string;
  remainingBalance: number;
  referenceNo?: string;
  tripLrNumber?: string;
}

/**
 * Prepares a manual-review WhatsApp Payment Receipt message.
 */
export function buildPaymentReceiptWhatsAppMessage(params: PaymentReceiptMessageParams): string {
  const company = (params.companyName || 'BAPASITARAM ENTERPRISE').trim();
  const formattedDate = formatDateIN(params.paymentDate);
  const formattedAmount = formatINR(params.amount);
  const absRemaining = Math.abs(params.remainingBalance);
  const remainingLine =
    params.remainingBalance > 0
      ? formatINR(params.remainingBalance)
      : params.remainingBalance < 0
      ? `${formatINR(absRemaining)} (Advance Credit)`
      : '₹0.00 (Settled)';

  const lines: string[] = [
    `*${company}*`,
    'Payment Receipt Confirmation',
    '',
    `Dear ${params.partyName},`,
    'We acknowledge receipt of your payment with the details below:',
    '',
    `Party Name: ${params.partyName}`,
    `Payment Type: ${params.paymentType || 'Payment Received'}`,
    `Amount Received: ${formattedAmount}`,
    `Date: ${formattedDate}`,
    `Payment Mode: ${params.paymentMode}`,
  ];

  if (params.referenceNo?.trim()) {
    lines.push(`Reference / UTR: ${params.referenceNo.trim()}`);
  }
  if (params.tripLrNumber?.trim()) {
    lines.push(`Trip / LR No: ${params.tripLrNumber.trim()}`);
  }

  lines.push(`Remaining Balance: ${remainingLine}`);
  lines.push('');
  lines.push('Thank you for your continued business.');
  lines.push(`Regards, ${company}`);

  return lines.join('\n');
}

export interface BillShareMessageParams {
  companyName?: string;
  bill: Pick<
    Bill,
    | 'billNumber'
    | 'billDate'
    | 'partyName'
    | 'freightTotal'
    | 'advanceTotal'
    | 'netPayable'
    | 'lineItems'
    | 'bankDetails'
  >;
  pdfFileName: string;
}

/**
 * Prepares a manual-review WhatsApp message accompanying a Freight Bill PDF.
 */
export function buildBillShareWhatsAppMessage(params: BillShareMessageParams): string {
  const company = (params.companyName || 'BAPASITARAM ENTERPRISE').trim();
  const { bill, pdfFileName } = params;
  const tripCount = bill.lineItems.length;

  const lines: string[] = [
    `*${company}*`,
    `Freight Bill — ${bill.billNumber}`,
    '',
    `Dear ${bill.partyName},`,
    `Please find attached Freight Bill ${bill.billNumber} (${pdfFileName}).`,
    '',
    `Bill No: ${bill.billNumber}`,
    `Bill Date: ${formatDateIN(bill.billDate)}`,
    `Trips Included: ${tripCount}`,
    `Freight Total: ${formatINR(bill.freightTotal)}`,
  ];

  if (bill.advanceTotal > 0) {
    lines.push(`Advance Received (Jama): ${formatINR(bill.advanceTotal)}`);
  }

  lines.push(`Net Payable: ${formatINR(bill.netPayable)}`);

  if (bill.bankDetails?.trim()) {
    lines.push('');
    lines.push(`Bank Details: ${bill.bankDetails.trim()}`);
  }

  lines.push('');
  lines.push('Kindly review and arrange payment as per agreed terms.');
  lines.push(`Regards, ${company}`);

  return lines.join('\n');
}

export interface PendingTripDueItem {
  lrNumber: string;
  tripDate: string;
  vehicleNumber: string;
  remainingDue: number;
}

export interface PaymentReminderMessageParams {
  companySettings?: CompanySettings | null;
  partyName: string;
  outstandingBalance: number;
  totalFreight: number;
  totalPaid: number;
  paymentTermsDays?: number;
  pendingTrips?: PendingTripDueItem[];
  todayISO?: string;
}

function addDaysISO(isoDate: string, days: number): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

/**
 * Prepares a manual-review WhatsApp Payment Reminder message with party name,
 * outstanding balance, credit terms, and pending trip/due details.
 */
export function buildPaymentReminderWhatsAppMessage(
  params: PaymentReminderMessageParams
): string {
  const company = (params.companySettings?.companyName || 'BAPASITARAM ENTERPRISE').trim();
  const termsDays = Math.max(0, Number(params.paymentTermsDays) || 0);
  const pendingTrips = (params.pendingTrips || [])
    .filter((t) => t.remainingDue > 0)
    .slice()
    .sort((a, b) => a.tripDate.localeCompare(b.tripDate));

  const lines: string[] = [
    `*${company}*`,
    'Payment Reminder',
    '',
    `Dear ${params.partyName},`,
  ];

  if (params.outstandingBalance > 0) {
    lines.push(
      `This is a gentle reminder regarding your pending freight account balance with ${company}.`
    );
  } else {
    lines.push(`Sharing your current freight account ledger summary with ${company}.`);
  }

  lines.push('');
  lines.push(`Party Name: ${params.partyName}`);
  lines.push(`Total Freight Billed: ${formatINR(params.totalFreight)}`);
  lines.push(`Payments Received: ${formatINR(params.totalPaid)}`);
  lines.push(
    `Outstanding Balance: ${
      params.outstandingBalance > 0
        ? formatINR(params.outstandingBalance)
        : params.outstandingBalance < 0
        ? `${formatINR(Math.abs(params.outstandingBalance))} (Advance Credit)`
        : '₹0.00 (Settled)'
    }`
  );

  if (termsDays > 0) {
    lines.push(`Credit Terms: ${termsDays} days`);
  }

  if (pendingTrips.length > 0 && params.outstandingBalance > 0) {
    const oldest = pendingTrips[0];
    const oldestDueIso = termsDays > 0 ? addDaysISO(oldest.tripDate, termsDays) : oldest.tripDate;
    const isOverdue = Boolean(params.todayISO && oldestDueIso && oldestDueIso < params.todayISO);

    lines.push('');
    lines.push(
      `Due Details (${pendingTrips.length} pending ${
        pendingTrips.length === 1 ? 'trip' : 'trips'
      }${oldestDueIso ? ` · Oldest Due: ${formatDateIN(oldestDueIso)}${isOverdue ? ' [Overdue]' : ''}` : ''}):`
    );

    pendingTrips.slice(0, 5).forEach((t) => {
      lines.push(
        `- ${formatDateIN(t.tripDate)} | LR ${t.lrNumber} (${t.vehicleNumber}): ${formatINR(t.remainingDue)}`
      );
    });
    if (pendingTrips.length > 5) {
      lines.push(`- ...and ${pendingTrips.length - 5} more pending trips`);
    }
  }

  const bankLine = buildBankSummaryLines(params.companySettings);
  if (bankLine) {
    lines.push('');
    lines.push(`Bank Details: ${bankLine}`);
  }

  lines.push('');
  if (params.outstandingBalance > 0) {
    lines.push('Kindly arrange payment at the earliest and share the UTR/payment reference.');
    lines.push('Please ignore this message if payment has already been made.');
  } else {
    lines.push('Thank you for keeping your account up to date.');
  }
  lines.push(`Regards, ${company}`);

  return lines.join('\n');
}

/**
 * Converts a generated jsPDF document into a real browser File object (`application/pdf`)
 * suitable for native Web Share API file sharing or download.
 */
export function createPdfFileFromJsPdf(pdf: jsPDF, fileName: string): File {
  const safeName = fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
  const blob = pdf.output('blob');
  return new File([blob], safeName, { type: 'application/pdf' });
}

/**
 * Checks whether the current browser supports sharing an actual PDF File via the
 * Web Share API Level 2 (e.g., Android Chrome, iOS Safari, supported desktop shells).
 */
export function canSharePdfFileViaWebShare(file: File): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export type NativeFileShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'error';

/**
 * Attempts to share an actual PDF File via the native OS share sheet (where the user
 * selects WhatsApp and manually confirms sending). Never sends automatically.
 */
export async function sharePdfFileViaWebShare(params: {
  file: File;
  title: string;
  text: string;
}): Promise<{ outcome: NativeFileShareOutcome; message?: string }> {
  if (!canSharePdfFileViaWebShare(params.file)) {
    return {
      outcome: 'unsupported',
      message:
        'Direct PDF file sharing is not supported by this browser. Download the PDF and attach it in WhatsApp.',
    };
  }

  try {
    await navigator.share({
      files: [params.file],
      title: params.title,
      text: params.text,
    });
    return { outcome: 'shared' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { outcome: 'cancelled' };
    }
    return {
      outcome: 'error',
      message: err instanceof Error ? err.message : 'Unable to open native file share sheet.',
    };
  }
}
