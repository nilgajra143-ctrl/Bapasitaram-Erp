import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  AlertTriangle,
  BellRing,
  Check,
  CheckCircle2,
  Clock,
  History,
  Mail,
  MessageCircle,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Truck,
  UserCheck,
  Users,
} from 'lucide-react';
import { auth, db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type CompanySettings,
  type Driver,
  type ErpUser,
  type ErpUserRole,
  type ExpiryAlertScope,
  type ExpiryNotificationRecord,
  type ExpiryRecipientRole,
  type NavSection,
  type NotificationChannel,
  type NotificationDeliveryStatus,
  type NotificationPreference,
  type UserPermissions,
  type Vehicle,
} from '../types/erp';
import {
  buildExpiryDedupKey,
  buildExpiryEmailContent,
  buildExpiryWhatsAppMessage,
  buildManualMailtoUrl,
  buildVehicleDocumentExpiryAlerts,
  filterNotificationHistoryForUser,
  formatRecipientRoleLabel,
  getDefaultNotificationPreference,
  hasDuplicateExpiryNotification,
  hasValidRecipientPhone,
  isTriggerEnabledForPreference,
  isValidEmailAddress,
  resolveAuthorizedVehiclesForUser,
  type AuthorizedExpiryRecipient,
  type VehicleDocumentExpiryAlert,
} from '../utils/expiryNotifications';
import { clampStr, formatDateIN, generateSafeDocId } from '../utils/formatters';
import { extractReadableFirestoreError } from '../utils/erpHelpers';
import { recordAuditLog } from '../utils/auditLogger';
import { WhatsAppShareModal } from './WhatsAppShareModal';

interface ExpiryNotificationsViewProps {
  userId: string;
  userEmail: string;
  userDisplayName: string;
  actorRole: ErpUserRole;
  isSuperAdmin: boolean;
  permissions: UserPermissions;
  vehicles: Vehicle[];
  drivers: Driver[];
  erpUsers: ErpUser[];
  notificationPreferences: NotificationPreference[];
  expiryNotifications: ExpiryNotificationRecord[];
  companySettings: CompanySettings | null;
  loading: boolean;
  onNavigate: (section: NavSection) => void;
}

interface ChannelStatusState {
  loaded: boolean;
  emailApiConfigured: boolean;
  whatsappApiConfigured: boolean;
}

interface StaffAccessDraft {
  recipientRole: ExpiryRecipientRole;
  phone: string;
  expiryAlertScope: ExpiryAlertScope;
  assignedVehicleIds: string[];
  assignedDriverId: string;
}

