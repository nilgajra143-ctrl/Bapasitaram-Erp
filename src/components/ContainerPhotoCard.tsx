import React, { useRef, useState } from 'react';
import {
  Camera,
  CloudOff,
  Download,
  Image as ImageIcon,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  ContainerPhotoCaptureSource,
  PendingContainerPhoto,
  TripContainerPhoto,
  UserPermissions,
} from '../types/erp';
import {
  buildContainerPhotoDownloadFileName,
  downloadContainerPhotoDataUrl,
  formatPhotoSizeKB,
  prepareContainerPhotoFromFile,
  type PreparedContainerPhoto,
} from '../utils/containerPhotoHelpers';
import { formatDateIN } from '../utils/formatters';
import { ConfirmDialog } from './ConfirmDialog';

type ZoomLevel = 100 | 150 | 200 | 300;
const ZOOM_LEVELS: ZoomLevel[] = [100, 150, 200, 300];

const ZOOM_WIDTH_CLASS: Record<ZoomLevel, string> = {
  100: 'w-full',
  150: 'w-[150%]',
  200: 'w-[200%]',
  300: 'w-[300%]',
};

interface ContainerPhotoCardProps {
  tripNumber: string;
  lrNumber: string;
  vehicleNumber: string;
  containerNumber: string;
  syncedPhoto: TripContainerPhoto | null;
  pendingPhoto: PendingContainerPhoto | null;
  stagedPhoto?: PreparedContainerPhoto | null;
  permissions: UserPermissions;
  isOnline: boolean;
  syncing?: boolean;
  canCapture?: boolean;
  onCapturePrepared: (prepared: PreparedContainerPhoto) => Promise<void> | void;
  onClearStaged?: () => void;
  onDeleteSynced?: (photo: TripContainerPhoto) => Promise<void>;
  onDiscardPending?: (tripId: string) => Promise<void>;
  onSyncNow?: () => Promise<void>;
}

