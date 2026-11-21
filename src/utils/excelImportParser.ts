import * as XLSX from 'xlsx';
import {
  BLUEPRINT_LIMITS,
  type ErpMappableField,
  type ExcelCellRecord,
  type ImportedSheetRow,
  type ImportTargetModule,
  type Party,
  type Trip,
  type TripStatus,
  type Vehicle,
} from '../types/erp';
import {
  clampNum,
  clampStr,
  derivePaymentStatus,
  getTodayISO,
} from './formatters';

export const EXPECTED_WORKSHEETS = [
  'Gadi Master Hisab',
  'Total Hisab',
  '4312',
  '6552',
] as const;

export const MAPPABLE_FIELD_OPTIONS: {
  value: ErpMappableField;
  label: string;
}[] = [
  { value: 'skip', label: 'Archive Only (Do Not Map)' },
  { value: 'srNo', label: 'Sr No' },
  { value: 'tripDate', label: 'Date (Trip / Entry Date)' },
  { value: 'lrNumber', label: 'LR / Bilty / Challan No.' },
  { value: 'vehicleNumber', label: 'Vehicle No' },
  { value: 'vehicleType', label: 'Vehicle Type' },
  { value: 'driverName', label: 'Driver Name' },
  { value: 'driverPhone', label: 'Driver Phone' },
  { value: 'partyName', label: 'Party Name' },
  { value: 'partyType', label: 'Party Type' },
  { value: 'gstin', label: 'GSTIN' },
  { value: 'origin', label: 'From (Origin)' },
  { value: 'destination', label: 'To (Destination)' },
  { value: 'containerNo', label: 'Container No' },
  { value: 'material', label: 'Material / Goods' },
  { value: 'weightTons', label: 'Weight (MT / Tons)' },
  { value: 'freightAmount', label: 'Rate / Freight (INR)' },
  { value: 'otherExpense', label: 'Kharcha / Other Expense (INR)' },
  { value: 'dieselQuantity', label: 'Diesel Quantity (Liters)' },
  { value: 'dieselExpense', label: 'Diesel Amount (INR)' },
  { value: 'tollExpense', label: 'Toll (INR)' },
  { value: 'driverAllowance', label: 'Driver Bhatta / Allowance (INR)' },
  { value: 'advanceReceived', label: 'Jama / Advance Received (INR)' },
  { value: 'balanceAmount', label: 'Hisab / Balance (INR)' },
  { value: 'tripStatus', label: 'Trip Status' },
  { value: 'notes', label: 'Note / Remarks' },
  { value: 'excluded_karja', label: 'Excluded (Karja / Interest)' },
];

export interface ParsedColumnInfo {
  colIndex: number;
  header: string;
  mappedField: ErpMappableField;
  excludedKarja: boolean;
}

export type ParsedRowStatus =
  | 'new'
  | 'duplicate'
  | 'summary'
  | 'excluded_karja';

export interface ParsedSheetRow {
  rowIndex: number; // 1-based Excel row index
  cells: ExcelCellRecord[];
  originalDate: string;
  primaryAmount: number;
  notes: string;
  isSummaryRow: boolean;
  isKarjaExcluded: boolean;
  extracted: {
    srNo: string;
    tripDate: string;
    lrNumber: string;
    vehicleNumber: string;
    vehicleType: string;
    driverName: string;
    driverPhone: string;
    partyName: string;
    partyType: string;
    gstin: string;
    origin: string;
    destination: string;
    containerNo: string;
    material: string;
    weightTons: number;
    freightAmount: number;
    advanceReceived: number;
    balanceAmount: number;
    hasExplicitBalance: boolean;
    dieselQuantity: number;
    dieselExpense: number;
    tollExpense: number;
    driverAllowance: number;
    otherExpense: number;
    tripStatus: TripStatus;
    notes: string;
  };
}

export interface ParsedWorksheet {
  sheetName: string;
  headerRowIndex: number; // 1-based
  targetModule: ImportTargetModule;
  defaultVehicleNumber: string;
  defaultPartyName: string;
  columns: ParsedColumnInfo[];
  rawRows: ParsedSheetRow[];
  formulaCount: number;
  noteCount: number;
  excludedKarjaColsCount: number;
  excludedKarjaRowsCount: number;
}

export interface PlannedVehicleCreate {
  registrationNumber: string;
  vehicleType: Vehicle['vehicleType'];
  driverName: string;
  driverPhone: string;
  notes: string;
}

export interface PlannedPartyCreate {
  partyName: string;
  partyType: Party['partyType'];
  gstin: string;
  notes: string;
}

export interface PlannedTripCreate {
  sheetName: string;
  rowIndex: number;
  srNo: string;
  lrNumber: string;
  tripDate: string;
  vehicleNumber: string;
  partyName: string;
  driverName: string;
  origin: string;
  destination: string;
  containerNo: string;
  material: string;
  weightTons: number;
  freightAmount: number;
  advanceReceived: number;
  dieselQuantity: number;
  dieselExpense: number;
  tollExpense: number;
  driverAllowance: number;
  otherExpense: number;
  balanceAmount: number;
  totalExpense: number;
  tripStatus: TripStatus;
  paymentStatus: Trip['paymentStatus'];
  podReceived: boolean;
  notes: string;
}

export interface PlannedSheetRowSave {
  sheetName: string;
  rowIndex: number;
  targetModule: ImportTargetModule;
  rowSignature: string;
  originalDate: string;
  primaryAmount: number;
  notes: string;
  columnsOrder: string[];
  cells: ExcelCellRecord[];
  linkedVehicleReg: string;
  linkedPartyName: string;
  linkedTripKey: string;
}

