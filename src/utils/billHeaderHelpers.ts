import {
  BLUEPRINT_LIMITS,
  type Bill,
  type CompanySettings,
} from '../types/erp';

export const BILL_HEADER_DEVOTIONAL_LINE =
  '|| માં આશાપુરા || માં મોગલ || માં ગાત્રોળ ||';
export const BILL_HEADER_COMPANY_NAME = 'BAPASITARAM ENTERPRISE';
export const BILL_HEADER_CONTACT_LEFT = '9537379915';
export const BILL_HEADER_CONTACT_RIGHT = '8128202784';
export const BILL_HEADER_LEFT_TRUCK_REG = 'GJ12 BV6552';
export const BILL_HEADER_RIGHT_TRUCK_REG = 'GJ12 CT4312';

const SAFE_TRUCK_DATA_URL_REGEX =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export interface DualTruckCropOptions {
  /** Horizontal split point (%) between left truck (GJ12 BV6552) and right truck (GJ12 CT4312). Default 50. */
  splitPercent?: number;
  /** Top vertical trim (%). Default 2. */
  topTrimPercent?: number;
  /** Bottom vertical trim (%). Default 2. */
  bottomTrimPercent?: number;
  /** Outer left/right edge trim (%). Default 1. */
  outerMarginPercent?: number;
  /** Gap around split center (%) to prevent overlap between trucks. Default 0.5. */
  centerGapPercent?: number;
}

export interface PixelCropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface DualTruckCropResult {
  leftTruckDataUrl: string;
  rightTruckDataUrl: string;
  sourceDataUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  leftRect: PixelCropRect;
  rightRect: PixelCropRect;
}

export function isValidBillHeaderTruckDataUrl(value: string): boolean {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  if (value.length > BLUEPRINT_LIMITS.BILL_HEADER_TRUCK_DATA_URL_MAX) return false;
  return SAFE_TRUCK_DATA_URL_REGEX.test(value);
}

/**
 * Computes exact pixel crop rectangles for splitting a single uploaded photo
 * containing BOTH vehicles into Left Truck (GJ12 BV6552) and Right Truck (GJ12 CT4312)
 * without stretching or clipping.
 */
export function computeDualTruckCropRects(
  sourceWidth: number,
  sourceHeight: number,
  options: DualTruckCropOptions = {}
): { leftRect: PixelCropRect; rightRect: PixelCropRect } {
  const safeW = Math.max(20, Math.round(sourceWidth));
  const safeH = Math.max(20, Math.round(sourceHeight));

  const splitPct = Math.min(70, Math.max(30, options.splitPercent ?? 50));
  const topPct = Math.min(35, Math.max(0, options.topTrimPercent ?? 2));
  const bottomPct = Math.min(35, Math.max(0, options.bottomTrimPercent ?? 2));
  const outerPct = Math.min(15, Math.max(0, options.outerMarginPercent ?? 1));
  const gapPct = Math.min(8, Math.max(0, options.centerGapPercent ?? 0.5));

  const sy = Math.round((safeH * topPct) / 100);
  const bottomPx = Math.round((safeH * bottomPct) / 100);
  const sh = Math.max(10, safeH - sy - bottomPx);

  const leftStart = Math.round((safeW * outerPct) / 100);
  const splitPx = Math.round((safeW * splitPct) / 100);
  const halfGapPx = Math.round((safeW * gapPct) / 100);
  const rightEnd = Math.max(splitPx + 10, safeW - leftStart);

  const leftEnd = Math.max(leftStart + 10, splitPx - halfGapPx);
  const rightStart = Math.min(rightEnd - 10, splitPx + halfGapPx);

  return {
    leftRect: {
      sx: leftStart,
      sy,
      sw: Math.max(10, leftEnd - leftStart),
      sh,
    },
    rightRect: {
      sx: rightStart,
      sy,
      sw: Math.max(10, rightEnd - rightStart),
      sh,
    },
  };
}

/**
 * Resolves company address strictly from verified Admin Settings.
 * Never invents or inserts placeholder addresses.
 */
export function resolveVerifiedCompanyAddress(
  companySettings: Pick<CompanySettings, 'address'> | null | undefined,
  activeSettingsAddress?: string
): string {
  const fromSettings = (companySettings?.address || '').trim();
  if (fromSettings) return fromSettings;
  const fromForm = (activeSettingsAddress || '').trim();
  return fromForm;
}

/**
 * Resolves bank details strictly from saved bill or verified Admin Settings.
 * Returns empty string if unconfigured (never invents sample bank details).
 */
