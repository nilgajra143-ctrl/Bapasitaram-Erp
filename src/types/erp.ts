import type { Timestamp } from 'firebase/firestore';

export type NavSection =
  | 'dashboard'
  | 'trip-entry'
  | 'trip-history'
  | 'vehicles'
  | 'parties'
  | 'drivers'
  | 'expenses'
  | 'billing'
  | 'reports'
  | 'route-map'
  | 'ai-assistant'
  | 'excel-import'
  | 'security';

export const VEHICLE_TYPES = [
  'Truck',
  'Trailer',
  'Container',
  'Tanker',
  'Tipper',
  'LCV',
  'Other',
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_STATUSES = [
  'Available',
  'On Trip',
  'Maintenance',
  'Inactive',
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const PARTY_TYPES = [
  'Consignor',
  'Consignee',
  'Broker',
  'Both',
] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const PARTY_STATUSES = ['Active', 'Inactive'] as const;
export type PartyStatus = (typeof PARTY_STATUSES)[number];

export const TRIP_STATUSES = [
  'Scheduled',
  'In Transit',
  'Delivered',
  'Settled',
  'Cancelled',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const PAYMENT_STATUSES = ['Unpaid', 'Partial', 'Paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DRIVER_STATUSES = ['Active', 'Inactive'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const DRIVER_PAYMENT_TYPES = [
  'Salary Due',
  'Salary Paid',
  'Advance',
  'Allowance',
  'Deduction',
] as const;
export type DriverPaymentType = (typeof DRIVER_PAYMENT_TYPES)[number];

export const PARTY_PAYMENT_TYPES = [
  'Payment Received',
  'Advance',
  'Deduction',
] as const;
export type PartyPaymentType = (typeof PARTY_PAYMENT_TYPES)[number];

export const PAYMENT_MODES = [
  'Cash',
  'Bank Transfer',
  'UPI',
  'Cheque',
  'Ledger Adjustment',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const EXPENSE_CATEGORIES = [
  'Maintenance & Repair',
  'Tyre & Alignment',
  'Spare Parts',
  'Diesel',
  'Toll',
  'RTO & Permit Tax',
  'Other Expense',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const BILL_STATUSES = ['Draft', 'Issued', 'Paid', 'Cancelled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const ERP_USER_ROLES = ['admin', 'employee'] as const;
export type ErpUserRole = (typeof ERP_USER_ROLES)[number];

export const ERP_USER_STATUSES = ['Active', 'Suspended'] as const;
export type ErpUserStatus = (typeof ERP_USER_STATUSES)[number];

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'IMPORT'
  | 'EXPORT'
  | 'BACKUP'
  | 'RESTORE'
  | 'BILL';

// Synchronized verbatim with firebase-blueprint.json & firestore.rules
export const BLUEPRINT_LIMITS = {
  ID_PATTERN: /^[a-zA-Z0-9_\-]+$/,
  REG_NO_PATTERN: /^[A-Z0-9\-\s]{4,20}$/,
  VEHICLE_REG_MIN: 4,
  VEHICLE_REG_MAX: 20,
  MAKE_MODEL_MAX: 80,
  CAPACITY_MAX: 200,
  DRIVER_NAME_MAX: 80,
  PHONE_MAX: 20,
  DATE_MAX: 20,
  NOTES_MAX: 500,
  PARTY_NAME_MIN: 2,
  PARTY_NAME_MAX: 120,
  CONTACT_PERSON_MAX: 80,
  EMAIL_MAX: 120,
  GSTIN_MAX: 20,
  CITY_MAX: 80,
  STATE_MAX: 80,
  ADDRESS_MAX: 300,
  PAYMENT_TERMS_MAX: 365,
  SR_NO_MAX: 30,
  LR_NUMBER_MAX: 40,
  CONTAINER_NO_MAX: 40,
  LOCATION_MAX: 100,
  MATERIAL_MAX: 100,
  WEIGHT_MAX: 500,
  DIESEL_QTY_MAX: 100000,
  DIESEL_RATE_MAX: 10000,
  CURRENCY_MAX: 100000000,
  LICENSE_MAX: 40,
  VENDOR_MAX: 100,
  DESCRIPTION_MAX: 200,
  BILL_NO_MAX: 50,
  REFERENCE_MAX: 60,
  WORDS_MAX: 250,
} as const;

export const DEFAULT_DIESEL_RATE = 98.34;

export interface Vehicle {
  id: string;
  registrationNumber: string;
  vehicleType: VehicleType;
  makeModel: string;
  capacityTons: number;
  driverName: string;
  driverPhone: string;
  fitnessExpiry: string;
  insuranceExpiry: string;
  permitExpiry: string;
  pucExpiry?: string;
  taxExpiry?: string;
  status: VehicleStatus;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface Party {
  id: string;
  partyName: string;
  partyType: PartyType;
  contactPerson: string;
  phone: string;
  email: string;
  gstin: string;
  city: string;
  state: string;
  address: string;
  paymentTermsDays: number;
  status: PartyStatus;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface Trip {
  id: string;
  srNo?: string;
  lrNumber: string;
  tripDate: string;
  vehicleId: string;
  vehicleNumber: string;
  partyId: string;
  partyName: string;
  driverName: string;
  origin: string;
  destination: string;
  containerNo?: string;
  material: string;
  weightTons: number;
  freightAmount: number;
  advanceReceived: number;
  dieselQuantity?: number;
  dieselRate?: number;
  dieselExpense: number;
  tollExpense: number;
  driverAllowance: number;
  otherExpense: number;
  balanceAmount: number;
  totalExpense: number;
  tripStatus: TripStatus;
  paymentStatus: PaymentStatus;
  podReceived: boolean;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface Driver {
  id: string;
  driverName: string;
  phone: string;
  licenseNumber: string;
  licenseExpiry: string;
  assignedVehicleId: string;
  assignedVehicleNumber: string;
  monthlySalary: number;
  openingBalance: number;
  status: DriverStatus;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface DriverPayment {
  id: string;
  driverId: string;
  driverName: string;
  vehicleId: string;
  vehicleNumber: string;
  paymentDate: string;
  paymentType: DriverPaymentType;
  amount: number;
  paymentMode: PaymentMode;
  referenceNo: string;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface PartyPayment {
  id: string;
  partyId: string;
  partyName: string;
  tripId?: string;
  tripLrNumber?: string;
  paymentDate: string;
  paymentType: PartyPaymentType;
  amount: number;
  paymentMode: PaymentMode;
  referenceNo: string;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface MaintenanceRecord {
  id: string;
  expenseDate: string;
  vehicleId: string;
  vehicleNumber: string;
  category: ExpenseCategory;
  vendorName: string;
  description: string;
  dieselQuantity: number;
  amount: number;
  billNo: string;
  odometerKm: number;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface BillLineItem {
  tripId: string;
  srNo: string;
  tripDate: string;
  lrNumber: string;
  vehicleNumber: string;
  containerNo: string;
  origin: string;
  destination: string;
  rate: number;
  kharcha: number;
  dieselQuantity: number;
  dieselAmount: number;
  toll: number;
  jama: number;
  hisab: number;
  note: string;
}

export interface Bill {
  id: string;
  billNumber: string;
  billDate: string;
  partyId: string;
  partyName: string;
  partyGstin: string;
  partyAddress: string;
  tripIds: string[];
  lineItems: BillLineItem[];
  freightTotal: number;
  expenseTotal: number;
  advanceTotal: number;
  netPayable: number;
  amountInWords: string;
  bankDetails: string;
  status: BillStatus;
  notes: string;
  ownerId: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface CompanySettings {
  id: string;
  companyName: string;
  address: string;
  gstin: string;
  pan: string;
  phone: string;
  email: string;
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  branchName: string;
  billPrefix: string;
  nextBillSeq: number;
  defaultDieselRate?: number;
  terms: string;
  ownerId: string;
  updatedAt: Timestamp | null;
}

export interface ErpUser {
  id: string;
  email: string;
  displayName: string;
  role: ErpUserRole;
  status: ErpUserStatus;
  canEditTrips: boolean;
  canDeleteRecords: boolean;
  canManageBilling: boolean;
  canImportExcel: boolean;
  canExportData: boolean;
  canManageMasters: boolean;
  addedBy: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface AuditLog {
  id: string;
  actorEmail: string;
  actorRole: ErpUserRole;
  action: AuditAction;
  module: string;
  recordId: string;
  summary: string;
  ownerId: string;
  createdAt: Timestamp | null;
}

export type ImportTargetModule =
  | 'vehicles'
  | 'parties'
  | 'trips'
  | 'ledger-summary';

export type ErpMappableField =
  | 'skip'
  | 'excluded_karja'
  | 'srNo'
  | 'tripDate'
  | 'lrNumber'
  | 'vehicleNumber'
  | 'vehicleType'
  | 'driverName'
  | 'driverPhone'
  | 'partyName'
  | 'partyType'
  | 'gstin'
  | 'origin'
  | 'destination'
  | 'containerNo'
  | 'material'
  | 'weightTons'
  | 'freightAmount'
  | 'advanceReceived'
  | 'balanceAmount'
  | 'dieselQuantity'
  | 'dieselExpense'
  | 'tollExpense'
  | 'driverAllowance'
  | 'otherExpense'
  | 'tripStatus'
  | 'notes';

export interface ExcelCellRecord {
  header: string;
  cellAddress: string;
  value: string;
  formula: string;
  note: string;
  dataType: 'string' | 'number' | 'date' | 'boolean' | 'empty';
}

export interface ImportBatch {
  id: string;
  fileName: string;
  sheetNames: string[];
  vehiclesCreated: number;
  partiesCreated: number;
  tripsCreated: number;
  sheetRowsSaved: number;
  duplicatesSkipped: number;
  karjaExcludedCount: number;
  ownerId: string;
  createdAt: Timestamp | null;
}

export interface ImportedSheetRow {
  id: string;
  batchId: string;
  sheetName: string;
  rowIndex: number;
  targetModule: ImportTargetModule;
  mappedRecordId: string;
  rowSignature: string;
  originalDate: string;
  primaryAmount: number;
  notes: string;
  columnsOrder: string[];
  cells: ExcelCellRecord[];
  ownerId: string;
  createdAt: Timestamp | null;
}

export interface UserPermissions {
  role: ErpUserRole;
  isAdmin: boolean;
  isSuspended: boolean;
  canEditTrips: boolean;
  canDeleteRecords: boolean;
  canManageBilling: boolean;
  canImportExcel: boolean;
  canExportData: boolean;
  canManageMasters: boolean;
}