export interface EvaluatedRowPreview {
  row: ParsedSheetRow;
  status: ParsedRowStatus;
  statusReason: string;
  rowSignature: string;
  resolvedVehicle: string;
  resolvedParty: string;
}

export interface ImportExecutionPlan {
  fileName: string;
  sheetNames: string[];
  vehiclesToCreate: PlannedVehicleCreate[];
  partiesToCreate: PlannedPartyCreate[];
  tripsToCreate: PlannedTripCreate[];
  sheetRowsToSave: PlannedSheetRowSave[];
  rowEvaluationsBySheet: Record<string, EvaluatedRowPreview[]>;
  duplicatesSkipped: {
    vehicles: number;
    parties: number;
    trips: number;
    sheetRows: number;
    total: number;
  };
  karjaExcludedCount: number;
}

const KARJA_INTEREST_REGEX =
  /\b(karja|karj|interest|vyaaj|vyaj|byaj|loan\s*interest|int\.?)\b|karja|vyaaj|vyaj|byaj|interest/i;

export function isKarjaOrInterestText(text: string): boolean {
  if (!text) return false;
  return KARJA_INTEREST_REGEX.test(text);
}

export function normalizeRegKey(reg: string): string {
  return reg.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSheetNameForMatch(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function inferSheetTargetModule(sheetName: string): ImportTargetModule {
  const norm = normalizeSheetNameForMatch(sheetName);
  if (norm.includes('gadi') || norm.includes('master') || norm.includes('vehicle')) {
    return 'vehicles';
  }
  if (norm.includes('total') || norm.includes('party') || norm.includes('summary')) {
    return 'parties';
  }
  if (/^\d{3,4}$/.test(norm) || norm.includes('4312') || norm.includes('6552')) {
    return 'trips';
  }
  return 'trips';
}

export function inferDefaultVehicleFromSheet(
  sheetName: string,
  existingVehicles: Vehicle[]
): string {
  const digits = sheetName.replace(/[^0-9]/g, '');
  if (digits.length >= 3) {
    const matched = existingVehicles.find((v) =>
      normalizeRegKey(v.registrationNumber).endsWith(digits)
    );
    if (matched) return matched.registrationNumber;
    return digits.toUpperCase();
  }
  return '';
}

export function autoMapHeaderToField(header: string): ErpMappableField {
  const h = header.trim().toLowerCase();
  if (!h) return 'skip';
  if (isKarjaOrInterestText(h)) return 'excluded_karja';

  if (/^(sr\.?\s*no\.?|s\.?\s*no\.?|serial)$/i.test(h) || /\bsr\.?\s*no\b/.test(h)) {
    return 'srNo';
  }
  if (/\b(date|tarikh|dt)\b/.test(h)) return 'tripDate';
  if (/\b(lr|bilty|bilti|challan|voucher|receipt|bill\s*no)\b/.test(h)) return 'lrNumber';
  if (/\b(container|cntr|cont\.?\s*no)\b/.test(h)) return 'containerNo';
  if (/\b(gadi|gaadi|truck|vehicle|reg)\b/.test(h) && !/type|model|cap/.test(h)) {
    return 'vehicleNumber';
  }
  if (/vehicle\s*type|truck\s*type|body/.test(h)) return 'vehicleType';
  if (/driver.*phone|driver.*mob|mobile|contact/.test(h)) return 'driverPhone';
  if (/driver/.test(h)) return 'driverName';
  if (/gstin|gst\s*no/.test(h)) return 'gstin';
  if (/party\s*type|account\s*type/.test(h)) return 'partyType';
  if (/\b(party|client|customer|broker|consignor|consignee|company|khata|name)\b/.test(h)) {
    return 'partyName';
  }
  if (/\b(from|origin|loading|source)\b/.test(h)) return 'origin';
  if (/\b(to|destination|unloading|dest)\b/.test(h)) return 'destination';
  if (/\b(material|goods|maal|cargo|item|product)\b/.test(h)) return 'material';
  if (/\b(weight|wt|ton|tons|mt|vajan)\b/.test(h)) return 'weightTons';
  if (/\b(diesel|fuel)\b/.test(h) && /\b(qty|quantity|ltr|litre|liters|liter|ltrs)\b/.test(h)) {
    return 'dieselQuantity';
  }
  if (/\b(diesel|fuel|oil|pump)\b/.test(h)) return 'dieselExpense';
  if (/\b(toll|fastag|border|rto|naka|tax)\b/.test(h)) return 'tollExpense';
  if (/\b(bhatta|allowance|salary|pagar|driver\s*exp)\b/.test(h)) return 'driverAllowance';
  if (/\b(kharcha|kharch|hamali|repair|maintenance|tyre|dalali|commission|misc|other\s*exp|expense)\b/.test(h)) {
    return 'otherExpense';
  }
  if (/\b(jama|advance|adv|upad|received|paid|deposit)\b/.test(h)) return 'advanceReceived';
  if (/\b(hisab|balance|bal|baki|due|pending|receivable|net)\b/.test(h)) return 'balanceAmount';
  if (/\b(rate|freight|bhada|bhadu|rent|hire|total\s*amount|amount|bill\s*amt|gross)\b/.test(h)) {
    return 'freightAmount';
  }
  if (/\b(status|state)\b/.test(h)) return 'tripStatus';
  if (/\b(note|notes|remark|remarks|particular|particulars|vigat|detail|details|comment)\b/.test(h)) {
    return 'notes';
  }
  return 'skip';
}

function parseExcelNumber(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.round(raw * 100) / 100;
  }
  if (typeof raw === 'string') {
    const cleaned = raw
      .replace(/[₹,\s]/g, '')
      .replace(/\/-$/g, '')
      .replace(/^rs\.?/i, '');
    if (!cleaned || cleaned === '-') return 0;
    const num = Number(cleaned);
    return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
  }
  return 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseExcelDate(cell: XLSX.CellObject | undefined): {
  isoDate: string;
  display: string;
  isDate: boolean;
} {
  if (!cell || cell.v === undefined || cell.v === null) {
    return { isoDate: '', display: '', isDate: false };
  }

  if (cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
    const d = cell.v;
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return { isoDate: iso, display: cell.w || iso, isDate: true };
  }

  const str = String(cell.w || cell.v || '').trim();
  if (!str) return { isoDate: '', display: '', isDate: false };

  // ISO YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const iso = `${isoMatch[1]}-${pad2(Number(isoMatch[2]))}-${pad2(Number(isoMatch[3]))}`;
    return { isoDate: iso, display: str, isDate: true };
  }

  // Indian DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    let year = Number(dmyMatch[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const iso = `${year}-${pad2(month)}-${pad2(day)}`;
      return { isoDate: iso, display: str, isDate: true };
    }
  }

  // DD-MMM-YYYY or DD MMM YY
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime()) && /[a-zA-Z]{3}/.test(str)) {
    const iso = `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(
      parsed.getDate()
    )}`;
    return { isoDate: iso, display: str, isDate: true };
  }

  return { isoDate: '', display: str, isDate: false };
}