export function resolveVerifiedBillBankDetails(
  bill: Pick<Bill, 'bankDetails'>,
  companySettings?: Pick<
    CompanySettings,
    'bankName' | 'accountHolderName' | 'accountNumber' | 'ifscCode' | 'branchName'
  > | null
): string {
  const direct = (bill.bankDetails || '').trim();
  if (direct) return direct;
  if (!companySettings) return '';
  return [
    companySettings.bankName ? `Bank: ${companySettings.bankName}` : '',
    companySettings.accountHolderName ? `A/c Name: ${companySettings.accountHolderName}` : '',
    companySettings.accountNumber ? `A/c No: ${companySettings.accountNumber}` : '',
    companySettings.ifscCode ? `IFSC: ${companySettings.ifscCode}` : '',
    companySettings.branchName ? `Branch: ${companySettings.branchName}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Could not read the uploaded truck photo.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read truck photo file.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error('Uploaded file could not be decoded as a valid photo.'));
    img.src = src;
  });
}

function renderCroppedRegionToBoundedJpeg(
  img: HTMLImageElement,
  rect: PixelCropRect
): string {
  const maxCharBudget = 190000; // safely below 200,000 firestore.rules limit
  const maxDimSteps = [680, 560, 460, 380];
  const qualitySteps = [0.88, 0.8, 0.72, 0.62];

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Browser canvas is unavailable for truck photo cropping.');
  }

  for (const maxDim of maxDimSteps) {
    const scale = Math.min(1, maxDim / Math.max(rect.sw, rect.sh));
    const targetW = Math.max(1, Math.round(rect.sw * scale));
    const targetH = Math.max(1, Math.round(rect.sh * scale));
    canvas.width = targetW;
    canvas.height = targetH;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(
      img,
      rect.sx,
      rect.sy,
      rect.sw,
      rect.sh,
      0,
      0,
      targetW,
      targetH
    );

    for (const quality of qualitySteps) {
      const candidate = canvas.toDataURL('image/jpeg', quality);
      if (candidate.length <= maxCharBudget && isValidBillHeaderTruckDataUrl(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    'Unable to optimize cropped truck photo within secure ERP storage limits.'
  );
}

/**
 * Crops a single real uploaded photo containing BOTH trucks into two separate
 * high-clarity aspect-preserved images:
 *   - Left Truck: GJ12 BV6552
 *   - Right Truck: GJ12 CT4312
 */
export async function cropDualTruckPhotoInBrowser(
  source: File | string,
  options: DualTruckCropOptions = {}
): Promise<DualTruckCropResult> {
  let sourceDataUrl = '';
  if (typeof source === 'string') {
    sourceDataUrl = source;
  } else {
    const typeLower = (source.type || '').toLowerCase();
    if (typeLower === 'image/svg+xml' || source.name.toLowerCase().endsWith('.svg')) {
      throw new Error('SVG files are not supported. Upload your actual truck photograph (JPEG, PNG, or WebP).');
    }
    if (typeLower && !typeLower.startsWith('image/')) {
      throw new Error('Please upload a valid JPEG, PNG, or WebP photograph of your trucks.');
    }
    sourceDataUrl = await readFileAsDataUrl(source);
  }

  const img = await loadImage(sourceDataUrl);
  const sourceWidth = img.naturalWidth || img.width || 1;
  const sourceHeight = img.naturalHeight || img.height || 1;

  const { leftRect, rightRect } = computeDualTruckCropRects(
    sourceWidth,
    sourceHeight,
    options
  );

  const leftTruckDataUrl = renderCroppedRegionToBoundedJpeg(img, leftRect);
  const rightTruckDataUrl = renderCroppedRegionToBoundedJpeg(img, rightRect);

  return {
    leftTruckDataUrl,
    rightTruckDataUrl,
    sourceDataUrl,
    sourceWidth,
    sourceHeight,
    leftRect,
    rightRect,
  };
}

/**
 * Optimizes a single uploaded real truck photograph without stretching or clipping.
 */
export async function prepareSingleTruckPhotoFromFile(file: File): Promise<string> {
  const typeLower = (file.type || '').toLowerCase();
  if (typeLower === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
    throw new Error('SVG files are not supported. Upload a real truck photograph.');
  }
  if (typeLower && !typeLower.startsWith('image/')) {
    throw new Error('Please upload a valid JPEG, PNG, or WebP photograph.');
  }
  const sourceDataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(sourceDataUrl);
  const sw = img.naturalWidth || img.width || 1;
  const sh = img.naturalHeight || img.height || 1;
  return renderCroppedRegionToBoundedJpeg(img, { sx: 0, sy: 0, sw, sh });
}
