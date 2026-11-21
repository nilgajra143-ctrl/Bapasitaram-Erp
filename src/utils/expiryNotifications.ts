import type {
  CompanySettings,
  Driver,
  ErpUser,
  ExpiryNotificationRecord,
  ExpiryRecipientRole,
  ExpiryTriggerType,
  NotificationChannel,
  NotificationPreference,
  UserPermissions,
  Vehicle,
  VehicleDocumentType,
} from '../types/erp';
import { formatDateIN, getTodayISO } from './formatters';
import { normalizeWhatsAppPhone } from './whatsappShare';

export interface ActiveAdminContext {
  userId: string;
  email: string;
  displayName: string;
}

export interface AuthorizedExpiryRecipient {
  recipientId: string;
  recipientRole: ExpiryRecipientRole;
  recipientName: string;
  recipientEmail: string;
  recipientPhone: string;
  preference: Pick<
    NotificationPreference,
    | 'inAppEnabled'
    | 'emailEnabled'
    | 'whatsappEnabled'
    | 'remindFiveDaysBefore'
    | 'remindOnExpiryDate'
    | 'remindOverdue'
  >;
}

export interface VehicleDocumentExpiryAlert {
  id: string;
  vehicleId: string;
  vehicleNumber: string;
  vehicleType: string;
  documentType: VehicleDocumentType;
  expiryDate: string;
  daysLeft: number;
  triggerType: ExpiryTriggerType;
  triggerLabel: string;
  recipients: AuthorizedExpiryRecipient[];
}

export const DEFAULT_NOTIFICATION_TOGGLES: Pick<
  NotificationPreference,
  | 'inAppEnabled'
  | 'emailEnabled'
  | 'whatsappEnabled'
  | 'remindFiveDaysBefore'
  | 'remindOnExpiryDate'
  | 'remindOverdue'
> = {
  inAppEnabled: true,
  emailEnabled: true,
  whatsappEnabled: true,
  remindFiveDaysBefore: true,
  remindOnExpiryDate: true,
  remindOverdue: true,
};

export function getDefaultNotificationPreference(params: {
  userId: string;
  email: string;
  displayName: string;
  phone?: string;
}): Omit<NotificationPreference, 'updatedAt'> {
  return {
    id: params.userId,
    userId: params.userId,
    email: params.email.trim().toLowerCase(),
    displayName: params.displayName.trim() || 'ERP User',
    phone: (params.phone || '').trim(),
    ...DEFAULT_NOTIFICATION_TOGGLES,
    ownerId: params.userId,
  };
}

/**
 * Deterministic calendar-day difference between `expiryDate` (YYYY-MM-DD) and `todayISO`.
 * Returns null if `expiryDate` is empty or invalid.
 */
export function getDaysUntilExpiryRelative(
  expiryDate: string,
  todayISO?: string
): number | null {
  const cleanTarget = (expiryDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanTarget)) return null;
  const baseDateStr = todayISO && /^\d{4}-\d{2}-\d{2}$/.test(todayISO) ? todayISO : getTodayISO();

  const [ty, tm, td] = cleanTarget.split('-').map(Number);
  const [by, bm, bd] = baseDateStr.split('-').map(Number);

  const targetUtc = Date.UTC(ty, tm - 1, td);
  const baseUtc = Date.UTC(by, bm - 1, bd);
  if (Number.isNaN(targetUtc) || Number.isNaN(baseUtc)) return null;

  return Math.round((targetUtc - baseUtc) / (1000 * 60 * 60 * 24));
}

/**
 * Vehicle document expiry schedule:
 * - 5 days before expiry (daysLeft in 1..5) -> '5_days_before'
 * - On expiry date (daysLeft === 0)        -> 'on_expiry'
 * - Overdue until renewal (daysLeft < 0)   -> 'overdue'
 * - Valid / renewed (daysLeft > 5)         -> null (no active expiry alert)
 */