function detectHeaderRowIndex(sheet: XLSX.WorkSheet, range: XLSX.Range): number {
  const maxScanRow = Math.min(range.e.r, range.s.r + 12);
  let bestRow = range.s.r;
  let bestScore = -1;

  for (let r = range.s.r; r <= maxScanRow; r++) {
    let textCount = 0;
    let keywordMatches = 0;

    for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 39); c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      if (!cell || cell.v === undefined || cell.v === null) continue;
      const val = String(cell.w || cell.v).trim();
      if (!val) continue;
      if (typeof cell.v === 'string' && val.length <= 45) {
        textCount += 1;
        if (autoMapHeaderToField(val) !== 'skip') {
          keywordMatches += 2;
        }
      }
    }

    const score = textCount + keywordMatches;
    if (score > bestScore && textCount >= 2) {
      bestScore = score;
      bestRow = r;
    }
  }

  return bestRow;
}

function isSummaryLabel(text: string): boolean {
  const norm = text.trim().toLowerCase();
  return (
    /^(total|grand\s*total|sub\s*total|subtotal|closing\s*balance|opening\s*balance|net\s*total|hisab\s*total)$/i.test(
      norm
    ) || /\bgrand\s*total\b/i.test(norm)
  );
}

export function parseWorkbookFile(
  buffer: ArrayBuffer,
  existingVehicles: Vehicle[]
): ParsedWorksheet[] {
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellFormula: true,
    cellDates: true,
    cellNF: true,
    cellText: true,
  });

  const parsedSheets: ParsedWorksheet[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const headerRow = detectHeaderRowIndex(sheet, range);
    const maxCol = Math.min(range.e.c, range.s.c + 39);

    const columns: ParsedColumnInfo[] = [];
    const seenHeaders = new Map<string, number>();

    for (let c = range.s.c; c <= maxCol; c++) {
      const addr = XLSX.utils.encode_cell({ r: headerRow, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      let rawHeader = cell ? String(cell.w || cell.v || '').trim() : '';
      if (!rawHeader) {
        // Check if any data exists in this column below headerRow
        let hasData = false;
        for (let r = headerRow + 1; r <= Math.min(range.e.r, headerRow + 20); r++) {
          const dAddr = XLSX.utils.encode_cell({ r, c });
          const dCell = sheet[dAddr] as XLSX.CellObject | undefined;
          if (dCell && dCell.v !== undefined && String(dCell.v).trim() !== '') {
            hasData = true;
            break;
          }
        }
        if (!hasData) continue;
        rawHeader = `Column ${XLSX.utils.encode_col(c)}`;
      }

      const count = seenHeaders.get(rawHeader) || 0;
      seenHeaders.set(rawHeader, count + 1);
      const uniqueHeader = count > 0 ? `${rawHeader} (${count + 1})` : rawHeader;

      const excludedKarja = isKarjaOrInterestText(uniqueHeader);
      const mappedField = excludedKarja
        ? 'excluded_karja'
        : autoMapHeaderToField(uniqueHeader);

      columns.push({
        colIndex: c,
        header: uniqueHeader.slice(0, 60),
        mappedField,
        excludedKarja,
      });
    }

    if (columns.length === 0) continue;

    const targetModule = inferSheetTargetModule(sheetName);
    const defaultVehicleNumber = inferDefaultVehicleFromSheet(
      sheetName,
      existingVehicles
    );

    const parsedSheet: ParsedWorksheet = {
      sheetName,
      headerRowIndex: headerRow + 1,
      targetModule,
      defaultVehicleNumber,
      defaultPartyName: '',
      columns,
      rawRows: [],
      formulaCount: 0,
      noteCount: 0,
      excludedKarjaColsCount: columns.filter((col) => col.excludedKarja).length,
      excludedKarjaRowsCount: 0,
    };

    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const cells: ExcelCellRecord[] = [];
      let nonEmptyCount = 0;
      let rowTextAll = '';
      let rowHasFormula = false;
      const cellNotes: string[] = [];

      for (const col of columns) {
        if (col.excludedKarja) continue;

        const addr = XLSX.utils.encode_cell({ r, c: col.colIndex });
        const cell = sheet[addr] as XLSX.CellObject | undefined;

        const formula = cell?.f ? `=${String(cell.f).replace(/^=/, '')}` : '';
        if (formula) {
          parsedSheet.formulaCount += 1;
          rowHasFormula = true;
        }

        const comments = Array.isArray(cell?.c)
          ? cell.c
              .map((cmt) => (cmt && typeof cmt.t === 'string' ? cmt.t.trim() : ''))
              .filter(Boolean)
          : [];
        const noteText = comments.join('; ');
        if (noteText) {
          parsedSheet.noteCount += 1;
          cellNotes.push(`${col.header}: ${noteText}`);
        }

        let valueStr = '';
        let dataType: ExcelCellRecord['dataType'] = 'empty';

        if (cell && cell.v !== undefined && cell.v !== null) {
          if (cell.v instanceof Date || (col.mappedField === 'tripDate' && cell.v)) {
            const parsedDt = parseExcelDate(cell);
            valueStr = parsedDt.isoDate || parsedDt.display;
            dataType = parsedDt.isDate ? 'date' : typeof cell.v === 'number' ? 'number' : 'string';
          } else if (typeof cell.v === 'number') {
            valueStr = String(Math.round(cell.v * 100) / 100);
            dataType = 'number';
          } else if (typeof cell.v === 'boolean') {
            valueStr = cell.v ? 'Yes' : 'No';
            dataType = 'boolean';
          } else {
            valueStr = String(cell.w || cell.v).trim();
            dataType = 'string';
          }
        }

        if (valueStr !== '' || formula !== '') {
          nonEmptyCount += 1;
        }
        rowTextAll += ' ' + valueStr + ' ' + noteText;

        cells.push({
          header: col.header.slice(0, 60),
          cellAddress: addr,
          value: valueStr.slice(0, 200),
          formula: formula.slice(0, 200),
          note: noteText.slice(0, 200),
          dataType,
        });
      }

      if (nonEmptyCount === 0) continue;

      const isKarjaExcluded = isKarjaOrInterestText(rowTextAll);
      if (isKarjaExcluded) {
        parsedSheet.excludedKarjaRowsCount += 1;
      }

      const row = buildParsedRowFromCells(
        r + 1,
        cells,
        columns.filter((col) => !col.excludedKarja),
        cellNotes,
        rowHasFormula,
        isKarjaExcluded
      );

      parsedSheet.rawRows.push(row);
    }

    parsedSheets.push(parsedSheet);
  }

  return parsedSheets;
}

