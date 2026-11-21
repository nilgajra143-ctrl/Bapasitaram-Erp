import {
  BLUEPRINT_LIMITS,
  type CompanySettings,
  type LorryReceipt,
  type Trip,
} from '../types/erp';
import { formatDateIN, formatINR } from './formatters';

export const LR_DEVOTIONAL_HEADER = '|| માં આશાપુરા || માં મોગલ || માં ગાત્રોળ ||';
export const LR_COMPANY_NAME = 'BAPASITARAM ENTERPRISE';
export const LR_CONTACT_LEFT = '9537379915';
export const LR_CONTACT_RIGHT = '8128202784';
export const DEFAULT_LR_PREFIX = 'BSE-LR-';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Normalizes an LR number for strict duplicate detection (case-insensitive, trimmed, collapsed spaces).
 */
export function normalizeLrKey(raw: string | null | undefined): string {
  return (raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Calculates LR Balance Amount (Total Freight - Advance Amount) rounded to 2 decimal places.
 */
export function calculateLrBalance(totalFreightAmount: number, advanceAmount: number): number {
  const safeTotal = Number.isFinite(totalFreightAmount) ? totalFreightAmount : 0;
  const safeAdvance = Number.isFinite(advanceAmount) ? advanceAmount : 0;
  return round2(safeTotal - safeAdvance);
}

/**
 * Checks whether a candidate LR number already exists in saved Lorry Receipts.
 */
export function findDuplicateLorryReceipt(
  receipts: Pick<LorryReceipt, 'id' | 'lrNumber'>[],
  candidateLrNumber: string,
  excludeId?: string
): Pick<LorryReceipt, 'id' | 'lrNumber'> | undefined {
  const target = normalizeLrKey(candidateLrNumber);
  if (!target) return undefined;
  return receipts.find((r) => r.id !== excludeId && normalizeLrKey(r.lrNumber) === target);
}

/**
 * Generates the next automatic unique LR number (e.g., BSE-LR-0001) guaranteed not to duplicate
 * any existing LR number in `lorryReceipts` or `trips`.
 */
export function generateNextUniqueLrNumber(
  lorryReceipts: Pick<LorryReceipt, 'lrNumber'>[],
  trips: Pick<Trip, 'lrNumber'>[] = [],
  companySettings?: Pick<CompanySettings, 'lrPrefix' | 'nextLrSeq'> | null
): { lrNumber: string; nextSeq: number; prefix: string } {
  const rawPrefix = (companySettings?.lrPrefix || DEFAULT_LR_PREFIX).trim();
  const prefix = rawPrefix.slice(0, BLUEPRINT_LIMITS.LR_PREFIX_MAX) || DEFAULT_LR_PREFIX;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seqRegex = new RegExp(`^${escapedPrefix}0*(\\d+)$`, 'i');

  const usedKeys = new Set<string>();
  let maxSeq = Math.max(0, Math.floor(Number(companySettings?.nextLrSeq) || 1) - 1);

  const inspectLr = (lrVal: string | undefined) => {
    const trimmed = (lrVal || '').trim();
    if (!trimmed) return;
    usedKeys.add(normalizeLrKey(trimmed));
    const match = trimmed.match(seqRegex);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > maxSeq) {
        maxSeq = parsed;
      }
    }
  };

  lorryReceipts.forEach((lr) => inspectLr(lr.lrNumber));
  trips.forEach((t) => inspectLr(t.lrNumber));

  let candidateSeq = Math.max(1, maxSeq + 1);
  let candidate = `${prefix}${String(candidateSeq).padStart(4, '0')}`;
  while (usedKeys.has(normalizeLrKey(candidate))) {
    candidateSeq += 1;
    candidate = `${prefix}${String(candidateSeq).padStart(4, '0')}`;
  }

  return {
    lrNumber: candidate,
    nextSeq: candidateSeq + 1,
    prefix,
  };
}

export interface LorryReceiptFilterOptions {
  searchQuery?: string;
  fromDate?: string;
  toDate?: string;
  vehicleFilter?: string;
}

/**
 * Filters Lorry Receipts by LR number, date range, party (consignor/consignee), vehicle,
 * container number, route, or driver.
 */