export function getExpiryTriggerType(daysLeft: number): ExpiryTriggerType | null {
  if (!Number.isFinite(daysLeft)) return null;
  if (daysLeft < 0) return 'overdue';
  if (daysLeft === 0) return 'on_expiry';
  if (daysLeft <= 5) return '5_days_before';
  return null;
}

export function getExpiryTriggerLabel(
  triggerType: ExpiryTriggerType,
  daysLeft: number
): string {
  if (triggerType === 'overdue') {
    const overdueDays = Math.abs(daysLeft);
    return `Overdue by ${overdueDays} ${overdueDays === 1 ? 'day' : 'days'}`;
  }
  if (triggerType === 'on_expiry') {
    return 'Expires Today';
  }
  return `Due in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`;
}

export function isTriggerEnabledForPreference(
  pref: Pick<
    NotificationPreference,
    'remindFiveDaysBefore' | 'remindOnExpiryDate' | 'remindOverdue'
  >,
  triggerType: ExpiryTriggerType
): boolean {
  if (triggerType === '5_days_before') return pref.remindFiveDaysBefore;
  if (triggerType === 'on_expiry') return pref.remindOnExpiryDate;
  return pref.remindOverdue;
}

export function isValidEmailAddress(email: string | null | undefined): boolean {
  const clean = (email || '').trim();
  if (!clean || clean.length > 120) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean);
}

/**
 * Deterministic deduplication key preventing duplicate reminders for the same
 * vehicle document, expiry date, recipient, trigger window, and channel.
 * Automatically resets when the document's `expiryDate` is renewed.
 */
export function buildExpiryDedupKey(params: {
  vehicleId: string;
  documentType: VehicleDocumentType;
  expiryDate: string;
  recipientRole: ExpiryRecipientRole;
  recipientId: string;
  triggerType: ExpiryTriggerType;
  channel: NotificationChannel;
}): string {
  const sanitize = (v: string) =>
    v
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9@._-]+/g, '_')
      .slice(0, 48);

  const raw = [
    sanitize(params.vehicleId),
    sanitize(params.documentType),
    sanitize(params.expiryDate),
    sanitize(params.recipientRole),
    sanitize(params.recipientId),
    sanitize(params.triggerType),
    sanitize(params.channel),
  ].join('|');

  return raw.slice(0, 240);
}

/**
 * Checks whether a non-failed notification with the exact `dedupKey` already exists
 * in the notification history so duplicates are strictly prevented.
 */
export function hasDuplicateExpiryNotification(
  history: Pick<ExpiryNotificationRecord, 'dedupKey' | 'deliveryStatus'>[],
  dedupKey: string
): boolean {
  if (!dedupKey) return false;
  return history.some(
    (entry) => entry.dedupKey === dedupKey && entry.deliveryStatus !== 'Failed'
  );
}

/**
 * Strictly scopes which vehicles a signed-in user is authorized to view
 * for Vehicle Document Expiry Notifications:
 * 1. Admin -> All vehicles in the fleet.
 * 2. Driver -> ONLY their single assigned vehicle (via assignedDriverId -> driver.assignedVehicleId, or assignedVehicleIds[0]).
 * 3. Office Staff -> Admin-configurable: 'assigned' (assignedVehicleIds), 'all', or 'none'.
 * Uninvited / suspended users receive an empty list (fail-closed).
 */