export const ExpiryNotificationsView: React.FC<ExpiryNotificationsViewProps> = ({
  userId,
  userEmail,
  userDisplayName,
  actorRole,
  isSuperAdmin,
  permissions,
  vehicles,
  drivers,
  erpUsers,
  notificationPreferences,
  expiryNotifications,
  companySettings,
  loading,
  onNavigate,
}) => {
  const [activeTab, setActiveTab] = useState<'alerts' | 'preferences' | 'history' | 'access'>(
    'alerts'
  );
  const [triggerFilter, setTriggerFilter] = useState<
    'all' | 'overdue' | 'on_expiry' | '5_days_before'
  >('all');
  const [alertSearch, setAlertSearch] = useState('');

  // History filters
  const [historySearch, setHistorySearch] = useState('');
  const [historyRoleFilter, setHistoryRoleFilter] = useState<'all' | ExpiryRecipientRole>('all');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<'all' | NotificationDeliveryStatus>(
    'all'
  );

  // Server channel integration status
  const [channelStatus, setChannelStatus] = useState<ChannelStatusState>({
    loaded: false,
    emailApiConfigured: false,
    whatsappApiConfigured: false,
  });

  // Action feedback banners
  const [actionBanner, setActionBanner] = useState<{
    tone: 'success' | 'info' | 'error';
    text: string;
  } | null>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [syncingInApp, setSyncingInApp] = useState(false);

  // Manual WhatsApp share modal state
  const [whatsappTarget, setWhatsappTarget] = useState<{
    alert: VehicleDocumentExpiryAlert;
    recipient: AuthorizedExpiryRecipient;
    message: string;
  } | null>(null);

  // Per-user Notification Preferences draft
  const existingUserPref = useMemo(() => {
    const emailLower = userEmail.trim().toLowerCase();
    return notificationPreferences.find(
      (p) =>
        p.id === userId ||
        p.userId === userId ||
        (emailLower && p.email.trim().toLowerCase() === emailLower)
    );
  }, [notificationPreferences, userId, userEmail]);

  const [prefForm, setPrefForm] = useState(() =>
    getDefaultNotificationPreference({
      userId,
      email: userEmail,
      displayName: userDisplayName || (permissions.isAdmin ? 'Administrator' : 'ERP User'),
      phone: '',
    })
  );
  const [savingPref, setSavingPref] = useState(false);
  const [prefMessage, setPrefMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  // Admin staff vehicle access drafts keyed by erpUser.id
  const [accessDrafts, setAccessDrafts] = useState<Record<string, StaffAccessDraft>>({});
  const [savingAccessUserId, setSavingAccessUserId] = useState<string | null>(null);
  const [accessBanner, setAccessBanner] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  // Sync preference form when Firestore preference loads
  useEffect(() => {
    if (existingUserPref) {
      setPrefForm({
        id: existingUserPref.id,
        userId: existingUserPref.userId,
        email: existingUserPref.email || userEmail.trim().toLowerCase(),
        displayName: existingUserPref.displayName || userDisplayName || 'ERP User',
        phone: existingUserPref.phone || '',
        inAppEnabled: existingUserPref.inAppEnabled,
        emailEnabled: existingUserPref.emailEnabled,
        whatsappEnabled: existingUserPref.whatsappEnabled,
        remindFiveDaysBefore: existingUserPref.remindFiveDaysBefore,
        remindOnExpiryDate: existingUserPref.remindOnExpiryDate,
        remindOverdue: existingUserPref.remindOverdue,
        ownerId: existingUserPref.ownerId || userId,
      });
    } else {
      setPrefForm(
        getDefaultNotificationPreference({
          userId,
          email: userEmail,
          displayName: userDisplayName || (permissions.isAdmin ? 'Administrator' : 'ERP User'),
          phone: '',
        })
      );
    }
  }, [existingUserPref, userId, userEmail, userDisplayName, permissions.isAdmin]);

  // Initialize Admin access drafts for ERP users
  useEffect(() => {
    if (!permissions.isAdmin) return;
    const next: Record<string, StaffAccessDraft> = {};
    erpUsers.forEach((u) => {
      const effectiveRole: ExpiryRecipientRole =
        u.role === 'admin' ? 'admin' : u.recipientRole || 'office_staff';
      next[u.id] = {
        recipientRole: effectiveRole,
        phone: u.phone || '',
        expiryAlertScope:
          effectiveRole === 'admin'
            ? 'all'
            : effectiveRole === 'driver'
            ? 'assigned'
            : u.expiryAlertScope || 'assigned',
        assignedVehicleIds: Array.isArray(u.assignedVehicleIds) ? u.assignedVehicleIds : [],
        assignedDriverId: u.assignedDriverId || '',
      };
    });
    setAccessDrafts(next);
  }, [erpUsers, permissions.isAdmin]);

  // Query server channel availability (Email/WhatsApp webhooks) without enabling paid APIs
  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const res = await fetch('/api/notifications/channel-status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          emailApiConfigured?: boolean;
          whatsappApiConfigured?: boolean;
        };
        if (active) {
          setChannelStatus({
            loaded: true,
            emailApiConfigured: Boolean(data.emailApiConfigured),
            whatsappApiConfigured: Boolean(data.whatsappApiConfigured),
          });
        }
      } catch {
        if (active) {
          setChannelStatus({
            loaded: true,
            emailApiConfigured: false,
            whatsappApiConfigured: false,
          });
        }
      }
    };
    fetchStatus();
    return () => {
      active = false;
    };
  }, [userId]);

  const authorizedVehicles = useMemo(
    () => resolveAuthorizedVehiclesForUser({ vehicles, drivers, permissions }),
    [vehicles, drivers, permissions]
  );

  const authorizedVehicleIdSet = useMemo(
    () => new Set(authorizedVehicles.map((v) => v.id)),
    [authorizedVehicles]
  );

  const allAlerts = useMemo(
    () =>
      buildVehicleDocumentExpiryAlerts({
        vehicles,
        drivers,
        erpUsers,
        preferences: notificationPreferences,
        permissions,
        activeUserEmail: userEmail,
        activeUserId: userId,
        activeUserName: userDisplayName || (permissions.isAdmin ? 'Administrator' : 'ERP User'),
        adminUser: permissions.isAdmin
          ? {
              userId,
              email: userEmail,
              displayName: userDisplayName || 'Administrator',
            }
          : null,
        companySettings,
        respectActiveUserPreferences: !permissions.isAdmin,
      }),
    [
      vehicles,
      drivers,
      erpUsers,
      notificationPreferences,
      permissions,
      userEmail,
      userId,
      userDisplayName,
      companySettings,
    ]
  );

  const scopedHistory = useMemo(
    () =>
      filterNotificationHistoryForUser({
        history: expiryNotifications,
        permissions,
        userId,
        userEmail,
        authorizedVehicleIds: authorizedVehicleIdSet,
      }),
    [expiryNotifications, permissions, userId, userEmail, authorizedVehicleIdSet]
  );

  // For non-admin recipients whose vehicle master records are owned by Admin, also show
  // active in-app notifications pushed to their verified email in `expiryNotifications`.
  const pushedAlertsForRecipient = useMemo(() => {
    if (permissions.isAdmin || allAlerts.length > 0) return [];
    const emailLower = userEmail.trim().toLowerCase();
    if (!emailLower) return [];
    return scopedHistory.filter(
      (h) =>
        h.recipientEmail.trim().toLowerCase() === emailLower &&
        h.deliveryStatus !== 'Acknowledged'
    );
  }, [permissions.isAdmin, allAlerts.length, scopedHistory, userEmail]);

  const filteredAlerts = useMemo(() => {
    const q = alertSearch.trim().toLowerCase();
    return allAlerts.filter((a) => {
      if (triggerFilter !== 'all' && a.triggerType !== triggerFilter) return false;
      if (!q) return true;
      return (
        a.vehicleNumber.toLowerCase().includes(q) ||
        a.documentType.toLowerCase().includes(q) ||
        a.recipients.some((r) => r.recipientName.toLowerCase().includes(q))
      );
    });
  }, [allAlerts, triggerFilter, alertSearch]);

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return scopedHistory.filter((item) => {
      if (historyRoleFilter !== 'all' && item.recipientRole !== historyRoleFilter) return false;
      if (historyStatusFilter !== 'all' && item.deliveryStatus !== historyStatusFilter) return false;
      if (!q) return true;
      return (
        item.vehicleNumber.toLowerCase().includes(q) ||
        item.documentType.toLowerCase().includes(q) ||
        item.recipientName.toLowerCase().includes(q) ||
        item.recipientEmail.toLowerCase().includes(q) ||
        item.recipientPhone.toLowerCase().includes(q) ||
        item.deliveryStatus.toLowerCase().includes(q)
      );
    });
  }, [scopedHistory, historyRoleFilter, historyStatusFilter, historySearch]);

  const summaryCounts = useMemo(() => {
    return {
      overdue: allAlerts.filter((a) => a.triggerType === 'overdue').length,
      onExpiry: allAlerts.filter((a) => a.triggerType === 'on_expiry').length,
      fiveDays: allAlerts.filter((a) => a.triggerType === '5_days_before').length,
      historyTotal: scopedHistory.length,
    };
  }, [allAlerts, scopedHistory]);

  const scopeBadgeText = useMemo(() => {
    if (permissions.isAdmin) {
      return `Admin Scope · All ${vehicles.length} Fleet Vehicles`;
    }
    if (permissions.recipientRole === 'driver') {
      return authorizedVehicles.length > 0
        ? `Driver Scope · Assigned Vehicle: ${authorizedVehicles[0].registrationNumber}`
        : 'Driver Scope · Assigned Vehicle Only';
    }
    if (permissions.expiryAlertScope === 'all') {
      return `Office Staff Scope · All Authorized Fleet Vehicles (${authorizedVehicles.length})`;
    }
    if (permissions.expiryAlertScope === 'none') {
      return 'Office Staff Scope · Expiry Alerts Restricted by Admin';
    }
    return `Office Staff Scope · ${permissions.assignedVehicleIds.length} Assigned ${
      permissions.assignedVehicleIds.length === 1 ? 'Vehicle' : 'Vehicles'
    }`;
  }, [permissions, vehicles.length, authorizedVehicles]);

  const logNotificationHistory = async (params: {
    alert: VehicleDocumentExpiryAlert;
    recipient: AuthorizedExpiryRecipient;
    channel: NotificationChannel;
    deliveryStatus: NotificationDeliveryStatus;
    statusNote: string;
    skipIfDuplicate?: boolean;
  }): Promise<{ saved: boolean; duplicate: boolean }> => {
    const dedupKey = buildExpiryDedupKey({
      vehicleId: params.alert.vehicleId,
      documentType: params.alert.documentType,
      expiryDate: params.alert.expiryDate,
      recipientRole: params.recipient.recipientRole,
      recipientId: params.recipient.recipientId,
      triggerType: params.alert.triggerType,
      channel: params.channel,
    });

    if (
      params.skipIfDuplicate !== false &&
      hasDuplicateExpiryNotification(expiryNotifications, dedupKey)
    ) {
      return { saved: false, duplicate: true };
    }

    const docId = generateSafeDocId('ntf');
    await setDoc(doc(collection(db, 'expiryNotifications'), docId), {
      dedupKey,
      vehicleId: params.alert.vehicleId,
      vehicleNumber: clampStr(params.alert.vehicleNumber, BLUEPRINT_LIMITS.VEHICLE_REG_MAX),
      documentType: params.alert.documentType,
      expiryDate: clampStr(params.alert.expiryDate, BLUEPRINT_LIMITS.DATE_MAX),
      triggerType: params.alert.triggerType,
      recipientRole: params.recipient.recipientRole,
      recipientId: clampStr(params.recipient.recipientId, 128),
      recipientName: clampStr(params.recipient.recipientName || 'Recipient', 120),
      recipientEmail: clampStr(params.recipient.recipientEmail || '', BLUEPRINT_LIMITS.EMAIL_MAX),
      recipientPhone: clampStr(params.recipient.recipientPhone || '', BLUEPRINT_LIMITS.PHONE_MAX),
      channel: params.channel,
      deliveryStatus: params.deliveryStatus,
      statusNote: clampStr(params.statusNote, 300),
      ownerId: userId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return { saved: true, duplicate: false };
  };

  const handleManualWhatsAppOpen = async (
    alert: VehicleDocumentExpiryAlert,
    recipient: AuthorizedExpiryRecipient
  ) => {
    setActionBanner(null);
    const message = buildExpiryWhatsAppMessage({
      alert,
      recipient,
      companyName: companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
    });

    setWhatsappTarget({ alert, recipient, message });

    if (!hasValidRecipientPhone(recipient.recipientPhone)) {
      return;
    }

    try {
      const result = await logNotificationHistory({
        alert,
        recipient,
        channel: 'WhatsApp (Manual)',
        deliveryStatus: 'Prepared (Manual)',
        statusNote: 'Opened manual WhatsApp share dialog for review before sending.',
        skipIfDuplicate: true,
      });
      if (result.duplicate) {
        setActionBanner({
          tone: 'info',
          text: `Manual WhatsApp reminder for ${alert.vehicleNumber} (${alert.documentType}) to ${recipient.recipientName} was already logged — duplicate history entry prevented.`,
        });
      }
    } catch (err) {
      setActionBanner({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Log WhatsApp Notification'),
      });
    }
  };

  const handleApiDispatch = async (
    alert: VehicleDocumentExpiryAlert,
    recipient: AuthorizedExpiryRecipient,
    mode: 'email' | 'whatsapp'
  ) => {
    const channel: NotificationChannel = mode === 'email' ? 'Email' : 'WhatsApp (API)';
    const actionKey = `${alert.id}:${recipient.recipientId}:${mode}`;
    setActionBanner(null);

    const dedupKey = buildExpiryDedupKey({
      vehicleId: alert.vehicleId,
      documentType: alert.documentType,
      expiryDate: alert.expiryDate,
      recipientRole: recipient.recipientRole,
      recipientId: recipient.recipientId,
      triggerType: alert.triggerType,
      channel,
    });

    if (hasDuplicateExpiryNotification(expiryNotifications, dedupKey)) {
      setActionBanner({
        tone: 'info',
        text: `Duplicate prevented: ${channel} alert for ${alert.vehicleNumber} (${alert.documentType}) was already sent to ${recipient.recipientName}.`,
      });
      return;
    }

    if (mode === 'email' && !isValidEmailAddress(recipient.recipientEmail)) {
      await logNotificationHistory({
        alert,
        recipient,
        channel,
        deliveryStatus: 'Skipped (No Contact)',
        statusNote: 'No saved email address on recipient profile.',
        skipIfDuplicate: true,
      });
      setActionBanner({
        tone: 'error',
        text: `Cannot send email to ${recipient.recipientName}: no saved email address found.`,
      });
      return;
    }

    if (mode === 'whatsapp' && !hasValidRecipientPhone(recipient.recipientPhone)) {
      await logNotificationHistory({
        alert,
        recipient,
        channel,
        deliveryStatus: 'Skipped (No Contact)',
        statusNote: 'No saved mobile number on recipient profile.',
        skipIfDuplicate: true,
      });
      setActionBanner({
        tone: 'error',
        text: `Cannot send WhatsApp to ${recipient.recipientName}: no saved mobile number found.`,
      });
      return;
    }

    setBusyActionKey(actionKey);
    try {
      const token = await auth.currentUser?.getIdToken();
      const emailContent = buildExpiryEmailContent({
        alert,
        recipient,
        companyName: companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
      });
      const waMessage = buildExpiryWhatsAppMessage({
        alert,
        recipient,
        companyName: companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
      });

      const res = await fetch('/api/notifications/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token || ''}`,
        },
        body: JSON.stringify({
          channel: mode,
          to: mode === 'email' ? recipient.recipientEmail : recipient.recipientPhone,
          recipientName: recipient.recipientName,
          subject: emailContent.subject,
          message: mode === 'email' ? emailContent.body : waMessage,
          vehicleNumber: alert.vehicleNumber,
          documentType: alert.documentType,
          expiryDate: alert.expiryDate,
        }),
      });

      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        configured?: boolean;
      };

      if (!res.ok) {
        if (res.status === 501 && mode === 'whatsapp') {
          await handleManualWhatsAppOpen(alert, recipient);
          return;
        }
        await logNotificationHistory({
          alert,
          recipient,
          channel,
          deliveryStatus: 'Failed',
          statusNote: payload.error || `Server returned HTTP ${res.status}`,
          skipIfDuplicate: false,
        });
        setActionBanner({
          tone: 'error',
          text: payload.error || `Failed to send ${channel} notification.`,
        });
        return;
      }

      await logNotificationHistory({
        alert,
        recipient,
        channel,
        deliveryStatus: 'Sent',
        statusNote: `Dispatched via configured ${mode === 'email' ? 'Email' : 'WhatsApp'} webhook.`,
        skipIfDuplicate: true,
      });

      setActionBanner({
        tone: 'success',
        text: `${channel} reminder sent to ${recipient.recipientName} for ${alert.vehicleNumber} (${alert.documentType}).`,
      });
    } catch (err) {
      setActionBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Unable to reach notification endpoint.',
      });
    } finally {
      setBusyActionKey(null);
    }
  };

  const handleManualEmailClick = async (
    alert: VehicleDocumentExpiryAlert,
    recipient: AuthorizedExpiryRecipient
  ) => {
    if (!isValidEmailAddress(recipient.recipientEmail)) return;
    try {
      const result = await logNotificationHistory({
        alert,
        recipient,
        channel: 'Email',
        deliveryStatus: 'Prepared (Manual)',
        statusNote: 'Opened manual email compose draft with recipient address and expiry details.',
        skipIfDuplicate: true,
      });
      if (result.duplicate) {
        setActionBanner({
          tone: 'info',
          text: `Email reminder for ${alert.vehicleNumber} (${alert.documentType}) to ${recipient.recipientName} was already logged — duplicate prevented.`,
        });
      } else {
        setActionBanner({
          tone: 'success',
          text: `Logged Email reminder draft for ${recipient.recipientName} (${alert.vehicleNumber} · ${alert.documentType}).`,
        });
      }
    } catch (err) {
      setActionBanner({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Log Email Notification'),
      });
    }
  };

  const handleSyncInAppNotifications = async () => {
    if (!permissions.isAdmin) return;
    setSyncingInApp(true);
    setActionBanner(null);

    let createdCount = 0;
    let skippedDuplicate = 0;
    let skippedPrefOff = 0;

    try {
      for (const alert of allAlerts) {
        for (const recipient of alert.recipients) {
          if (
            !recipient.preference.inAppEnabled ||
            !isTriggerEnabledForPreference(recipient.preference, alert.triggerType)
          ) {
            skippedPrefOff += 1;
            continue;
          }

          const res = await logNotificationHistory({
            alert,
            recipient,
            channel: 'In-App',
            deliveryStatus: 'Displayed',
            statusNote: `Dashboard alert synced for ${formatRecipientRoleLabel(
              recipient.recipientRole
            )} (${alert.triggerLabel}).`,
            skipIfDuplicate: true,
          });
          if (res.saved) createdCount += 1;
          else if (res.duplicate) skippedDuplicate += 1;
        }
      }

      if (createdCount > 0) {
        await recordAuditLog({
          ownerId: userId,
          actorRole,
          action: 'CREATE',
          module: 'Expiry Alerts',
          recordId: `sync-${Date.now()}`,
          summary: `Synced ${createdCount} new in-app vehicle expiry alerts (${skippedDuplicate} duplicates prevented)`,
        });
      }

      setActionBanner({
        tone: createdCount > 0 ? 'success' : 'info',
        text: `In-App alert sync complete: ${createdCount} new alert(s) published, ${skippedDuplicate} duplicate(s) prevented${
          skippedPrefOff > 0 ? `, ${skippedPrefOff} muted by user preferences` : ''
        }.`,
      });
    } catch (err) {
      setActionBanner({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Sync In-App Alerts'),
      });
    } finally {
      setSyncingInApp(false);
    }
  };

  const handleAcknowledgeNotification = async (record: ExpiryNotificationRecord) => {
    setActionBanner(null);
    setBusyActionKey(`ack:${record.id}`);
    try {
      await updateDoc(doc(db, 'expiryNotifications', record.id), {
        deliveryStatus: 'Acknowledged' as NotificationDeliveryStatus,
        statusNote: clampStr(
          `Acknowledged by ${userEmail || 'user'} on ${formatDateIN(
            new Date().toISOString().slice(0, 10)
          )}`,
          300
        ),
        updatedAt: serverTimestamp(),
      });
      setActionBanner({
        tone: 'success',
        text: `Marked ${record.vehicleNumber} (${record.documentType}) notification as Acknowledged.`,
      });
    } catch (err) {
      setActionBanner({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Acknowledge Notification'),
      });
    } finally {
      setBusyActionKey(null);
    }
  };

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPref(true);
    setPrefMessage(null);

    const cleanPhone = clampStr(prefForm.phone, BLUEPRINT_LIMITS.PHONE_MAX);
    if (cleanPhone && !hasValidRecipientPhone(cleanPhone)) {
      setPrefMessage({
        tone: 'error',
        text: 'Enter a valid 10-digit mobile number (or with country code like +91), or leave blank.',
      });
      setSavingPref(false);
      return;
    }

    try {
      const prefDocId = existingUserPref?.id || userId;
      await setDoc(doc(db, 'notificationPreferences', prefDocId), {
        userId,
        email: clampStr(userEmail.trim().toLowerCase(), BLUEPRINT_LIMITS.EMAIL_MAX),
        displayName: clampStr(
          prefForm.displayName || userDisplayName || 'ERP User',
          BLUEPRINT_LIMITS.DRIVER_NAME_MAX
        ),
        phone: cleanPhone,
        inAppEnabled: Boolean(prefForm.inAppEnabled),
        emailEnabled: Boolean(prefForm.emailEnabled),
        whatsappEnabled: Boolean(prefForm.whatsappEnabled),
        remindFiveDaysBefore: Boolean(prefForm.remindFiveDaysBefore),
        remindOnExpiryDate: Boolean(prefForm.remindOnExpiryDate),
        remindOverdue: Boolean(prefForm.remindOverdue),
        ownerId: userId,
        updatedAt: serverTimestamp(),
      });

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'UPDATE',
        module: 'Notification Preferences',
        recordId: prefDocId,
        summary: `Updated expiry alert preferences (In-App: ${prefForm.inAppEnabled ? 'On' : 'Off'}, Email: ${prefForm.emailEnabled ? 'On' : 'Off'}, WhatsApp: ${prefForm.whatsappEnabled ? 'On' : 'Off'})`,
      });

      setPrefMessage({
        tone: 'success',
        text: 'Your notification preferences have been saved.',
      });
    } catch (err) {
      setPrefMessage({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Save Notification Preferences'),
      });
    } finally {
      setSavingPref(false);
    }
  };

  const handleUpdateAccessDraft = (
    erpUserId: string,
    updater: (prev: StaffAccessDraft) => StaffAccessDraft
  ) => {
    setAccessDrafts((prev) => {
      const current = prev[erpUserId] || {
        recipientRole: 'office_staff',
        phone: '',
        expiryAlertScope: 'assigned',
        assignedVehicleIds: [],
        assignedDriverId: '',
      };
      return {
        ...prev,
        [erpUserId]: updater(current),
      };
    });
  };

  const handleSaveStaffAccess = async (targetUser: ErpUser) => {
    if (!isSuperAdmin && !permissions.isAdmin) return;
    const draft = accessDrafts[targetUser.id];
    if (!draft) return;

    const cleanPhone = clampStr(draft.phone, BLUEPRINT_LIMITS.PHONE_MAX);
    if (cleanPhone && !hasValidRecipientPhone(cleanPhone)) {
      setAccessBanner({
        tone: 'error',
        text: `Invalid mobile number for ${targetUser.displayName}. Enter a valid 10-digit/+91 number or leave blank.`,
      });
      return;
    }

    setSavingAccessUserId(targetUser.id);
    setAccessBanner(null);

    try {
      const normalizedRole: ExpiryRecipientRole =
        targetUser.role === 'admin' ? 'admin' : draft.recipientRole;

      let finalVehicleIds = draft.assignedVehicleIds.filter((id) =>
        vehicles.some((v) => v.id === id)
      );
      let finalDriverId = '';
      let finalScope: ExpiryAlertScope = draft.expiryAlertScope;

      if (normalizedRole === 'admin') {
        finalScope = 'all';
        finalVehicleIds = [];
      } else if (normalizedRole === 'driver') {
        finalScope = 'assigned';
        finalDriverId = draft.assignedDriverId;
        if (finalDriverId) {
          const matchedDriver = drivers.find((d) => d.id === finalDriverId);
          finalVehicleIds = matchedDriver?.assignedVehicleId
            ? [matchedDriver.assignedVehicleId]
            : finalVehicleIds.slice(0, 1);
        } else {
          finalVehicleIds = finalVehicleIds.slice(0, 1);
        }
      } else {
        // Office Staff
        if (finalScope !== 'assigned') {
          finalVehicleIds = [];
        }
      }

      await updateDoc(doc(db, 'erpUsers', targetUser.id), {
        displayName: targetUser.displayName,
        role: targetUser.role,
        recipientRole: normalizedRole,
        phone: cleanPhone,
        expiryAlertScope: finalScope,
        assignedVehicleIds: finalVehicleIds.slice(0, 50),
        assignedDriverId: finalDriverId,
        status: targetUser.status,
        canEditTrips: targetUser.canEditTrips,
        canDeleteRecords: targetUser.canDeleteRecords,
        canManageBilling: targetUser.canManageBilling,
        canImportExcel: targetUser.canImportExcel,
        canExportData: targetUser.canExportData,
        canManageMasters: targetUser.canManageMasters,
        updatedAt: serverTimestamp(),
      });

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'UPDATE',
        module: 'Expiry Alerts Access',
        recordId: targetUser.id,
        summary: `Updated expiry alert access for ${targetUser.email} (${normalizedRole}, scope: ${finalScope}, ${finalVehicleIds.length} assigned vehicle(s))`,
      });

      setAccessBanner({
        tone: 'success',
        text: `Saved expiry notification access for ${targetUser.displayName}.`,
      });
    } catch (err) {
      setAccessBanner({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Save Staff Expiry Access'),
      });
    } finally {
      setSavingAccessUserId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-72 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Overdue (Until Renewed)</span>
            <AlertTriangle className="w-4 h-4 text-red-600" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-red-700 tabular-nums">
            {summaryCounts.overdue}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Remains active until expiry date is renewed
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Expiring Today</span>
            <BellRing className="w-4 h-4 text-amber-600" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
            {summaryCounts.onExpiry}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Same-day expiry renewal reminder
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Due Within 5 Days</span>
            <Clock className="w-4 h-4 text-blue-600" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {summaryCounts.fiveDays}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            5-day advance compliance notice
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Notification History</span>
            <History className="w-4 h-4 text-slate-500" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {summaryCounts.historyTotal}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Deduplicated delivery audit records
          </div>
        </div>
      </div>

      {/* Role Scope & Delivery Mode Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="flex items-start sm:items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-900">{scopeBadgeText}</div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Email API:{' '}
              <span className="font-medium text-slate-700">
                {channelStatus.emailApiConfigured ? 'Configured (Webhook Active)' : 'Manual Email Draft'}
              </span>{' '}
              · WhatsApp API:{' '}
              <span className="font-medium text-slate-700">
                {channelStatus.whatsappApiConfigured
                  ? 'Configured (Webhook Active)'
                  : 'Manual WhatsApp Share (No Paid API)'}
              </span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {permissions.isAdmin && (
            <button
              type="button"
              disabled={syncingInApp || allAlerts.length === 0}
              onClick={handleSyncInAppNotifications}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncingInApp ? 'animate-spin' : ''}`} />
              <span>{syncingInApp ? 'Syncing...' : 'Sync In-App Alerts'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('vehicles')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
          >
            <Truck className="w-3.5 h-3.5" />
            <span>Update Vehicle Docs</span>
          </button>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('alerts')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg cursor-pointer ${
            activeTab === 'alerts'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <BellRing className="w-3.5 h-3.5" />
          <span>Active Expiry Alerts ({allAlerts.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('preferences')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg cursor-pointer ${
            activeTab === 'preferences'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Settings2 className="w-3.5 h-3.5" />
          <span>My Preferences</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('history')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg cursor-pointer ${
            activeTab === 'history'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <History className="w-3.5 h-3.5" />
          <span>Notification History ({scopedHistory.length})</span>
        </button>

        {permissions.isAdmin && (
          <button
            type="button"
            onClick={() => setActiveTab('access')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg cursor-pointer ${
              activeTab === 'access'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Recipient Access Control</span>
          </button>
        )}
      </div>

      {actionBanner && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${
            actionBanner.tone === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : actionBanner.tone === 'error'
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-slate-50 border-slate-200 text-slate-700'
          }`}
        >
          <span>{actionBanner.text}</span>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-[11px] font-medium underline shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* TAB 1: ACTIVE EXPIRY ALERTS */}
      {activeTab === 'alerts' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'all', label: `All (${allAlerts.length})` },
                  { id: 'overdue', label: `Overdue (${summaryCounts.overdue})` },
                  { id: 'on_expiry', label: `Today (${summaryCounts.onExpiry})` },
                  { id: '5_days_before', label: `5-Day Notice (${summaryCounts.fiveDays})` },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTriggerFilter(item.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                    triggerFilter === item.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="relative w-full md:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={alertSearch}
                onChange={(e) => setAlertSearch(e.target.value)}
                placeholder="Search vehicle, doc type, recipient..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
              />
            </div>
          </div>

          {filteredAlerts.length === 0 && pushedAlertsForRecipient.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
              <h3 className="text-sm font-semibold text-slate-900">
                No Active Vehicle Document Expiry Alerts
              </h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                {permissions.isAdmin
                  ? 'All fleet vehicles are compliant beyond 5 days, or no expiry dates fall in the 5-day / today / overdue alert window.'
                  : permissions.expiryAlertScope === 'none'
                  ? 'Your account is currently not assigned vehicle expiry alerts by the Administrator.'
                  : 'All documents for your assigned vehicle(s) are valid beyond 5 days (or alerts are muted in your Preferences).'}
              </p>
            </div>
          ) : filteredAlerts.length === 0 && pushedAlertsForRecipient.length > 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70">
                <h3 className="text-sm font-semibold text-slate-900">
                  Assigned Vehicle Expiry Notifications
                </h3>
                <p className="text-xs text-slate-500">
                  Alerts sent to your account ({userEmail}) for your assigned vehicle(s).
                </p>
              </div>
              <div className="divide-y divide-slate-100">
                {pushedAlertsForRecipient.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-900">
                          {rec.vehicleNumber}
                        </span>
                        <span className="text-xs font-medium text-slate-700">
                          {rec.documentType}
                        </span>
                        <span
                          className={`px-2 py-0.5 text-[11px] font-semibold rounded border ${
                            rec.triggerType === 'overdue'
                              ? 'bg-red-50 border-red-200 text-red-700'
                              : rec.triggerType === 'on_expiry'
                              ? 'bg-amber-50 border-amber-200 text-amber-800'
                              : 'bg-blue-50 border-blue-200 text-blue-700'
                          }`}
                        >
                          {rec.triggerType === 'overdue'
                            ? 'Overdue'
                            : rec.triggerType === 'on_expiry'
                            ? 'Expires Today'
                            : '5-Day Reminder'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        Expiry Date: {formatDateIN(rec.expiryDate)} · Status: {rec.deliveryStatus}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busyActionKey === `ack:${rec.id}`}
                      onClick={() => handleAcknowledgeNotification(rec)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg cursor-pointer self-start sm:self-center"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Acknowledge</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAlerts.map((alert) => (
                <article
                  key={alert.id}
                  className="bg-white border border-slate-200 rounded-xl overflow-hidden"
                >
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-mono text-sm font-bold text-slate-900">
                        {alert.vehicleNumber}
                      </span>
                      <span className="text-xs text-slate-500">{alert.vehicleType}</span>
                      <span className="px-2 py-0.5 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded">
                        {alert.documentType}
                      </span>
                      <span className="text-xs text-slate-600">
                        Expiry: <span className="font-mono font-medium">{formatDateIN(alert.expiryDate)}</span>
                      </span>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md border ${
                        alert.triggerType === 'overdue'
                          ? 'bg-red-50 border-red-200 text-red-700'
                          : alert.triggerType === 'on_expiry'
                          ? 'bg-amber-50 border-amber-300 text-amber-800'
                          : 'bg-blue-50 border-blue-200 text-blue-800'
                      }`}
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>{alert.triggerLabel}</span>
                    </span>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {alert.recipients.map((recipient) => {
                      const waChannel: NotificationChannel = channelStatus.whatsappApiConfigured
                        ? 'WhatsApp (API)'
                        : 'WhatsApp (Manual)';
                      const waDedupKey = buildExpiryDedupKey({
                        vehicleId: alert.vehicleId,
                        documentType: alert.documentType,
                        expiryDate: alert.expiryDate,
                        recipientRole: recipient.recipientRole,
                        recipientId: recipient.recipientId,
                        triggerType: alert.triggerType,
                        channel: waChannel,
                      });
                      const emailDedupKey = buildExpiryDedupKey({
                        vehicleId: alert.vehicleId,
                        documentType: alert.documentType,
                        expiryDate: alert.expiryDate,
                        recipientRole: recipient.recipientRole,
                        recipientId: recipient.recipientId,
                        triggerType: alert.triggerType,
                        channel: 'Email',
                      });

                      const waAlreadySent = hasDuplicateExpiryNotification(
                        expiryNotifications,
                        waDedupKey
                      );
                      const emailAlreadySent = hasDuplicateExpiryNotification(
                        expiryNotifications,
                        emailDedupKey
                      );
                      const hasPhone = hasValidRecipientPhone(recipient.recipientPhone);
                      const hasEmail = isValidEmailAddress(recipient.recipientEmail);
                      const triggerAllowed = isTriggerEnabledForPreference(
                        recipient.preference,
                        alert.triggerType
                      );

                      const emailDraft = buildExpiryEmailContent({
                        alert,
                        recipient,
                        companyName: companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
                      });
                      const mailtoUrl = buildManualMailtoUrl(
                        recipient.recipientEmail,
                        emailDraft.subject,
                        emailDraft.body
                      );

                      return (
                        <div
                          key={`${alert.id}-${recipient.recipientRole}-${recipient.recipientId}`}
                          className="px-5 py-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`px-2 py-0.5 text-[11px] font-semibold rounded border ${
                                  recipient.recipientRole === 'admin'
                                    ? 'bg-slate-900 border-slate-900 text-white'
                                    : recipient.recipientRole === 'driver'
                                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                                    : 'bg-blue-50 border-blue-200 text-blue-900'
                                }`}
                              >
                                {formatRecipientRoleLabel(recipient.recipientRole)}
                              </span>
                              <span className="text-xs font-semibold text-slate-900">
                                {recipient.recipientName}
                              </span>
                              {!triggerAllowed && (
                                <span className="text-[11px] text-slate-500">
                                  (Muted in user preferences)
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 font-mono">
                              <span>
                                Mobile:{' '}
                                {hasPhone ? (
                                  <span className="text-slate-700">{recipient.recipientPhone}</span>
                                ) : (
                                  <span className="text-amber-700 font-sans">Not saved</span>
                                )}
                              </span>
                              <span>
                                Email:{' '}
                                {hasEmail ? (
                                  <span className="text-slate-700">{recipient.recipientEmail}</span>
                                ) : (
                                  <span className="text-slate-400 font-sans">Not saved</span>
                                )}
                              </span>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            {/* WhatsApp Button (API if configured, otherwise Manual WhatsApp Share) */}
                            {hasPhone && recipient.preference.whatsappEnabled ? (
                              channelStatus.whatsappApiConfigured ? (
                                <button
                                  type="button"
                                  disabled={
                                    waAlreadySent ||
                                    busyActionKey === `${alert.id}:${recipient.recipientId}:whatsapp`
                                  }
                                  onClick={() => handleApiDispatch(alert, recipient, 'whatsapp')}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer disabled:cursor-not-allowed ${
                                    waAlreadySent
                                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800 opacity-80'
                                      : 'bg-emerald-700 border-emerald-700 text-white hover:bg-emerald-800'
                                  }`}
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  <span>
                                    {waAlreadySent ? 'WhatsApp Sent' : 'Send WhatsApp (API)'}
                                  </span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleManualWhatsAppOpen(alert, recipient)}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer ${
                                    waAlreadySent
                                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100'
                                      : 'bg-emerald-700 border-emerald-700 text-white hover:bg-emerald-800'
                                  }`}
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                  <span>
                                    {waAlreadySent ? 'WhatsApp Prepared' : 'WhatsApp Share'}
                                  </span>
                                </button>
                              )
                            ) : (
                              <span className="px-2.5 py-1.5 text-[11px] text-slate-400 bg-slate-50 border border-slate-200 rounded-lg">
                                {!recipient.preference.whatsappEnabled
                                  ? 'WhatsApp Off'
                                  : 'No Saved Mobile'}
                              </span>
                            )}

                            {/* Email Button (API if configured, otherwise safe mailto: link) */}
                            {hasEmail && recipient.preference.emailEnabled ? (
                              channelStatus.emailApiConfigured ? (
                                <button
                                  type="button"
                                  disabled={
                                    emailAlreadySent ||
                                    busyActionKey === `${alert.id}:${recipient.recipientId}:email`
                                  }
                                  onClick={() => handleApiDispatch(alert, recipient, 'email')}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer disabled:cursor-not-allowed ${
                                    emailAlreadySent
                                      ? 'bg-blue-50 border-blue-200 text-blue-800 opacity-80'
                                      : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
                                  }`}
                                >
                                  <Mail className="w-3.5 h-3.5" />
                                  <span>{emailAlreadySent ? 'Email Sent' : 'Send Email (API)'}</span>
                                </button>
                              ) : mailtoUrl ? (
                                <a
                                  href={mailtoUrl}
                                  onClick={() => handleManualEmailClick(alert, recipient)}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border ${
                                    emailAlreadySent
                                      ? 'bg-blue-50 border-blue-200 text-blue-800 hover:bg-blue-100'
                                      : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
                                  }`}
                                >
                                  <Mail className="w-3.5 h-3.5" />
                                  <span>
                                    {emailAlreadySent ? 'Email Prepared' : 'Email Draft'}
                                  </span>
                                </a>
                              ) : null
                            ) : (
                              <span className="px-2.5 py-1.5 text-[11px] text-slate-400 bg-slate-50 border border-slate-200 rounded-lg">
                                {!recipient.preference.emailEnabled ? 'Email Off' : 'No Saved Email'}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: MY NOTIFICATION PREFERENCES */}
      {activeTab === 'preferences' && (
        <form
          onSubmit={handleSavePreferences}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-6 max-w-2xl"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Personal Vehicle Expiry Notification Preferences
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Control which channels and reminder schedules apply to your account ({userEmail}). Contact details are never invented — provide your real mobile number only if you want WhatsApp reminders.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Display Name
              </label>
              <input
                type="text"
                value={prefForm.displayName}
                onChange={(e) => setPrefForm((p) => ({ ...p, displayName: e.target.value }))}
                maxLength={BLUEPRINT_LIMITS.DRIVER_NAME_MAX}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Verified Account Email
              </label>
              <input
                type="email"
                value={userEmail}
                readOnly
                className="w-full px-3 py-2 text-sm bg-slate-50 text-slate-600 border border-slate-200 rounded-lg"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Mobile Number for WhatsApp Reminders (Optional)
              </label>
              <input
                type="tel"
                value={prefForm.phone}
                onChange={(e) => setPrefForm((p) => ({ ...p, phone: e.target.value }))}
                placeholder="e.g. +91 9876543210 (leave blank if not used)"
                maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-100">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Notification Channels
            </h3>
            {(
              [
                {
                  key: 'inAppEnabled',
                  label: 'ERP Dashboard In-App Alerts',
                  desc: 'Show expiry banners and alerts inside the ERP dashboard.',
                },
                {
                  key: 'emailEnabled',
                  label: 'Email Reminders',
                  desc: 'Allow Email delivery when configured or manual email draft preparation.',
                },
                {
                  key: 'whatsappEnabled',
                  label: 'WhatsApp Reminders',
                  desc: 'Allow WhatsApp API delivery (if configured) or manual WhatsApp sharing.',
                },
              ] as const
            ).map((item) => (
              <label
                key={item.key}
                className="flex items-start justify-between gap-4 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer"
              >
                <div>
                  <div className="text-xs font-semibold text-slate-900">{item.label}</div>
                  <div className="text-[11px] text-slate-500">{item.desc}</div>
                </div>
                <input
                  type="checkbox"
                  checked={prefForm[item.key]}
                  onChange={(e) =>
                    setPrefForm((p) => ({ ...p, [item.key]: e.target.checked }))
                  }
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
              </label>
            ))}
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-100">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Reminder Timing Rules
            </h3>
            {(
              [
                {
                  key: 'remindFiveDaysBefore',
                  label: '5 Days Before Expiry',
                  desc: 'Receive advance reminders starting 5 days before document expiry.',
                },
                {
                  key: 'remindOnExpiryDate',
                  label: 'On Expiry Date',
                  desc: 'Receive urgent notification on the exact expiry date.',
                },
                {
                  key: 'remindOverdue',
                  label: 'Overdue Alerts Until Renewed',
                  desc: 'Keep overdue alerts visible until the vehicle document expiry date is updated.',
                },
              ] as const
            ).map((item) => (
              <label
                key={item.key}
                className="flex items-start justify-between gap-4 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer"
              >
                <div>
                  <div className="text-xs font-semibold text-slate-900">{item.label}</div>
                  <div className="text-[11px] text-slate-500">{item.desc}</div>
                </div>
                <input
                  type="checkbox"
                  checked={prefForm[item.key]}
                  onChange={(e) =>
                    setPrefForm((p) => ({ ...p, [item.key]: e.target.checked }))
                  }
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
              </label>
            ))}
          </div>

          {prefMessage && (
            <div
              role="status"
              className={`p-3 rounded-lg text-xs border ${
                prefMessage.tone === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {prefMessage.text}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingPref}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <Save className="w-4 h-4" />
              <span>{savingPref ? 'Saving...' : 'Save Preferences'}</span>
            </button>
          </div>
        </form>
      )}

      {/* TAB 3: NOTIFICATION HISTORY */}
      {activeTab === 'history' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Search vehicle, recipient, document..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {permissions.isAdmin && (
                <select
                  aria-label="Filter by recipient role"
                  value={historyRoleFilter}
                  onChange={(e) =>
                    setHistoryRoleFilter(e.target.value as 'all' | ExpiryRecipientRole)
                  }
                  className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="all">All Roles</option>
                  <option value="admin">Admin</option>
                  <option value="driver">Driver</option>
                  <option value="office_staff">Office Staff</option>
                </select>
              )}

              <select
                aria-label="Filter by delivery status"
                value={historyStatusFilter}
                onChange={(e) =>
                  setHistoryStatusFilter(e.target.value as 'all' | NotificationDeliveryStatus)
                }
                className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
              >
                <option value="all">All Statuses</option>
                <option value="Displayed">Displayed</option>
                <option value="Prepared (Manual)">Prepared (Manual)</option>
                <option value="Sent">Sent</option>
                <option value="Acknowledged">Acknowledged</option>
                <option value="Failed">Failed</option>
                <option value="Skipped (No Contact)">Skipped (No Contact)</option>
              </select>
            </div>
          </div>

          {filteredHistory.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No expiry notification history records match your current scope and filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-4 whitespace-nowrap">Recipient</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Vehicle No</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Document</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Expiry Date</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Trigger</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Channel</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">Delivery Status</th>
                    <th className="py-2.5 px-4 whitespace-nowrap text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredHistory.map((item) => {
                    const canAck =
                      item.deliveryStatus !== 'Acknowledged' &&
                      (permissions.isAdmin ||
                        item.ownerId === userId ||
                        (item.recipientEmail &&
                          item.recipientEmail.toLowerCase() === userEmail.toLowerCase()));
                    return (
                      <tr key={item.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4">
                          <div className="font-semibold text-slate-900">{item.recipientName}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatRecipientRoleLabel(item.recipientRole)}
                            {item.recipientPhone ? ` · ${item.recipientPhone}` : ''}
                            {item.recipientEmail ? ` · ${item.recipientEmail}` : ''}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {item.vehicleNumber}
                        </td>
                        <td className="py-2.5 px-4 text-slate-800 whitespace-nowrap">
                          {item.documentType}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-700 whitespace-nowrap">
                          {formatDateIN(item.expiryDate)}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          {item.triggerType === 'overdue'
                            ? 'Overdue'
                            : item.triggerType === 'on_expiry'
                            ? 'On Expiry Date'
                            : '5 Days Before'}
                        </td>
                        <td className="py-2.5 px-4 text-slate-700 whitespace-nowrap">
                          {item.channel}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <span
                            className={`inline-flex px-2 py-0.5 text-[11px] font-semibold rounded border ${
                              item.deliveryStatus === 'Sent' ||
                              item.deliveryStatus === 'Acknowledged'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                : item.deliveryStatus === 'Failed'
                                ? 'bg-red-50 border-red-200 text-red-700'
                                : 'bg-slate-100 border-slate-200 text-slate-700'
                            }`}
                          >
                            {item.deliveryStatus}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right whitespace-nowrap">
                          {canAck ? (
                            <button
                              type="button"
                              disabled={busyActionKey === `ack:${item.id}`}
                              onClick={() => handleAcknowledgeNotification(item)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded cursor-pointer"
                            >
                              <Check className="w-3 h-3" />
                              <span>Acknowledge</span>
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: ADMIN RECIPIENT ACCESS CONTROL */}
      {activeTab === 'access' && permissions.isAdmin && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Office Staff &amp; Driver Vehicle Expiry Access Control
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Configure which vehicles each Office Staff or Driver ERP account is authorized to receive expiry reminders for. Admin always receives all fleet alerts.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('security')}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
              >
                Add ERP Users in Security →
              </button>
            </div>

            {accessBanner && (
              <div
                role="status"
                className={`p-3 rounded-lg text-xs border ${
                  accessBanner.tone === 'success'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border-red-200 text-red-800'
                }`}
              >
                {accessBanner.text}
              </div>
            )}

            {erpUsers.length === 0 ? (
              <div className="p-6 rounded-xl bg-slate-50 border border-slate-200 text-center text-xs text-slate-600">
                No Office Staff or Driver ERP accounts added yet. Go to{' '}
                <button
                  type="button"
                  onClick={() => onNavigate('security')}
                  className="font-semibold underline text-slate-900 cursor-pointer"
                >
                  Security &amp; Backup → RBAC Users
                </button>{' '}
                to invite staff or driver accounts.
              </div>
            ) : (
              <div className="space-y-4">
                {erpUsers.map((u) => {
                  const draft = accessDrafts[u.id] || {
                    recipientRole: u.role === 'admin' ? 'admin' : u.recipientRole || 'office_staff',
                    phone: u.phone || '',
                    expiryAlertScope:
                      u.role === 'admin' ? 'all' : u.expiryAlertScope || 'assigned',
                    assignedVehicleIds: u.assignedVehicleIds || [],
                    assignedDriverId: u.assignedDriverId || '',
                  };
                  const isAdminRow = u.role === 'admin';

                  return (
                    <div
                      key={u.id}
                      className="p-4 rounded-xl border border-slate-200 bg-slate-50/40 space-y-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-900">
                              {u.displayName}
                            </span>
                            <span
                              className={`px-2 py-0.5 text-[11px] font-semibold rounded border ${
                                u.status === 'Active'
                                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                  : 'bg-red-50 border-red-200 text-red-700'
                              }`}
                            >
                              {u.status}
                            </span>
                          </div>
                          <div className="text-xs font-mono text-slate-500">{u.email}</div>
                        </div>

                        <button
                          type="button"
                          disabled={savingAccessUserId === u.id}
                          onClick={() => handleSaveStaffAccess(u)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-50"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>
                            {savingAccessUserId === u.id ? 'Saving...' : 'Save Access'}
                          </span>
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            Notification Recipient Role
                          </label>
                          <select
                            disabled={isAdminRow}
                            value={draft.recipientRole}
                            onChange={(e) => {
                              const nextRole = e.target.value as ExpiryRecipientRole;
                              handleUpdateAccessDraft(u.id, (prev) => ({
                                ...prev,
                                recipientRole: nextRole,
                                expiryAlertScope:
                                  nextRole === 'driver' ? 'assigned' : prev.expiryAlertScope,
                                assignedVehicleIds:
                                  nextRole === 'driver'
                                    ? prev.assignedVehicleIds.slice(0, 1)
                                    : prev.assignedVehicleIds,
                              }));
                            }}
                            className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg disabled:bg-slate-100"
                          >
                            {isAdminRow ? (
                              <option value="admin">Admin (All Fleet)</option>
                            ) : (
                              <>
                                <option value="office_staff">Office Staff</option>
                                <option value="driver">Driver (Assigned Vehicle Only)</option>
                              </>
                            )}
                          </select>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            Mobile Number (Optional, Real Only)
                          </label>
                          <input
                            type="tel"
                            value={draft.phone}
                            onChange={(e) =>
                              handleUpdateAccessDraft(u.id, (prev) => ({
                                ...prev,
                                phone: e.target.value,
                              }))
                            }
                            placeholder="+91..."
                            maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                            className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg"
                          />
                        </div>

                        {draft.recipientRole === 'office_staff' && !isAdminRow && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 mb-1">
                              Staff Vehicle Expiry Scope
                            </label>
                            <select
                              value={draft.expiryAlertScope}
                              onChange={(e) =>
                                handleUpdateAccessDraft(u.id, (prev) => ({
                                  ...prev,
                                  expiryAlertScope: e.target.value as ExpiryAlertScope,
                                }))
                              }
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                            >
                              <option value="assigned">Assigned Vehicles Only</option>
                              <option value="all">All Fleet Vehicles</option>
                              <option value="none">No Expiry Alerts</option>
                            </select>
                          </div>
                        )}

                        {draft.recipientRole === 'driver' && !isAdminRow && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 mb-1">
                              Link Driver Master Record
                            </label>
                            <select
                              value={draft.assignedDriverId}
                              onChange={(e) => {
                                const drvId = e.target.value;
                                const matchedDrv = drivers.find((d) => d.id === drvId);
                                handleUpdateAccessDraft(u.id, (prev) => ({
                                  ...prev,
                                  assignedDriverId: drvId,
                                  assignedVehicleIds: matchedDrv?.assignedVehicleId
                                    ? [matchedDrv.assignedVehicleId]
                                    : prev.assignedVehicleIds.slice(0, 1),
                                }));
                              }}
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                            >
                              <option value="">-- Select Driver Profile --</option>
                              {drivers.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.driverName}
                                  {d.assignedVehicleNumber ? ` (${d.assignedVehicleNumber})` : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>

                      {/* Vehicle Selection Grid for Office Staff ('assigned') or Driver without linked Driver record */}
                      {!isAdminRow &&
                        ((draft.recipientRole === 'office_staff' &&
                          draft.expiryAlertScope === 'assigned') ||
                          (draft.recipientRole === 'driver' && !draft.assignedDriverId)) && (
                          <div className="space-y-2">
                            <div className="text-[11px] font-medium text-slate-600">
                              {draft.recipientRole === 'driver'
                                ? 'Assigned Vehicle (Single Vehicle Only)'
                                : `Assigned Vehicles (${draft.assignedVehicleIds.length} selected)`}
                            </div>
                            {vehicles.length === 0 ? (
                              <div className="text-xs text-slate-500">
                                No vehicles registered in Fleet yet.
                              </div>
                            ) : (
                              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-44 overflow-y-auto p-2 bg-white border border-slate-200 rounded-lg">
                                {vehicles.map((v) => {
                                  const checked = draft.assignedVehicleIds.includes(v.id);
                                  return (
                                    <label
                                      key={v.id}
                                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs cursor-pointer ${
                                        checked
                                          ? 'bg-slate-900 border-slate-900 text-white'
                                          : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                                      }`}
                                    >
                                      <input
                                        type={
                                          draft.recipientRole === 'driver' ? 'radio' : 'checkbox'
                                        }
                                        name={`veh-assign-${u.id}`}
                                        checked={checked}
                                        onChange={() => {
                                          handleUpdateAccessDraft(u.id, (prev) => {
                                            if (prev.recipientRole === 'driver') {
                                              return { ...prev, assignedVehicleIds: [v.id] };
                                            }
                                            const exists = prev.assignedVehicleIds.includes(v.id);
                                            return {
                                              ...prev,
                                              assignedVehicleIds: exists
                                                ? prev.assignedVehicleIds.filter((id) => id !== v.id)
                                                : [...prev.assignedVehicleIds, v.id],
                                            };
                                          });
                                        }}
                                        className="h-3.5 w-3.5"
                                      />
                                      <span className="font-mono truncate">
                                        {v.registrationNumber}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Driver Master Assignments Reference */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-slate-600" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Driver Master Vehicle Assignments
                  </h3>
                  <p className="text-xs text-slate-500">
                    Drivers only receive expiry alerts for their assigned vehicle using their saved real mobile number.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('drivers')}
                className="text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
              >
                Manage Drivers →
              </button>
            </div>
            {drivers.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No drivers registered yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                      <th className="py-2.5 px-4">Driver Name</th>
                      <th className="py-2.5 px-4">Assigned Vehicle</th>
                      <th className="py-2.5 px-4">Saved Mobile</th>
                      <th className="py-2.5 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {drivers.map((d) => (
                      <tr key={d.id}>
                        <td className="py-2.5 px-4 font-semibold text-slate-900">{d.driverName}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-700">
                          {d.assignedVehicleNumber || 'Unassigned'}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-700">
                          {d.phone || <span className="text-amber-700 font-sans">Not saved</span>}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600">{d.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Manual WhatsApp Share Modal (No automatic sending, locked to recipient's real saved phone) */}
      <WhatsAppShareModal
        open={Boolean(whatsappTarget)}
        onClose={() => setWhatsappTarget(null)}
        title={
          whatsappTarget
            ? `Vehicle Expiry Reminder — ${whatsappTarget.alert.vehicleNumber} (${whatsappTarget.alert.documentType})`
            : 'Vehicle Expiry Reminder'
        }
        subtitle="Review recipient mobile number and prepared document expiry reminder — press Send manually in WhatsApp."
        partyName={
          whatsappTarget
            ? `${whatsappTarget.recipient.recipientName} (${formatRecipientRoleLabel(
                whatsappTarget.recipient.recipientRole
              )})`
            : ''
        }
        partyPhone={whatsappTarget?.recipient.recipientPhone || ''}
        initialMessage={whatsappTarget?.message || ''}
      />
    </div>
  );
};