export function filterLorryReceipts(
  receipts: LorryReceipt[],
  options: LorryReceiptFilterOptions
): LorryReceipt[] {
  const query = (options.searchQuery || '').trim().toLowerCase();
  const fromDate = (options.fromDate || '').trim();
  const toDate = (options.toDate || '').trim();
  const vehicleFilter = normalizeLrKey(options.vehicleFilter || '');

  return receipts.filter((lr) => {
    if (fromDate && lr.lrDate && lr.lrDate < fromDate) return false;
    if (toDate && lr.lrDate && lr.lrDate > toDate) return false;

    if (vehicleFilter && normalizeLrKey(lr.vehicleNumber) !== vehicleFilter) {
      return false;
    }

    if (!query) return true;

    const haystack = [
      lr.lrNumber,
      lr.lrDate,
      formatDateIN(lr.lrDate),
      lr.vehicleNumber,
      lr.consignorName,
      lr.consignorAddress,
      lr.consigneeName,
      lr.consigneeAddress,
      lr.origin,
      lr.destination,
      lr.containerNo,
      lr.goodsDescription,
      lr.driverName,
      lr.driverMobile,
      lr.tripRefLr,
      lr.remarks,
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });
}

/**
 * Builds a manual-review WhatsApp message for sharing a Lorry Receipt (LR).
 * Intentionally omits bank account details and QR codes per company LR policy.
 */
export function buildLorryReceiptWhatsAppMessage(
  lr: Pick<
    LorryReceipt,
    | 'lrNumber'
    | 'lrDate'
    | 'vehicleNumber'
    | 'consignorName'
    | 'consigneeName'
    | 'origin'
    | 'destination'
    | 'containerNo'
    | 'goodsDescription'
    | 'quantityWeight'
    | 'freightRate'
    | 'totalFreightAmount'
    | 'advanceAmount'
    | 'balanceAmount'
    | 'driverName'
    | 'driverMobile'
    | 'remarks'
  >,
  pdfFileName?: string
): string {
  const lines: string[] = [
    LR_DEVOTIONAL_HEADER,
    `*${LR_COMPANY_NAME}*`,
    `Lorry Receipt (LR) — ${lr.lrNumber}`,
    `Contacts: ${LR_CONTACT_LEFT} / ${LR_CONTACT_RIGHT}`,
    '',
    `LR No: ${lr.lrNumber}`,
    `LR Date: ${formatDateIN(lr.lrDate)}`,
    `Vehicle No: ${lr.vehicleNumber}`,
    `Route: ${lr.origin} → ${lr.destination}`,
    `Consignor: ${lr.consignorName}`,
    `Consignee: ${lr.consigneeName}`,
  ];

  if (lr.containerNo.trim()) {
    lines.push(`Container No: ${lr.containerNo.trim()}`);
  }

  lines.push(`Goods: ${lr.goodsDescription}`);
  if (lr.quantityWeight.trim()) {
    lines.push(`Qty / Weight: ${lr.quantityWeight.trim()}`);
  }

  lines.push('');
  if (lr.freightRate > 0) {
    lines.push(`Freight Rate: ${formatINR(lr.freightRate)}`);
  }
  lines.push(`Total Freight: ${formatINR(lr.totalFreightAmount)}`);
  lines.push(`Advance: ${formatINR(lr.advanceAmount)}`);
  lines.push(`Balance: ${formatINR(lr.balanceAmount)}`);

  if (lr.driverName.trim() || lr.driverMobile.trim()) {
    lines.push('');
    const driverLabel = [lr.driverName.trim(), lr.driverMobile.trim()].filter(Boolean).join(' · ');
    lines.push(`Driver: ${driverLabel}`);
  }

  if (lr.remarks.trim()) {
    lines.push(`Remarks: ${lr.remarks.trim()}`);
  }

  if (pdfFileName?.trim()) {
    lines.push('');
    lines.push(`LR PDF File: ${pdfFileName.trim()}`);
  }

  lines.push('');
  lines.push(`Regards, ${LR_COMPANY_NAME}`);
  return lines.join('\n');
}

const VALID_LOGO_DATA_URL_REGEX = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export function isValidCompanyLogoDataUrl(value: string | null | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return true;
  return (
    trimmed.length <= BLUEPRINT_LIMITS.LOGO_DATA_URL_MAX &&
    VALID_LOGO_DATA_URL_REGEX.test(trimmed)
  );
}

/**
 * Compresses and scales an Admin-uploaded company logo image (PNG/JPEG/WebP) in the browser
 * using an offscreen canvas so it stays crisp in A4 LR headers and strictly within Firestore limits.
 */
export async function compressLogoImageFile(file: File): Promise<string> {
  const allowedMime = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowedMime.includes(file.type)) {
    throw new Error('Please upload a PNG, JPG, or WebP logo image.');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('Logo image must be smaller than 5 MB before compression.');
  }

  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Could not read the selected logo file.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read the selected logo file.'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Selected file is not a valid image.'));
    image.src = rawDataUrl;
  });

  const maxW = 360;
  const maxH = 160;
  const scale = Math.min(1, maxW / Math.max(1, img.width), maxH / Math.max(1, img.height));
  const targetW = Math.max(1, Math.round(img.width * scale));
  const targetH = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to initialize canvas for logo optimization.');
  }
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);

  // Prefer PNG for crisp transparent logos; fall back to WebP/JPEG if PNG exceeds size ceiling
  let encoded = canvas.toDataURL('image/png');
  if (encoded.length > BLUEPRINT_LIMITS.LOGO_DATA_URL_MAX - 5000) {
    encoded = canvas.toDataURL('image/webp', 0.88);
  }
  if (encoded.length > BLUEPRINT_LIMITS.LOGO_DATA_URL_MAX - 5000) {
    // White background fallback for JPEG if needed
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(img, 0, 0, targetW, targetH);
    encoded = canvas.toDataURL('image/jpeg', 0.82);
  }

  if (!isValidCompanyLogoDataUrl(encoded)) {
    throw new Error(
      'Logo image is too large even after compression. Please upload a cleaner, smaller logo (PNG/JPG/WebP).'
    );
  }

  return encoded;
}