export function resolveAuthorizedVehiclesForUser(params: {
  vehicles: Vehicle[];
  drivers: Driver[];
  permissions: UserPermissions;
}): Vehicle[] {
  const { vehicles, drivers, permissions } = params;

  if (permissions.isSuspended) return [];
  if (permissions.isAdmin) return vehicles;

  if (permissions.recipientRole === 'driver') {
    let assignedVehicleId = '';
    if (permissions.assignedDriverId) {
      const driver = drivers.find((d) => d.id === permissions.assignedDriverId);
      if (driver?.assignedVehicleId) {
        assignedVehicleId = driver.assignedVehicleId;
      }
    }
    if (!assignedVehicleId && permissions.assignedVehicleIds.length > 0) {
      assignedVehicleId = permissions.assignedVehicleIds[0];
    }
    if (!assignedVehicleId) return [];
    return vehicles.filter((v) => v.id === assignedVehicleId);
  }

  // Office Staff
  if (permissions.expiryAlertScope === 'none') return [];
  if (permissions.expiryAlertScope === 'all') return vehicles;

  const allowedSet = new Set(permissions.assignedVehicleIds || []);
  if (allowedSet.size === 0) return [];
  return vehicles.filter((v) => allowedSet.has(v.id));
}

function findPreferenceForRecipient(
  preferences: NotificationPreference[],
  email: string,
  userId?: string
): NotificationPreference | undefined {
  const emailLower = email.trim().toLowerCase();
  return preferences.find(
    (p) =>
      (userId && (p.userId === userId || p.id === userId)) ||
      (emailLower && p.email.trim().toLowerCase() === emailLower)
  );
}

/**
 * Resolves all authorized expiry recipients for a specific vehicle without ever
 * inventing phone numbers or email addresses:
 * 1. Admin (all vehicles)
 * 2. Assigned Driver (ONLY the driver assigned to this specific vehicle)
 * 3. Assigned Office Staff (staff assigned to this vehicle or granted 'all' scope by Admin)
 */
