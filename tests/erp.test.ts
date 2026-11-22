import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import {
  buildDateWisePartyStatement,
  calculateDieselAmount,
  classifyCleanupRecords,
  computePartyLedgerSummary,
  computeTripLinkedPaymentTotals,
  findDuplicateParty,
  findDuplicatePartyPayment,
  findDuplicateVehicle,
  matchesStatementPaymentMethod,
  resolveEffectiveDieselRate,
  sanitizeBackupRecordForRestore,
  STATEMENT_PAYMENT_METHOD_FILTERS,
} from '../src/utils/erpHelpers';
import {
  buildTripExcelRows,
  derivePaymentStatus,
  formatDateIN,
  formatINR,
  rupeesInWords,
} from '../src/utils/formatters';
import { buildImportExecutionPlan, parseWorkbookFile } from '../src/utils/excelImportParser';
import {
  createPartyStatementPdfDocument,
  reportContainsDevanagari,
} from '../src/utils/partyStatementPdf';
import {
  buildBillShareWhatsAppMessage,
  buildPaymentReceiptWhatsAppMessage,
  buildPaymentReminderWhatsAppMessage,
  buildWhatsAppManualUrl,
  createPdfFileFromJsPdf,
  normalizeWhatsAppPhone,
} from '../src/utils/whatsappShare';
import {
  buildLorryReceiptWhatsAppMessage,
  calculateLrBalance,
  filterLorryReceipts,
  findDuplicateLorryReceipt,
  generateNextUniqueLrNumber,
  isValidCompanyLogoDataUrl,
  LR_COMPANY_NAME,
  LR_CONTACT_LEFT,
  LR_CONTACT_RIGHT,
  LR_DEVOTIONAL_HEADER,
} from '../src/utils/lorryReceiptHelpers';
import {
  buildExpiryDedupKey,
  buildExpiryEmailContent,
  buildExpiryWhatsAppMessage,
  buildManualMailtoUrl,
  buildVehicleDocumentExpiryAlerts,
  filterNotificationHistoryForUser,
  getDaysUntilExpiryRelative,
  getExpiryTriggerType,
  hasDuplicateExpiryNotification,
  hasValidRecipientPhone,
  resolveAuthorizedRecipientsForVehicle,
  resolveAuthorizedVehiclesForUser,
} from '../src/utils/expiryNotifications';
import {
  buildContainerPhotoDownloadFileName,
  buildFirestoreContainerPhotoFields,
  buildPendingContainerPhotoRecord,
  formatLocalUploadDateTime,
  validateContainerPhotoDataUrl,
} from '../src/utils/containerPhotoHelpers';
import {
  createInMemoryPhotoQueueAdapter,
  getPendingContainerPhotos,
  savePendingContainerPhoto,
  syncPendingContainerPhotos,
} from '../src/utils/containerPhotoOfflineQueue';
import {
  BILL_HEADER_COMPANY_NAME,
  BILL_HEADER_CONTACT_LEFT,
  BILL_HEADER_CONTACT_RIGHT,
  BILL_HEADER_DEVOTIONAL_LINE,
  BILL_HEADER_LEFT_TRUCK_REG,
  BILL_HEADER_RIGHT_TRUCK_REG,
  computeDualTruckCropRects,
  isValidBillHeaderTruckDataUrl,
  resolveVerifiedBillBankDetails,
  resolveVerifiedCompanyAddress,
} from '../src/utils/billHeaderHelpers';
import {
  CONTAINER_PHOTO_TYPE,
  DEFAULT_DIESEL_RATE,
  type Bill,
  type CompanySettings,
  type Driver,
  type ErpUser,
  type ExpiryNotificationRecord,
  type ImportedSheetRow,
  type LorryReceipt,
  type NotificationPreference,
  type Party,
  type PartyPayment,
  type Trip,
  type UserPermissions,
  type Vehicle,
} from '../src/types/erp';

const ROOT_DIR = process.cwd();

test('Diesel automatic calculation computes exact 2-decimal INR and preserves historical rates', () => {
  assert.equal(DEFAULT_DIESEL_RATE, 98.34);
  assert.equal(calculateDieselAmount(100, 98.34), 9834);
  assert.equal(calculateDieselAmount(42.5, 98.34), 4179.45);
  assert.equal(calculateDieselAmount(33.33, 98.34), 3277.67);
  assert.equal(calculateDieselAmount(0, 98.34), 0);
  assert.equal(calculateDieselAmount(-15, 98.34), 0);

  // Historical trip retains its saved rate even if Admin updates company default rate later
  assert.equal(resolveEffectiveDieselRate(104.5, 98.34), 98.34);
  // New trips inherit updated Admin company rate
  assert.equal(resolveEffectiveDieselRate(101.25, undefined), 101.25);
  // Fallback when neither is set
  assert.equal(resolveEffectiveDieselRate(undefined, undefined), 98.34);
});

test('Vehicle & Party duplicate checks normalize formatting and allow self-edits', () => {
  const vehicles: Pick<Vehicle, 'id' | 'registrationNumber'>[] = [
    { id: 'veh_1', registrationNumber: 'GJ-03-BW-4312' },
    { id: 'veh_2', registrationNumber: 'GJ-03-BT-6552' },
  ];

  assert.equal(findDuplicateVehicle(vehicles, 'gj03bw4312')?.id, 'veh_1');
  assert.equal(findDuplicateVehicle(vehicles, 'GJ 03 BW 4312')?.id, 'veh_1');
  assert.equal(findDuplicateVehicle(vehicles, 'GJ-03-BW-4312', 'veh_1'), undefined);
  assert.equal(findDuplicateVehicle(vehicles, 'GJ-12-AZ-9999'), undefined);

  const parties: Pick<Party, 'id' | 'partyName' | 'gstin'>[] = [
    { id: 'pty_1', partyName: 'Mundra Logistics Pvt Ltd', gstin: '24AAACM1234A1Z5' },
  ];

  assert.equal(findDuplicateParty(parties, '  mundra   logistics pvt ltd ')?.reason, 'name');
  assert.equal(findDuplicateParty(parties, 'New Freight Co', '24aaacm1234a1z5')?.reason, 'gstin');
  assert.equal(
    findDuplicateParty(parties, 'Mundra Logistics Pvt Ltd', '24AAACM1234A1Z5', 'pty_1'),
    null
  );
  assert.equal(findDuplicateParty(parties, 'Adani Container Yard', '24AABCA9999B1Z2'), null);
});

test('INR formatting, amount-in-words, and Hindi Devanagari preservation work cleanly', () => {
  const formatted = formatINR(125430.5);
  assert.match(formatted, /1,25,430\.50/);

  assert.equal(
    rupeesInWords(45250.5),
    'Rupees Forty Five Thousand Two Hundred Fifty and Fifty Paise Only'
  );
  assert.equal(rupeesInWords(0), 'Rupees Zero Only');

  assert.equal(derivePaymentStatus(25000, 0), 'Unpaid');
  assert.equal(derivePaymentStatus(25000, 10000), 'Partial');
  assert.equal(derivePaymentStatus(25000, 25000), 'Paid');

  const hindiNote = 'मुंद्रा पोर्ट कंटेनर लोडिंग - भाड़ा बाकी';
  const exportedRows = buildTripExcelRows([
    {
      id: 'trp_1',
      srNo: '1',
      lrNumber: 'LR-101',
      tripDate: '2026-03-10',
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      partyId: 'pty_1',
      partyName: 'बापासीताराम लॉजिस्टिक्स',
      driverName: 'रमेश भाई',
      origin: 'Mundra',
      destination: 'Rajkot',
      containerNo: 'MSCU1234567',
      material: 'Tiles',
      weightTons: 28,
      freightAmount: 42000,
      advanceReceived: 15000,
      dieselQuantity: 120,
      dieselRate: 98.34,
      dieselExpense: 11800.8,
      tollExpense: 1200,
      driverAllowance: 800,
      otherExpense: 500,
      balanceAmount: 27000,
      totalExpense: 14300.8,
      tripStatus: 'Delivered',
      paymentStatus: 'Partial',
      podReceived: true,
      notes: hindiNote,
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ]);

  assert.equal(exportedRows[0]['Diesel Quantity (L)'], 120);
  assert.equal(exportedRows[0]['Diesel Amount (INR)'], 11800.8);
  assert.equal(exportedRows[0]['Note'], hindiNote);
  assert.equal(exportedRows[0]['Party Name'], 'बापासीताराम लॉजिस्टिक्स');
});

test('Excel 4-sheet parser preserves Diesel Qty/Amt separately, respects Hisab=0, and excludes Karja', () => {
  const wb = XLSX.utils.book_new();
  const sheet4312Rows = [
    ['Sr No', 'Date', 'Party Name', 'From', 'To', 'Container No', 'Rate', 'Kharcha', 'Diesel Quantity', 'Diesel Amount', 'Toll', 'Jama', 'Hisab', 'Karja', 'Note'],
    [1, '2026-02-15', 'Mundra Port Co', 'Mundra', 'Morbi', 'TEMU1122334', 35000, 400, 100, 9834, 650, 35000, 0, 5000, 'कंटेनर डिलीवरी'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Summary'], ['Total Trips', 1]]), 'Gadi Master Hisab');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Vehicle', 'Total Freight'], ['4312', 35000]]), 'Total Hisab');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet4312Rows), '4312');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Sr No', 'Date', 'Party Name', 'Rate']]), '6552');

  const nodeBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const buf = Uint8Array.from(nodeBuf).buffer;
  const parsed = parseWorkbookFile(buf, []);

  assert.equal(parsed.length, 4);
  const sheet4312 = parsed.find((s) => s.sheetName === '4312');
  assert.ok(sheet4312);
  assert.equal(sheet4312.excludedKarjaColsCount, 1);

  const plan = buildImportExecutionPlan('bapasitaram-test.xlsx', parsed, [], [], [], []);
  assert.equal(plan.tripsToCreate.length, 1);
  const trip = plan.tripsToCreate[0];
  assert.equal(trip.dieselQuantity, 100);
  assert.equal(trip.dieselExpense, 9834);
  assert.equal(trip.balanceAmount, 0); // Explicit Hisab = 0 preserved!
  assert.equal(trip.notes, 'कंटेनर डिलीवरी');
});

