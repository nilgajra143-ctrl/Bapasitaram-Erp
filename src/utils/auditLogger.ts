import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import type { AuditAction, ErpUserRole } from '../types/erp';
import { clampStr, generateSafeDocId } from './formatters';

export async function recordAuditLog(params: {
  ownerId: string;
  actorRole: ErpUserRole;
  action: AuditAction;
  module: string;
  recordId: string;
  summary: string;
}): Promise<void> {
  const logId = generateSafeDocId('aud');
  try {
    await setDoc(doc(collection(db, 'auditLogs'), logId), {
      actorEmail: clampStr(auth.currentUser?.email || 'unknown', 120),
      actorRole: params.actorRole,
      action: params.action,
      module: clampStr(params.module, 50) || 'ERP',
      recordId: clampStr(params.recordId, 128),
      summary: clampStr(params.summary, 300) || 'ERP operation logged',
      ownerId: params.ownerId,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `auditLogs/${logId}`);
  }
}