export function resolveAuthorizedRecipientsForVehicle(params: {
  vehicle: Vehicle;
  drivers: Driver[];
  erpUsers: ErpUser[];
  preferences: NotificationPreference[];
  adminUser?: ActiveAdminContext | null;
  companySettings?: CompanySettings | null;
}): AuthorizedExpiryRecipient[] {
  const { vehicle, drivers, erpUsers, preferences, adminUser, companySettings } = params;
  const recipients: AuthorizedExpiryRecipient[] = [];
  const seenKeys = new Set<string>();

  const pushUnique = (recipient: AuthorizedExpiryRecipient) => {
    const key = `${recipient.recipientRole}:${recipient.recipientId.toLowerCase()}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    recipients.push(recipient);
  };

  // 1. Primary Admin recipient (real signed-in admin or configured company email, never invented)
  const adminEmail = (adminUser?.email || companySettings?.email || '').trim().toLowerCase();
  const adminPref = findPreferenceForRecipient(preferences, adminEmail, adminUser?.userId);
  const adminPhone = (adminPref?.phone || companySettings?.phone || '').trim();
  const adminName = (adminPref?.displayName || adminUser?.displayName || 'Administrator').trim();
  const adminId = adminUser?.userId || adminEmail || 'admin';

  pushUnique({
    recipientId: adminId,
    recipientRole: 'admin',
    recipientName: adminName,
    recipientEmail: adminEmail,
    recipientPhone: adminPhone,
    preference: adminPref
      ? {
          inAppEnabled: adminPref.inAppEnabled,
          emailEnabled: adminPref.emailEnabled,
          whatsappEnabled: adminPref.whatsappEnabled,
          remindFiveDaysBefore: adminPref.remindFiveDaysBefore,
          remindOnExpiryDate: adminPref.remindOnExpiryDate,
          remindOverdue: adminPref.remindOverdue,
        }
      : { ...DEFAULT_NOTIFICATION_TOGGLES },
  });

  // Additional Active Admin ERP users (if configured in RBAC)
  erpUsers
    .filter((u) => u.status === 'Active' && u.role === 'admin')
    .forEach((u) => {
      const uEmail = u.email.trim().toLowerCase();
      if (uEmail && uEmail === adminEmail) return;
      const pref = findPreferenceForRecipient(preferences, uEmail);
      pushUnique({
        recipientId: u.id,
        recipientRole: 'admin',
        recipientName: u.displayName || 'Admin',
        recipientEmail: uEmail,
        recipientPhone: (pref?.phone || u.phone || '').trim(),
        preference: pref
          ? {
              inAppEnabled: pref.inAppEnabled,
              emailEnabled: pref.emailEnabled,
              whatsappEnabled: pref.whatsappEnabled,
              remindFiveDaysBefore: pref.remindFiveDaysBefore,
              remindOnExpiryDate: pref.remindOnExpiryDate,
              remindOverdue: pref.remindOverdue,
            }
          : { ...DEFAULT_NOTIFICATION_TOGGLES },
      });
    });

  // 2. Assigned Driver (ONLY driver assigned to this vehicle)
  const matchingDrivers = drivers.filter(
    (d) => d.status !== 'Inactive' && d.assignedVehicleId === vehicle.id
  );

  const driverErpAccounts = erpUsers.filter(
    (u) => u.status === 'Active' && u.role === 'employee' && u.recipientRole === 'driver'
  );

  if (matchingDrivers.length > 0) {
    matchingDrivers.forEach((drv) => {
      const linkedAccount = driverErpAccounts.find(
        (u) =>
          u.assignedDriverId === drv.id ||
          (u.assignedVehicleIds || []).includes(vehicle.id)
      );
      const email = (linkedAccount?.email || '').trim().toLowerCase();
      const pref = email ? findPreferenceForRecipient(preferences, email) : undefined;
      const phone = (pref?.phone || linkedAccount?.phone || drv.phone || '').trim();

      pushUnique({
        recipientId: drv.id,
        recipientRole: 'driver',
        recipientName: drv.driverName,
        recipientEmail: email,
        recipientPhone: phone,
        preference: pref
          ? {
              inAppEnabled: pref.inAppEnabled,
              emailEnabled: pref.emailEnabled,
              whatsappEnabled: pref.whatsappEnabled,
              remindFiveDaysBefore: pref.remindFiveDaysBefore,
              remindOnExpiryDate: pref.remindOnExpiryDate,
              remindOverdue: pref.remindOverdue,
            }
          : { ...DEFAULT_NOTIFICATION_TOGGLES },
      });
    });
  } else {
    // Check if an ERP driver account is explicitly mapped to this vehicle
    const explicitVehicleDriverUsers = driverErpAccounts.filter((u) =>
      (u.assignedVehicleIds || []).includes(vehicle.id)
    );
    if (explicitVehicleDriverUsers.length > 0) {
      explicitVehicleDriverUsers.forEach((u) => {
        const email = u.email.trim().toLowerCase();
        const pref = findPreferenceForRecipient(preferences, email);
        pushUnique({
          recipientId: u.id,
          recipientRole: 'driver',
          recipientName: u.displayName,
          recipientEmail: email,
          recipientPhone: (pref?.phone || u.phone || vehicle.driverPhone || '').trim(),
          preference: pref
            ? {
                inAppEnabled: pref.inAppEnabled,
                emailEnabled: pref.emailEnabled,
                whatsappEnabled: pref.whatsappEnabled,
                remindFiveDaysBefore: pref.remindFiveDaysBefore,
                remindOnExpiryDate: pref.remindOnExpiryDate,
                remindOverdue: pref.remindOverdue,
              }
            : { ...DEFAULT_NOTIFICATION_TOGGLES },
        });
      });
    } else if (vehicle.driverName.trim() || vehicle.driverPhone.trim()) {
      // Fall back strictly to driver details already saved on the Vehicle record (never invented)
      pushUnique({
        recipientId: `veh_driver_${vehicle.id}`,
        recipientRole: 'driver',
        recipientName: vehicle.driverName.trim() || `Driver (${vehicle.registrationNumber})`,
        recipientEmail: '',
        recipientPhone: vehicle.driverPhone.trim(),
        preference: { ...DEFAULT_NOTIFICATION_TOGGLES },
      });
    }
  }

  // 3. Authorized Office Staff (Admin-configurable vehicle access)
  erpUsers
    .filter((u) => {
      if (u.status !== 'Active') return false;
      if (u.role !== 'employee') return false;
      const effRole = u.recipientRole || 'office_staff';
      if (effRole !== 'office_staff') return false;
      const scope = u.expiryAlertScope || 'assigned';
      if (scope === 'none') return false;
      if (scope === 'all') return true;
      return (u.assignedVehicleIds || []).includes(vehicle.id);
    })
    .forEach((staff) => {
      const email = staff.email.trim().toLowerCase();
      const pref = findPreferenceForRecipient(preferences, email);
      pushUnique({
        recipientId: staff.id,
        recipientRole: 'office_staff',
        recipientName: staff.displayName,
        recipientEmail: email,
        recipientPhone: (pref?.phone || staff.phone || '').trim(),
        preference: pref
          ? {
              inAppEnabled: pref.inAppEnabled,
              emailEnabled: pref.emailEnabled,
              whatsappEnabled: pref.whatsappEnabled,
              remindFiveDaysBefore: pref.remindFiveDaysBefore,
              remindOnExpiryDate: pref.remindOnExpiryDate,
              remindOverdue: pref.remindOverdue,
            }
          : { ...DEFAULT_NOTIFICATION_TOGGLES },
      });
    });

  return recipients;
}

/**
 * Generates strictly recipient-scoped Vehicle Document Expiry Alerts for the
 * active user across all 5 vehicle documents (Fitness, Insurance, PUC, Road Tax, Permit).
 * - Only alerts within 5 days before expiry, on expiry date, or overdue until renewal.
 * - Non-admin users never see unauthorized vehicles or other users' private contact details.
 */
export function buildVehicleDocumentExpiryAlerts(params: {
  vehicles: Vehicle[];
  drivers: Driver[];
  erpUsers: ErpUser[];
  preferences: NotificationPreference[];
  permissions: UserPermissions;
  activeUserEmail: string;
  activeUserId: string;
  activeUserName: string;
  adminUser?: ActiveAdminContext | null;
  companySettings?: CompanySettings | null;
  todayISO?: string;
  respectActiveUserPreferences?: boolean;
}): VehicleDocumentExpiryAlert[] {
  const {
    vehicles,
    drivers,
    erpUsers,
    preferences,
    permissions,
    activeUserEmail,
    activeUserId,
    activeUserName,
    adminUser,
    companySettings,
    todayISO,
    respectActiveUserPreferences = false,
  } = params;

  const authorizedVehicles = resolveAuthorizedVehiclesForUser({
    vehicles,
    drivers,
    permissions,
  });

  const activePref = findPreferenceForRecipient(
    preferences,
    activeUserEmail,
    activeUserId
  );

  if (respectActiveUserPreferences && activePref && !activePref.inAppEnabled) {
    return [];
  }

  const alerts: VehicleDocumentExpiryAlert[] = [];

  authorizedVehicles.forEach((vehicle) => {
    const docChecks: { type: VehicleDocumentType; expiryDate: string }[] = [
      { type: 'Fitness', expiryDate: vehicle.fitnessExpiry || '' },
      { type: 'Insurance', expiryDate: vehicle.insuranceExpiry || '' },
      { type: 'PUC', expiryDate: vehicle.pucExpiry || '' },
      { type: 'Road Tax', expiryDate: vehicle.taxExpiry || '' },
      { type: 'Permit', expiryDate: vehicle.permitExpiry || '' },
    ];

    const fullRecipients = permissions.isAdmin
      ? resolveAuthorizedRecipientsForVehicle({
          vehicle,
          drivers,
          erpUsers,
          preferences,
          adminUser,
          companySettings,
        })
      : [
          {
            recipientId: activeUserId,
            recipientRole: permissions.recipientRole,
            recipientName: activePref?.displayName || activeUserName || 'Assigned User',
            recipientEmail: activeUserEmail.trim().toLowerCase(),
            recipientPhone: (activePref?.phone || '').trim(),
            preference: activePref
              ? {
                  inAppEnabled: activePref.inAppEnabled,
                  emailEnabled: activePref.emailEnabled,
                  whatsappEnabled: activePref.whatsappEnabled,
                  remindFiveDaysBefore: activePref.remindFiveDaysBefore,
                  remindOnExpiryDate: activePref.remindOnExpiryDate,
                  remindOverdue: activePref.remindOverdue,
                }
              : { ...DEFAULT_NOTIFICATION_TOGGLES },
          },
        ];

    docChecks.forEach((docItem) => {
      const daysLeft = getDaysUntilExpiryRelative(docItem.expiryDate, todayISO);
      if (daysLeft === null) return;
      const triggerType = getExpiryTriggerType(daysLeft);
      if (!triggerType) return;

      if (
        respectActiveUserPreferences &&
        activePref &&
        !isTriggerEnabledForPreference(activePref, triggerType)
      ) {
        return;
      }

      alerts.push({
        id: `${vehicle.id}__${docItem.type}__${docItem.expiryDate}`,
        vehicleId: vehicle.id,
        vehicleNumber: vehicle.registrationNumber,
        vehicleType: vehicle.vehicleType,
        documentType: docItem.type,
        expiryDate: docItem.expiryDate,
        daysLeft,
        triggerType,
        triggerLabel: getExpiryTriggerLabel(triggerType, daysLeft),
        recipients: fullRecipients,
      });
    });
  });

  // Sort most urgent first: most overdue -> expires today -> 1..5 days left
  return alerts.sort((a, b) => {
    if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
    const vehCmp = a.vehicleNumber.localeCompare(b.vehicleNumber);
    if (vehCmp !== 0) return vehCmp;
    return a.documentType.localeCompare(b.documentType);
  });
}

/**
 * Strictly scopes Notification History so non-admin users only see records
 * addressed to them (or logged by them) for their authorized vehicles.
 */
export function filterNotificationHistoryForUser(params: {
  history: ExpiryNotificationRecord[];
  permissions: UserPermissions;
  userId: string;
  userEmail: string;
  authorizedVehicleIds: Set<string>;
}): ExpiryNotificationRecord[] {
  const { history, permissions, userId, userEmail, authorizedVehicleIds } = params;
  if (permissions.isSuspended) return [];
  if (permissions.isAdmin) return history;

  const emailLower = userEmail.trim().toLowerCase();
  return history.filter((item) => {
    const addressedToUser =
      item.ownerId === userId ||
      (emailLower !== '' && item.recipientEmail.trim().toLowerCase() === emailLower);
    if (!addressedToUser) return false;
    // If vehicle list is loaded for this user, enforce vehicle-level scope too;
    // also allow notifications explicitly addressed to their verified email for assigned vehicles.
    if (authorizedVehicleIds.size > 0) {
      return authorizedVehicleIds.has(item.vehicleId);
    }
    return emailLower !== '' && item.recipientEmail.trim().toLowerCase() === emailLower;
  });
}

export function formatRecipientRoleLabel(role: ExpiryRecipientRole): string {
  if (role === 'admin') return 'Admin';
  if (role === 'driver') return 'Driver';
  return 'Office Staff';
}

export function buildExpiryWhatsAppMessage(params: {
  alert: Pick<
    VehicleDocumentExpiryAlert,
    'vehicleNumber' | 'documentType' | 'expiryDate' | 'daysLeft' | 'triggerType' | 'triggerLabel'
  >;
  recipient: Pick<AuthorizedExpiryRecipient, 'recipientName' | 'recipientRole'>;
  companyName?: string;
}): string {
  const company = (params.companyName || 'BAPASITARAM ENTERPRISE').trim();
  const { alert, recipient } = params;

  const urgencyHeader =
    alert.triggerType === 'overdue'
      ? 'OVERDUE VEHICLE DOCUMENT ALERT'
      : alert.triggerType === 'on_expiry'
      ? 'DOCUMENT EXPIRING TODAY — URGENT'
      : 'VEHICLE DOCUMENT EXPIRY REMINDER (5-DAY NOTICE)';

  const lines = [
    `*${company}*`,
    urgencyHeader,
    '',
    `Dear ${recipient.recipientName} (${formatRecipientRoleLabel(recipient.recipientRole)}),`,
    `Vehicle document renewal attention is required for vehicle *${alert.vehicleNumber}*:`,
    '',
    `Vehicle Number: ${alert.vehicleNumber}`,
    `Document Type: ${alert.documentType}`,
    `Expiry Date: ${formatDateIN(alert.expiryDate)}`,
    `Status: ${alert.triggerLabel}`,
    '',
    alert.triggerType === 'overdue'
      ? 'This document is currently OVERDUE. Please complete renewal immediately and update the renewed expiry date in the ERP.'
      : alert.triggerType === 'on_expiry'
      ? 'This document expires TODAY. Please arrange renewal immediately and update the ERP once renewed.'
      : 'Please arrange document renewal before the expiry date and update the new expiry date in the ERP.',
    '',
    `Regards, ${company}`,
  ];

  return lines.join('\n');
}

export function buildExpiryEmailContent(params: {
  alert: Pick<
    VehicleDocumentExpiryAlert,
    'vehicleNumber' | 'documentType' | 'expiryDate' | 'daysLeft' | 'triggerType' | 'triggerLabel'
  >;
  recipient: Pick<AuthorizedExpiryRecipient, 'recipientName' | 'recipientRole'>;
  companyName?: string;
}): { subject: string; body: string } {
  const company = (params.companyName || 'BAPASITARAM ENTERPRISE').trim();
  const { alert, recipient } = params;

  const statusTag =
    alert.triggerType === 'overdue'
      ? 'OVERDUE'
      : alert.triggerType === 'on_expiry'
      ? 'EXPIRING TODAY'
      : '5-DAY REMINDER';

  const subject = `[${statusTag}] ${alert.vehicleNumber} — ${alert.documentType} Expiry (${formatDateIN(alert.expiryDate)}) | ${company}`;

  const body = [
    `${company}`,
    `Vehicle Document Expiry Notification`,
    '',
    `Dear ${recipient.recipientName} (${formatRecipientRoleLabel(recipient.recipientRole)}),`,
    '',
    `Vehicle Number: ${alert.vehicleNumber}`,
    `Document Type: ${alert.documentType}`,
    `Expiry Date: ${formatDateIN(alert.expiryDate)}`,
    `Alert Status: ${alert.triggerLabel}`,
    '',
    alert.triggerType === 'overdue'
      ? 'Action Required: This vehicle document is overdue. Please renew immediately and update the renewed expiry date in the BAPASITARAM ENTERPRISE ERP.'
      : 'Action Required: Please arrange renewal before the expiry date and update the renewed date in the BAPASITARAM ENTERPRISE ERP.',
    '',
    `Regards,`,
    company,
  ].join('\n');

  return { subject, body };
}

/**
 * Builds a manual `mailto:` link strictly when a real saved email exists.
 * Never invents an email address.
 */
export function buildManualMailtoUrl(
  recipientEmail: string | null | undefined,
  subject: string,
  body: string
): string | null {
  const cleanEmail = (recipientEmail || '').trim();
  if (!isValidEmailAddress(cleanEmail)) return null;
  return `mailto:${encodeURIComponent(cleanEmail)}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
}

/**
 * Checks whether a recipient has a valid saved phone number for WhatsApp.
 */
export function hasValidRecipientPhone(phone: string | null | undefined): boolean {
  return normalizeWhatsAppPhone(phone).valid;
}