export const ContainerPhotoCard: React.FC<ContainerPhotoCardProps> = ({
  tripNumber,
  lrNumber,
  vehicleNumber,
  containerNumber,
  syncedPhoto,
  pendingPhoto,
  stagedPhoto = null,
  permissions,
  isOnline,
  syncing = false,
  canCapture = true,
  onCapturePrepared,
  onClearStaged,
  onDeleteSynced,
  onDiscardPending,
  onSyncNow,
}) => {
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const [processing, setProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(100);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Active photo display priority: staged (unsaved new trip) -> pending offline queue -> synced Firestore photo
  const activeMode: 'staged' | 'pending' | 'synced' | 'empty' = stagedPhoto
    ? 'staged'
    : pendingPhoto
    ? 'pending'
    : syncedPhoto
    ? 'synced'
    : 'empty';

  const activeDataUrl =
    stagedPhoto?.photoDataUrl ||
    pendingPhoto?.photoDataUrl ||
    syncedPhoto?.photoDataUrl ||
    '';

  const activeFileName =
    stagedPhoto
      ? buildContainerPhotoDownloadFileName({
          containerNumber,
          lrNumber,
          vehicleNumber,
          tripNumber,
          mimeType: stagedPhoto.mimeType,
        })
      : pendingPhoto?.fileName ||
        syncedPhoto?.fileName ||
        buildContainerPhotoDownloadFileName({
          containerNumber,
          lrNumber,
          vehicleNumber,
          tripNumber,
        });

  const activeUploadDate =
    stagedPhoto?.uploadedDate ||
    pendingPhoto?.uploadedDate ||
    syncedPhoto?.uploadedDate ||
    '';
  const activeUploadTime =
    stagedPhoto?.uploadedTime ||
    pendingPhoto?.uploadedTime ||
    syncedPhoto?.uploadedTime ||
    '';
  const activeCaptureSource =
    stagedPhoto?.captureSource ||
    pendingPhoto?.captureSource ||
    syncedPhoto?.captureSource ||
    null;
  const activeSizeBytes =
    stagedPhoto?.fileSizeBytes ||
    pendingPhoto?.fileSizeBytes ||
    syncedPhoto?.fileSizeBytes ||
    0;
  const activeDimensions =
    stagedPhoto
      ? `${stagedPhoto.width} × ${stagedPhoto.height}px`
      : pendingPhoto
      ? `${pendingPhoto.width} × ${pendingPhoto.height}px`
      : syncedPhoto
      ? `${syncedPhoto.width} × ${syncedPhoto.height}px`
      : '';

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
    source: ContainerPhotoCaptureSource
  ) => {
    const file = event.target.files?.[0];
    // Reset input value so re-capturing or picking the same image triggers onChange
    event.target.value = '';
    if (!file) return;

    setErrorMsg(null);
    setStatusMsg(null);
    setProcessing(true);
    try {
      const prepared = await prepareContainerPhotoFromFile(file, source);
      await onCapturePrepared(prepared);
      if (!stagedPhoto && !isOnline) {
        setStatusMsg(
          'Rear container door photo saved safely offline. It will upload automatically when internet returns.'
        );
      } else {
        setStatusMsg(
          source === 'camera'
            ? 'Rear container door photo captured from camera.'
            : 'Rear container door photo selected from gallery.'
        );
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Could not process the selected container photo.'
      );
    } finally {
      setProcessing(false);
    }
  };

  const handleDownload = () => {
    if (!activeDataUrl) return;
    downloadContainerPhotoDataUrl(activeDataUrl, activeFileName);
  };

  const handleZoomIn = () => {
    const idx = ZOOM_LEVELS.indexOf(zoomLevel);
    if (idx < ZOOM_LEVELS.length - 1) {
      setZoomLevel(ZOOM_LEVELS[idx + 1]);
    }
  };

  const handleZoomOut = () => {
    const idx = ZOOM_LEVELS.indexOf(zoomLevel);
    if (idx > 0) {
      setZoomLevel(ZOOM_LEVELS[idx - 1]);
    }
  };

  const handleConfirmDelete = async () => {
    if (!permissions.isAdmin) return;
    setDeleting(true);
    setErrorMsg(null);
    try {
      if (pendingPhoto && onDiscardPending) {
        await onDiscardPending(pendingPhoto.tripId);
      }
      if (syncedPhoto && onDeleteSynced) {
        await onDeleteSynced(syncedPhoto);
      }
      setDeleteDialogOpen(false);
      setLightboxOpen(false);
      setStatusMsg('Container rear-door photo deleted by Admin.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to delete container photo.'
      );
    } finally {
      setDeleting(false);
    }
  };

  const linkedTripNumber =
    pendingPhoto?.tripNumber || syncedPhoto?.tripNumber || tripNumber || 'Auto on Save';
  const linkedLrNumber =
    pendingPhoto?.lrNumber || syncedPhoto?.lrNumber || lrNumber || '—';
  const linkedVehicleNumber =
    pendingPhoto?.vehicleNumber || syncedPhoto?.vehicleNumber || vehicleNumber || '—';
  const linkedContainerNumber =
    pendingPhoto?.containerNumber || syncedPhoto?.containerNumber || containerNumber || 'Not entered';

  return (
    <div className="space-y-4">
      {/* Scope & Requirement Notice */}
      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-900">
            Rear-Side Shipping Container Doors Photo (1 Photo Per Trip)
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600">
            <Lock className="w-3 h-3 text-slate-500" />
            Private ERP Record · Excluded from LR &amp; Bill PDFs
          </span>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          Upload <strong className="text-slate-900">only one</strong> rear-side photograph of the
          shipping container doors clearly showing the printed{' '}
          <strong className="text-slate-900">Container Identification Number</strong>. Replacing
          the photo updates this single slot.
        </p>

        {/* Linked Trip / LR / Vehicle / Container Metadata */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1.5 border-t border-slate-200 text-xs">
          <div className="bg-white border border-slate-200 rounded-md px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Trip No</div>
            <div className="font-mono font-semibold text-slate-900 truncate">
              {linkedTripNumber}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-md px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">LR No</div>
            <div className="font-mono font-semibold text-slate-900 truncate">
              {linkedLrNumber}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-md px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Vehicle No</div>
            <div className="font-mono font-semibold text-slate-900 truncate">
              {linkedVehicleNumber}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-md px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Container No</div>
            <div className="font-mono font-semibold text-slate-900 truncate">
              {linkedContainerNumber}
            </div>
          </div>
        </div>
      </div>

      {/* Hidden File Inputs: Dedicated Mobile Rear Camera & Device Gallery */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => handleFileChange(e, 'camera')}
        aria-label="Capture rear container doors photo with mobile camera"
        className="hidden"
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        onChange={(e) => handleFileChange(e, 'gallery')}
        aria-label="Select rear container doors photo from device gallery"
        className="hidden"
      />

      {/* Capture / Gallery Controls */}
      {canCapture && (
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={processing}
            onClick={() => cameraInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[42px] text-xs sm:text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
          >
            <Camera className="w-4 h-4" />
            <span>
              {processing
                ? 'Processing Photo...'
                : activeMode === 'empty'
                ? 'Capture with Camera'
                : 'Retake with Camera'}
            </span>
          </button>

          <button
            type="button"
            disabled={processing}
            onClick={() => galleryInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[42px] text-xs sm:text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
          >
            <ImageIcon className="w-4 h-4" />
            <span>
              {activeMode === 'empty' ? 'Select from Gallery' : 'Replace from Gallery'}
            </span>
          </button>

          {!isOnline && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
              <CloudOff className="w-3.5 h-3.5" />
              <span>Offline Mode — Photos save locally &amp; auto-upload when online</span>
            </span>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {errorMsg}
        </div>
      )}

      {statusMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">
          {statusMsg}
        </div>
      )}

      {/* Photo Preview & Audit Metadata */}
      {activeMode === 'empty' ? (
        <div className="p-6 border border-dashed border-slate-300 rounded-xl bg-slate-50/60 text-center space-y-1.5">
          <Camera className="w-7 h-7 text-slate-400 mx-auto" />
          <div className="text-xs font-semibold text-slate-700">
            No Rear Container Doors Photo Uploaded Yet
          </div>
          <p className="text-[11px] text-slate-500 max-w-md mx-auto">
            Capture the rear shipping container doors showing the printed Container Identification
            Number using your mobile camera or choose an existing photograph from your gallery.
          </p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
          {/* Status Strip */}
          <div
            className={`px-4 py-2.5 border-b flex flex-wrap items-center justify-between gap-2 text-xs ${
              activeMode === 'pending'
                ? 'bg-amber-50 border-amber-200 text-amber-900'
                : activeMode === 'staged'
                ? 'bg-blue-50 border-blue-200 text-blue-900'
                : 'bg-emerald-50 border-emerald-200 text-emerald-900'
            }`}
          >
            <div className="inline-flex items-center gap-1.5 font-semibold">
              {activeMode === 'pending' ? (
                <>
                  <CloudOff className="w-4 h-4 text-amber-700" />
                  <span>
                    {pendingPhoto?.syncStatus === 'syncing'
                      ? 'Uploading Offline Photo to Secure ERP...'
                      : 'Saved Offline — Pending Automatic Upload'}
                  </span>
                </>
              ) : activeMode === 'staged' ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-blue-700" />
                  <span>Photo Ready — Will Link &amp; Upload When Trip Is Saved</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 text-emerald-700" />
                  <span>Stored Securely in Private ERP (Not Public)</span>
                </>
              )}
            </div>

            {activeMode === 'pending' && isOnline && onSyncNow && (
              <button
                type="button"
                disabled={syncing}
                onClick={() => onSyncNow()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-amber-950 bg-white border border-amber-300 hover:bg-amber-100 rounded-md cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                <span>{syncing ? 'Syncing...' : 'Sync Now'}</span>
              </button>
            )}
          </div>

          {pendingPhoto?.lastError && (
            <div className="px-4 py-2 bg-amber-50/70 border-b border-amber-200 text-[11px] text-amber-900">
              Pending photo is kept safe locally (retry #{pendingPhoto.retryCount}):{' '}
              {pendingPhoto.lastError}
            </div>
          )}

          <div className="p-4 grid grid-cols-1 md:grid-cols-5 gap-4 items-start">
            {/* Clickable Preview Image */}
            <div className="md:col-span-2">
              <button
                type="button"
                onClick={() => {
                  setZoomLevel(100);
                  setLightboxOpen(true);
                }}
                aria-label="Preview and zoom rear container doors photo"
                className="group relative block w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 cursor-pointer text-left"
              >
                <img
                  src={activeDataUrl}
                  alt={`Rear container doors for ${linkedContainerNumber} (${linkedLrNumber})`}
                  className="w-full h-48 object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
                <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-white bg-slate-900/80 rounded-md">
                  <ZoomIn className="w-3 h-3" />
                  <span>Zoom</span>
                </span>
              </button>
            </div>

            {/* Audit Details & Actions */}
            <div className="md:col-span-3 space-y-3">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                  <dt className="text-slate-500">Upload Date &amp; Time</dt>
                  <dd className="font-mono font-semibold text-slate-900 mt-0.5">
                    {activeUploadDate ? formatDateIN(activeUploadDate) : '—'}{' '}
                    {activeUploadTime || ''}
                  </dd>
                </div>

                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                  <dt className="text-slate-500">Capture Source &amp; Size</dt>
                  <dd className="font-medium text-slate-900 mt-0.5">
                    {activeCaptureSource === 'camera'
                      ? 'Mobile Camera'
                      : activeCaptureSource === 'gallery'
                      ? 'Device Gallery'
                      : '—'}{' '}
                    · {formatPhotoSizeKB(activeSizeBytes)}
                    {activeDimensions ? ` (${activeDimensions})` : ''}
                  </dd>
                </div>

                {(syncedPhoto || pendingPhoto) && (
                  <div className="sm:col-span-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-2">
                    <UserCheck className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <dt className="text-slate-500">Uploaded By Employee</dt>
                      <dd className="font-semibold text-slate-900 truncate mt-0.5">
                        {pendingPhoto?.uploadedByName || syncedPhoto?.uploadedByName || 'ERP User'}{' '}
                        <span className="font-normal text-slate-600">
                          ({pendingPhoto?.uploadedByEmail || syncedPhoto?.uploadedByEmail || 'Verified Account'} ·{' '}
                          {(pendingPhoto?.uploadedByRole || syncedPhoto?.uploadedByRole) === 'admin'
                            ? 'Admin'
                            : 'Employee'}
                          )
                        </span>
                      </dd>
                    </div>
                  </div>
                )}
              </dl>

              {/* Preview / Zoom / Download / Admin-only Delete Buttons */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setZoomLevel(100);
                    setLightboxOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                  <span>Preview &amp; Zoom</span>
                </button>

                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </button>

                {activeMode === 'staged' && onClearStaged && (
                  <button
                    type="button"
                    onClick={onClearStaged}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Remove Unsaved Photo</span>
                  </button>
                )}

                {activeMode !== 'staged' && permissions.isAdmin && (
                  <button
                    type="button"
                    onClick={() => setDeleteDialogOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 rounded-lg cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Photo (Admin)</span>
                  </button>
                )}
              </div>

              {activeMode !== 'staged' && !permissions.isAdmin && (
                <p className="text-[11px] text-slate-500">
                  Photo deletion is restricted strictly to authorized Admin accounts.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Zoom & Inspection Lightbox */}
      {lightboxOpen && activeDataUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/85"
          role="dialog"
          aria-modal="true"
          aria-label="Rear Container Doors Photo Preview and Zoom"
        >
          <div className="w-full max-w-5xl max-h-[92vh] bg-white rounded-xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            {/* Lightbox Header */}
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate">
                  Rear Container Doors · {linkedContainerNumber}
                </div>
                <div className="font-mono text-[11px] text-slate-600 truncate">
                  Trip {linkedTripNumber} · LR {linkedLrNumber} · Vehicle {linkedVehicleNumber}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={zoomLevel === 100}
                  onClick={handleZoomOut}
                  aria-label="Zoom out"
                  className="p-2 text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                {ZOOM_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setZoomLevel(level)}
                    className={`px-2.5 py-1.5 text-xs font-mono font-semibold rounded-lg border cursor-pointer ${
                      zoomLevel === level
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    {level}%
                  </button>
                ))}
                <button
                  type="button"
                  disabled={zoomLevel === 300}
                  onClick={handleZoomIn}
                  aria-label="Zoom in"
                  className="p-2 text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </button>

                {activeMode !== 'staged' && permissions.isAdmin && (
                  <button
                    type="button"
                    onClick={() => setDeleteDialogOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 rounded-lg cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setLightboxOpen(false)}
                  aria-label="Close photo preview"
                  className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Scrollable Zoom Canvas (Zero Inline Styles) */}
            <div className="flex-1 overflow-auto bg-slate-900 p-4">
              <div className={`${ZOOM_WIDTH_CLASS[zoomLevel]} mx-auto transition-all duration-150`}>
                <img
                  src={activeDataUrl}
                  alt={`Zoomed rear container doors for ${linkedContainerNumber}`}
                  className="w-full h-auto rounded-md shadow-lg block"
                />
              </div>
            </div>

            {/* Lightbox Footer Metadata */}
            <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
              <span>
                Uploaded: {activeUploadDate ? formatDateIN(activeUploadDate) : '—'}{' '}
                {activeUploadTime || ''} ·{' '}
                {pendingPhoto?.uploadedByName || syncedPhoto?.uploadedByName || 'Current Session'}
              </span>
              <span>
                Zoom {zoomLevel}% — Scroll inside preview to inspect printed Container
                Identification Number
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Admin-Only Delete Confirmation */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete Rear Container Photo"
        description={`Permanently delete the rear container doors photograph for Trip ${linkedTripNumber} (LR ${linkedLrNumber}, Container ${linkedContainerNumber})? This Admin action cannot be undone.`}
        confirmLabel="Delete Photo"
        destructive
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteDialogOpen(false)}
      />
    </div>
  );
};
