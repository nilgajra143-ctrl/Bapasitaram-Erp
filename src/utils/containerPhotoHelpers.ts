import {
  BLUEPRINT_LIMITS,
  CONTAINER_PHOTO_TYPE,
  type ContainerPhotoCaptureSource,
  type ErpUserRole,
  type PendingContainerPhoto,
  type Trip,
} from '../types/erp';
import { clampStr } from './formatters';

const SAFE_CONTAINER_PHOTO_DATA_URL_REGEX =
  /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export interface PreparedContainerPhoto {
  photoDataUrl: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  fileSizeBytes: number;
  width: number;
  height: number;
  fileName: string;
  captureSource: ContainerPhotoCaptureSource;
  uploadedDate: string;
  uploadedTime: string;
  uploadedAtIso: string;
}

export interface ContainerPhotoTripMetadata {
  tripId: string;
  tripNumber: string;
  lrNumber: string;
  vehicleNumber: string;
  containerNumber: string;
}

export interface ContainerPhotoUploaderInfo {
  uid: string;
  displayName: string;
  email: string;
  role: ErpUserRole;
  ownerId: string;
}

export function validateContainerPhotoDataUrl(dataUrl: string): {
  valid: boolean;
  error?: string;
} {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return { valid: false, error: 'Container photo payload is empty.' };
  }
  const trimmed = dataUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      valid: false,
      error: 'Public external URLs are not permitted. Photos must be stored securely inside private ERP records.',
    };
  }
  if (/^data:image\/svg/i.test(trimmed)) {
    return {
      valid: false,
      error: 'SVG images are not supported. Capture or select a JPEG, PNG, or WebP photograph.',
    };
  }
  if (!SAFE_CONTAINER_PHOTO_DATA_URL_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Invalid image format. Only JPEG, PNG, or WebP rear-door container photos are allowed.',
    };
  }
  if (trimmed.length < 30) {
    return { valid: false, error: 'Image payload is corrupted or too small.' };
  }
  if (trimmed.length > BLUEPRINT_LIMITS.CONTAINER_PHOTO_DATA_URL_MAX) {
    return {
      valid: false,
      error: 'Compressed image still exceeds the secure ERP storage limit. Please retake a clearer photo.',
    };
  }
  return { valid: true };
}

export function estimateBase64ByteLength(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const base64Part = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const padding = base64Part.endsWith('==') ? 2 : base64Part.endsWith('=') ? 1 : 0;
  return Math.max(1, Math.floor((base64Part.length * 3) / 4) - padding);
}

export function formatLocalUploadDateTime(date: Date = new Date()): {
  uploadedDate: string;
  uploadedTime: string;
  uploadedAtIso: string;
} {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return {
    uploadedDate: `${year}-${month}-${day}`,
    uploadedTime: `${hours}:${minutes}:${seconds}`,
    uploadedAtIso: date.toISOString(),
  };
}

export function deriveTripNumber(trip: Pick<Trip, 'id' | 'srNo' | 'lrNumber'>): string {
  const sr = (trip.srNo || '').trim();
  if (sr) return clampStr(sr, BLUEPRINT_LIMITS.TRIP_NUMBER_MAX);
  const lr = (trip.lrNumber || '').trim();
  if (lr) return clampStr(lr, BLUEPRINT_LIMITS.TRIP_NUMBER_MAX);
  return clampStr(trip.id, BLUEPRINT_LIMITS.TRIP_NUMBER_MAX);
}

function sanitizeFileSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return cleaned || fallback;
}

export function buildContainerPhotoDownloadFileName(params: {
  containerNumber?: string;
  lrNumber?: string;
  vehicleNumber?: string;
  tripNumber?: string;
  mimeType?: string;
}): string {
  const ext =
    params.mimeType === 'image/png'
      ? 'png'
      : params.mimeType === 'image/webp'
      ? 'webp'
      : 'jpg';
  const containerSeg = sanitizeFileSegment(params.containerNumber || '', 'CONTAINER');
  const lrSeg = sanitizeFileSegment(params.lrNumber || params.tripNumber || '', 'TRIP');
  const vehSeg = sanitizeFileSegment(params.vehicleNumber || '', 'VEHICLE');
  return clampStr(
    `Container-RearDoors-${containerSeg}-${lrSeg}-${vehSeg}.${ext}`,
    BLUEPRINT_LIMITS.FILE_NAME_MAX
  );
}

