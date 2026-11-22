import type {
  PendingContainerPhoto,
  PendingContainerPhotoSyncStatus,
} from '../types/erp';

const IDB_NAME = 'bapasitaram_erp_offline_photos';
const IDB_VERSION = 1;
const IDB_STORE = 'pendingContainerPhotos';
const FALLBACK_STORAGE_KEY = 'bse_pending_container_photos_v1';

export interface OfflinePhotoQueueAdapter {
  put: (record: PendingContainerPhoto) => Promise<void>;
  getAll: () => Promise<PendingContainerPhoto[]>;
  delete: (tripId: string) => Promise<void>;
}

export function createInMemoryPhotoQueueAdapter(
  initial: PendingContainerPhoto[] = []
): OfflinePhotoQueueAdapter {
  const map = new Map<string, PendingContainerPhoto>();
  for (const item of initial) {
    map.set(item.tripId, { ...item });
  }
  return {
    async put(record: PendingContainerPhoto) {
      map.set(record.tripId, { ...record });
    },
    async getAll() {
      return Array.from(map.values()).map((item) => ({ ...item }));
    },
    async delete(tripId: string) {
      map.delete(tripId);
    },
  };
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function';
}

function openPhotoQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        // Keyed by tripId -> mathematically enforces strictly ONE pending photo per trip
        db.createObjectStore(IDB_STORE, { keyPath: 'tripId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error('Failed to open offline container photo database.'));
  });
}

function readLocalStorageFallback(): PendingContainerPhoto[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingContainerPhoto[]) : [];
  } catch {
    return [];
  }
}

function writeLocalStorageFallback(items: PendingContainerPhoto[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota errors in fallback mode
  }
}

const browserQueueAdapter: OfflinePhotoQueueAdapter = {
  async put(record: PendingContainerPhoto): Promise<void> {
    if (hasIndexedDb()) {
      try {
        const db = await openPhotoQueueDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed.'));
        });
        db.close();
        return;
      } catch {
        // Fall through to localStorage backup if IndexedDB is blocked
      }
    }
    const existing = readLocalStorageFallback().filter((item) => item.tripId !== record.tripId);
    existing.push(record);
    writeLocalStorageFallback(existing);
  },

  async getAll(): Promise<PendingContainerPhoto[]> {
    if (hasIndexedDb()) {
      try {
        const db = await openPhotoQueueDb();
        const rows = await new Promise<PendingContainerPhoto[]>((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = () =>
            resolve(Array.isArray(req.result) ? (req.result as PendingContainerPhoto[]) : []);
          req.onerror = () => reject(req.error || new Error('IndexedDB read failed.'));
        });
        db.close();
        return rows;
      } catch {
        // Fall through to localStorage
      }
    }
    return readLocalStorageFallback();
  },

  async delete(tripId: string): Promise<void> {
    if (hasIndexedDb()) {
      try {
        const db = await openPhotoQueueDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(tripId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed.'));
        });
        db.close();
        return;
      } catch {
        // Fall through to localStorage
      }
    }
    const remaining = readLocalStorageFallback().filter((item) => item.tripId !== tripId);
    writeLocalStorageFallback(remaining);
  },
};

export async function savePendingContainerPhoto(
  record: PendingContainerPhoto,
  adapter: OfflinePhotoQueueAdapter = browserQueueAdapter
): Promise<void> {
  await adapter.put({
    ...record,
    photoType: 'rear_container_doors',
  });
}

export async function getPendingContainerPhotos(
  ownerId?: string,
  adapter: OfflinePhotoQueueAdapter = browserQueueAdapter
): Promise<PendingContainerPhoto[]> {
  const all = await adapter.getAll();
  const filtered = ownerId ? all.filter((item) => item.ownerId === ownerId) : all;
  return filtered.sort((a, b) => b.queuedAtIso.localeCompare(a.queuedAtIso));
}

export async function removePendingContainerPhoto(
  tripId: string,
  adapter: OfflinePhotoQueueAdapter = browserQueueAdapter
): Promise<void> {
  await adapter.delete(tripId);
}

export async function updatePendingContainerPhotoStatus(
  tripId: string,
  patch: {
    syncStatus: PendingContainerPhotoSyncStatus;
    retryCount?: number;
    lastError?: string;
  },
  adapter: OfflinePhotoQueueAdapter = browserQueueAdapter
): Promise<PendingContainerPhoto | null> {
  const all = await adapter.getAll();
  const target = all.find((item) => item.tripId === tripId);
  if (!target) return null;
  const updated: PendingContainerPhoto = {
    ...target,
    syncStatus: patch.syncStatus,
    retryCount: patch.retryCount ?? target.retryCount,
    lastError: patch.lastError ?? target.lastError,
  };
  await adapter.put(updated);
  return updated;
}

export interface SyncPendingContainerPhotosResult {
  uploadedTripIds: string[];
  failedTripIds: string[];
  remainingCount: number;
  skippedOffline: boolean;
}

/**
 * Safely uploads queued offline rear-door container photos when internet returns.
 * Pending photos are NEVER deleted from local offline storage until `uploadFn`
 * resolves cleanly from Firestore.
 */
export async function syncPendingContainerPhotos(params: {
  ownerId?: string;
  isOnline: boolean;
  uploadFn: (pending: PendingContainerPhoto) => Promise<void>;
  adapter?: OfflinePhotoQueueAdapter;
}): Promise<SyncPendingContainerPhotosResult> {
  const adapter = params.adapter || browserQueueAdapter;
  const queue = await getPendingContainerPhotos(params.ownerId, adapter);

  if (!params.isOnline) {
    return {
      uploadedTripIds: [],
      failedTripIds: [],
      remainingCount: queue.length,
      skippedOffline: true,
    };
  }

  const uploadedTripIds: string[] = [];
  const failedTripIds: string[] = [];

  for (const item of queue) {
    await updatePendingContainerPhotoStatus(
      item.tripId,
      {
        syncStatus: 'syncing',
        lastError: '',
      },
      adapter
    );

    try {
      await params.uploadFn(item);
      // Remove from local pending storage ONLY AFTER Firestore confirms upload
      await removePendingContainerPhoto(item.tripId, adapter);
      uploadedTripIds.push(item.tripId);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Upload paused due to network interruption. Photo remains safely queued.';
      await updatePendingContainerPhotoStatus(
        item.tripId,
        {
          syncStatus: 'retry_pending',
          retryCount: item.retryCount + 1,
          lastError: msg,
        },
        adapter
      );
      failedTripIds.push(item.tripId);
    }
  }

  const remaining = await getPendingContainerPhotos(params.ownerId, adapter);
  return {
    uploadedTripIds,
    failedTripIds,
    remainingCount: remaining.length,
    skippedOffline: false,
  };
}
