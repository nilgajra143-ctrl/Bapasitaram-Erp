import * as XLSX from 'xlsx';
import { BLUEPRINT_LIMITS, type PaymentStatus, type Trip } from '../types/erp';

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrCompactFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export function formatINR(value: number, compact = false): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  return compact
    ? inrCompactFormatter.format(safeValue)
    : inrFormatter.format(safeValue);
}

export function formatNumberIN(value: number, decimals = 2): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  return safeValue.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatDateIN(dateStr: string): string {
  if (!dateStr) return '—';
  const parsed = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(parsed.getTime())) return dateStr;
  return parsed.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function getTodayISO(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDaysUntilExpiry(dateStr: string): number | null {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffMs = target.getTime() - today.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export function clampStr(val: string, maxLen: number): string {
  return val.trim().slice(0, maxLen);
}

export function clampNum(val: number | string, min: number, max: number): number {
  const num = typeof val === 'number' ? val : parseFloat(val);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, Math.round(num * 100) / 100));
}

export function derivePaymentStatus(freight: number, advance: number): PaymentStatus {
  if (freight <= 0) return advance > 0 ? 'Paid' : 'Unpaid';
  if (advance >= freight) return 'Paid';
  if (advance > 0) return 'Partial';
  return 'Unpaid';
}

export function generateSafeDocId(prefix: string): string {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const raw = `${prefix}_${randomPart}`;
  return BLUEPRINT_LIMITS.ID_PATTERN.test(raw) ? raw : `${prefix}_${Date.now()}`;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function twoDigitWords(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  const ten = Math.floor(n / 10);
  const one = n % 10;
  return one ? `${TENS[ten]} ${ONES[one]}` : TENS[ten];
}

function threeDigitWords(n: number): string {
  const hundred = Math.floor(n / 100);
  const rem = n % 100;
  if (hundred && rem) return `${ONES[hundred]} Hundred ${twoDigitWords(rem)}`;
  if (hundred) return `${ONES[hundred]} Hundred`;
  return twoDigitWords(rem);
}

export function rupeesInWords(amount: number): string {
  if (!Number.isFinite(amount)) return 'Rupees Zero Only';
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);

  if (rupees === 0 && paise === 0) return 'Rupees Zero Only';

  let n = rupees;
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const remainder = n;

  const parts: string[] = [];
  if (crore > 0) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigitWords(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigitWords(thousand)} Thousand`);
  if (remainder > 0) parts.push(threeDigitWords(remainder));

  const rupeesText = parts.length > 0 ? `Rupees ${parts.join(' ')}` : 'Rupees Zero';
  const paiseText = paise > 0 ? ` and ${twoDigitWords(paise)} Paise` : '';
  const prefix = negative ? 'Minus ' : '';
  return clampStr(`${prefix}${rupeesText}${paiseText} Only`, BLUEPRINT_LIMITS.WORDS_MAX);
}

export function buildTripExcelRows(trips: Trip[]): Record<string, string | number>[] {
  return trips.map((t, index) => ({
    'Sr No': t.srNo || String(index + 1),
    Date: t.tripDate,
    'LR No': t.lrNumber,
    'Vehicle No': t.vehicleNumber,
    'Party Name': t.partyName,
    From: t.origin,
    To: t.destination,
    'Container No': t.containerNo || '',
    Rate: t.freightAmount,
    Kharcha: t.otherExpense,
    'Diesel Quantity (L)': t.dieselQuantity ?? 0,
    'Diesel Amount (INR)': t.dieselExpense,
    Toll: t.tollExpense,
    'Driver Bhatta': t.driverAllowance,
    'Total Expenses': t.totalExpense,
    Jama: t.advanceReceived,
    Hisab: t.balanceAmount,
    Note: t.notes,
    Driver: t.driverName,
    Material: t.material || '',
    'Weight (MT)': t.weightTons ?? '',
    'Trip Status': t.tripStatus,
    'Payment Status': t.paymentStatus,
    'POD Received': t.podReceived ? 'Yes' : 'No',
  }));
}

export function exportTripsToExcel(trips: Trip[], fileNamePrefix = 'bapasitaram-trips'): void {
  const rows = buildTripExcelRows(trips);
  exportSheetsToExcel([{ name: 'Trips Ledger', rows }], `${fileNamePrefix}-${getTodayISO()}.xlsx`);
}

export function exportSheetsToExcel(
  sheets: { name: string; rows: Record<string, string | number | boolean | null | undefined>[] }[],
  fileName: string
): void {
  const wb = XLSX.utils.book_new();
  sheets.forEach((s) => {
    const safeRows = s.rows.length > 0 ? s.rows : [{ Status: 'No records' }];
    const ws = XLSX.utils.json_to_sheet(safeRows);
    const safeName = s.name.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet';
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  });
  XLSX.writeFile(wb, fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`);
}

export function exportTripsToCSV(trips: Trip[]): void {
  const headers = [
    'Sr No',
    'Date',
    'LR Number',
    'Vehicle No',
    'Party Name',
    'From',
    'To',
    'Container No',
    'Rate (INR)',
    'Kharcha (INR)',
    'Diesel Quantity (L)',
    'Diesel Amount (INR)',
    'Toll (INR)',
    'Driver Bhatta (INR)',
    'Total Expense (INR)',
    'Jama (INR)',
    'Hisab (INR)',
    'Note',
    'Trip Status',
    'Payment Status',
    'POD Received',
  ];

  const escapeCsv = (cell: string | number | boolean): string => {
    const str = String(cell ?? '');
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = trips.map((t, idx) =>
    [
      t.srNo || String(idx + 1),
      t.tripDate,
      t.lrNumber,
      t.vehicleNumber,
      t.partyName,
      t.origin,
      t.destination,
      t.containerNo || '',
      t.freightAmount,
      t.otherExpense,
      t.dieselQuantity ?? 0,
      t.dieselExpense,
      t.tollExpense,
      t.driverAllowance,
      t.totalExpense,
      t.advanceReceived,
      t.balanceAmount,
      t.notes,
      t.tripStatus,
      t.paymentStatus,
      t.podReceived ? 'Yes' : 'No',
    ]
      .map(escapeCsv)
      .join(',')
  );

  const csvContent = [headers.map(escapeCsv).join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bapasitaram-trips-${getTodayISO()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