export function buildPendingContainerPhotoRecord(params: {
  prepared: PreparedContainerPhoto;
  metadata: ContainerPhotoTripMetadata;
  uploader: ContainerPhotoUploaderInfo;
  now?: Date;
}): PendingContainerPhoto {
  const nowIso = (params.now || new Date()).toISOString();
  const safeTripNumber = clampStr(
    params.metadata.tripNumber || params.metadata.lrNumber || params.metadata.tripId,
    BLUEPRINT_LIMITS.TRIP_NUMBER_MAX
  );
  const safeLrNumber = clampStr(
    params.metadata.lrNumber || safeTripNumber,
    BLUEPRINT_LIMITS.LR_NUMBER_MAX
  );
  const safeVehicleNumber = clampStr(
    params.metadata.vehicleNumber || 'UNASSIGNED',
    BLUEPRINT_LIMITS.VEHICLE_REG_MAX
  );
  const safeContainerNumber = clampStr(
    (params.metadata.containerNumber || '').toUpperCase(),
    BLUEPRINT_LIMITS.CONTAINER_NO_MAX
  );
  const safeFileName = buildContainerPhotoDownloadFileName({
    containerNumber: safeContainerNumber,
    lrNumber: safeLrNumber,
    vehicleNumber: safeVehicleNumber,
    tripNumber: safeTripNumber,
    mimeType: params.prepared.mimeType,
  });

  return {
    tripId: params.metadata.tripId,
    tripNumber: safeTripNumber,
    lrNumber: safeLrNumber,
    vehicleNumber: safeVehicleNumber,
    containerNumber: safeContainerNumber,
    photoType: CONTAINER_PHOTO_TYPE,
    photoDataUrl: params.prepared.photoDataUrl,
    fileName: safeFileName,
    mimeType: params.prepared.mimeType,
    fileSizeBytes: Math.min(Math.max(1, Math.round(params.prepared.fileSizeBytes)), 600000),
    width: Math.min(Math.max(1, Math.round(params.prepared.width)), 4000),
    height: Math.min(Math.max(1, Math.round(params.prepared.height)), 4000),
    captureSource: params.prepared.captureSource,
    uploadedDate: clampStr(params.prepared.uploadedDate, BLUEPRINT_LIMITS.DATE_MAX),
    uploadedTime: clampStr(params.prepared.uploadedTime, BLUEPRINT_LIMITS.UPLOAD_TIME_MAX),
    uploadedAtIso: clampStr(params.prepared.uploadedAtIso, 40),
    uploadedByUid: params.uploader.uid,
    uploadedByName: clampStr(
      params.uploader.displayName || params.uploader.email || 'ERP Employee',
      BLUEPRINT_LIMITS.UPLOADER_NAME_MAX
    ),
    uploadedByEmail: clampStr(params.uploader.email || '', BLUEPRINT_LIMITS.EMAIL_MAX),
    uploadedByRole: params.uploader.role,
    ownerId: params.uploader.ownerId,
    queuedAtIso: nowIso,
    syncStatus: 'pending',
    retryCount: 0,
    lastError: '',
  };
}

export function buildFirestoreContainerPhotoFields(pending: PendingContainerPhoto) {
  const check = validateContainerPhotoDataUrl(pending.photoDataUrl);
  if (!check.valid) {
    throw new Error(check.error || 'Invalid container photo payload.');
  }
  return {
    tripId: pending.tripId,
    tripNumber: clampStr(pending.tripNumber, BLUEPRINT_LIMITS.TRIP_NUMBER_MAX),
    lrNumber: clampStr(pending.lrNumber, BLUEPRINT_LIMITS.LR_NUMBER_MAX),
    vehicleNumber: clampStr(pending.vehicleNumber, BLUEPRINT_LIMITS.VEHICLE_REG_MAX),
    containerNumber: clampStr(pending.containerNumber, BLUEPRINT_LIMITS.CONTAINER_NO_MAX),
    photoType: CONTAINER_PHOTO_TYPE,
    photoDataUrl: pending.photoDataUrl,
    fileName: clampStr(pending.fileName, BLUEPRINT_LIMITS.FILE_NAME_MAX),
    mimeType: pending.mimeType,
    fileSizeBytes: Math.min(Math.max(1, Math.round(pending.fileSizeBytes)), 600000),
    width: Math.min(Math.max(1, Math.round(pending.width)), 4000),
    height: Math.min(Math.max(1, Math.round(pending.height)), 4000),
    captureSource: pending.captureSource,
    uploadedDate: clampStr(pending.uploadedDate, BLUEPRINT_LIMITS.DATE_MAX),
    uploadedTime: clampStr(pending.uploadedTime, BLUEPRINT_LIMITS.UPLOAD_TIME_MAX),
    uploadedAtIso: clampStr(pending.uploadedAtIso, 40),
    uploadedByUid: pending.uploadedByUid,
    uploadedByName: clampStr(pending.uploadedByName, BLUEPRINT_LIMITS.UPLOADER_NAME_MAX),
    uploadedByEmail: clampStr(pending.uploadedByEmail, BLUEPRINT_LIMITS.EMAIL_MAX),
    uploadedByRole: pending.uploadedByRole,
    ownerId: pending.ownerId,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Could not read the selected image file.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read image file from device.'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error('Selected file could not be decoded as a valid photograph.'));
    img.src = src;
  });
}