export function buildParsedRowFromCells(
  rowIndex: number,
  cells: ExcelCellRecord[],
  activeColumns: ParsedColumnInfo[],
  cellNotes: string[],
  rowHasFormula: boolean,
  isKarjaExcluded: boolean
): ParsedSheetRow {
  const extracted: ParsedSheetRow['extracted'] = {
    srNo: '',
    tripDate: '',
    lrNumber: '',
    vehicleNumber: '',
    vehicleType: 'Truck',
    driverName: '',
    driverPhone: '',
    partyName: '',
    partyType: 'Consignor',
    gstin: '',
    origin: '',
    destination: '',
    containerNo: '',
    material: '',
    weightTons: 0,
    freightAmount: 0,
    advanceReceived: 0,
    balanceAmount: 0,
    hasExplicitBalance: false,
    dieselQuantity: 0,
    dieselExpense: 0,
    tollExpense: 0,
    driverAllowance: 0,
    otherExpense: 0,
    tripStatus: 'Settled',
    notes: '',
  };

  const extraNotes: string[] = [...cellNotes];
  let summaryDetected = false;
  let primaryAmount = 0;

  activeColumns.forEach((col, idx) => {
    const cell = cells[idx];
    if (!cell) return;
    const val = cell.value.trim();
    if (val && isSummaryLabel(val)) {
      summaryDetected = true;
    }

    switch (col.mappedField) {
      case 'srNo':
        if (val && !extracted.srNo) extracted.srNo = val;
        break;
      case 'tripDate':
        if (val && !extracted.tripDate) extracted.tripDate = val;
        break;
      case 'lrNumber':
        if (val) extracted.lrNumber = val.toUpperCase();
        break;
      case 'vehicleNumber':
        if (val) extracted.vehicleNumber = val.toUpperCase();
        break;
      case 'vehicleType':
        if (val) extracted.vehicleType = val;
        break;
      case 'driverName':
        if (val) extracted.driverName = val;
        break;
      case 'driverPhone':
        if (val) extracted.driverPhone = val;
        break;
      case 'partyName':
        if (val) extracted.partyName = val;
        break;
      case 'partyType':
        if (val) extracted.partyType = val;
        break;
      case 'gstin':
        if (val) extracted.gstin = val.toUpperCase();
        break;
      case 'origin':
        if (val) extracted.origin = val;
        break;
      case 'destination':
        if (val) extracted.destination = val;
        break;
      case 'containerNo':
        if (val) extracted.containerNo = val.toUpperCase();
        break;
      case 'material':
        if (val) extracted.material = val;
        break;
      case 'weightTons':
        extracted.weightTons += parseExcelNumber(val);
        break;
      case 'freightAmount':
        extracted.freightAmount += parseExcelNumber(val);
        break;
      case 'advanceReceived':
        extracted.advanceReceived += parseExcelNumber(val);
        break;
      case 'balanceAmount':
        if (val !== '' && /\d/.test(val)) {
          extracted.hasExplicitBalance = true;
        }
        extracted.balanceAmount += parseExcelNumber(val);
        break;
      case 'dieselQuantity':
        extracted.dieselQuantity += parseExcelNumber(val);
        break;
      case 'dieselExpense':
        extracted.dieselExpense += parseExcelNumber(val);
        break;
      case 'tollExpense':
        extracted.tollExpense += parseExcelNumber(val);
        break;
      case 'driverAllowance':
        extracted.driverAllowance += parseExcelNumber(val);
        break;
      case 'otherExpense':
        extracted.otherExpense += parseExcelNumber(val);
        break;
      case 'tripStatus': {
        const lower = val.toLowerCase();
        if (lower.includes('transit')) extracted.tripStatus = 'In Transit';
        else if (lower.includes('sched')) extracted.tripStatus = 'Scheduled';
        else if (lower.includes('deliv')) extracted.tripStatus = 'Delivered';
        else if (lower.includes('cancel')) extracted.tripStatus = 'Cancelled';
        else extracted.tripStatus = 'Settled';
        break;
      }
      case 'notes':
        if (val) extraNotes.push(val);
        break;
      default:
        break;
    }
  });

  // Also detect summary rows with SUM formula and no date/LR
  if (
    rowHasFormula &&
    cells.some((c) => /^=SUM\(/i.test(c.formula)) &&
    !extracted.tripDate &&
    !extracted.lrNumber
  ) {
    summaryDetected = true;
  }

  if (extracted.freightAmount > 0) {
    primaryAmount = extracted.freightAmount;
  } else if (extracted.balanceAmount !== 0) {
    primaryAmount = extracted.balanceAmount;
  } else {
    const firstNumeric = cells.find((c) => c.dataType === 'number');
    if (firstNumeric) primaryAmount = parseExcelNumber(firstNumeric.value);
  }

  extracted.notes = clampStr(extraNotes.join(' | '), BLUEPRINT_LIMITS.NOTES_MAX);

  return {
    rowIndex,
    cells,
    originalDate: extracted.tripDate.slice(0, 30),
    primaryAmount: Math.round(primaryAmount * 100) / 100,
    notes: extracted.notes,
    isSummaryRow: summaryDetected,
    isKarjaExcluded,
    extracted,
  };
}

export function recomputeSheetRowMappings(sheet: ParsedWorksheet): ParsedWorksheet {
  const activeCols = sheet.columns.filter((c) => !c.excludedKarja);
  const updatedRows = sheet.rawRows.map((r) => {
    const cellNotes = r.cells
      .filter((c) => c.note)
      .map((c) => `${c.header}: ${c.note}`);
    const rowHasFormula = r.cells.some((c) => Boolean(c.formula));
    return buildParsedRowFromCells(
      r.rowIndex,
      r.cells,
      activeCols,
      cellNotes,
      rowHasFormula,
      r.isKarjaExcluded
    );
  });
  return { ...sheet, rawRows: updatedRows };
}

function buildRowSignature(
  sheetName: string,
  row: ParsedSheetRow
): string {
  const keyPreview = row.cells
    .slice(0, 4)
    .map((c) => c.value.trim().toLowerCase())
    .join('|');
  const raw = `${sheetName.trim().toLowerCase()}#r${row.rowIndex}#${row.originalDate}#${row.primaryAmount}#${keyPreview}`;
  return raw.slice(0, 200);
}

function buildTripDedupSignature(
  lrNumber: string,
  tripDate: string,
  vehicleNumber: string,
  partyName: string,
  origin: string,
  destination: string,
  freightAmount: number
): string {
  const normVeh = normalizeRegKey(vehicleNumber);
  const normParty = normalizeNameKey(partyName);
  const normOrig = origin.trim().toLowerCase();
  const normDest = destination.trim().toLowerCase();
  const normLr = lrNumber.trim().toUpperCase();
  return `${tripDate}|${normLr}|${normVeh}|${normParty}|${normOrig}|${normDest}|${freightAmount}`;
}

export function buildImportExecutionPlan(
  fileName: string,
  sheets: ParsedWorksheet[],
  existingVehicles: Vehicle[],
  existingParties: Party[],
  existingTrips: Trip[],
  existingSheetRows: ImportedSheetRow[]
): ImportExecutionPlan {
  const existingVehicleKeys = new Set(
    existingVehicles.map((v) => normalizeRegKey(v.registrationNumber))
  );
  const plannedVehicleKeys = new Map<string, PlannedVehicleCreate>();

  const existingPartyKeys = new Set(
    existingParties.map((p) => normalizeNameKey(p.partyName))
  );
  const plannedPartyKeys = new Map<string, PlannedPartyCreate>();

  const existingTripLrDateKeys = new Set(
    existingTrips.map(
      (t) => `${t.lrNumber.trim().toUpperCase()}|${t.tripDate}|${normalizeRegKey(t.vehicleNumber)}`
    )
  );
  const existingTripContentKeys = new Set(
    existingTrips.map((t) =>
      buildTripDedupSignature(
        t.lrNumber,
        t.tripDate,
        t.vehicleNumber,
        t.partyName,
        t.origin,
        t.destination,
        t.freightAmount
      )
    )
  );
  const plannedTripKeys = new Set<string>();

  const existingRowSigs = new Set(existingSheetRows.map((r) => r.rowSignature));
  const plannedRowSigs = new Set<string>();

  const tripsToCreate: PlannedTripCreate[] = [];
  const sheetRowsToSave: PlannedSheetRowSave[] = [];
  const rowEvaluationsBySheet: Record<string, EvaluatedRowPreview[]> = {};

  let dupVehicles = 0;
  let dupParties = 0;
  let dupTrips = 0;
  let dupSheetRows = 0;
  let karjaExcludedCount = 0;

  const resolveOrPlanVehicle = (rawReg: string, driverName = '', driverPhone = '', typeStr = 'Truck', notes = ''): { reg: string; isDup: boolean } => {
    let cleaned = clampStr(rawReg.toUpperCase().replace(/[^A-Z0-9\-\s]/g, ''), BLUEPRINT_LIMITS.VEHICLE_REG_MAX);
    if (!cleaned) {
      return { reg: '', isDup: false };
    }
    if (cleaned.length < BLUEPRINT_LIMITS.VEHICLE_REG_MIN) {
      cleaned = `VH-${cleaned}`;
    }
    const key = normalizeRegKey(cleaned);
    // Match exact or suffix match for 4-digit sheet names like 4312 / 6552
    const existingMatch = existingVehicles.find((v) => {
      const ek = normalizeRegKey(v.registrationNumber);
      return ek === key || (key.length >= 3 && ek.endsWith(key));
    });
    if (existingMatch) {
      return { reg: existingMatch.registrationNumber, isDup: true };
    }
    if (existingVehicleKeys.has(key)) {
      return { reg: cleaned, isDup: true };
    }
    if (!plannedVehicleKeys.has(key) && BLUEPRINT_LIMITS.REG_NO_PATTERN.test(cleaned)) {
      const normalizedType: Vehicle['vehicleType'] =
        /trailer/i.test(typeStr)
          ? 'Trailer'
          : /container/i.test(typeStr)
          ? 'Container'
          : /tanker/i.test(typeStr)
          ? 'Tanker'
          : /tipper/i.test(typeStr)
          ? 'Tipper'
          : /lcv/i.test(typeStr)
          ? 'LCV'
          : 'Truck';
      plannedVehicleKeys.set(key, {
        registrationNumber: cleaned,
        vehicleType: normalizedType,
        driverName: clampStr(driverName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX),
        driverPhone: clampStr(driverPhone, BLUEPRINT_LIMITS.PHONE_MAX),
        notes: clampStr(notes, BLUEPRINT_LIMITS.NOTES_MAX),
      });
    }
    return { reg: cleaned, isDup: false };
  };

  const resolveOrPlanParty = (rawParty: string, typeStr = 'Consignor', gstin = '', notes = ''): { name: string; isDup: boolean } => {
    const cleaned = clampStr(rawParty, BLUEPRINT_LIMITS.PARTY_NAME_MAX);
    if (!cleaned || cleaned.length < BLUEPRINT_LIMITS.PARTY_NAME_MIN) {
      return { name: '', isDup: false };
    }
    const key = normalizeNameKey(cleaned);
    const existingMatch = existingParties.find(
      (p) => normalizeNameKey(p.partyName) === key
    );
    if (existingMatch) {
      return { name: existingMatch.partyName, isDup: true };
    }
    if (existingPartyKeys.has(key)) {
      return { name: cleaned, isDup: true };
    }
    if (!plannedPartyKeys.has(key)) {
      const normalizedPartyType: Party['partyType'] =
        /broker/i.test(typeStr)
          ? 'Broker'
          : /consignee/i.test(typeStr)
          ? 'Consignee'
          : /both/i.test(typeStr)
          ? 'Both'
          : 'Consignor';
      plannedPartyKeys.set(key, {
        partyName: cleaned,
        partyType: normalizedPartyType,
        gstin: clampStr(gstin.toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX),
        notes: clampStr(notes, BLUEPRINT_LIMITS.NOTES_MAX),
      });
    }
    return { name: cleaned, isDup: false };
  };

  for (const sheet of sheets) {
    karjaExcludedCount += sheet.excludedKarjaColsCount + sheet.excludedKarjaRowsCount;
    const evaluations: EvaluatedRowPreview[] = [];

    // If sheet has a default vehicle number (e.g., 4312 or 6552), ensure it is resolved
    let sheetDefaultVehicle = '';
    if (sheet.defaultVehicleNumber) {
      const res = resolveOrPlanVehicle(sheet.defaultVehicleNumber, '', '', 'Truck', `Imported from sheet ${sheet.sheetName}`);
      sheetDefaultVehicle = res.reg;
    }

    for (const row of sheet.rawRows) {
      const rowSig = buildRowSignature(sheet.sheetName, row);

      if (row.isKarjaExcluded || row.cells.length === 0) {
        evaluations.push({
          row,
          status: 'excluded_karja',
          statusReason: 'Excluded: Karja / Interest row',
          rowSignature: rowSig,
          resolvedVehicle: '',
          resolvedParty: '',
        });
        continue;
      }

      const isSheetRowDuplicate =
        existingRowSigs.has(rowSig) || plannedRowSigs.has(rowSig);

      const candidateVehicle =
        row.extracted.vehicleNumber || sheetDefaultVehicle || '';
      const candidateParty =
        row.extracted.partyName ||
        sheet.defaultPartyName ||
        (sheet.targetModule === 'trips' ? 'General Transport Account' : '');

      if (row.isSummaryRow || sheet.targetModule === 'ledger-summary') {
        if (isSheetRowDuplicate) {
          dupSheetRows += 1;
          evaluations.push({
            row,
            status: 'duplicate',
            statusReason: 'Duplicate preserved row (skipped)',
            rowSignature: rowSig,
            resolvedVehicle: candidateVehicle,
            resolvedParty: candidateParty,
          });
        } else {
          plannedRowSigs.add(rowSig);
          sheetRowsToSave.push({
            sheetName: sheet.sheetName,
            rowIndex: row.rowIndex,
            targetModule: 'ledger-summary',
            rowSignature: rowSig,
            originalDate: row.originalDate,
            primaryAmount: row.primaryAmount,
            notes: row.notes,
            columnsOrder: sheet.columns
              .filter((c) => !c.excludedKarja)
              .map((c) => c.header),
            cells: row.cells,
            linkedVehicleReg: '',
            linkedPartyName: '',
            linkedTripKey: '',
          });
          evaluations.push({
            row,
            status: 'summary',
            statusReason: 'Preserved in Workbook Ledger (with formulas)',
            rowSignature: rowSig,
            resolvedVehicle: candidateVehicle,
            resolvedParty: candidateParty,
          });
        }
        continue;
      }

      if (sheet.targetModule === 'vehicles') {
        const vehRes = candidateVehicle
          ? resolveOrPlanVehicle(
              candidateVehicle,
              row.extracted.driverName,
              row.extracted.driverPhone,
              row.extracted.vehicleType,
              row.notes
            )
          : { reg: '', isDup: false };

        if (candidateVehicle && vehRes.isDup) {
          dupVehicles += 1;
        }
        if (candidateParty) {
          const ptyRes = resolveOrPlanParty(candidateParty, row.extracted.partyType, row.extracted.gstin, row.notes);
          if (ptyRes.isDup) dupParties += 1;
        }

        if (isSheetRowDuplicate) {
          dupSheetRows += 1;
          evaluations.push({
            row,
            status: 'duplicate',
            statusReason: 'Duplicate record (existing data preserved)',
            rowSignature: rowSig,
            resolvedVehicle: vehRes.reg,
            resolvedParty: candidateParty,
          });
        } else {
          plannedRowSigs.add(rowSig);
          sheetRowsToSave.push({
            sheetName: sheet.sheetName,
            rowIndex: row.rowIndex,
            targetModule: 'vehicles',
            rowSignature: rowSig,
            originalDate: row.originalDate,
            primaryAmount: row.primaryAmount,
            notes: row.notes,
            columnsOrder: sheet.columns
              .filter((c) => !c.excludedKarja)
              .map((c) => c.header),
            cells: row.cells,
            linkedVehicleReg: vehRes.reg,
            linkedPartyName: '',
            linkedTripKey: '',
          });
          evaluations.push({
            row,
            status: vehRes.isDup ? 'duplicate' : 'new',
            statusReason: vehRes.isDup
              ? 'Existing Vehicle kept (row archived)'
              : vehRes.reg
              ? `New Vehicle ${vehRes.reg} + Ledger Row`
              : 'Archived to Workbook Ledger',
            rowSignature: rowSig,
            resolvedVehicle: vehRes.reg,
            resolvedParty: candidateParty,
          });
        }
        continue;
      }

      if (sheet.targetModule === 'parties') {
        const ptyRes = candidateParty
          ? resolveOrPlanParty(
              candidateParty,
              row.extracted.partyType,
              row.extracted.gstin,
              row.notes
            )
          : { name: '', isDup: false };
        if (candidateParty && ptyRes.isDup) {
          dupParties += 1;
        }
        if (candidateVehicle) {
          const vehRes = resolveOrPlanVehicle(candidateVehicle);
          if (vehRes.isDup) dupVehicles += 1;
        }

        if (isSheetRowDuplicate) {
          dupSheetRows += 1;
          evaluations.push({
            row,
            status: 'duplicate',
            statusReason: 'Duplicate record (existing data preserved)',
            rowSignature: rowSig,
            resolvedVehicle: candidateVehicle,
            resolvedParty: ptyRes.name,
          });
        } else {
          plannedRowSigs.add(rowSig);
          sheetRowsToSave.push({
            sheetName: sheet.sheetName,
            rowIndex: row.rowIndex,
            targetModule: 'parties',
            rowSignature: rowSig,
            originalDate: row.originalDate,
            primaryAmount: row.primaryAmount,
            notes: row.notes,
            columnsOrder: sheet.columns
              .filter((c) => !c.excludedKarja)
              .map((c) => c.header),
            cells: row.cells,
            linkedVehicleReg: '',
            linkedPartyName: ptyRes.name,
            linkedTripKey: '',
          });
          evaluations.push({
            row,
            status: ptyRes.isDup ? 'duplicate' : 'new',
            statusReason: ptyRes.isDup
              ? 'Existing Party kept (row archived)'
              : ptyRes.name
              ? `New Party "${ptyRes.name}" + Ledger Row`
              : 'Archived to Workbook Ledger',
            rowSignature: rowSig,
            resolvedVehicle: candidateVehicle,
            resolvedParty: ptyRes.name,
          });
        }
        continue;
      }

      // Target: trips
      const vehRes = resolveOrPlanVehicle(
        candidateVehicle || `${sheet.sheetName.replace(/[^A-Z0-9]/gi, '').slice(0, 8) || 'TRUCK'}`,
        row.extracted.driverName,
        row.extracted.driverPhone,
        row.extracted.vehicleType,
        ''
      );
      const ptyRes = resolveOrPlanParty(
        candidateParty || 'General Transport Account',
        row.extracted.partyType,
        row.extracted.gstin,
        ''
      );

      const tripDate = clampStr(
        row.extracted.tripDate || getTodayISO(),
        BLUEPRINT_LIMITS.DATE_MAX
      );
      const lrNumber = clampStr(
        row.extracted.lrNumber ||
          `${sheet.sheetName.replace(/[^A-Z0-9]/gi, '').slice(0, 10) || 'XLS'}-R${row.rowIndex}`,
        BLUEPRINT_LIMITS.LR_NUMBER_MAX
      );
      const origin = clampStr(
        row.extracted.origin || 'Origin (Excel)',
        BLUEPRINT_LIMITS.LOCATION_MAX
      );
      const destination = clampStr(
        row.extracted.destination || 'Destination (Excel)',
        BLUEPRINT_LIMITS.LOCATION_MAX
      );
      const freightAmount = clampNum(
        row.extracted.freightAmount,
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const advanceReceived = clampNum(
        row.extracted.advanceReceived,
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const dieselExpense = clampNum(
        row.extracted.dieselExpense,
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const tollExpense = clampNum(
        row.extracted.tollExpense,
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const driverAllowance = clampNum(
        row.extracted.driverAllowance,
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const otherExpense = clampNum(
        row.extracted.otherExpense,
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const totalExpense =
        Math.round(
          (dieselExpense + tollExpense + driverAllowance + otherExpense) * 100
        ) / 100;
      const balanceAmount =
        row.extracted.hasExplicitBalance || row.extracted.balanceAmount !== 0
          ? clampNum(
              row.extracted.balanceAmount,
              -BLUEPRINT_LIMITS.CURRENCY_MAX,
              BLUEPRINT_LIMITS.CURRENCY_MAX
            )
          : Math.round((freightAmount - advanceReceived) * 100) / 100;

      const lrDateKey = `${lrNumber.toUpperCase()}|${tripDate}|${normalizeRegKey(vehRes.reg)}`;
      const contentKey = buildTripDedupSignature(
        lrNumber,
        tripDate,
        vehRes.reg,
        ptyRes.name,
        origin,
        destination,
        freightAmount
      );

      const isTripDuplicate =
        existingTripLrDateKeys.has(lrDateKey) ||
        existingTripContentKeys.has(contentKey) ||
        plannedTripKeys.has(lrDateKey) ||
        plannedTripKeys.has(contentKey);

      if (isTripDuplicate) {
        dupTrips += 1;
        if (isSheetRowDuplicate) dupSheetRows += 1;
        evaluations.push({
          row,
          status: 'duplicate',
          statusReason: 'Duplicate Trip detected — skipped (existing data preserved)',
          rowSignature: rowSig,
          resolvedVehicle: vehRes.reg,
          resolvedParty: ptyRes.name,
        });
        continue;
      }

      plannedTripKeys.add(lrDateKey);
      plannedTripKeys.add(contentKey);

      tripsToCreate.push({
        sheetName: sheet.sheetName,
        rowIndex: row.rowIndex,
        srNo: clampStr(row.extracted.srNo || String(row.rowIndex), BLUEPRINT_LIMITS.SR_NO_MAX),
        lrNumber,
        tripDate,
        vehicleNumber: vehRes.reg,
        partyName: ptyRes.name,
        driverName: clampStr(row.extracted.driverName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX),
        origin,
        destination,
        containerNo: clampStr(row.extracted.containerNo, BLUEPRINT_LIMITS.CONTAINER_NO_MAX),
        material: clampStr(row.extracted.material, BLUEPRINT_LIMITS.MATERIAL_MAX),
        weightTons: clampNum(row.extracted.weightTons, 0, BLUEPRINT_LIMITS.WEIGHT_MAX),
        freightAmount,
        advanceReceived,
        dieselQuantity: clampNum(row.extracted.dieselQuantity, 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX),
        dieselExpense,
        tollExpense,
        driverAllowance,
        otherExpense,
        balanceAmount,
        totalExpense,
        tripStatus: row.extracted.tripStatus,
        paymentStatus: derivePaymentStatus(freightAmount, advanceReceived),
        podReceived: row.extracted.tripStatus === 'Settled' || row.extracted.tripStatus === 'Delivered',
        notes: row.notes,
      });

      if (!isSheetRowDuplicate) {
        plannedRowSigs.add(rowSig);
        sheetRowsToSave.push({
          sheetName: sheet.sheetName,
          rowIndex: row.rowIndex,
          targetModule: 'trips',
          rowSignature: rowSig,
          originalDate: tripDate,
          primaryAmount: freightAmount || row.primaryAmount,
          notes: row.notes,
          columnsOrder: sheet.columns
            .filter((c) => !c.excludedKarja)
            .map((c) => c.header),
          cells: row.cells,
          linkedVehicleReg: vehRes.reg,
          linkedPartyName: ptyRes.name,
          linkedTripKey: lrDateKey,
        });
      }

      evaluations.push({
        row,
        status: 'new',
        statusReason: `New Trip (${lrNumber}) → ${vehRes.reg}`,
        rowSignature: rowSig,
        resolvedVehicle: vehRes.reg,
        resolvedParty: ptyRes.name,
      });
    }

    rowEvaluationsBySheet[sheet.sheetName] = evaluations;
  }

  return {
    fileName,
    sheetNames: sheets.map((s) => s.sheetName),
    vehiclesToCreate: Array.from(plannedVehicleKeys.values()),
    partiesToCreate: Array.from(plannedPartyKeys.values()),
    tripsToCreate,
    sheetRowsToSave,
    rowEvaluationsBySheet,
    duplicatesSkipped: {
      vehicles: dupVehicles,
      parties: dupParties,
      trips: dupTrips,
      sheetRows: dupSheetRows,
      total: dupVehicles + dupParties + dupTrips + dupSheetRows,
    },
    karjaExcludedCount,
  };
}