test('Cleanup classifier protects Excel-linked records and surfaces test/demo records', () => {
  const realTrip: Trip = {
    id: 'trp_real_1',
    srNo: '1',
    lrNumber: 'XLS-4312-R2',
    tripDate: '2026-02-15',
    vehicleId: 'veh_real',
    vehicleNumber: 'GJ-03-BW-4312',
    partyId: 'pty_real',
    partyName: 'Mundra Logistics',
    driverName: 'Ramesh',
    origin: 'Mundra',
    destination: 'Morbi',
    containerNo: '',
    material: 'General Cargo',
    weightTons: 0,
    freightAmount: 35000,
    advanceReceived: 35000,
    dieselQuantity: 100,
    dieselRate: 98.34,
    dieselExpense: 9834,
    tollExpense: 650,
    driverAllowance: 0,
    otherExpense: 400,
    balanceAmount: 0,
    totalExpense: 10884,
    tripStatus: 'Settled',
    paymentStatus: 'Paid',
    podReceived: true,
    notes: 'Imported from sheet 4312',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  const testTrip: Trip = {
    ...realTrip,
    id: 'trp_test_1',
    lrNumber: 'TEST-LR-999',
    vehicleId: 'veh_test',
    vehicleNumber: 'GJ-00-TEST-0001',
    partyId: 'pty_test',
    partyName: 'Demo Test Party',
    notes: 'smoke test entry',
  };

  const vehicles: Vehicle[] = [
    {
      id: 'veh_real',
      registrationNumber: 'GJ-03-BW-4312',
      vehicleType: 'Trailer',
      makeModel: 'Tata',
      capacityTons: 35,
      driverName: 'Ramesh',
      driverPhone: '',
      fitnessExpiry: '',
      insuranceExpiry: '',
      permitExpiry: '',
      pucExpiry: '',
      taxExpiry: '',
      status: 'Available',
      notes: 'Imported from Excel',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'veh_test',
      registrationNumber: 'GJ-00-TEST-0001',
      vehicleType: 'Truck',
      makeModel: 'Demo',
      capacityTons: 10,
      driverName: 'Dummy Driver',
      driverPhone: '',
      fitnessExpiry: '',
      insuranceExpiry: '',
      permitExpiry: '',
      pucExpiry: '',
      taxExpiry: '',
      status: 'Available',
      notes: 'temporary test truck',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const parties: Party[] = [
    {
      id: 'pty_real',
      partyName: 'Mundra Logistics',
      partyType: 'Consignor',
      contactPerson: '',
      phone: '',
      email: '',
      gstin: '',
      city: '',
      state: 'Gujarat',
      address: '',
      paymentTermsDays: 15,
      status: 'Active',
      notes: 'Imported from Excel',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const sheetRows: ImportedSheetRow[] = [
    {
      id: 'isr_1',
      batchId: 'imp_1',
      sheetName: '4312',
      rowIndex: 2,
      targetModule: 'trips',
      mappedRecordId: 'trp_real_1',
      rowSignature: '4312|2',
      originalDate: '2026-02-15',
      primaryAmount: 35000,
      notes: '',
      columnsOrder: ['Vehicle No', 'Party Name'],
      cells: [
        { header: 'Vehicle No', cellAddress: 'A2', dataType: 'string', value: 'GJ-03-BW-4312', formula: '', note: '' },
        { header: 'Party Name', cellAddress: 'B2', dataType: 'string', value: 'Mundra Logistics', formula: '', note: '' },
      ],
      ownerId: 'uid_admin',
      createdAt: null,
    },
  ];

  const classified = classifyCleanupRecords({
    vehicles,
    parties,
    trips: [realTrip, testTrip],
    drivers: [],
    driverPayments: [],
    maintenanceRecords: [],
    bills: [],
    importedSheetRows: sheetRows,
  });

  const realRow = classified.find((r) => r.id === 'trp_real_1');
  const testRow = classified.find((r) => r.id === 'trp_test_1');
  const realVehRow = classified.find((r) => r.id === 'veh_real');
  const testVehRow = classified.find((r) => r.id === 'veh_test');

  assert.equal(realRow?.classification, 'protected-excel');
  assert.equal(realRow?.isExcelLinked, true);
  assert.equal(realVehRow?.classification, 'protected-excel');

  assert.equal(testRow?.classification, 'suspected-test');
  assert.equal(testRow?.isExcelLinked, false);
  assert.equal(testVehRow?.classification, 'suspected-test');
});

test('Security rules, offline persistence, and fail-closed default permissions are configured correctly', () => {
  const rulesText = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
  assert.match(rulesText, /request\.auth\.token\.email_verified == true/);
  assert.match(rulesText, /'dieselRate' in data/);
  assert.match(rulesText, /'defaultDieselRate' in data/);
  assert.match(rulesText, /match \/auditLogs\/\{logId\}[\s\S]*allow update: if false;[\s\S]*allow delete: if false;/);
  assert.match(rulesText, /match \/companySettings\/\{settingId\}[\s\S]*allow delete: if false;/);

  const firebaseSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/firebase.ts'), 'utf8');
  assert.match(firebaseSrc, /persistentLocalCache/);
  assert.match(firebaseSrc, /persistentMultipleTabManager/);

  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
  assert.match(appSrc, /canEditTrips:\s*false/);
  assert.match(appSrc, /canDeleteRecords:\s*false/);
  assert.match(appSrc, /canManageBilling:\s*false/);
  assert.match(appSrc, /canManageMasters:\s*false/);
});

test('Trip Bill A4 PDF generator configuration and jsPDF binary output work as expected', () => {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  assert.equal(Math.round(doc.internal.pageSize.getWidth()), 210);
  assert.equal(Math.round(doc.internal.pageSize.getHeight()), 297);

  doc.setFontSize(14);
  doc.text('BAPASITARAM ENTERPRISE - Freight Bill BSE-0001', 15, 20);
  doc.setFontSize(10);
  doc.text('Party: Mundra Logistics | Vehicle: GJ-03-BW-4312 | Net: INR 35,000.00', 15, 30);
  doc.addPage();
  doc.text('Page 2 - Continuation', 15, 20);

  const bytes = doc.output('arraybuffer');
  const header = Buffer.from(bytes.slice(0, 8)).toString('ascii');
  assert.match(header, /^%PDF-1\./);
  assert.equal(doc.getNumberOfPages(), 2);

  const pdfExportSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/utils/pdfExport.ts'), 'utf8');
  assert.match(pdfExportSrc, /html2canvas-pro/);
  assert.match(pdfExportSrc, /document\.fonts\.ready/);
  assert.match(pdfExportSrc, /pdf\.save/);
});

test('Frontend source contains no exposed secret keys, GEMINI_API_KEY, or unsafe alerts/popups', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  assert.match(indexHtml, /Noto\+Sans\+Devanagari/);

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  for (const file of walk(path.join(ROOT_DIR, 'src'))) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /GEMINI_API_KEY|PRIVATE_KEY|window\.alert\(|window\.open\(/);
  }
});

test('Phase 1 PDF preview, download, print layout, and Hindi/English Trip Bill totals are wired', () => {
  const pdfExportSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/utils/pdfExport.ts'), 'utf8');
  assert.match(pdfExportSrc, /export async function renderElementToA4Pdf/);
  assert.match(pdfExportSrc, /export async function downloadElementAsA4Pdf/);
  assert.match(pdfExportSrc, /export function triggerPrintPreview/);
  assert.match(pdfExportSrc, /Noto Sans Devanagari/);
  assert.match(pdfExportSrc, /pageImages/);

  const previewModalSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PdfPreviewModal.tsx'), 'utf8');
  assert.match(previewModalSrc, /Download PDF/);
  assert.match(previewModalSrc, /Print/);
  assert.match(previewModalSrc, /A4 Page/);

  const billingSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/BillingView.tsx'), 'utf8');
  assert.match(billingSrc, /Preview A4 PDF/);
  assert.match(billingSrc, /<PdfPreviewModal/);
  assert.match(billingSrc, /<tfoot/);
  assert.match(billingSrc, /renderElementToA4Pdf/);

  const tripHistSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/TripHistoryView.tsx'), 'utf8');
  assert.match(tripHistSrc, /Preview A4 PDF/);
  assert.match(tripHistSrc, /<PdfPreviewModal/);

  const reportsSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/ReportsView.tsx'), 'utf8');
  assert.match(reportsSrc, /Preview A4 PDF/);
  assert.match(reportsSrc, /<PdfPreviewModal/);

  const indexCss = fs.readFileSync(path.join(ROOT_DIR, 'src/index.css'), 'utf8');
  assert.match(indexCss, /@media print/);
  assert.match(indexCss, /\.print-area-card/);
  assert.match(indexCss, /Noto Sans Devanagari/);
});

test('Backup sanitizer enforces firestore.rules schemas across all 8 collections and strips stray keys', () => {
  const ownerId = 'uid_admin_123';

  const v = sanitizeBackupRecordForRestore(
    'vehicles',
    {
      registrationNumber: 'gj-03-bw-4312',
      vehicleType: 'Trailer',
      capacityTons: 35,
      extraJunkField: 'should-be-stripped',
      createdAt: 'old-timestamp',
    },
    ownerId
  );
  assert.ok(v);
  assert.equal(v.registrationNumber, 'GJ-03-BW-4312');
  assert.equal('extraJunkField' in v, false);
  assert.equal('createdAt' in v, false);
  assert.equal('pucExpiry' in v, true);
  assert.equal('taxExpiry' in v, true);
  assert.equal(v.ownerId, ownerId);

  const invalidV = sanitizeBackupRecordForRestore('vehicles', { registrationNumber: '12' }, ownerId);
  assert.equal(invalidV, null);

  const p = sanitizeBackupRecordForRestore(
    'parties',
    { partyName: 'Shree Minerals', gstin: '24aabcs1429b1zs', stray: 99 },
    ownerId
  );
  assert.ok(p);
  assert.equal(p.gstin, '24AABCS1429B1ZS');
  assert.equal('stray' in p, false);

  const d = sanitizeBackupRecordForRestore('drivers', { driverName: 'Ramesh Patel', monthlySalary: 22000 }, ownerId);
  assert.ok(d);
  assert.equal(d.status, 'Active');

  const tr = sanitizeBackupRecordForRestore(
    'trips',
    {
      lrNumber: 'LR-501',
      tripDate: '2026-03-01',
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      partyId: 'pty_1',
      partyName: 'Shree Minerals',
      origin: 'Mundra',
      destination: 'Morbi',
      freightAmount: 40000,
      advanceReceived: 10000,
      dieselQuantity: 100,
      dieselRate: 98.34,
      dieselExpense: 9834,
      unknownCol: 'drop-me',
    },
    ownerId
  );
  assert.ok(tr);
  assert.equal(tr.balanceAmount, 30000);
  assert.equal(tr.paymentStatus, 'Partial');
  assert.equal('unknownCol' in tr, false);

  const dp = sanitizeBackupRecordForRestore(
    'driverPayments',
    { driverId: 'drv_1', driverName: 'Ramesh', paymentDate: '2026-03-02', amount: 2500 },
    ownerId
  );
  assert.ok(dp);

  const mr = sanitizeBackupRecordForRestore(
    'maintenanceRecords',
    {
      expenseDate: '2026-03-02',
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      category: 'Diesel',
      description: 'Diesel 50L',
      dieselQuantity: 50,
      amount: 4917,
    },
    ownerId
  );
  assert.ok(mr);

  const bill = sanitizeBackupRecordForRestore(
    'bills',
    {
      billNumber: 'BSE-0001',
      billDate: '2026-03-05',
      partyId: 'pty_1',
      partyName: 'Shree Minerals',
      tripIds: ['trp_1'],
      lineItems: [{ tripId: 'trp_1', rate: 40000 }],
      freightTotal: 40000,
      netPayable: 30000,
    },
    ownerId
  );
  assert.ok(bill);

  const cs = sanitizeBackupRecordForRestore(
    'companySettings',
    { companyName: 'BAPASITARAM ENTERPRISE', defaultDieselRate: 98.34, createdAt: 'strip-me' },
    ownerId
  );
  assert.ok(cs);
  assert.equal(cs.defaultDieselRate, 98.34);
  assert.equal('createdAt' in cs, false);
});

test('ExpensesView auto-calculates Diesel amount, and Cleanup confirmation shows full list without 6-row truncation', () => {
  const expensesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/ExpensesView.tsx'), 'utf8');
  assert.match(expensesSrc, /calculateDieselAmount/);
  assert.match(expensesSrc, /resolveEffectiveDieselRate/);
  assert.match(expensesSrc, /handleDieselLitresChange/);

  const securitySrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/SecurityBackupView.tsx'), 'utf8');
  assert.doesNotMatch(securitySrc, /\.slice\(0,\s*6\)/);
  assert.match(securitySrc, /sanitizeBackupRecordForRestore/);
  assert.match(securitySrc, /companySettings/);
});

test('Phase 1 interactive Verification Checklist drawer covers all 10 steps and persists progress', () => {
  const checklistSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/Phase1ChecklistDrawer.tsx'), 'utf8');
  assert.match(checklistSrc, /Phase 1 Verification Checklist/);
  assert.match(checklistSrc, /pdf_preview_a4/);
  assert.match(checklistSrc, /print_functionality/);
  assert.match(checklistSrc, /pdf_download/);
  assert.match(checklistSrc, /diesel_calc/);
  assert.match(checklistSrc, /add_test_party/);
  assert.match(checklistSrc, /add_test_vehicle/);
  assert.match(checklistSrc, /download_json_backup/);
  assert.match(checklistSrc, /verify_backup_valid/);
  assert.match(checklistSrc, /data_persistence/);
  assert.match(checklistSrc, /scan_old_test_records/);
  assert.match(checklistSrc, /localStorage/);
  assert.doesNotMatch(checklistSrc, /style=\{\{/);

  const layoutSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/LayoutShell.tsx'), 'utf8');
  assert.match(layoutSrc, /Phase 1 Checklist/);

  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
  assert.match(appSrc, /<Phase1ChecklistDrawer/);
});

test('Phase 2 Party Ledger computes accurate balances without double counting trips and handles Excel Hisab=0', () => {
  const baseTrip: Trip = {
    id: 'trp_1',
    srNo: '1',
    lrNumber: 'LR-1001',
    tripDate: '2026-04-01',
    vehicleId: 'veh_1',
    vehicleNumber: 'GJ-03-BW-4312',
    partyId: 'pty_1',
    partyName: 'Shree Ceramic Pvt Ltd',
    driverName: 'Ramesh',
    origin: 'Mundra',
    destination: 'Morbi',
    containerNo: '',
    material: 'Tiles',
    weightTons: 25,
    freightAmount: 40000,
    advanceReceived: 10000,
    dieselQuantity: 100,
    dieselRate: 98.34,
    dieselExpense: 9834,
    tollExpense: 500,
    driverAllowance: 500,
    otherExpense: 0,
    balanceAmount: 30000,
    totalExpense: 10834,
    tripStatus: 'Delivered',
    paymentStatus: 'Partial',
    podReceived: true,
    notes: '',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  const trips: Trip[] = [
    baseTrip,
    // Excel-settled row with small waiver -> explicit balanceAmount = 0 preserved
    {
      ...baseTrip,
      id: 'trp_2',
      lrNumber: 'XLS-4312-R5',
      freightAmount: 25000,
      advanceReceived: 24500,
      balanceAmount: 0,
      tripStatus: 'Settled',
      paymentStatus: 'Paid',
    },
    // Cancelled trip must be excluded from Party Ledger totals
    {
      ...baseTrip,
      id: 'trp_cancelled',
      lrNumber: 'LR-CANCEL',
      freightAmount: 99000,
      advanceReceived: 0,
      balanceAmount: 99000,
      tripStatus: 'Cancelled',
    },
    // Different party trip must not leak into pty_1
    {
      ...baseTrip,
      id: 'trp_other',
      partyId: 'pty_2',
      partyName: 'Other Party',
      freightAmount: 50000,
      advanceReceived: 0,
      balanceAmount: 50000,
    },
  ];

  const payments: PartyPayment[] = [
    {
      id: 'ptyp_1',
      partyId: 'pty_1',
      partyName: 'Shree Ceramic Pvt Ltd',
      paymentDate: '2026-04-05',
      paymentType: 'Payment Received',
      amount: 12000,
      paymentMode: 'UPI',
      referenceNo: 'UTR-9911',
      notes: 'Part payment',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ptyp_2',
      partyId: 'pty_1',
      partyName: 'Shree Ceramic Pvt Ltd',
      paymentDate: '2026-04-07',
      paymentType: 'Advance',
      amount: 5000,
      paymentMode: 'Bank Transfer',
      referenceNo: 'NEFT-202',
      notes: 'On-account advance',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ptyp_3',
      partyId: 'pty_1',
      partyName: 'Shree Ceramic Pvt Ltd',
      paymentDate: '2026-04-08',
      paymentType: 'Deduction',
      amount: 500,
      paymentMode: 'Ledger Adjustment',
      referenceNo: 'TDS-01',
      notes: 'TDS deducted',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const summary = computePartyLedgerSummary('pty_1', trips, payments);
  assert.equal(summary.tripCount, 2);
  assert.equal(summary.totalFreight, 65000);
  assert.equal(summary.tripAdvanceReceived, 34500);
  assert.equal(summary.tripHisabBalance, 30000);
  assert.equal(summary.paymentsReceivedTotal, 12000);
  assert.equal(summary.ledgerAdvancesTotal, 5000);
  assert.equal(summary.deductionsTotal, 500);
  assert.equal(summary.separatePaymentsTotal, 17000);
  assert.equal(summary.totalReceived, 51500);
  assert.equal(summary.totalCredited, 52000);
  assert.equal(summary.netOutstanding, 12500);
  assert.equal(summary.paymentCount, 3);

  // Overpayment / advance credit yields negative netOutstanding
  const creditSummary = computePartyLedgerSummary('pty_1', trips, [
    ...payments,
    {
      ...payments[0],
      id: 'ptyp_4',
      amount: 20000,
      referenceNo: 'UTR-ADV',
    },
  ]);
  assert.equal(creditSummary.netOutstanding, -7500);
});

test('Phase 2 Payment Entry duplicate guard blocks duplicate UTR/reference and identical same-day payments', () => {
  const existing: PartyPayment[] = [
    {
      id: 'ptyp_1',
      partyId: 'pty_1',
      partyName: 'Shree Ceramic',
      paymentDate: '2026-04-10',
      paymentType: 'Payment Received',
      amount: 15000,
      paymentMode: 'UPI',
      referenceNo: 'UTR 123456',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ptyp_2',
      partyId: 'pty_1',
      partyName: 'Shree Ceramic',
      paymentDate: '2026-04-10',
      paymentType: 'Payment Received',
      amount: 8000,
      paymentMode: 'Cash',
      referenceNo: '',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  // Duplicate normalized reference number blocked
  const dupRef = findDuplicatePartyPayment(existing, {
    partyId: 'pty_1',
    paymentDate: '2026-04-11',
    paymentType: 'Payment Received',
    amount: 12000,
    paymentMode: 'Bank Transfer',
    referenceNo: 'utr123456',
  });
  assert.equal(dupRef?.reason, 'reference');

  // Identical unreferenced same-day Cash entry blocked
  const dupIdentical = findDuplicatePartyPayment(existing, {
    partyId: 'pty_1',
    paymentDate: '2026-04-10',
    paymentType: 'Payment Received',
    amount: 8000,
    paymentMode: 'Cash',
    referenceNo: '',
  });
  assert.equal(dupIdentical?.reason, 'identical');

  // Distinct reference number for same-day, same-amount payment allowed
  const distinctRefAllowed = findDuplicatePartyPayment(existing, {
    partyId: 'pty_1',
    paymentDate: '2026-04-10',
    paymentType: 'Payment Received',
    amount: 15000,
    paymentMode: 'UPI',
    referenceNo: 'UTR-999888',
  });
  assert.equal(distinctRefAllowed, null);

  // Different party with same ref allowed
  const diffPartyAllowed = findDuplicatePartyPayment(existing, {
    partyId: 'pty_2',
    paymentDate: '2026-04-10',
    paymentType: 'Payment Received',
    amount: 15000,
    paymentMode: 'UPI',
    referenceNo: 'UTR123456',
  });
  assert.equal(diffPartyAllowed, null);
});

test('Phase 2 PartyPayments schema rules, backup sanitizer, and PartiesView statement PDF wiring are complete', () => {
  const sanitized = sanitizeBackupRecordForRestore(
    'partyPayments',
    {
      partyId: 'pty_1',
      partyName: 'Shree Ceramic',
      paymentDate: '2026-04-10',
      paymentType: 'Payment Received',
      amount: 15000,
      paymentMode: 'UPI',
      referenceNo: 'UTR123',
      junkField: 'strip-me',
    },
    'uid_admin_123'
  );
  assert.ok(sanitized);
  assert.equal('junkField' in sanitized, false);
  assert.equal(sanitized.amount, 15000);

  // Zero-amount party payment rejected by sanitizer
  const zeroRejected = sanitizeBackupRecordForRestore(
    'partyPayments',
    { partyId: 'pty_1', partyName: 'Shree Ceramic', paymentDate: '2026-04-10', amount: 0 },
    'uid_admin_123'
  );
  assert.equal(zeroRejected, null);

  const rulesText = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
  assert.match(rulesText, /function isValidPartyPayment\(data\)/);
  assert.match(rulesText, /match \/partyPayments\/\{paymentId\}/);

  const partiesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PartiesView.tsx'), 'utf8');
  assert.match(partiesSrc, /Add Payment/);
  assert.match(partiesSrc, /findDuplicatePartyPayment/);
  assert.match(partiesSrc, /computePartyLedgerSummary/);
  assert.match(partiesSrc, /buildDateWisePartyStatement/);
  assert.match(partiesSrc, /computeTripLinkedPaymentTotals/);
  assert.match(partiesSrc, /const canEditParty = permissions\.isAdmin/);
  assert.match(partiesSrc, /Print \/ PDF Statement/);
  assert.match(partiesSrc, /party-statement-a4-content/);
  assert.match(partiesSrc, /<PdfPreviewModal/);
  assert.doesNotMatch(partiesSrc, /style=\{\{/);
});

test('Phase 2 Date-Wise Party Statement reconciles running balance, date filters, Excel Hisab=0, and trip-linked partial payments', () => {
  const trip1: Trip = {
    id: 'trp_1',
    srNo: '1',
    lrNumber: 'LR-201',
    tripDate: '2026-04-01',
    vehicleId: 'veh_1',
    vehicleNumber: 'GJ-03-BW-4312',
    partyId: 'pty_1',
    partyName: 'Shree Ceramic Pvt Ltd',
    driverName: 'Ramesh',
    origin: 'Mundra',
    destination: 'Morbi',
    containerNo: 'MSCU1111111',
    material: 'Tiles',
    weightTons: 25,
    freightAmount: 40000,
    advanceReceived: 10000,
    dieselQuantity: 100,
    dieselRate: 98.34,
    dieselExpense: 9834,
    tollExpense: 500,
    driverAllowance: 500,
    otherExpense: 0,
    balanceAmount: 30000,
    totalExpense: 10834,
    tripStatus: 'Delivered',
    paymentStatus: 'Partial',
    podReceived: true,
    notes: '',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  const trip2ExcelZero: Trip = {
    ...trip1,
    id: 'trp_2',
    lrNumber: 'XLS-4312-R9',
    tripDate: '2026-04-05',
    freightAmount: 25000,
    advanceReceived: 24500,
    balanceAmount: 0,
    tripStatus: 'Settled',
    paymentStatus: 'Paid',
  };

  const payments: PartyPayment[] = [
    {
      id: 'ptyp_1',
      partyId: 'pty_1',
      partyName: 'Shree Ceramic Pvt Ltd',
      tripId: 'trp_1',
      tripLrNumber: 'LR-201',
      paymentDate: '2026-04-06',
      paymentType: 'Payment Received',
      amount: 12000,
      paymentMode: 'UPI',
      referenceNo: 'UTR-7711',
      notes: 'Partial payment against LR-201',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ptyp_2',
      partyId: 'pty_1',
      partyName: 'Shree Ceramic Pvt Ltd',
      tripId: '',
      tripLrNumber: '',
      paymentDate: '2026-04-08',
      paymentType: 'Advance',
      amount: 5000,
      paymentMode: 'Bank Transfer',
      referenceNo: 'NEFT-8822',
      notes: 'On-account advance',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const ledger = computePartyLedgerSummary('pty_1', [trip1, trip2ExcelZero], payments);
  const fullStmt = buildDateWisePartyStatement('pty_1', [trip1, trip2ExcelZero], payments);

  assert.equal(fullStmt.openingBalance, 0);
  assert.equal(fullStmt.rows.length, 4);
  assert.equal(fullStmt.rows[0].runningBalance, 30000); // Trip 1: 40000 - 10000
  assert.equal(fullStmt.rows[1].runningBalance, 30000); // Trip 2 Excel Hisab=0: 25000 - 25000
  assert.equal(fullStmt.rows[2].runningBalance, 18000); // Payment 12000
  assert.equal(fullStmt.rows[3].runningBalance, 13000); // Advance 5000
  assert.equal(fullStmt.closingBalance, ledger.netOutstanding);

  // Date-range filter starting 2026-04-06 rolls Trips 1 & 2 into Opening Balance = 30000
  const filteredStmt = buildDateWisePartyStatement(
    'pty_1',
    [trip1, trip2ExcelZero],
    payments,
    '2026-04-06',
    '2026-04-08'
  );
  assert.equal(filteredStmt.openingBalance, 30000);
  assert.equal(filteredStmt.rows.length, 2);
  assert.equal(filteredStmt.closingBalance, 13000);

  // Trip-linked partial payment totals map cleanly
  const linkedMap = computeTripLinkedPaymentTotals('pty_1', payments);
  assert.equal(linkedMap.get('trp_1'), 12000);
  assert.equal(linkedMap.get('trp_2'), undefined);
});

test('PartiesView real-time outstanding balance subtracts partyPayments from total freight bills safely', () => {
  const manualTripNoBalanceField = {
    id: 'trp_10',
    lrNumber: 'LR-301',
    tripDate: '2026-05-01',
    vehicleId: 'veh_1',
    vehicleNumber: 'GJ-03-BW-4312',
    partyId: 'pty_9',
    partyName: 'Morbi Freight Co',
    driverName: 'Suresh',
    origin: 'Mundra',
    destination: 'Morbi',
    material: 'Ceramic',
    weightTons: 20,
    freightAmount: 50000,
    advanceReceived: 0,
    dieselExpense: 5000,
    tollExpense: 400,
    driverAllowance: 600,
    otherExpense: 0,
    balanceAmount: undefined as unknown as number,
    totalExpense: 6000,
    tripStatus: 'Delivered' as const,
    paymentStatus: 'Unpaid' as const,
    podReceived: false,
    notes: '',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  const payments: PartyPayment[] = [
    {
      id: 'ptyp_10',
      partyId: 'pty_9',
      partyName: 'Morbi Freight Co',
      paymentDate: '2026-05-03',
      paymentType: 'Payment Received',
      amount: 18000,
      paymentMode: 'UPI',
      referenceNo: 'UTR-5501',
      notes: 'Part payment 1',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ptyp_11',
      partyId: 'pty_9',
      partyName: 'Morbi Freight Co',
      paymentDate: '2026-05-06',
      paymentType: 'Advance',
      amount: 7000,
      paymentMode: 'Bank Transfer',
      referenceNo: 'NEFT-5502',
      notes: 'Part payment 2',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ptyp_12',
      partyId: 'pty_9',
      partyName: 'Morbi Freight Co',
      paymentDate: '2026-05-07',
      paymentType: 'Deduction',
      amount: 1000,
      paymentMode: 'Ledger Adjustment',
      referenceNo: 'TDS-5503',
      notes: 'TDS deduction',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ptyp_13',
      partyId: 'pty_9',
      partyName: 'Morbi Freight Co',
      paymentDate: '2026-05-08',
      paymentType: '' as unknown as PartyPayment['paymentType'],
      amount: 2000,
      paymentMode: 'Cash',
      referenceNo: 'CASH-5504',
      notes: 'Legacy record with missing paymentType',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const summary = computePartyLedgerSummary('pty_9', [manualTripNoBalanceField], payments, 'Morbi Freight Co');
  assert.equal(summary.totalFreight, 50000);
  assert.equal(summary.partyPaymentsTotal, 28000);
  assert.equal(summary.totalCredited, 28000);
  assert.equal(summary.deductionsTotal, 1000);
  assert.equal(summary.netOutstanding, 22000);
  assert.equal(summary.paymentCount, 4);

  // Real-time update: removing one payment immediately recalculates outstanding balance
  const afterRemoval = computePartyLedgerSummary(
    'pty_9',
    [manualTripNoBalanceField],
    payments.slice(0, 2),
    'Morbi Freight Co'
  );
  assert.equal(afterRemoval.partyPaymentsTotal, 25000);
  assert.equal(afterRemoval.netOutstanding, 25000);

  const partiesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PartiesView.tsx'), 'utf8');
  assert.match(partiesSrc, /Real-Time Outstanding Balance/);
  assert.match(partiesSrc, /Total Freight Bills/);
  assert.match(partiesSrc, /directoryTotals/);
  assert.match(partiesSrc, /activeInspectParty/);
});

test('Party Details Download Statement generates a valid PDF summarizing freight bills, payments, and outstanding balance', () => {
  const party: Party = {
    id: 'pty_stmt_1',
    partyName: 'Saurashtra Tiles & Exports',
    partyType: 'Consignor',
    contactPerson: 'Maheshbhai',
    phone: '9825011223',
    email: 'accounts@saurashtratiles.in',
    gstin: '24AAECS1234F1Z5',
    city: 'Morbi',
    state: 'Gujarat',
    address: '8-A National Highway, Morbi',
    paymentTermsDays: 15,
    status: 'Active',
    notes: '',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  const trips: Trip[] = [
    {
      id: 'trp_stmt_1',
      srNo: '1',
      lrNumber: 'LR-9001',
      tripDate: '2026-05-01',
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      partyId: 'pty_stmt_1',
      partyName: 'Saurashtra Tiles & Exports',
      driverName: 'Kishore',
      origin: 'Morbi',
      destination: 'Mundra Port',
      containerNo: 'MSCU7654321',
      material: 'Ceramic Tiles',
      weightTons: 26,
      freightAmount: 45000,
      advanceReceived: 5000,
      dieselQuantity: 90,
      dieselRate: 98.34,
      dieselExpense: 8850.6,
      tollExpense: 600,
      driverAllowance: 500,
      otherExpense: 0,
      balanceAmount: 40000,
      totalExpense: 9950.6,
      tripStatus: 'Delivered',
      paymentStatus: 'Partial',
      podReceived: true,
      notes: 'Container gate-in done',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'trp_stmt_2',
      srNo: '2',
      lrNumber: 'XLS-4312-R22',
      tripDate: '2026-05-04',
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      partyId: 'pty_stmt_1',
      partyName: 'Saurashtra Tiles & Exports',
      driverName: 'Kishore',
      origin: 'Morbi',
      destination: 'Kandla',
      material: 'Ceramic Tiles',
      weightTons: 24,
      freightAmount: 30000,
      advanceReceived: 29500,
      dieselExpense: 7200,
      tollExpense: 400,
      driverAllowance: 400,
      otherExpense: 0,
      balanceAmount: 0, // Excel Hisab = 0 settled row preserved
      totalExpense: 8000,
      tripStatus: 'Settled',
      paymentStatus: 'Paid',
      podReceived: true,
      notes: 'Imported from Excel',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const payments: PartyPayment[] = [
    {
      id: 'ptyp_stmt_1',
      partyId: 'pty_stmt_1',
      partyName: 'Saurashtra Tiles & Exports',
      tripId: 'trp_stmt_1',
      tripLrNumber: 'LR-9001',
      paymentDate: '2026-05-08',
      paymentType: 'Payment Received',
      amount: 15000,
      paymentMode: 'UPI',
      referenceNo: 'UTR-908811',
      notes: 'Part settlement',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const bills: Bill[] = [
    {
      id: 'bill_stmt_1',
      billNumber: 'BS-2026-014',
      billDate: '2026-05-05',
      partyId: 'pty_stmt_1',
      partyName: 'Saurashtra Tiles & Exports',
      partyGstin: '24AAECS1234F1Z5',
      partyAddress: '8-A National Highway, Morbi',
      tripIds: ['trp_stmt_1'],
      lineItems: [],
      freightTotal: 45000,
      expenseTotal: 9950.6,
      advanceTotal: 5000,
      netPayable: 40000,
      amountInWords: 'Rupees Forty Thousand Only',
      bankDetails: 'State Bank of India',
      status: 'Issued',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const companySettings: CompanySettings = {
    id: 'primary',
    companyName: 'BAPASITARAM ENTERPRISE',
    address: 'Morbi, Gujarat',
    gstin: '24ABCDE1234F1Z5',
    pan: 'ABCDE1234F',
    phone: '9999988888',
    email: 'office@bapasitaram.in',
    bankName: 'State Bank of India',
    accountHolderName: 'BAPASITARAM ENTERPRISE',
    accountNumber: '12345678901',
    ifscCode: 'SBIN0001234',
    branchName: 'Morbi Main',
    billPrefix: 'BS',
    nextBillSeq: 15,
    terms: '',
    defaultDieselRate: 98.34,
    ownerId: 'uid_admin',
    updatedAt: null,
  };

  const built = createPartyStatementPdfDocument({
    party,
    trips,
    partyPayments: payments,
    bills,
    companySettings,
  });

  // Verify exact summary reconciliation (40,000 Trip Hisab + 0 Excel Hisab - 15,000 Payment = 25,000)
  assert.equal(built.summary.totalFreight, 75000);
  assert.equal(built.summary.partyPaymentsTotal, 15000);
  assert.equal(built.summary.netOutstanding, 25000);
  assert.equal(built.reportData.dateWise.closingBalance, 25000);
  assert.match(built.fileName, /^Party-Statement-Saurashtra-Tiles-Exports-\d{4}-\d{2}-\d{2}\.pdf$/);

  // Verify uncompressed PDF binary output contains header, party name, freight LR, payment ref, and outstanding balance
  const pdfBinary = built.pdf.output();
  assert.ok(pdfBinary.startsWith('%PDF-'), 'Output must be a valid PDF binary');
  assert.ok(pdfBinary.includes('Saurashtra Tiles & Exports'));
  assert.ok(pdfBinary.includes('LR-9001'));
  assert.ok(pdfBinary.includes('BS-2026-014'));
  assert.ok(pdfBinary.includes('UTR-908811'));
  assert.ok(pdfBinary.includes('Rs. 25,000.00'));
  assert.equal(reportContainsDevanagari(built.reportData), false);

  // Verify Devanagari detection triggers Noto Sans fallback when Hindi text is present
  const hindiReport = createPartyStatementPdfDocument({
    party: { ...party, partyName: 'श्री सिरेमिक ट्रांसपोर्ट' },
    trips,
    partyPayments: payments,
    companySettings,
  });
  assert.equal(reportContainsDevanagari(hindiReport.reportData), true);

  // Verify PartiesView wires Download Statement directly inside Party Details drawer with zero inline styles
  const partiesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PartiesView.tsx'), 'utf8');
  assert.match(partiesSrc, /Download Statement/);
  assert.match(partiesSrc, /downloadPartyStatementPdf/);
  assert.match(partiesSrc, /handleDirectDownloadStatement/);
  assert.doesNotMatch(partiesSrc, /style=\{\{/);
});

test('Reusable AddPaymentModal supports Cash/Bank/UPI/Cheque, required fields, and writes cleanly to partyPayments', () => {
  const modalSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/AddPaymentModal.tsx'), 'utf8');
  const partiesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PartiesView.tsx'), 'utf8');
  const rulesSrc = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');

  // Verify required payment method options (Cash, Bank -> Bank Transfer, UPI, Cheque) match firestore.rules enum
  assert.match(modalSrc, /label:\s*'Cash',\s*value:\s*'Cash'/);
  assert.match(modalSrc, /label:\s*'Bank',\s*value:\s*'Bank Transfer'/);
  assert.match(modalSrc, /label:\s*'UPI',\s*value:\s*'UPI'/);
  assert.match(modalSrc, /label:\s*'Cheque',\s*value:\s*'Cheque'/);
  assert.match(rulesSrc, /\['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Ledger Adjustment'\]/);

  // Verify all required form inputs, duplicate guard, and Firestore partyPayments write
  assert.match(modalSrc, /id="add-payment-party"/);
  assert.match(modalSrc, /id="add-payment-amount"/);
  assert.match(modalSrc, /id="add-payment-date"/);
  assert.match(modalSrc, /id="add-payment-reference"/);
  assert.match(modalSrc, /id="add-payment-notes"/);
  assert.match(modalSrc, /collection\(db,\s*'partyPayments'\)/);
  assert.match(modalSrc, /duplicateChecker/);
  assert.match(modalSrc, /recordAuditLog/);
  assert.doesNotMatch(modalSrc, /style=\{\{/);

  // Verify PartiesView renders and re-exports the reusable AddPaymentModal
  assert.match(partiesSrc, /<AddPaymentModal/);
  assert.match(partiesSrc, /export\s*\{\s*AddPaymentModal/);
});

test('Party Statement payment method filter (Cash, Bank, UPI, Cheque) reconciles accurately and filters PDF output', () => {
  // Verify dropdown filter options include All, Cash, Bank, UPI, Cheque
  assert.deepEqual(
    STATEMENT_PAYMENT_METHOD_FILTERS.map((o) => o.value),
    ['All', 'Cash', 'Bank', 'UPI', 'Cheque']
  );

  assert.equal(matchesStatementPaymentMethod('Cash', 'Cash'), true);
  assert.equal(matchesStatementPaymentMethod('Bank Transfer', 'Bank'), true);
  assert.equal(matchesStatementPaymentMethod('UPI', 'UPI'), true);
  assert.equal(matchesStatementPaymentMethod('Cheque', 'Cheque'), true);
  assert.equal(matchesStatementPaymentMethod('Cash', 'UPI'), false);
  assert.equal(matchesStatementPaymentMethod('Bank Transfer', 'Cheque'), false);

  const party: Party = {
    id: 'pty_flt_1',
    partyName: 'Gujarat Ceramic Works',
    partyType: 'Consignor',
    contactPerson: 'Raju',
    phone: '9825099887',
    email: '',
    gstin: '',
    city: 'Morbi',
    state: 'Gujarat',
    address: '',
    paymentTermsDays: 15,
    status: 'Active',
    notes: '',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  const trips: Trip[] = [
    {
      id: 'trp_flt_1',
      lrNumber: 'LR-701',
      tripDate: '2026-06-01',
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      partyId: 'pty_flt_1',
      partyName: 'Gujarat Ceramic Works',
      driverName: 'Manoj',
      origin: 'Morbi',
      destination: 'Mundra',
      material: 'Tiles',
      weightTons: 25,
      freightAmount: 100000,
      advanceReceived: 0,
      dieselExpense: 8000,
      tollExpense: 500,
      driverAllowance: 500,
      otherExpense: 0,
      balanceAmount: 100000,
      totalExpense: 9000,
      tripStatus: 'Delivered',
      paymentStatus: 'Partial',
      podReceived: true,
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const payments: PartyPayment[] = [
    {
      id: 'pp_cash',
      partyId: 'pty_flt_1',
      partyName: 'Gujarat Ceramic Works',
      paymentDate: '2026-06-02',
      paymentType: 'Payment Received',
      amount: 10000,
      paymentMode: 'Cash',
      referenceNo: 'CASH-01',
      notes: 'Cash receipt',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'pp_bank',
      partyId: 'pty_flt_1',
      partyName: 'Gujarat Ceramic Works',
      paymentDate: '2026-06-03',
      paymentType: 'Payment Received',
      amount: 25000,
      paymentMode: 'Bank Transfer',
      referenceNo: 'NEFT-202',
      notes: 'Bank NEFT',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'pp_upi',
      partyId: 'pty_flt_1',
      partyName: 'Gujarat Ceramic Works',
      paymentDate: '2026-06-04',
      paymentType: 'Payment Received',
      amount: 15000,
      paymentMode: 'UPI',
      referenceNo: 'UPI-303',
      notes: 'GPay UPI',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'pp_cheque',
      partyId: 'pty_flt_1',
      partyName: 'Gujarat Ceramic Works',
      paymentDate: '2026-06-05',
      paymentType: 'Payment Received',
      amount: 20000,
      paymentMode: 'Cheque',
      referenceNo: 'CHQ-404',
      notes: 'SBI Cheque',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  // Unfiltered statement reconciles full account: 100,000 - 70,000 = 30,000
  const allStmt = buildDateWisePartyStatement('pty_flt_1', trips, payments, '', '', party.partyName, 'All');
  assert.equal(allStmt.rows.length, 5);
  assert.equal(allStmt.closingBalance, 30000);

  // Filtered by Bank matches 'Bank Transfer' only
  const bankStmt = buildDateWisePartyStatement('pty_flt_1', trips, payments, '', '', party.partyName, 'Bank');
  assert.equal(bankStmt.rows.length, 1);
  assert.equal(bankStmt.periodCredit, 25000);
  assert.equal(bankStmt.closingBalance, 25000);

  // Filtered by UPI matches 'UPI' only and produces valid filtered PDF while keeping true overall balance (30,000)
  const upiPdf = createPartyStatementPdfDocument({
    party,
    trips,
    partyPayments: payments,
    paymentMethodFilter: 'UPI',
  });
  assert.equal(upiPdf.reportData.payments.length, 1);
  assert.equal(upiPdf.reportData.filteredPaymentsTotal, 15000);
  assert.equal(upiPdf.summary.netOutstanding, 30000);
  assert.match(upiPdf.fileName, /Party-Statement-Gujarat-Ceramic-Works-UPI-/);

  const upiPdfBinary = upiPdf.pdf.output();
  assert.ok(upiPdfBinary.includes('Payment Method Filter: UPI'));
  assert.ok(upiPdfBinary.includes('UPI-303'));
  assert.equal(upiPdfBinary.includes('CHQ-404'), false);

  // Verify PartiesView wires both payment method dropdown filters cleanly with zero inline styles
  const partiesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PartiesView.tsx'), 'utf8');
  assert.match(partiesSrc, /aria-label="Filter statement by payment method"/);
  assert.match(partiesSrc, /aria-label="Filter party payments by method"/);
  assert.match(partiesSrc, /STATEMENT_PAYMENT_METHOD_FILTERS/);
  assert.doesNotMatch(partiesSrc, /style=\{\{/);
});

test('WhatsApp phone normalization enforces country code and blocks invalid/empty recipients to protect privacy', () => {
  // 10-digit Indian mobile -> defaults to +91
  const local = normalizeWhatsAppPhone('98250 11223');
  assert.equal(local.valid, true);
  assert.equal(local.digits, '919825011223');
  assert.equal(local.displayNumber, '+91 98250 11223');

  // Leading 0 Indian mobile -> strips 0 and applies 91
  const withZero = normalizeWhatsAppPhone('098250-11223');
  assert.equal(withZero.valid, true);
  assert.equal(withZero.digits, '919825011223');

  // Explicit +91 international number preserved
  const withPlus = normalizeWhatsAppPhone('+91 98250-11223');
  assert.equal(withPlus.valid, true);
  assert.equal(withPlus.digits, '919825011223');

  // Non-Indian explicit international number preserved
  const intl = normalizeWhatsAppPhone('+1 (415) 555-2671');
  assert.equal(intl.valid, true);
  assert.equal(intl.digits, '14155552671');
  assert.equal(intl.displayNumber, '+14155552671');

  // Missing or malformed phone MUST NOT produce a recipient-less wa.me link
  const missing = buildWhatsAppManualUrl('', 'Confidential Ledger');
  assert.equal(missing.phone.valid, false);
  assert.equal(missing.url, null);

  const shortNum = buildWhatsAppManualUrl('12345', 'Confidential Ledger');
  assert.equal(shortNum.phone.valid, false);
  assert.equal(shortNum.url, null);

  // Valid recipient produces official manual wa.me URL with encoded text
  const validLink = buildWhatsAppManualUrl('9825011223', 'Hello Party');
  assert.equal(validLink.phone.valid, true);
  assert.equal(validLink.url, 'https://wa.me/919825011223?text=Hello%20Party');
});

test('WhatsApp Feature 1 (Payment Receipt) and Feature 3 (Payment Reminder) prepare accurate messages and wire into PartiesView', () => {
  // Feature 1: Payment Receipt message
  const receiptMsg = buildPaymentReceiptWhatsAppMessage({
    companyName: 'BAPASITARAM ENTERPRISE',
    partyName: 'Saurashtra Tiles & Exports',
    amount: 15000,
    paymentDate: '2026-06-10',
    paymentMode: 'UPI',
    paymentType: 'Payment Received',
    referenceNo: 'UTR-778899',
    tripLrNumber: 'LR-9001',
    remainingBalance: 25000,
  });

  assert.ok(receiptMsg.includes('BAPASITARAM ENTERPRISE'));
  assert.ok(receiptMsg.includes('Saurashtra Tiles & Exports'));
  assert.ok(receiptMsg.includes('15,000.00'));
  assert.ok(receiptMsg.includes(formatDateIN('2026-06-10')));
  assert.ok(receiptMsg.includes('UPI'));
  assert.ok(receiptMsg.includes('UTR-778899'));
  assert.ok(receiptMsg.includes('LR-9001'));
  assert.ok(receiptMsg.includes('25,000.00'));

  const receiptLink = buildWhatsAppManualUrl('+91 98250 11223', receiptMsg);
  assert.ok(receiptLink.url?.startsWith('https://wa.me/919825011223?text='));

  // Feature 3: Payment Reminder message with due details
  const reminderMsg = buildPaymentReminderWhatsAppMessage({
    companySettings: {
      id: 'primary',
      companyName: 'BAPASITARAM ENTERPRISE',
      address: 'Morbi, Gujarat',
      gstin: '24ABCDE1234F1Z5',
      pan: 'ABCDE1234F',
      phone: '9999988888',
      email: 'office@bapasitaram.in',
      bankName: 'State Bank of India',
      accountHolderName: 'BAPASITARAM ENTERPRISE',
      accountNumber: '12345678901',
      ifscCode: 'SBIN0001234',
      branchName: 'Morbi Main',
      billPrefix: 'BSE-',
      nextBillSeq: 2,
      terms: '',
      defaultDieselRate: 98.34,
      ownerId: 'uid_admin',
      updatedAt: null,
    },
    partyName: 'Saurashtra Tiles & Exports',
    outstandingBalance: 40000,
    totalFreight: 75000,
    totalPaid: 35000,
    paymentTermsDays: 15,
    pendingTrips: [
      {
        lrNumber: 'LR-9001',
        tripDate: '2026-05-01',
        vehicleNumber: 'GJ-03-BW-4312',
        remainingDue: 40000,
      },
    ],
    todayISO: '2026-06-10',
  });

  assert.ok(reminderMsg.includes('Payment Reminder'));
  assert.ok(reminderMsg.includes('Saurashtra Tiles & Exports'));
  assert.ok(reminderMsg.includes('40,000.00'));
  assert.ok(reminderMsg.includes('Credit Terms: 15 days'));
  assert.ok(reminderMsg.includes('LR-9001'));
  assert.ok(reminderMsg.includes('[Overdue]'));
  assert.ok(reminderMsg.includes('SBIN0001234'));

  // Verify PartiesView, AddPaymentModal, & WhatsAppShareModal wiring (no window.open, no inline styles)
  const partiesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PartiesView.tsx'), 'utf8');
  const modalSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/WhatsAppShareModal.tsx'), 'utf8');
  const addPaymentSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/AddPaymentModal.tsx'), 'utf8');
  assert.match(partiesSrc, /WhatsApp Share/);
  assert.match(partiesSrc, /WhatsApp Reminder/);
  assert.match(partiesSrc, /openWhatsAppPaymentReceipt/);
  assert.match(partiesSrc, /openWhatsAppPaymentReminder/);
  assert.match(partiesSrc, /<WhatsAppShareModal/);
  assert.match(addPaymentSrc, /Share on WhatsApp/);
  assert.match(addPaymentSrc, /Payment Confirmed/);
  assert.match(addPaymentSrc, /buildPaymentReceiptWhatsAppMessage/);
  assert.match(addPaymentSrc, /buildWhatsAppManualUrl/);
  assert.match(addPaymentSrc, /href=\{confirmedWhatsApp\.url\}/);
  assert.doesNotMatch(addPaymentSrc, /window\.open\(/);
  assert.doesNotMatch(addPaymentSrc, /style=\{\{/);
  assert.doesNotMatch(partiesSrc, /style=\{\{/);
  assert.doesNotMatch(modalSrc, /style=\{\{/);
  assert.doesNotMatch(modalSrc, /window\.open\(/);
  assert.match(modalSrc, /href=\{whatsappUrl\}/);
  assert.match(modalSrc, /rel="noopener noreferrer"/);
});

test('WhatsApp Feature 2 (Bill PDF Sharing) builds real PDF File attachment and wires WhatsApp Share into BillingView and PdfPreviewModal', () => {
  const bill: Bill = {
    id: 'bil_wa_1',
    billNumber: 'BSE-0042',
    billDate: '2026-06-12',
    partyId: 'pty_wa_1',
    partyName: 'Morbi Ceramic Exports',
    partyGstin: '24AAECM1234F1Z5',
    partyAddress: 'Morbi, Gujarat',
    tripIds: ['trp_1'],
    lineItems: [
      {
        tripId: 'trp_1',
        srNo: '1',
        tripDate: '2026-06-05',
        lrNumber: 'LR-4201',
        vehicleNumber: 'GJ-03-BW-4312',
        containerNo: 'MSCU9999999',
        origin: 'Morbi',
        destination: 'Mundra',
        rate: 48000,
        kharcha: 0,
        dieselQuantity: 95,
        dieselAmount: 9342.3,
        toll: 500,
        jama: 8000,
        hisab: 40000,
        note: '',
      },
    ],
    freightTotal: 48000,
    expenseTotal: 9842.3,
    advanceTotal: 8000,
    netPayable: 40000,
    amountInWords: 'Rupees Forty Thousand Only',
    bankDetails: 'Bank: State Bank of India | IFSC: SBIN0001234',
    status: 'Issued',
    notes: '',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  const billMsg = buildBillShareWhatsAppMessage({
    companyName: 'BAPASITARAM ENTERPRISE',
    bill,
    pdfFileName: 'Bill-BSE-0042-Morbi-Ceramic-Exports.pdf',
  });

  assert.ok(billMsg.includes('BSE-0042'));
  assert.ok(billMsg.includes('Morbi Ceramic Exports'));
  assert.ok(billMsg.includes('Bill-BSE-0042-Morbi-Ceramic-Exports.pdf'));
  assert.ok(billMsg.includes('48,000.00'));
  assert.ok(billMsg.includes('40,000.00'));
  assert.ok(billMsg.includes('SBIN0001234'));

  // Verify actual PDF File object creation from jsPDF
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  doc.text('BAPASITARAM ENTERPRISE - Bill BSE-0042', 15, 20);
  const pdfFile = createPdfFileFromJsPdf(doc, 'Bill-BSE-0042-Morbi-Ceramic-Exports.pdf');
  assert.equal(pdfFile.name, 'Bill-BSE-0042-Morbi-Ceramic-Exports.pdf');
  assert.equal(pdfFile.type, 'application/pdf');
  assert.ok(pdfFile.size > 100, 'Generated PDF File must contain valid PDF binary bytes');

  // Verify BillingView & PdfPreviewModal wire WhatsApp Share cleanly with zero inline styles
  const billingSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/BillingView.tsx'), 'utf8');
  const previewSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PdfPreviewModal.tsx'), 'utf8');
  const shareUtilSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/utils/whatsappShare.ts'), 'utf8');

  assert.match(billingSrc, /openWhatsAppShareForBillPdf/);
  assert.match(billingSrc, /createPdfFileFromJsPdf/);
  assert.match(billingSrc, /WhatsApp Share/);
  assert.match(billingSrc, /<WhatsAppShareModal/);
  assert.match(billingSrc, /onWhatsAppShare=/);
  assert.doesNotMatch(billingSrc, /style=\{\{/);
  assert.match(previewSrc, /onWhatsAppShare/);
  assert.match(shareUtilSrc, /navigator\.share\(/);
  assert.match(shareUtilSrc, /navigator\.canShare\(/);
});

test('Lorry Receipt (LR) numbering prevents duplicates across lorryReceipts and trips, calculates balance, and filters cleanly', () => {
  const existingLrs: LorryReceipt[] = [
    {
      id: 'lr_1',
      lrNumber: 'BSE-LR-0001',
      lrDate: '2026-06-15',
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      tripId: 'trp_1',
      tripRefLr: 'LR-4201',
      consignorPartyId: 'pty_1',
      consignorName: 'Shree Ceramic Pvt Ltd',
      consignorAddress: '8-A National Highway, Morbi, Gujarat',
      consignorPhone: '9825011223',
      consigneePartyId: 'pty_2',
      consigneeName: 'Mundra Export Hub',
      consigneeAddress: 'Plot 14, Mundra Port SEZ, Kutch',
      consigneePhone: '9825099887',
      origin: 'Morbi',
      destination: 'Mundra Port',
      containerNo: 'MSCU7788991',
      goodsDescription: 'Ceramic Floor Tiles (1200 Boxes)',
      quantityWeight: '26 MT',
      freightRate: 45000,
      totalFreightAmount: 45000,
      advanceAmount: 10000,
      balanceAmount: 35000,
      driverName: 'Rameshbhai Patel',
      driverMobile: '9876543210',
      remarks: 'Deliver before 6 PM',
      senderSignature: 'Maheshbhai',
      receiverSignature: 'Karanbhai',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'lr_2',
      lrNumber: 'BSE-LR-0002',
      lrDate: '2026-06-18',
      vehicleId: 'veh_2',
      vehicleNumber: 'GJ-12-AZ-9901',
      tripId: '',
      tripRefLr: '',
      consignorPartyId: '',
      consignorName: 'Kutch Minerals',
      consignorAddress: 'Gandhidham, Gujarat',
      consignorPhone: '9898112233',
      consigneePartyId: '',
      consigneeName: 'Rajkot Sanitaryware',
      consigneeAddress: 'Shapar GIDC, Rajkot',
      consigneePhone: '9898445566',
      origin: 'Gandhidham',
      destination: 'Rajkot',
      containerNo: '',
      goodsDescription: 'Silica Raw Material',
      quantityWeight: '22 MT',
      freightRate: 28000,
      totalFreightAmount: 28000,
      advanceAmount: 5000,
      balanceAmount: 23000,
      driverName: 'Vikram Sinh',
      driverMobile: '9725001122',
      remarks: '',
      senderSignature: '',
      receiverSignature: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  // Auto-generation skips existing LR numbers in both lorryReceipts AND trips
  const gen1 = generateNextUniqueLrNumber(
    existingLrs,
    [{ lrNumber: 'BSE-LR-0003' }],
    { lrPrefix: 'BSE-LR-', nextLrSeq: 1 }
  );
  assert.equal(gen1.lrNumber, 'BSE-LR-0004');
  assert.equal(gen1.nextSeq, 5);

  // Duplicate LR detection (case-insensitive & whitespace normalized)
  assert.ok(findDuplicateLorryReceipt(existingLrs, ' bse-lr-0001 '));
  assert.equal(findDuplicateLorryReceipt(existingLrs, 'BSE-LR-0001', 'lr_1'), undefined);
  assert.equal(findDuplicateLorryReceipt(existingLrs, 'BSE-LR-0099'), undefined);

  // Exact balance calculation
  assert.equal(calculateLrBalance(45000, 10000), 35000);
  assert.equal(calculateLrBalance(45000.75, 10000.25), 35000.5);

  // Search by LR number, date range, party (consignor/consignee), and vehicle
  assert.equal(filterLorryReceipts(existingLrs, { searchQuery: 'BSE-LR-0002' }).length, 1);
  assert.equal(filterLorryReceipts(existingLrs, { searchQuery: 'Mundra Export Hub' }).length, 1);
  assert.equal(filterLorryReceipts(existingLrs, { searchQuery: 'Shree Ceramic' }).length, 1);
  assert.equal(filterLorryReceipts(existingLrs, { vehicleFilter: 'GJ-03-BW-4312' }).length, 1);
  assert.equal(
    filterLorryReceipts(existingLrs, { fromDate: '2026-06-17', toDate: '2026-06-20' }).length,
    1
  );

  // WhatsApp LR message contains branding, contacts, route & amounts, and ZERO bank details / QR codes
  const waMsg = buildLorryReceiptWhatsAppMessage(existingLrs[0], 'LR-BSE-LR-0001-GJ-03-BW-4312.pdf');
  assert.ok(waMsg.includes(LR_DEVOTIONAL_HEADER));
  assert.ok(waMsg.includes(LR_COMPANY_NAME));
  assert.ok(waMsg.includes(LR_CONTACT_LEFT));
  assert.ok(waMsg.includes(LR_CONTACT_RIGHT));
  assert.ok(waMsg.includes('BSE-LR-0001'));
  assert.ok(waMsg.includes('GJ-03-BW-4312'));
  assert.ok(waMsg.includes('MSCU7788991'));
  assert.ok(waMsg.includes('45,000.00'));
  assert.ok(waMsg.includes('35,000.00'));
  assert.equal(/IFSC|Account No|A\/c No|QR Code/i.test(waMsg), false);

  // Logo data URL validator enforces safe PNG/JPEG/WebP and rejects invalid/oversized strings
  assert.equal(isValidCompanyLogoDataUrl(''), true);
  assert.equal(isValidCompanyLogoDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='), true);
  assert.equal(isValidCompanyLogoDataUrl('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(isValidCompanyLogoDataUrl('https://evil.example/logo.png'), false);
});

test('LorryReceiptsView, LayoutShell, App, blueprint, and firestore.rules enforce branding, all 19 LR fields, Admin logo & edit permissions, and no inline styles', () => {
  const lrViewSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/LorryReceiptsView.tsx'),
    'utf8'
  );
  const helpersSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/utils/lorryReceiptHelpers.ts'),
    'utf8'
  );
  const layoutSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/LayoutShell.tsx'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
  const rulesSrc = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
  const blueprintSrc = fs.readFileSync(path.join(ROOT_DIR, 'firebase-blueprint.json'), 'utf8');
  const indexHtmlSrc = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

  // Branding & Gujarati font
  assert.ok(helpersSrc.includes('|| માં આશાપુરા || માં મોગલ || માં ગાત્રોળ ||'));
  assert.ok(helpersSrc.includes('BAPASITARAM ENTERPRISE'));
  assert.ok(helpersSrc.includes('9537379915'));
  assert.ok(helpersSrc.includes('8128202784'));
  assert.match(indexHtmlSrc, /Noto\+Sans\+Gujarati/);

  // Royal Blue & White styling, zero inline styles, zero window.open/alert
  assert.match(lrViewSrc, /bg-blue-900/);
  assert.match(lrViewSrc, /border-blue-900/);
  assert.doesNotMatch(lrViewSrc, /style=\{\{/);
  assert.doesNotMatch(lrViewSrc, /window\.open\(/);
  assert.doesNotMatch(lrViewSrc, /window\.alert\(/);

  // All 19 LR form fields + Admin logo upload + A4 PDF/Print/WhatsApp
  assert.match(lrViewSrc, /1\. LR Number/);
  assert.match(lrViewSrc, /2\. LR Date/);
  assert.match(lrViewSrc, /3\. Vehicle Number/);
  assert.match(lrViewSrc, /4\. Consignor/);
  assert.match(lrViewSrc, /5\. Consignee/);
  assert.match(lrViewSrc, /6\. From/);
  assert.match(lrViewSrc, /7\. To/);
  assert.match(lrViewSrc, /8\. Container Number/);
  assert.match(lrViewSrc, /9\. Goods Description/);
  assert.match(lrViewSrc, /10\. Quantity \/ Weight/);
  assert.match(lrViewSrc, /11\. Freight Rate/);
  assert.match(lrViewSrc, /12\. Total Freight Amount/);
  assert.match(lrViewSrc, /13\. Advance Amount/);
  assert.match(lrViewSrc, /14\. Balance Amount/);
  assert.match(lrViewSrc, /15\. Driver Name/);
  assert.match(lrViewSrc, /16\. Driver Mobile Number/);
  assert.match(lrViewSrc, /17\. Remarks/);
  assert.match(lrViewSrc, /18\. Sender Signature/);
  assert.match(lrViewSrc, /19\. Receiver Signature/);
  assert.match(lrViewSrc, /Admin Company Logo Upload/);
  assert.match(lrViewSrc, /const canEditLr = permissions\.isAdmin/);
  assert.match(lrViewSrc, /const canManageBranding = permissions\.isAdmin/);
  assert.match(lrViewSrc, /lorry-receipt-a4-sheet/);
  assert.match(lrViewSrc, /renderElementToA4Pdf/);
  assert.match(lrViewSrc, /triggerPrintPreview/);
  assert.match(lrViewSrc, /<PdfPreviewModal/);
  assert.match(lrViewSrc, /<WhatsAppShareModal/);

  // Separate from Billing module & wired cleanly
  assert.match(layoutSrc, /Lorry Receipt \(LR\)/);
  assert.match(appSrc, /lorryReceipts/);
  assert.match(appSrc, /<LorryReceiptsView/);

  // Hardened Firestore rules & blueprint
  assert.match(rulesSrc, /function isValidLorryReceipt\(data\)/);
  assert.match(rulesSrc, /match \/lorryReceipts\/\{lrId\}/);
  assert.match(rulesSrc, /logoDataUrl/);
  assert.match(blueprintSrc, /"LorryReceipt"/);
  assert.match(blueprintSrc, /"\/lorryReceipts\/\{lrId\}"/);
});

test('Vehicle Document Expiry Notifications enforce Admin/Driver/Office Staff permissions, 5d/today/overdue timing, renewal clearing, deduplication, and contact safety', () => {
  const todayISO = '2026-07-10';

  // Timing window checks
  assert.equal(getDaysUntilExpiryRelative('2026-07-15', todayISO), 5);
  assert.equal(getExpiryTriggerType(5), '5_days_before');
  assert.equal(getExpiryTriggerType(1), '5_days_before');
  assert.equal(getExpiryTriggerType(0), 'on_expiry');
  assert.equal(getExpiryTriggerType(-1), 'overdue');
  assert.equal(getExpiryTriggerType(-30), 'overdue');
  assert.equal(getExpiryTriggerType(6), null); // Beyond 5-day window (renewed)
  assert.equal(getExpiryTriggerType(90), null);

  const vehicles: Vehicle[] = [
    {
      id: 'veh_1',
      registrationNumber: 'GJ-03-BW-4312',
      vehicleType: 'Truck',
      makeModel: 'Tata Prima',
      capacityTons: 25,
      driverName: 'Rameshbhai',
      driverPhone: '9825011111',
      fitnessExpiry: '2026-07-15', // 5 days before -> '5_days_before'
      insuranceExpiry: '2026-07-10', // Today -> 'on_expiry'
      permitExpiry: '2026-07-05', // 5 days overdue -> 'overdue'
      pucExpiry: '2026-12-31', // Valid (>5 days) -> no alert
      taxExpiry: '2026-10-01', // Valid -> no alert
      status: 'Available',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'veh_2',
      registrationNumber: 'GJ-12-AZ-9900',
      vehicleType: 'Trailer',
      makeModel: 'Ashok Leyland',
      capacityTons: 35,
      driverName: 'Sureshbhai',
      driverPhone: '', // Deliberately blank — must NEVER be invented
      fitnessExpiry: '2026-07-08', // Overdue -> 'overdue'
      insuranceExpiry: '2026-11-20',
      permitExpiry: '2026-11-20',
      pucExpiry: '2026-11-20',
      taxExpiry: '2026-11-20',
      status: 'On Trip',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'veh_3',
      registrationNumber: 'GJ-36-T-5555',
      vehicleType: 'Container',
      makeModel: 'BharatBenz',
      capacityTons: 30,
      driverName: 'Mahesh',
      driverPhone: '9825033333',
      fitnessExpiry: '2027-01-01', // All renewed > 5 days -> zero alerts
      insuranceExpiry: '2027-01-01',
      permitExpiry: '2027-01-01',
      pucExpiry: '2027-01-01',
      taxExpiry: '2027-01-01',
      status: 'Available',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const drivers: Driver[] = [
    {
      id: 'drv_1',
      driverName: 'Rameshbhai',
      phone: '9825011111',
      licenseNumber: 'GJ0320180001',
      licenseExpiry: '2028-01-01',
      assignedVehicleId: 'veh_1',
      assignedVehicleNumber: 'GJ-03-BW-4312',
      monthlySalary: 22000,
      openingBalance: 0,
      status: 'Active',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'drv_2',
      driverName: 'Sureshbhai',
      phone: '',
      licenseNumber: 'GJ1220190002',
      licenseExpiry: '2028-01-01',
      assignedVehicleId: 'veh_2',
      assignedVehicleNumber: 'GJ-12-AZ-9900',
      monthlySalary: 24000,
      openingBalance: 0,
      status: 'Active',
      notes: '',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const erpUsers: ErpUser[] = [
    {
      id: 'usr_staff_assigned',
      email: 'staff1@bapasitaram.in',
      displayName: 'Kiran Staff',
      role: 'employee',
      recipientRole: 'office_staff',
      phone: '9825022222',
      expiryAlertScope: 'assigned',
      assignedVehicleIds: ['veh_2'],
      assignedDriverId: '',
      status: 'Active',
      canEditTrips: true,
      canDeleteRecords: false,
      canManageBilling: false,
      canImportExcel: false,
      canExportData: true,
      canManageMasters: false,
      addedBy: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'usr_staff_all',
      email: 'manager@bapasitaram.in',
      displayName: 'Fleet Manager',
      role: 'employee',
      recipientRole: 'office_staff',
      phone: '',
      expiryAlertScope: 'all',
      assignedVehicleIds: [],
      assignedDriverId: '',
      status: 'Active',
      canEditTrips: true,
      canDeleteRecords: false,
      canManageBilling: true,
      canImportExcel: false,
      canExportData: true,
      canManageMasters: true,
      addedBy: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'usr_staff_none',
      email: 'restricted@bapasitaram.in',
      displayName: 'Restricted Clerk',
      role: 'employee',
      recipientRole: 'office_staff',
      phone: '',
      expiryAlertScope: 'none',
      assignedVehicleIds: ['veh_1'],
      assignedDriverId: '',
      status: 'Active',
      canEditTrips: false,
      canDeleteRecords: false,
      canManageBilling: false,
      canImportExcel: false,
      canExportData: false,
      canManageMasters: false,
      addedBy: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'usr_driver_1',
      email: 'ramesh.driver@gmail.com',
      displayName: 'Rameshbhai',
      role: 'employee',
      recipientRole: 'driver',
      phone: '9825011111',
      expiryAlertScope: 'assigned',
      assignedVehicleIds: ['veh_1'],
      assignedDriverId: 'drv_1',
      status: 'Active',
      canEditTrips: false,
      canDeleteRecords: false,
      canManageBilling: false,
      canImportExcel: false,
      canExportData: false,
      canManageMasters: false,
      addedBy: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];

  const basePerm = {
    isSuspended: false,
    canEditTrips: false,
    canDeleteRecords: false,
    canManageBilling: false,
    canImportExcel: false,
    canExportData: false,
    canManageMasters: false,
  };

  const adminPerms: UserPermissions = {
    ...basePerm,
    role: 'admin',
    recipientRole: 'admin',
    expiryAlertScope: 'all',
    assignedVehicleIds: [],
    assignedDriverId: '',
    isAdmin: true,
  };

  const driver1Perms: UserPermissions = {
    ...basePerm,
    role: 'employee',
    recipientRole: 'driver',
    expiryAlertScope: 'assigned',
    assignedVehicleIds: ['veh_1'],
    assignedDriverId: 'drv_1',
    isAdmin: false,
  };

  const staffAssignedPerms: UserPermissions = {
    ...basePerm,
    role: 'employee',
    recipientRole: 'office_staff',
    expiryAlertScope: 'assigned',
    assignedVehicleIds: ['veh_2'],
    assignedDriverId: '',
    isAdmin: false,
  };

  const staffAllPerms: UserPermissions = {
    ...basePerm,
    role: 'employee',
    recipientRole: 'office_staff',
    expiryAlertScope: 'all',
    assignedVehicleIds: [],
    assignedDriverId: '',
    isAdmin: false,
  };

  const staffNonePerms: UserPermissions = {
    ...basePerm,
    role: 'employee',
    recipientRole: 'office_staff',
    expiryAlertScope: 'none',
    assignedVehicleIds: ['veh_1'],
    assignedDriverId: '',
    isAdmin: false,
  };

  // 1. Admin sees ALL vehicles & ALL 4 alerts (veh_1: Permit overdue, Insurance today, Fitness 5d; veh_2: Fitness overdue; veh_3: 0 renewed)
  assert.equal(resolveAuthorizedVehiclesForUser({ vehicles, drivers, permissions: adminPerms }).length, 3);
  const adminAlerts = buildVehicleDocumentExpiryAlerts({
    vehicles,
    drivers,
    erpUsers,
    preferences: [],
    permissions: adminPerms,
    activeUserEmail: 'nilgajra143@gmail.com',
    activeUserId: 'uid_admin',
    activeUserName: 'Admin',
    adminUser: { userId: 'uid_admin', email: 'nilgajra143@gmail.com', displayName: 'Admin' },
    todayISO,
  });
  assert.equal(adminAlerts.length, 4);
  assert.equal(adminAlerts[0].triggerType, 'overdue');
  assert.ok(adminAlerts.some((a) => a.vehicleId === 'veh_1' && a.documentType === 'Fitness' && a.triggerType === '5_days_before'));
  assert.ok(adminAlerts.some((a) => a.vehicleId === 'veh_1' && a.documentType === 'Insurance' && a.triggerType === 'on_expiry'));
  assert.ok(adminAlerts.some((a) => a.vehicleId === 'veh_1' && a.documentType === 'Permit' && a.triggerType === 'overdue'));
  assert.ok(adminAlerts.some((a) => a.vehicleId === 'veh_2' && a.documentType === 'Fitness' && a.triggerType === 'overdue'));

  // 2. Driver sees ONLY assigned vehicle (veh_1) — NEVER veh_2 or other staff contacts
  const driverVehicles = resolveAuthorizedVehiclesForUser({ vehicles, drivers, permissions: driver1Perms });
  assert.deepEqual(driverVehicles.map((v) => v.id), ['veh_1']);
  const driverAlerts = buildVehicleDocumentExpiryAlerts({
    vehicles,
    drivers,
    erpUsers,
    preferences: [],
    permissions: driver1Perms,
    activeUserEmail: 'ramesh.driver@gmail.com',
    activeUserId: 'uid_drv_1',
    activeUserName: 'Rameshbhai',
    todayISO,
  });
  assert.equal(driverAlerts.length, 3);
  assert.equal(driverAlerts.every((a) => a.vehicleId === 'veh_1'), true);
  assert.equal(driverAlerts.every((a) => a.recipients.length === 1 && a.recipients[0].recipientRole === 'driver'), true);

  // 3. Office Staff ('assigned') sees ONLY veh_2 (never veh_1!)
  const staffAssignedAlerts = buildVehicleDocumentExpiryAlerts({
    vehicles,
    drivers,
    erpUsers,
    preferences: [],
    permissions: staffAssignedPerms,
    activeUserEmail: 'staff1@bapasitaram.in',
    activeUserId: 'uid_staff_1',
    activeUserName: 'Kiran Staff',
    todayISO,
  });
  assert.equal(staffAssignedAlerts.length, 1);
  assert.equal(staffAssignedAlerts[0].vehicleId, 'veh_2');

  // 4. Office Staff ('all') sees all fleet alerts; Office Staff ('none') sees ZERO alerts
  assert.equal(resolveAuthorizedVehiclesForUser({ vehicles, drivers, permissions: staffAllPerms }).length, 3);
  assert.equal(resolveAuthorizedVehiclesForUser({ vehicles, drivers, permissions: staffNonePerms }).length, 0);

  // 5. Recipient resolution per vehicle: veh_1 includes Admin + Driver Ramesh + Fleet Manager (all), NEVER Kiran Staff (assigned to veh_2) or Restricted Clerk
  const veh1Recipients = resolveAuthorizedRecipientsForVehicle({
    vehicle: vehicles[0],
    drivers,
    erpUsers,
    preferences: [],
    adminUser: { userId: 'uid_admin', email: 'nilgajra143@gmail.com', displayName: 'Admin' },
  });
  assert.ok(veh1Recipients.some((r) => r.recipientRole === 'admin' && r.recipientEmail === 'nilgajra143@gmail.com'));
  assert.ok(veh1Recipients.some((r) => r.recipientRole === 'driver' && r.recipientName === 'Rameshbhai' && r.recipientPhone === '9825011111'));
  assert.ok(veh1Recipients.some((r) => r.recipientRole === 'office_staff' && r.recipientEmail === 'manager@bapasitaram.in'));
  assert.equal(veh1Recipients.some((r) => r.recipientEmail === 'staff1@bapasitaram.in'), false);
  assert.equal(veh1Recipients.some((r) => r.recipientEmail === 'restricted@bapasitaram.in'), false);

  // 6. Contact safety: veh_2 driver Suresh has NO phone & NO email — NEVER invented!
  const veh2Recipients = resolveAuthorizedRecipientsForVehicle({
    vehicle: vehicles[1],
    drivers,
    erpUsers,
    preferences: [],
    adminUser: { userId: 'uid_admin', email: 'nilgajra143@gmail.com', displayName: 'Admin' },
  });
  const sureshRec = veh2Recipients.find((r) => r.recipientRole === 'driver');
  assert.ok(sureshRec);
  assert.equal(sureshRec.recipientPhone, '');
  assert.equal(sureshRec.recipientEmail, '');
  assert.equal(hasValidRecipientPhone(sureshRec.recipientPhone), false);
  assert.equal(buildManualMailtoUrl(sureshRec.recipientEmail, 'Test', 'Body'), null);

  // 7. Renewing veh_2 Fitness to future (>5 days) immediately clears its overdue alert
  const renewedVehicles = vehicles.map((v) =>
    v.id === 'veh_2' ? { ...v, fitnessExpiry: '2027-07-08' } : v
  );
  const afterRenewalAlerts = buildVehicleDocumentExpiryAlerts({
    vehicles: renewedVehicles,
    drivers,
    erpUsers,
    preferences: [],
    permissions: staffAssignedPerms,
    activeUserEmail: 'staff1@bapasitaram.in',
    activeUserId: 'uid_staff_1',
    activeUserName: 'Kiran Staff',
    todayISO,
  });
  assert.equal(afterRenewalAlerts.length, 0);

  // 8. Per-user preference filtering respects remindFiveDaysBefore / inAppEnabled toggles
  const muted5DayPref: NotificationPreference = {
    id: 'uid_drv_1',
    userId: 'uid_drv_1',
    email: 'ramesh.driver@gmail.com',
    displayName: 'Rameshbhai',
    phone: '9825011111',
    inAppEnabled: true,
    emailEnabled: true,
    whatsappEnabled: true,
    remindFiveDaysBefore: false,
    remindOnExpiryDate: true,
    remindOverdue: true,
    ownerId: 'uid_drv_1',
    updatedAt: null,
  };
  const driverWithPrefAlerts = buildVehicleDocumentExpiryAlerts({
    vehicles,
    drivers,
    erpUsers,
    preferences: [muted5DayPref],
    permissions: driver1Perms,
    activeUserEmail: 'ramesh.driver@gmail.com',
    activeUserId: 'uid_drv_1',
    activeUserName: 'Rameshbhai',
    todayISO,
    respectActiveUserPreferences: true,
  });
  assert.equal(driverWithPrefAlerts.length, 2); // Only overdue + on_expiry remain
  assert.equal(driverWithPrefAlerts.some((a) => a.triggerType === '5_days_before'), false);

  // 9. Duplicate notification prevention & renewal reset
  const dedup1 = buildExpiryDedupKey({
    vehicleId: 'veh_1',
    documentType: 'Insurance',
    expiryDate: '2026-07-10',
    recipientRole: 'driver',
    recipientId: 'drv_1',
    triggerType: 'on_expiry',
    channel: 'WhatsApp (Manual)',
  });
  const dedupRenewed = buildExpiryDedupKey({
    vehicleId: 'veh_1',
    documentType: 'Insurance',
    expiryDate: '2027-07-10',
    recipientRole: 'driver',
    recipientId: 'drv_1',
    triggerType: 'on_expiry',
    channel: 'WhatsApp (Manual)',
  });
  assert.notEqual(dedup1, dedupRenewed);

  const history: ExpiryNotificationRecord[] = [
    {
      id: 'ntf_1',
      dedupKey: dedup1,
      vehicleId: 'veh_1',
      vehicleNumber: 'GJ-03-BW-4312',
      documentType: 'Insurance',
      expiryDate: '2026-07-10',
      triggerType: 'on_expiry',
      recipientRole: 'driver',
      recipientId: 'drv_1',
      recipientName: 'Rameshbhai',
      recipientEmail: 'ramesh.driver@gmail.com',
      recipientPhone: '9825011111',
      channel: 'WhatsApp (Manual)',
      deliveryStatus: 'Prepared (Manual)',
      statusNote: 'Manual share prepared',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'ntf_2',
      dedupKey: 'veh_2|fitness|2026-07-08|office_staff|usr_staff_assigned|overdue|email',
      vehicleId: 'veh_2',
      vehicleNumber: 'GJ-12-AZ-9900',
      documentType: 'Fitness',
      expiryDate: '2026-07-08',
      triggerType: 'overdue',
      recipientRole: 'office_staff',
      recipientId: 'usr_staff_assigned',
      recipientName: 'Kiran Staff',
      recipientEmail: 'staff1@bapasitaram.in',
      recipientPhone: '9825022222',
      channel: 'Email',
      deliveryStatus: 'Sent',
      statusNote: 'Sent',
      ownerId: 'uid_admin',
      createdAt: null,
      updatedAt: null,
    },
  ];
  assert.equal(hasDuplicateExpiryNotification(history, dedup1), true);
  assert.equal(hasDuplicateExpiryNotification(history, dedupRenewed), false);

  // 10. History scoping prevents cross-user & cross-vehicle exposure
  const driverHistory = filterNotificationHistoryForUser({
    history,
    permissions: driver1Perms,
    userId: 'uid_drv_1',
    userEmail: 'ramesh.driver@gmail.com',
    authorizedVehicleIds: new Set(['veh_1']),
  });
  assert.deepEqual(driverHistory.map((h) => h.id), ['ntf_1']);

  const staffHistory = filterNotificationHistoryForUser({
    history,
    permissions: staffAssignedPerms,
    userId: 'uid_staff_1',
    userEmail: 'staff1@bapasitaram.in',
    authorizedVehicleIds: new Set(['veh_2']),
  });
  assert.deepEqual(staffHistory.map((h) => h.id), ['ntf_2']);

  // 11. WhatsApp & Email message builders include vehicle, doc type, expiry date, and urgency status
  const waMsg = buildExpiryWhatsAppMessage({
    alert: adminAlerts[0],
    recipient: veh1Recipients[0],
  });
  assert.ok(waMsg.includes('BAPASITARAM ENTERPRISE'));
  assert.ok(waMsg.includes(adminAlerts[0].vehicleNumber));
  assert.ok(waMsg.includes(adminAlerts[0].documentType));

  const emailObj = buildExpiryEmailContent({
    alert: adminAlerts[0],
    recipient: veh1Recipients[0],
  });
  assert.ok(emailObj.subject.includes(adminAlerts[0].vehicleNumber));
  const mailto = buildManualMailtoUrl('nilgajra143@gmail.com', emailObj.subject, emailObj.body);
  assert.ok(mailto?.startsWith('mailto:nilgajra143%40gmail.com?subject='));
});

test('ExpiryNotificationsView, DashboardView, SecurityBackupView, server.ts, blueprint, and firestore.rules satisfy security and UI constraints', () => {
  const expiryViewSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/ExpiryNotificationsView.tsx'),
    'utf8'
  );
  const dashboardSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/DashboardView.tsx'),
    'utf8'
  );
  const securitySrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/SecurityBackupView.tsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.ts'), 'utf8');
  const rulesSrc = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
  const blueprintSrc = fs.readFileSync(path.join(ROOT_DIR, 'firebase-blueprint.json'), 'utf8');
  const envExampleSrc = fs.readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf8');

  // Zero inline styles, zero window.open, zero window.alert
  for (const src of [expiryViewSrc, dashboardSrc, securitySrc]) {
    assert.doesNotMatch(src, /style=\{\{/);
    assert.doesNotMatch(src, /window\.open\(/);
    assert.doesNotMatch(src, /window\.alert\(/);
  }

  // UI wiring assertions
  assert.match(expiryViewSrc, /<WhatsAppShareModal/);
  assert.match(expiryViewSrc, /My Preferences/);
  assert.match(expiryViewSrc, /Notification History/);
  assert.match(expiryViewSrc, /Recipient Access Control/);
  assert.match(expiryViewSrc, /\/api\/notifications\/channel-status/);
  assert.match(expiryViewSrc, /\/api\/notifications\/send/);
  assert.match(dashboardSrc, /Vehicle Document Expiry Alerts/);
  assert.match(dashboardSrc, /buildVehicleDocumentExpiryAlerts/);
  assert.match(dashboardSrc, /<WhatsAppShareModal/);
  assert.match(appSrc, /notificationPreferences/);
  assert.match(appSrc, /expiryNotifications/);
  assert.match(appSrc, /<ExpiryNotificationsView/);

  // Server webhook endpoints stay auth-protected & free-by-default (no paid APIs)
  assert.match(serverSrc, /\/api\/notifications\/channel-status/);
  assert.match(serverSrc, /\/api\/notifications\/send/);
  assert.match(envExampleSrc, /NOTIFICATION_EMAIL_WEBHOOK_URL=/);
  assert.match(envExampleSrc, /NOTIFICATION_WHATSAPP_WEBHOOK_URL=/);

  // Firestore rules & blueprint hardened
  assert.match(rulesSrc, /function isValidNotificationPreference\(data\)/);
  assert.match(rulesSrc, /function isValidExpiryNotification\(data\)/);
  assert.match(rulesSrc, /match \/notificationPreferences\/\{prefId\}/);
  assert.match(rulesSrc, /match \/expiryNotifications\/\{notificationId\}/);
  assert.match(blueprintSrc, /"NotificationPreference"/);
  assert.match(blueprintSrc, /"ExpiryNotification"/);
});

test('Container Rear-Door Photo validation blocks public links, SVG, and oversized payloads while linking trip metadata', () => {
  const sampleJpegDataUrl = `data:image/jpeg;base64,${'A'.repeat(120)}`;
  assert.equal(validateContainerPhotoDataUrl(sampleJpegDataUrl).valid, true);
  assert.equal(
    validateContainerPhotoDataUrl(`data:image/webp;base64,${'B'.repeat(80)}`).valid,
    true
  );

  // Rejects public URLs so photos are never exposed as public links
  assert.equal(
    validateContainerPhotoDataUrl('https://storage.googleapis.com/public-bucket/photo.jpg').valid,
    false
  );
  assert.equal(
    validateContainerPhotoDataUrl('http://example.com/container.jpg').valid,
    false
  );
  // Rejects SVG and oversized payloads
  assert.equal(
    validateContainerPhotoDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').valid,
    false
  );
  assert.equal(
    validateContainerPhotoDataUrl(`data:image/jpeg;base64,${'A'.repeat(705000)}`).valid,
    false
  );

  const stamp = formatLocalUploadDateTime(new Date('2026-07-10T09:15:30.000Z'));
  assert.match(stamp.uploadedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(stamp.uploadedTime, /^\d{2}:\d{2}:\d{2}$/);

  const downloadName = buildContainerPhotoDownloadFileName({
    containerNumber: 'MSKU1234567',
    lrNumber: 'BSE-LR-0042',
    vehicleNumber: 'GJ-03-BW-4312',
    mimeType: 'image/jpeg',
  });
  assert.equal(downloadName, 'Container-RearDoors-MSKU1234567-BSE-LR-0042-GJ-03-BW-4312.jpg');

  // Verify camera & gallery capture records link Trip No, LR No, Vehicle No, Container No, date/time, and employee info
  const pendingFromCamera = buildPendingContainerPhotoRecord({
    prepared: {
      photoDataUrl: sampleJpegDataUrl,
      mimeType: 'image/jpeg',
      fileSizeBytes: 90,
      width: 1280,
      height: 960,
      fileName: 'IMG_20260710.jpg',
      captureSource: 'camera',
      uploadedDate: '2026-07-10',
      uploadedTime: '14:45:10',
      uploadedAtIso: '2026-07-10T09:15:10.000Z',
    },
    metadata: {
      tripId: 'trip_abc123',
      tripNumber: 'SR-108',
      lrNumber: 'BSE-LR-0042',
      vehicleNumber: 'GJ-03-BW-4312',
      containerNumber: 'msku1234567',
    },
    uploader: {
      uid: 'uid_emp_1',
      displayName: 'Kishore Patel',
      email: 'kishore@bapasitaram.in',
      role: 'employee',
      ownerId: 'uid_emp_1',
    },
  });

  assert.equal(pendingFromCamera.photoType, CONTAINER_PHOTO_TYPE);
  assert.equal(pendingFromCamera.photoType, 'rear_container_doors');
  assert.equal(pendingFromCamera.tripNumber, 'SR-108');
  assert.equal(pendingFromCamera.lrNumber, 'BSE-LR-0042');
  assert.equal(pendingFromCamera.vehicleNumber, 'GJ-03-BW-4312');
  assert.equal(pendingFromCamera.containerNumber, 'MSKU1234567');
  assert.equal(pendingFromCamera.captureSource, 'camera');
  assert.equal(pendingFromCamera.uploadedDate, '2026-07-10');
  assert.equal(pendingFromCamera.uploadedTime, '14:45:10');
  assert.equal(pendingFromCamera.uploadedByName, 'Kishore Patel');
  assert.equal(pendingFromCamera.uploadedByEmail, 'kishore@bapasitaram.in');

  const firestorePayload = buildFirestoreContainerPhotoFields(pendingFromCamera);
  assert.equal(firestorePayload.photoType, 'rear_container_doors');
  assert.equal(firestorePayload.tripId, 'trip_abc123');
  assert.equal(firestorePayload.containerNumber, 'MSKU1234567');
});

test('Container Rear-Door Photo offline queue preserves pending photos safely, enforces 1 photo per trip, and auto-syncs when online', async () => {
  const adapter = createInMemoryPhotoQueueAdapter();
  const sampleCameraUrl = `data:image/jpeg;base64,${'C'.repeat(120)}`;
  const sampleGalleryUrl = `data:image/jpeg;base64,${'G'.repeat(120)}`;

  // 1. Capture photo via mobile camera while offline
  const firstOffline = buildPendingContainerPhotoRecord({
    prepared: {
      photoDataUrl: sampleCameraUrl,
      mimeType: 'image/jpeg',
      fileSizeBytes: 90,
      width: 1200,
      height: 900,
      fileName: 'cam_rear.jpg',
      captureSource: 'camera',
      uploadedDate: '2026-07-10',
      uploadedTime: '15:00:00',
      uploadedAtIso: '2026-07-10T09:30:00.000Z',
    },
    metadata: {
      tripId: 'trip_offline_1',
      tripNumber: 'SR-201',
      lrNumber: 'LR-201',
      vehicleNumber: 'GJ-03-BW-4312',
      containerNumber: 'TGHU7654321',
    },
    uploader: {
      uid: 'uid_staff_1',
      displayName: 'Field Operator',
      email: 'staff@bapasitaram.in',
      role: 'employee',
      ownerId: 'uid_staff_1',
    },
  });

  await savePendingContainerPhoto(firstOffline, adapter);
  let queued = await getPendingContainerPhotos('uid_staff_1', adapter);
  assert.equal(queued.length, 1);

  // 2. Replace photo from gallery for the SAME trip -> strictly 1 pending photo per trip
  const replacedFromGallery = buildPendingContainerPhotoRecord({
    prepared: {
      photoDataUrl: sampleGalleryUrl,
      mimeType: 'image/jpeg',
      fileSizeBytes: 95,
      width: 1280,
      height: 960,
      fileName: 'gallery_rear.jpg',
      captureSource: 'gallery',
      uploadedDate: '2026-07-10',
      uploadedTime: '15:02:00',
      uploadedAtIso: '2026-07-10T09:32:00.000Z',
    },
    metadata: {
      tripId: 'trip_offline_1',
      tripNumber: 'SR-201',
      lrNumber: 'LR-201',
      vehicleNumber: 'GJ-03-BW-4312',
      containerNumber: 'TGHU7654321',
    },
    uploader: {
      uid: 'uid_staff_1',
      displayName: 'Field Operator',
      email: 'staff@bapasitaram.in',
      role: 'employee',
      ownerId: 'uid_staff_1',
    },
  });

  await savePendingContainerPhoto(replacedFromGallery, adapter);
  queued = await getPendingContainerPhotos('uid_staff_1', adapter);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].captureSource, 'gallery');
  assert.equal(queued[0].photoDataUrl, sampleGalleryUrl);

  // 3. Attempting sync while still offline must NOT drop or upload the pending photo
  let uploadCalls = 0;
  const offlineRes = await syncPendingContainerPhotos({
    ownerId: 'uid_staff_1',
    isOnline: false,
    adapter,
    uploadFn: async () => {
      uploadCalls += 1;
    },
  });
  assert.equal(offlineRes.skippedOffline, true);
  assert.equal(offlineRes.remainingCount, 1);
  assert.equal(uploadCalls, 0);

  // 4. Transient network failure while online keeps pending photo safely queued with retry status
  const failedRes = await syncPendingContainerPhotos({
    ownerId: 'uid_staff_1',
    isOnline: true,
    adapter,
    uploadFn: async () => {
      uploadCalls += 1;
      throw new Error('Temporary network timeout');
    },
  });
  assert.equal(failedRes.uploadedTripIds.length, 0);
  assert.deepEqual(failedRes.failedTripIds, ['trip_offline_1']);
  assert.equal(failedRes.remainingCount, 1);
  queued = await getPendingContainerPhotos('uid_staff_1', adapter);
  assert.equal(queued[0].syncStatus, 'retry_pending');
  assert.equal(queued[0].retryCount, 1);
  assert.match(queued[0].lastError, /Temporary network timeout/);

  // 5. Internet returns cleanly -> auto-sync uploads and ONLY THEN clears pending queue
  const uploadedRecords: string[] = [];
  const successRes = await syncPendingContainerPhotos({
    ownerId: 'uid_staff_1',
    isOnline: true,
    adapter,
    uploadFn: async (item) => {
      uploadedRecords.push(`${item.tripId}:${item.containerNumber}:${item.captureSource}`);
    },
  });
  assert.deepEqual(successRes.uploadedTripIds, ['trip_offline_1']);
  assert.equal(successRes.remainingCount, 0);
  assert.deepEqual(uploadedRecords, ['trip_offline_1:TGHU7654321:gallery']);

  queued = await getPendingContainerPhotos('uid_staff_1', adapter);
  assert.equal(queued.length, 0);
});

test('Container Rear-Door Photo UI, Firestore rules, Admin-only delete, single category, and PDF exclusion are enforced', () => {
  const cardSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/ContainerPhotoCard.tsx'),
    'utf8'
  );
  const tripEntrySrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/TripEntryView.tsx'),
    'utf8'
  );
  const tripHistorySrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/TripHistoryView.tsx'),
    'utf8'
  );
  const lrViewSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/LorryReceiptsView.tsx'),
    'utf8'
  );
  const billingViewSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/BillingView.tsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
  const rulesSrc = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
  const blueprintSrc = fs.readFileSync(path.join(ROOT_DIR, 'firebase-blueprint.json'), 'utf8');

  // Mobile rear camera & gallery inputs present
  assert.match(cardSrc, /capture="environment"/);
  assert.match(cardSrc, /accept="image\/jpeg,image\/png,image\/webp,image\/\*"/);
  assert.match(cardSrc, /Capture with Camera/);
  assert.match(cardSrc, /Select from Gallery/);

  // Preview, zoom levels (100/150/200/300), download, and Admin-only delete present
  assert.match(cardSrc, /Preview &amp; Zoom/);
  assert.match(cardSrc, /\[100,\s*150,\s*200,\s*300\]/);
  assert.match(cardSrc, /downloadContainerPhotoDataUrl/);
  assert.match(cardSrc, /permissions\.isAdmin/);
  assert.match(cardSrc, /Delete Photo \(Admin\)/);

  // Strictly NO front, side, seal, loading, or unloading photo categories
  assert.doesNotMatch(cardSrc, /front_photo|side_photo|seal_photo|loading_photo|unloading_photo/i);
  assert.doesNotMatch(cardSrc, /\b(Seal Photo|Loading Photo|Unloading Photo|Side Photo|Front Photo)\b/i);

  // Zero inline styles, zero window.open, zero window.alert
  for (const src of [cardSrc, tripEntrySrc, tripHistorySrc]) {
    assert.doesNotMatch(src, /style=\{\{/);
    assert.doesNotMatch(src, /window\.open\(/);
    assert.doesNotMatch(src, /window\.alert\(/);
  }

  // Strictly excluded from LR PDF and Bill PDF modules
  assert.doesNotMatch(lrViewSrc, /tripContainerPhotos|ContainerPhotoCard|photoDataUrl/);
  assert.doesNotMatch(billingViewSrc, /tripContainerPhotos|ContainerPhotoCard|photoDataUrl/);

  // Inside TripHistoryView, #lr-voucher-a4-content MUST NOT contain ContainerPhotoCard or photoDataUrl
  const lrVoucherStart = tripHistorySrc.indexOf('id="lr-voucher-a4-content"');
  const lrVoucherEnd = tripHistorySrc.indexOf('id="container-photo-modal-title"');
  assert.ok(lrVoucherStart > 0 && lrVoucherEnd > lrVoucherStart);
  const lrVoucherSegment = tripHistorySrc.slice(lrVoucherStart, lrVoucherEnd);
  assert.doesNotMatch(lrVoucherSegment, /ContainerPhotoCard|tripContainerPhotos|photoDataUrl/);

  // App.tsx wires online/offline listeners, auto-sync, and Admin-only delete
  assert.match(appSrc, /window\.addEventListener\('online'/);
  assert.match(appSrc, /window\.addEventListener\('offline'/);
  assert.match(appSrc, /syncPendingContainerPhotos/);
  assert.match(appSrc, /scopedQuery\('tripContainerPhotos'\)/);

  // Firestore rules & blueprint enforce strictly 1 rear_container_doors photo, private auth storage, and Admin-only delete
  assert.match(rulesSrc, /function isValidTripContainerPhoto\(data\)/);
  assert.match(rulesSrc, /data\.photoType == 'rear_container_doors'/);
  assert.match(rulesSrc, /match \/tripContainerPhotos\/\{tripId\}/);
  assert.match(rulesSrc, /allow delete: if isValidId\(tripId\) && isAdmin\(\);/);
  assert.match(blueprintSrc, /"TripContainerPhoto"/);
  assert.match(blueprintSrc, /"\/tripContainerPhotos\/\{tripId\}"/);
  assert.match(blueprintSrc, /"enum": \["rear_container_doors"\]/);
});

test('Trip Entry form removes Material and Weight (MT) completely while preserving all other fields, historical records, and calculations', () => {
  const tripEntrySrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/TripEntryView.tsx'),
    'utf8'
  );
  const tripHistorySrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/TripHistoryView.tsx'),
    'utf8'
  );
  const rulesSrc = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
  const blueprint = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'firebase-blueprint.json'), 'utf8')
  );

  // 1. Removed completely from TripEntryView UI, state, validation, and submit payload
  assert.doesNotMatch(tripEntrySrc, /\bmaterial\b/);
  assert.doesNotMatch(tripEntrySrc, /\bweightTons\b/);
  assert.doesNotMatch(tripEntrySrc, /Weight \(MT\)/);
  assert.doesNotMatch(tripEntrySrc, />Material</);

  // Other essential Trip Entry fields remain untouched
  assert.match(tripEntrySrc, /LR \/ Bilty Number/);
  assert.match(tripEntrySrc, /Container No/);
  assert.match(tripEntrySrc, /Rate \/ Freight/);
  assert.match(tripEntrySrc, /Diesel Calculation/);

  // 2. Removed from TripHistoryView Trip & LR Statement PDF voucher and mobile card
  assert.doesNotMatch(tripHistorySrc, /Cargo:/);
  assert.doesNotMatch(tripHistorySrc, /weightTons/);

  // 3. Removed from required validation in blueprint and firestore.rules while preserving optional historical compatibility
  const tripRequired: string[] = blueprint.entities.Trip.required;
  assert.equal(tripRequired.includes('material'), false);
  assert.equal(tripRequired.includes('weightTons'), false);
  assert.ok(blueprint.entities.Trip.properties.material, 'Historical Trip property preserved');
  assert.ok(blueprint.entities.Trip.properties.weightTons, 'Historical Trip property preserved');

  assert.match(rulesSrc, /\(!\('material' in data\) \|\| \(data\.material is string && data\.material\.size\(\) <= 100\)\)/);
  assert.match(rulesSrc, /\(!\('weightTons' in data\) \|\| \(data\.weightTons is number && data\.weightTons >= 0 && data\.weightTons <= 500\)\)/);

  // 4. Creating a brand-new Trip without material or weightTons works cleanly across Ledger, Statement PDF, and Excel export
  const newTripWithoutMaterialOrWeight: Trip = {
    id: 'trip_new_no_mat_wt',
    srNo: '101',
    lrNumber: 'LR-NEW-101',
    tripDate: '2026-07-15',
    vehicleId: 'veh_1',
    vehicleNumber: 'GJ-03-BW-4312',
    partyId: 'pty_new_1',
    partyName: 'Mundra Logistics Co',
    driverName: 'Suresh',
    origin: 'Morbi',
    destination: 'Mundra Port',
    containerNo: 'MSKU9876543',
    freightAmount: 42000,
    advanceReceived: 12000,
    dieselQuantity: 100,
    dieselRate: 98.34,
    dieselExpense: 9834,
    tollExpense: 600,
    driverAllowance: 500,
    otherExpense: 200,
    balanceAmount: 30000,
    totalExpense: 11134,
    tripStatus: 'In Transit',
    paymentStatus: 'Partial',
    podReceived: false,
    notes: 'Container dispatched',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };

  // Freight, Diesel, Expenses, Party Ledger calculations unchanged
  const ledger = computePartyLedgerSummary(
    'pty_new_1',
    [newTripWithoutMaterialOrWeight],
    [],
    'Mundra Logistics Co'
  );
  assert.equal(ledger.totalFreight, 42000);
  assert.equal(ledger.netOutstanding, 30000);

  // Statement PDF generates cleanly without material/weightTons
  const party: Party = {
    id: 'pty_new_1',
    partyName: 'Mundra Logistics Co',
    partyType: 'Consignor',
    contactPerson: 'Hitesh',
    phone: '9825012345',
    email: '',
    gstin: '',
    city: 'Morbi',
    state: 'Gujarat',
    address: 'Morbi',
    paymentTermsDays: 15,
    status: 'Active',
    notes: '',
    ownerId: 'uid_admin',
    createdAt: null,
    updatedAt: null,
  };
  const stmtPdf = createPartyStatementPdfDocument({
    party,
    trips: [newTripWithoutMaterialOrWeight],
    partyPayments: [],
  });
  assert.equal(stmtPdf.summary.netOutstanding, 30000);
  assert.ok(stmtPdf.pdf.output().startsWith('%PDF-'));

  // Excel export handles missing material/weightTons gracefully
  const excelRows = buildTripExcelRows([newTripWithoutMaterialOrWeight]);
  assert.equal(excelRows.length, 1);
  assert.equal(excelRows[0]['LR No'], 'LR-NEW-101');
  assert.equal(excelRows[0].Material, '');
  assert.equal(excelRows[0]['Weight (MT)'], '');
});

test('Approved Format B Bill Header enforces branding, dual-truck split cropping, verified Admin address, zero fake data, and preserves Format A unchanged', () => {
  // 1. Approved branding & vehicle registration constants
  assert.equal(BILL_HEADER_DEVOTIONAL_LINE, '|| માં આશાપુરા || માં મોગલ || માં ગાત્રોળ ||');
  assert.equal(BILL_HEADER_COMPANY_NAME, 'BAPASITARAM ENTERPRISE');
  assert.equal(BILL_HEADER_CONTACT_LEFT, '9537379915');
  assert.equal(BILL_HEADER_CONTACT_RIGHT, '8128202784');
  assert.equal(BILL_HEADER_LEFT_TRUCK_REG, 'GJ12 BV6552');
  assert.equal(BILL_HEADER_RIGHT_TRUCK_REG, 'GJ12 CT4312');

  // 2. Dual-truck photo split-cropper math separates Left (GJ12 BV6552) and Right (GJ12 CT4312) cleanly without overlap
  const defaultCrop = computeDualTruckCropRects(1600, 900);
  assert.ok(defaultCrop.leftRect.sw > 0 && defaultCrop.leftRect.sh > 0);
  assert.ok(defaultCrop.rightRect.sw > 0 && defaultCrop.rightRect.sh > 0);
  assert.ok(
    defaultCrop.leftRect.sx + defaultCrop.leftRect.sw <= defaultCrop.rightRect.sx,
    'Left truck crop (GJ12 BV6552) and Right truck crop (GJ12 CT4312) must not overlap'
  );
  assert.ok(defaultCrop.rightRect.sx + defaultCrop.rightRect.sw <= 1600);
  assert.ok(defaultCrop.leftRect.sy + defaultCrop.leftRect.sh <= 900);

  const customCrop = computeDualTruckCropRects(2000, 1000, {
    splitPercent: 45,
    topTrimPercent: 10,
    bottomTrimPercent: 10,
  });
  assert.equal(customCrop.leftRect.sy, 100);
  assert.equal(customCrop.leftRect.sh, 800);
  assert.ok(customCrop.leftRect.sw < customCrop.rightRect.sw);

  // 3. Truck image data URL validator allows safe base64 photos only and rejects public URLs, SVG, and oversized strings
  assert.equal(isValidBillHeaderTruckDataUrl(''), true);
  assert.equal(
    isValidBillHeaderTruckDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='),
    true
  );
  assert.equal(
    isValidBillHeaderTruckDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='),
    true
  );
  assert.equal(isValidBillHeaderTruckDataUrl('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(isValidBillHeaderTruckDataUrl('https://cdn.example.com/truck.jpg'), false);
  assert.equal(
    isValidBillHeaderTruckDataUrl(`data:image/jpeg;base64,${'A'.repeat(200001)}`),
    false
  );

  // 4. Verified Admin Settings address & bank details — never invents placeholder address or sample bank details
  assert.equal(resolveVerifiedCompanyAddress(null, ''), '');
  assert.equal(
    resolveVerifiedCompanyAddress({ address: 'Plot 12, Transport Nagar, Morbi, Gujarat' }),
    'Plot 12, Transport Nagar, Morbi, Gujarat'
  );
  assert.equal(resolveVerifiedBillBankDetails({ bankDetails: '' }, null), '');
  assert.equal(
    resolveVerifiedBillBankDetails(
      { bankDetails: '' },
      {
        bankName: '',
        accountHolderName: '',
        accountNumber: '',
        ifscCode: '',
        branchName: '',
      }
    ),
    ''
  );
  assert.match(
    resolveVerifiedBillBankDetails(
      { bankDetails: '' },
      {
        bankName: 'State Bank of India',
        accountHolderName: 'BAPASITARAM ENTERPRISE',
        accountNumber: '12345678901',
        ifscCode: 'SBIN0001234',
        branchName: 'Morbi Main',
      }
    ),
    /State Bank of India.*SBIN0001234/
  );

  // 5. Verify BillFormatBDocument & BillingView enforce Royal Blue / White / Red Format B, preserve Format A unchanged, and contain zero fake QR/signatures/inline styles
  const formatBSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/BillFormatBDocument.tsx'),
    'utf8'
  );
  const billingSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/BillingView.tsx'),
    'utf8'
  );
  const rulesSrc = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
  const blueprint = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'firebase-blueprint.json'), 'utf8')
  );

  assert.match(formatBSrc, /bg-blue-900/);
  assert.match(formatBSrc, /bg-red-600/);
  assert.match(formatBSrc, /bg-white/);
  assert.match(formatBSrc, /BILL_HEADER_DEVOTIONAL_LINE/);
  assert.match(formatBSrc, /BILL_HEADER_CONTACT_LEFT/);
  assert.match(formatBSrc, /BILL_HEADER_CONTACT_RIGHT/);
  assert.match(formatBSrc, /BILL_HEADER_LEFT_TRUCK_REG/);
  assert.match(formatBSrc, /BILL_HEADER_RIGHT_TRUCK_REG/);
  assert.match(formatBSrc, /object-contain/);
  assert.match(formatBSrc, /resolveVerifiedCompanyAddress/);
  assert.match(formatBSrc, /resolveVerifiedBillBankDetails/);
  assert.match(formatBSrc, /RELIABLE TRANSPORT • TRUSTED SERVICE/);
  assert.match(formatBSrc, />Amount Received</);
  assert.match(formatBSrc, />Balance Due</);
  assert.match(formatBSrc, />Total Payable</);
  assert.match(formatBSrc, />Less: Amount Received</);
  assert.doesNotMatch(formatBSrc, />Jama<|>Hisab<|>Net Payable<|Transport &amp; Container Logistics/);
  assert.doesNotMatch(formatBSrc, /QR Code|upi:\/\/|fake|sample bank/i);
  assert.doesNotMatch(formatBSrc, /style=\{\{/);
  assert.doesNotMatch(formatBSrc, /window\.open\(/);
  assert.doesNotMatch(formatBSrc, /window\.alert\(/);

  // BillingView switches between Format A (Original) and Format B (Modern Minimal) and keeps Format A untouched
  assert.match(billingSrc, /Format A \(Original\)/);
  assert.match(billingSrc, /Format B \(Modern Minimal\)/);
  assert.match(billingSrc, /<BillFormatBDocument/);
  assert.match(billingSrc, /Preview Sample Bill \(Format B\)/);
  assert.match(billingSrc, /Upload Dual-Truck Photo \(Auto-Crop Left &amp; Right\)/);
  assert.match(billingSrc, /cropDualTruckPhotoInBrowser/);
  assert.match(billingSrc, />Jama</);
  assert.match(billingSrc, />Hisab</);
  assert.match(billingSrc, /Net Payable Total/);
  assert.match(billingSrc, /Configure bank details in Company & Bank Details tab\./);
  assert.doesNotMatch(billingSrc, /style=\{\{/);
  assert.doesNotMatch(billingSrc, /window\.open\(/);
  assert.doesNotMatch(billingSrc, /window\.alert\(/);

  // Firestore rules & blueprint enforce bounded Admin-only truck header photo fields
  assert.ok(blueprint.entities.CompanySettings.properties.billHeaderLeftTruckDataUrl);
  assert.ok(blueprint.entities.CompanySettings.properties.billHeaderRightTruckDataUrl);
  assert.equal(
    blueprint.entities.CompanySettings.properties.billHeaderLeftTruckDataUrl.maxLength,
    200000
  );
  assert.match(rulesSrc, /'billHeaderLeftTruckDataUrl'/);
  assert.match(rulesSrc, /'billHeaderRightTruckDataUrl'/);

  // 6. Verify A4 Portrait Sample Bill PDF generation produces a valid PDF document
  const samplePdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  samplePdf.text('BAPASITARAM ENTERPRISE - Format B Sample Bill', 15, 20);
  const samplePdfFile = createPdfFileFromJsPdf(
    samplePdf,
    'Bill-BSE-SAMPLE-FormatB-Sample-Consignor.pdf'
  );
  assert.equal(samplePdfFile.type, 'application/pdf');
  assert.ok(samplePdfFile.size > 100);
  assert.ok(samplePdf.output().startsWith('%PDF-'));
});

test('Industrial Command Center visual redesign applies Deep Slate, Graphite, Industrial Orange & Signal Green consistently across ERP without breaking logic or print layouts', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  const indexCss = fs.readFileSync(path.join(ROOT_DIR, 'src/index.css'), 'utf8');
  const layoutSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/LayoutShell.tsx'), 'utf8');
  const loginSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/AdminLogin.tsx'), 'utf8');
  const dashboardSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/DashboardView.tsx'),
    'utf8'
  );

  // Industrial display font + Gujarati/Devanagari preserved
  assert.match(indexHtml, /Barlow\+Condensed/);
  assert.match(indexHtml, /Noto\+Sans\+Gujarati/);
  assert.match(indexCss, /--font-display:\s*"Barlow Condensed"/);
  assert.match(indexCss, /--icc-orange:\s*#ea580c/);
  assert.match(indexCss, /--icc-signal-green:\s*#16a34a/);
  assert.match(indexCss, /\.erp-industrial-workspace/);
  assert.match(indexCss, /:not\(#freight-bill-a4-content table\)/);

  // LayoutShell: Deep Slate & Graphite sidebar + Industrial Orange primary CTA + preserved Phase 1 Checklist
  assert.match(layoutSrc, /bg-\[#0b111c\]/);
  assert.match(layoutSrc, /bg-\[#111827\]/);
  assert.match(layoutSrc, /bg-orange-600/);
  assert.match(layoutSrc, /Phase 1 Checklist/);
  assert.match(layoutSrc, /erp-industrial-workspace/);
  assert.doesNotMatch(layoutSrc, /style=\{\{/);

  // AdminLogin: Industrial Command Center login preserving Google popup auth
  assert.match(loginSrc, /signInWithPopup\(auth, googleProvider\)/);
  assert.match(loginSrc, /bg-\[#0b111c\]/);
  assert.match(loginSrc, /bg-orange-600/);
  assert.doesNotMatch(loginSrc, /style=\{\{/);

  // DashboardView: all requested command modules with real ERP data and zero fake stats/inline styles
  assert.match(dashboardSrc, /Operations Overview/);
  assert.match(dashboardSrc, /Fleet Status —/);
  assert.match(dashboardSrc, /BILL_HEADER_LEFT_TRUCK_REG/);
  assert.match(dashboardSrc, /BILL_HEADER_RIGHT_TRUCK_REG/);
  assert.match(dashboardSrc, /Today&apos;s Trips/);
  assert.match(dashboardSrc, /Pending Bills/);
  assert.match(dashboardSrc, /Amount Received/);
  assert.match(dashboardSrc, /Balance Due/);
  assert.match(dashboardSrc, /Recent Activity/);
  assert.match(dashboardSrc, />Trip Entry</);
  assert.match(dashboardSrc, />Lorry Receipt \(LR\)</);
  assert.match(dashboardSrc, />Bill</);
  assert.match(dashboardSrc, />Payment</);
  assert.doesNotMatch(dashboardSrc, /style=\{\{/);
  assert.doesNotMatch(dashboardSrc, /window\.open\(/);
  assert.doesNotMatch(dashboardSrc, /window\.alert\(/);
});

test('Accidental deletion protection removes Vehicle Management delete action, disables permanent deletion for ordinary users across all modules, and preserves View & Edit', () => {
  const vehiclesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/VehiclesView.tsx'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
  const tripsSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/TripHistoryView.tsx'), 'utf8');
  const lrSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/LorryReceiptsView.tsx'), 'utf8');
  const billingSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/BillingView.tsx'), 'utf8');
  const partiesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PartiesView.tsx'), 'utf8');
  const driversSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/DriversView.tsx'), 'utf8');
  const expensesSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/ExpensesView.tsx'), 'utf8');
  const importSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/ExcelImportView.tsx'), 'utf8');
  const securitySrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/SecurityBackupView.tsx'), 'utf8');

  // 1. Vehicle Management: ZERO Trash/Delete icons, buttons, or deleteDoc calls; View & Edit preserved
  assert.doesNotMatch(vehiclesSrc, /\bTrash2\b/);
  assert.doesNotMatch(vehiclesSrc, /\bdeleteDoc\b/);
  assert.doesNotMatch(vehiclesSrc, /Delete Vehicle/);
  assert.doesNotMatch(vehiclesSrc, /aria-label=\{`Delete /);
  assert.match(vehiclesSrc, /openEditDrawer/);
  assert.match(vehiclesSrc, /setInspectVehicle/);
  assert.match(vehiclesSrc, /Ledger &amp; Trips/);

  // 2. App RBAC: ordinary users NEVER receive canDeleteRecords: true
  assert.match(appSrc, /canDeleteRecords:\s*isUserAdmin,/);
  assert.doesNotMatch(appSrc, /canDeleteRecords:\s*isUserAdmin\s*\|\|\s*matched\.canDeleteRecords/);

  // 3. Operational modules guard both UI and delete handlers with permissions.isAdmin && permissions.canDeleteRecords
  assert.match(tripsSrc, /if \(!deleteTarget \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\) return;/);
  assert.doesNotMatch(tripsSrc, /\{permissions\.canDeleteRecords && \(/);
  assert.match(tripsSrc, /onEditTrip/);

  assert.match(lrSrc, /const canDeleteLr = permissions\.isAdmin && permissions\.canDeleteRecords;/);
  assert.match(lrSrc, /if \(!deleteTarget \|\| !canDeleteLr\) return;/);

  assert.match(billingSrc, /if \(!deleteTarget \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\) return;/);
  assert.doesNotMatch(billingSrc, /\{permissions\.canDeleteRecords && !/);

  assert.match(partiesSrc, /if \(!deleteTarget \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\) return;/);
  assert.match(partiesSrc, /if \(!deletePaymentTarget \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\) return;/);
  assert.doesNotMatch(partiesSrc, /\{permissions\.canDeleteRecords && \(/);
  assert.match(partiesSrc, /openEditDrawer/);

  assert.match(driversSrc, /if \(!deleteDriverTarget \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\) return;/);
  assert.match(driversSrc, /if \(!deletePaymentTarget \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\) return;/);
  assert.doesNotMatch(driversSrc, /\{permissions\.canDeleteRecords &&/);
  assert.match(driversSrc, /openEditDriver/);

  assert.match(expensesSrc, /if \(!deleteTarget \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\) return;/);
  assert.doesNotMatch(expensesSrc, /\{permissions\.canDeleteRecords && \(/);
  assert.match(expensesSrc, /openEditDrawer/);

  assert.match(importSrc, /if \(!deleteBatchTarget \|\| !isSuperAdmin \|\| !permissions\.isAdmin \|\| !permissions\.canDeleteRecords\)/);

  // 4. SecurityBackupView locks canDeleteRecords off for ordinary users
  assert.match(securitySrc, /canDeleteRecords:\s*newRole === 'admin',/);
  assert.match(securitySrc, /if \(field === 'canDeleteRecords' && u\.role !== 'admin'\)/);
  assert.match(securitySrc, /Delete Records \(Disabled for Ordinary Users\)/);
  assert.match(securitySrc, /if \(!deleteUserTarget \|\| !isSuperAdmin\) return;/);
});

test('Capacitor Android APK preparation exposes all 11 Vivo mobile modules, reuses existing Firebase project, adds Android WebView offline persistence fallback, and keeps PC Web ERP unchanged', () => {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const capConfigSrc = fs.readFileSync(path.join(ROOT_DIR, 'capacitor.config.ts'), 'utf8');
  const manifestTemplateSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'android-setup/AndroidManifest.permissions.xml'),
    'utf8'
  );
  const setupGuideSrc = fs.readFileSync(path.join(ROOT_DIR, 'ANDROID_CAPACITOR_SETUP.md'), 'utf8');
  const platformSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/utils/capacitorPlatform.ts'),
    'utf8'
  );
  const mobileShellSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/MobileAppShell.tsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
  const firebaseSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/firebase.ts'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  const indexCss = fs.readFileSync(path.join(ROOT_DIR, 'src/index.css'), 'utf8');

  // 1. Capacitor packages & scripts
  assert.ok(pkgJson.dependencies['@capacitor/core']);
  assert.ok(pkgJson.dependencies['@capacitor/cli']);
  assert.ok(pkgJson.dependencies['@capacitor/android']);
  assert.ok(pkgJson.scripts['build:mobile']);
  assert.ok(pkgJson.scripts['cap:add:android']);
  assert.ok(pkgJson.scripts['cap:sync']);
  assert.ok(pkgJson.scripts['cap:open:android']);

  // 2. Capacitor config & Android manifest template
  assert.match(capConfigSrc, /appId:\s*'com\.bapasitaram\.transporterp'/);
  assert.match(capConfigSrc, /webDir:\s*'dist'/);
  assert.match(capConfigSrc, /androidScheme:\s*'https'/);
  assert.match(capConfigSrc, /cleartext:\s*false/);
  assert.match(manifestTemplateSrc, /android\.permission\.CAMERA/);
  assert.match(manifestTemplateSrc, /android\.permission\.READ_MEDIA_IMAGES/);
  assert.match(manifestTemplateSrc, /com\.whatsapp/);

  // 3. Setup guide reuses existing Firebase project and honestly documents manual local APK steps
  assert.match(setupGuideSrc, /project-bb532c5d-caa8-4900-a11/);
  assert.match(setupGuideSrc, /ai-studio-914e08fc-768d-4fdb-a892-abe3b764cf48/);
  assert.match(setupGuideSrc, /google-services\.json/);
  assert.match(setupGuideSrc, /Android Studio/);
  assert.match(setupGuideSrc, /Vivo/i);

  // 4. MobileAppShell exposes all 11 required mobile modules & reuses existing modals/cards
  const requiredMobileModules = [
    'Dashboard',
    'Trip Entry',
    'Trip History',
    'LR Management',
    'Bill Management',
    'Payment Entry',
    'Party Ledger',
    'Vehicle Details',
    'Driver Details',
    'Vehicle Document Expiry Alerts',
    'Container Rear Photo Capture',
  ];
  for (const modName of requiredMobileModules) {
    assert.ok(
      mobileShellSrc.includes(modName),
      `MobileAppShell must include mobile module "${modName}"`
    );
  }
  assert.match(mobileShellSrc, /<AddPaymentModal/);
  assert.match(mobileShellSrc, /<ContainerPhotoCard/);
  assert.match(mobileShellSrc, /registerAndroidBackButtonHandler/);
  assert.match(mobileShellSrc, /permissions\.canEditTrips/);
  assert.match(mobileShellSrc, /permissions\.canManageBilling/);
  assert.doesNotMatch(mobileShellSrc, /style=\{\{/);
  assert.doesNotMatch(mobileShellSrc, /window\.open\(/);
  assert.doesNotMatch(mobileShellSrc, /window\.alert\(/);

  // 5. PC Web ERP preserved unchanged alongside conditional MobileAppShell
  assert.match(appSrc, /<LayoutShell/);
  assert.match(appSrc, /<MobileAppShell/);
  assert.match(appSrc, /shouldUseAndroidMobileShell/);
  assert.match(platformSrc, /isCapacitorAndroid/);
  assert.match(platformSrc, /registerAndroidBackButtonHandler/);

  // 6. Existing Firebase project/database preserved + Android WebView offline fallback
  assert.match(firebaseSrc, /firebaseConfig\.firestoreDatabaseId/);
  assert.match(firebaseSrc, /persistentMultipleTabManager/);
  assert.match(firebaseSrc, /persistentSingleTabManager/);

  // 7. Safe-area & touch ergonomics scoped cleanly
  assert.match(indexHtml, /viewport-fit=cover/);
  assert.match(indexCss, /\.pt-safe/);
  assert.match(indexCss, /\.pb-safe/);
  assert.match(indexCss, /\.android-mobile-shell/);
});

test('GitHub Actions cloud APK workflows separate Debug and Release builds, require zero secrets for initial Vivo Debug testing, harden .gitignore, and merge AndroidManifest permissions idempotently', async () => {
  const debugWf = fs.readFileSync(
    path.join(ROOT_DIR, '.github/workflows/android-debug-apk.yml'),
    'utf8'
  );
  const releaseWf = fs.readFileSync(
    path.join(ROOT_DIR, '.github/workflows/android-release-apk.yml'),
    'utf8'
  );
  const gitignoreSrc = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
  const cloudGuideSrc = fs.readFileSync(path.join(ROOT_DIR, 'GITHUB_ACTIONS_APK_SETUP.md'), 'utf8');
  const templateManifestXml = fs.readFileSync(
    path.join(ROOT_DIR, 'android-setup/AndroidManifest.permissions.xml'),
    'utf8'
  );

  // 1. Debug workflow: manual dispatch, least privilege, Java 21 + Android 36, ZERO secrets required
  assert.match(debugWf, /workflow_dispatch:/);
  assert.match(debugWf, /contents:\s*read/);
  assert.match(debugWf, /runs-on:\s*ubuntu-latest/);
  assert.match(debugWf, /java-version:\s*'21'/);
  assert.match(debugWf, /platforms;android-36/);
  assert.match(debugWf, /assembleDebug/);
  assert.match(debugWf, /prepare-android-manifest\.mjs/);
  assert.match(debugWf, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(debugWf, /secrets\./);

  // 2. Release workflow: separate manual workflow, defaults to unsigned_dry_run (no signing creds required yet),
  //    uses GitHub Encrypted Secrets only in signed_with_secrets mode, cleans up temp files always
  assert.match(releaseWf, /workflow_dispatch:/);
  assert.match(releaseWf, /contents:\s*read/);
  assert.match(releaseWf, /default:\s*'unsigned_dry_run'/);
  assert.match(releaseWf, /signed_with_secrets/);
  assert.match(releaseWf, /ANDROID_KEYSTORE_B64/);
  assert.match(releaseWf, /--ks-pass env:ANDROID_KEYSTORE_PASSWORD/);
  assert.match(releaseWf, /--key-pass env:ANDROID_KEY_PASSWORD/);
  assert.match(releaseWf, /if:\s*always\(\)/);
  assert.match(releaseWf, /rm -f "\$RUNNER_TEMP\/release-keystore\.jks"/);

  // 3. .gitignore blocks signing credentials, Firebase Admin keys, google-services.json, and built APKs
  assert.match(gitignoreSrc, /\*\.jks/);
  assert.match(gitignoreSrc, /\*\.keystore/);
  assert.match(gitignoreSrc, /keystore\.properties/);
  assert.match(gitignoreSrc, /google-services\.json/);
  assert.match(gitignoreSrc, /\*firebase-adminsdk\*\.json/);
  assert.match(gitignoreSrc, /serviceAccountKey\.json/);
  assert.match(gitignoreSrc, /\*\.apk/);

  // 4. Setup guide clearly states no APK has been built yet and keeps existing Firebase project
  assert.match(cloudGuideSrc, /No `\.apk` file has been created yet/);
  assert.match(cloudGuideSrc, /project-bb532c5d-caa8-4900-a11/);
  assert.match(cloudGuideSrc, /ai-studio-914e08fc-768d-4fdb-a892-abe3b764cf48/);
  assert.match(cloudGuideSrc, /Private/);

  // 5. Manifest merge helper cleanly merges missing permissions/features/queries and is idempotent
  const manifestHelperUrl = new URL('../android-setup/prepare-android-manifest.mjs', import.meta.url);
  const { mergeAndroidManifestPermissions } = await import(manifestHelperUrl.href);
  const sampleBaseManifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name" />
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

  const mergedOnce = mergeAndroidManifestPermissions(sampleBaseManifest, templateManifestXml);
  assert.match(mergedOnce, /android\.permission\.ACCESS_NETWORK_STATE/);
  assert.match(mergedOnce, /android\.permission\.CAMERA/);
  assert.match(mergedOnce, /android\.permission\.READ_MEDIA_IMAGES/);
  assert.match(mergedOnce, /android\.permission\.READ_EXTERNAL_STORAGE/);
  assert.match(mergedOnce, /android\.hardware\.camera/);
  assert.match(mergedOnce, /<package android:name="com\.whatsapp" \/>/);
  assert.equal((mergedOnce.match(/android\.permission\.INTERNET/g) || []).length, 1);

  const mergedTwice = mergeAndroidManifestPermissions(mergedOnce, templateManifestXml);
  assert.equal(mergedTwice, mergedOnce);
});