/**
 * Validates and compresses a mobile camera or gallery photograph of the rear
 * shipping container doors so the printed Container Identification Number stays
 * crisp while fitting safely inside a private Firestore document (< 680KB chars).
 */
export async function prepareContainerPhotoFromFile(
  file: File,
  captureSource: ContainerPhotoCaptureSource
): Promise<PreparedContainerPhoto> {
  if (!file) {
    throw new Error('No photo file was selected.');
  }
  const typeLower = (file.type || '').toLowerCase();
  if (typeLower === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
    throw new Error('SVG files are not supported. Capture or choose a real photograph.');
  }
  if (typeLower && !typeLower.startsWith('image/')) {
    throw new Error('Only photograph files (JPEG, PNG, WebP) are accepted.');
  }
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('Selected photo is larger than 25 MB. Please choose a smaller photo.');
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  const img = await loadImageElement(rawDataUrl);

  const naturalWidth = img.naturalWidth || img.width || 1;
  const naturalHeight = img.naturalHeight || img.height || 1;

  // Target sharp legibility for printed Container ID numbers while keeping under 680,000 chars
  const maxCharBudget = 680000;
  const dimensionSteps = [1440, 1200, 960, 760];
  const qualitySteps = [0.84, 0.74, 0.64, 0.52];

  let finalDataUrl = '';
  let finalWidth = naturalWidth;
  let finalHeight = naturalHeight;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Browser image processor unavailable.');
  }

  for (const maxDim of dimensionSteps) {
    const scale = Math.min(1, maxDim / Math.max(naturalWidth, naturalHeight));
    const targetW = Math.max(1, Math.round(naturalWidth * scale));
    const targetH = Math.max(1, Math.round(naturalHeight * scale));
    canvas.width = targetW;
    canvas.height = targetH;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(img, 0, 0, targetW, targetH);

    for (const quality of qualitySteps) {
      const candidate = canvas.toDataURL('image/jpeg', quality);
      if (candidate.length <= maxCharBudget && estimateBase64ByteLength(candidate) <= 580000) {
        finalDataUrl = candidate;
        finalWidth = targetW;
        finalHeight = targetH;
        break;
      }
    }
    if (finalDataUrl) break;
  }

  if (!finalDataUrl) {
    throw new Error(
      'Unable to compress container photo within secure ERP storage limits. Please retake the photo.'
    );
  }

  const validation = validateContainerPhotoDataUrl(finalDataUrl);
  if (!validation.valid) {
    throw new Error(validation.error || 'Prepared container photo failed validation.');
  }

  const timestamp = formatLocalUploadDateTime(new Date());
  return {
    photoDataUrl: finalDataUrl,
    mimeType: 'image/jpeg',
    fileSizeBytes: estimateBase64ByteLength(finalDataUrl),
    width: finalWidth,
    height: finalHeight,
    fileName: clampStr(file.name || 'container-rear-doors.jpg', BLUEPRINT_LIMITS.FILE_NAME_MAX),
    captureSource,
    uploadedDate: timestamp.uploadedDate,
    uploadedTime: timestamp.uploadedTime,
    uploadedAtIso: timestamp.uploadedAtIso,
  };
}

export function downloadContainerPhotoDataUrl(
  photoDataUrl: string,
  fileName: string
): void {
  const check = validateContainerPhotoDataUrl(photoDataUrl);
  if (!check.valid) return;

  const [header, base64Data] = photoDataUrl.split(',');
  if (!header || !base64Data) return;
  const mimeMatch = header.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64$/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName || 'container-rear-doors.jpg';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
}

export function formatPhotoSizeKB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
