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






