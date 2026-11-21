import {
  BILL_STATUSES,
  BLUEPRINT_LIMITS,
  DEFAULT_DIESEL_RATE,
  DRIVER_PAYMENT_TYPES,
  DRIVER_STATUSES,
  EXPENSE_CATEGORIES,
  PARTY_PAYMENT_TYPES,
  PARTY_STATUSES,
  PARTY_TYPES,
  PAYMENT_MODES,
  PAYMENT_STATUSES,
  TRIP_STATUSES,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
  type Bill,
  type Driver,
  type DriverPayment,
  type ImportedSheetRow,
  type MaintenanceRecord,
  type Party,
  type PartyPayment,
  type Trip,
  type Vehicle,
} from '../types/erp';
import { normalizeNameKey, normalizeRegKey } from './excelImportParser';
import { clampNum, clampStr, derivePaymentStatus } from './formatters';

export { normalizeNameKey };

/**
 * Computes rounded INR diesel amount from litres and per-litre rate.
 * Ensures floating point precision never drifts past 2 decimal places.
 */
export function calculateDieselAmount(litres: number, ratePerLitre: number): number {
  const safeLitres = Number.isFinite(litres) && litres > 0 ? litres : 0;
  const safeRate = Number.isFinite(ratePerLitre) && ratePerLitre > 0 ? ratePerLitre : 0;
  if (safeLitres === 0 || safeRate === 0) return 0;
  return Math.round(safeLitres * safeRate * 100) / 100;
}

export function resolveEffectiveDieselRate(
  companyDefaultRate?: number | null,
  tripSavedRate?: number | null
): number {
  if (typeof tripSavedRate === 'number' && Number.isFinite(tripSavedRate) && tripSavedRate > 0) {
    return Math.round(tripSavedRate * 100) / 100;
  }
  if (
    typeof companyDefaultRate === 'number' &&
    Number.isFinite(companyDefaultRate) &&
    companyDefaultRate > 0
  ) {
    return Math.round(companyDefaultRate * 100) / 100;
  }
  return DEFAULT_DIESEL_RATE;
}

/**
 * Checks if a vehicle registration number duplicates an existing fleet record
 * using normalized alphanumeric matching (e.g. GJ-03-BW-4312 === GJ03BW4312).
 */
export function findDuplicateVehicle(
  vehicles: Pick<Vehicle, 'id' | 'registrationNumber'>[],
  candidateReg: string,
  excludeId?: string
): Pick<Vehicle, 'id' | 'registrationNumber'> | undefined {
  const targetKey = normalizeRegKey(candidateReg);
  if (!targetKey) return undefined;
  return vehicles.find(
    (v) => v.id !== excludeId && normalizeRegKey(v.registrationNumber) === targetKey
  );
}

/**
 * Checks if a party name or non-empty GSTIN duplicates an existing party record.
 */
export function findDuplicateParty(
  parties: Pick<Party, 'id' | 'partyName' | 'gstin'>[],
  candidateName: string,
  candidateGstin = '',
  excludeId?: string
): { reason: 'name' | 'gstin'; existing: Pick<Party, 'id' | 'partyName' | 'gstin'> } | null {
  const targetNameKey = normalizeNameKey(candidateName);
  const targetGstin = candidateGstin.trim().toUpperCase().replace(/\s+/g, '');

  if (targetNameKey) {
    const byName = parties.find(
      (p) => p.id !== excludeId && normalizeNameKey(p.partyName) === targetNameKey
    );
    if (byName) {
      return { reason: 'name', existing: byName };
    }
  }

  if (targetGstin.length >= 10) {
    const byGstin = parties.find(
      (p) =>
        p.id !== excludeId &&
        p.gstin.trim().toUpperCase().replace(/\s+/g, '') === targetGstin
    );
    if (byGstin) {
      return { reason: 'gstin', existing: byGstin };
    }
  }

  return null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PartyLedgerSummary {
  tripCount: number;
  totalFreight: number;
  tripAdvanceReceived: number;
  tripHisabBalance: number;
  paymentsReceivedTotal: number;
  ledgerAdvancesTotal: number;
  deductionsTotal: number;
  separatePaymentsTotal: number;
  partyPaymentsTotal: number;
  totalReceived: number;
  totalCredited: number;
  netOutstanding: number;
  paymentCount: number;
}

/**
 * Computes a party's complete real-time account ledger by subtracting the sum of
 * partyPayments (and any trip-level Jama) from the party's active trip freight bills,
 * while preserving historical Excel-imported settled rows (explicit Hisab = 0).
 */
export function computePartyLedgerSummary(
  partyId: string,
  trips: Trip[],
  partyPayments: PartyPayment[],
  partyNameFallback = ''
): PartyLedgerSummary {
  const fallbackNameKey = partyNameFallback ? normalizeNameKey(partyNameFallback) : '';
  let tripCount = 0;
  let totalFreight = 0;
  let tripAdvanceReceived = 0;
  let tripHisabBalance = 0;

  for (const t of trips) {
    if (t.tripStatus === 'Cancelled') continue;
    const matchesById = t.partyId === partyId;
    const matchesByFallbackName =
      !t.partyId && fallbackNameKey !== '' && normalizeNameKey(t.partyName) === fallbackNameKey;
    if (!matchesById && !matchesByFallbackName) continue;

    const freight = Number(t.freightAmount) || 0;
    const tripAdv = Number(t.advanceReceived) || 0;
    const hasExplicitBalance =
      typeof t.balanceAmount === 'number' && Number.isFinite(t.balanceAmount);
    const effectiveTripBalance = hasExplicitBalance
      ? t.balanceAmount
      : round2(freight - tripAdv);

    tripCount += 1;
    totalFreight += freight;
    tripAdvanceReceived += tripAdv;
    tripHisabBalance += effectiveTripBalance;
  }

  let paymentsReceivedTotal = 0;
  let ledgerAdvancesTotal = 0;
  let deductionsTotal = 0;
  let paymentCount = 0;

  for (const p of partyPayments) {
    const matchesById = p.partyId === partyId;
    const matchesByFallbackName =
      !p.partyId && fallbackNameKey !== '' && normalizeNameKey(p.partyName) === fallbackNameKey;
    if (!matchesById && !matchesByFallbackName) continue;

    const amt = Number(p.amount) || 0;
    paymentCount += 1;
    if (p.paymentType === 'Advance') {
      ledgerAdvancesTotal += amt;
    } else if (p.paymentType === 'Deduction') {
      deductionsTotal += amt;
    } else {
      paymentsReceivedTotal += amt;
    }
  }

  const separatePaymentsTotal = round2(paymentsReceivedTotal + ledgerAdvancesTotal);
  const partyPaymentsTotal = round2(separatePaymentsTotal + deductionsTotal);
  const totalReceived = round2(tripAdvanceReceived + separatePaymentsTotal);
  const totalCredited = round2(totalReceived + deductionsTotal);
  const netOutstanding = round2(tripHisabBalance - partyPaymentsTotal);

  return {
    tripCount,
    totalFreight: round2(totalFreight),
    tripAdvanceReceived: round2(tripAdvanceReceived),
    tripHisabBalance: round2(tripHisabBalance),
    paymentsReceivedTotal: round2(paymentsReceivedTotal),
    ledgerAdvancesTotal: round2(ledgerAdvancesTotal),
    deductionsTotal: round2(deductionsTotal),
    separatePaymentsTotal,
    partyPaymentsTotal,
    totalReceived,
    totalCredited,
    netOutstanding,
    paymentCount,
  };
}

export interface DateWiseStatementRow {
  id: string;
  date: string;
  entryType: 'Trip' | 'Payment Received' | 'Advance' | 'Deduction';
  particulars: string;
  reference: string;
  debit: number;
  credit: number;
  runningBalance: number;
  note: string;
}

export interface DateWiseStatementResult {
  openingBalance: number;
  rows: DateWiseStatementRow[];
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
}

/**
 * Computes sum of partyPayments explicitly linked to individual tripIds for a party,
 * without ever modifying historical trip records.
 */
export function computeTripLinkedPaymentTotals(
  partyId: string,
  partyPayments: PartyPayment[],
  partyNameFallback = ''
): Map<string, number> {
  const fallbackNameKey = partyNameFallback ? normalizeNameKey(partyNameFallback) : '';
  const map = new Map<string, number>();
  for (const p of partyPayments) {
    if (!p.tripId) continue;
    const matchesById = p.partyId === partyId;
    const matchesByFallbackName =
      !p.partyId && fallbackNameKey !== '' && normalizeNameKey(p.partyName) === fallbackNameKey;
    if (!matchesById && !matchesByFallbackName) continue;
    const prev = map.get(p.tripId) || 0;
    map.set(p.tripId, round2(prev + (Number(p.amount) || 0)));
  }
  return map;
}

export type StatementPaymentMethodFilter = 'All' | 'Cash' | 'Bank' | 'UPI' | 'Cheque';

export const STATEMENT_PAYMENT_METHOD_FILTERS: readonly {
  value: StatementPaymentMethodFilter;
  label: string;
}[] = [
  { value: 'All', label: 'All Payment Methods' },
  { value: 'Cash', label: 'Cash' },
  { value: 'Bank', label: 'Bank (NEFT/RTGS/IMPS)' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Cheque', label: 'Cheque' },
] as const;

export function matchesStatementPaymentMethod(
  paymentMode: string,
  filter: StatementPaymentMethodFilter
): boolean {
  if (filter === 'All') return true;
  if (filter === 'Bank') {
    return paymentMode === 'Bank Transfer' || paymentMode === 'Bank';
  }
  return paymentMode === filter;
}

/**
 * Builds a chronological date-wise party account statement with running balance,
 * reconciling identically with computePartyLedgerSummary (including Excel Hisab=0 rows).
 * When paymentMethodFilter is set to Cash/Bank/UPI/Cheque, returns a reconciliation
 * view focused strictly on payments made via that method.
 */
export function buildDateWisePartyStatement(
  partyId: string,
  trips: Trip[],
  partyPayments: PartyPayment[],
  fromDate = '',
  toDate = '',
  partyNameFallback = '',
  paymentMethodFilter: StatementPaymentMethodFilter = 'All'
): DateWiseStatementResult {
  interface RawEvent {
    id: string;
    date: string;
    sortPriority: number; // 0 = trip, 1 = payment
    entryType: DateWiseStatementRow['entryType'];
    particulars: string;
    reference: string;
    debit: number;
    credit: number;
    note: string;
  }

  const fallbackNameKey = partyNameFallback ? normalizeNameKey(partyNameFallback) : '';
  const isPaymentMethodFiltered = paymentMethodFilter !== 'All';
  const events: RawEvent[] = [];

  if (!isPaymentMethodFiltered) {
    for (const t of trips) {
      if (t.tripStatus === 'Cancelled') continue;
      const matchesById = t.partyId === partyId;
      const matchesByFallbackName =
        !t.partyId && fallbackNameKey !== '' && normalizeNameKey(t.partyName) === fallbackNameKey;
      if (!matchesById && !matchesByFallbackName) continue;

      const freight = round2(Number(t.freightAmount) || 0);
      const jama = round2(Number(t.advanceReceived) || 0);
      const hasExplicitBalance =
        typeof t.balanceAmount === 'number' && Number.isFinite(t.balanceAmount);
      const hisab = hasExplicitBalance ? round2(t.balanceAmount) : round2(freight - jama);
      const debit = freight >= hisab ? freight : hisab;
      const credit = round2(Math.max(0, debit - hisab));
      const waiver = round2(Math.max(0, credit - jama));

      const routeText = [t.origin, t.destination].filter(Boolean).join(' → ');
      const noteParts: string[] = [];
      if (jama > 0) noteParts.push(`Trip Jama: ₹${jama.toFixed(2)}`);
      if (waiver > 0) noteParts.push(`Settled Adj: ₹${waiver.toFixed(2)}`);
      if (t.notes) noteParts.push(t.notes);

      events.push({
        id: `stmt_trp_${t.id}`,
        date: t.tripDate || '',
        sortPriority: 0,
        entryType: 'Trip',
        particulars: `Trip ${t.vehicleNumber}${routeText ? ` (${routeText})` : ''}`,
        reference: t.containerNo ? `${t.lrNumber} / ${t.containerNo}` : t.lrNumber,
        debit,
        credit,
        note: noteParts.join(' · '),
      });
    }
  }

  for (const p of partyPayments) {
    const matchesById = p.partyId === partyId;
    const matchesByFallbackName =
      !p.partyId && fallbackNameKey !== '' && normalizeNameKey(p.partyName) === fallbackNameKey;
    if (!matchesById && !matchesByFallbackName) continue;
    if (!matchesStatementPaymentMethod(p.paymentMode, paymentMethodFilter)) continue;

    const amt = round2(Number(p.amount) || 0);
    const resolvedType = p.paymentType || 'Payment Received';
    const refParts = [p.paymentMode, p.referenceNo, p.tripLrNumber ? `Trip ${p.tripLrNumber}` : ''].filter(Boolean);
    events.push({
      id: `stmt_pay_${p.id}`,
      date: p.paymentDate || '',
      sortPriority: 1,
      entryType: resolvedType,
      particulars: `${resolvedType} (${p.paymentMode})`,
      reference: refParts.join(' · ') || '—',
      debit: 0,
      credit: amt,
      note: p.notes || '',
    });
  }

  events.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp !== 0) return dateCmp;
    if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority;
    return a.id.localeCompare(b.id);
  });

  const cleanFrom = fromDate.trim();
  const cleanTo = toDate.trim();

  let openingBalance = 0;
  let running = 0;
  let periodDebit = 0;
  let periodCredit = 0;
  const rows: DateWiseStatementRow[] = [];

  for (const ev of events) {
    const delta = isPaymentMethodFiltered ? ev.credit : ev.debit - ev.credit;
    if (cleanFrom && ev.date && ev.date < cleanFrom) {
      openingBalance = round2(openingBalance + delta);
      running = openingBalance;
      continue;
    }
    if (cleanTo && ev.date && ev.date > cleanTo) {
      continue;
    }
    running = round2(running + delta);
    periodDebit = round2(periodDebit + ev.debit);
    periodCredit = round2(periodCredit + ev.credit);
    rows.push({
      id: ev.id,
      date: ev.date,
      entryType: ev.entryType,
      particulars: ev.particulars,
      reference: ev.reference,
      debit: ev.debit,
      credit: ev.credit,
      runningBalance: running,
      note: ev.note,
    });
  }

  return {
    openingBalance,
    rows,
    periodDebit,
    periodCredit,
    closingBalance: running,
  };
}

/**
 * Prevents duplicate party payment entries by checking:
 * 1) Same party + non-empty normalized Reference/UTR/Cheque No.
 * 2) Exact duplicate party + date + amount + payment mode + payment type.
 */
export function findDuplicatePartyPayment(
  existingPayments: Pick<
    PartyPayment,
    'id' | 'partyId' | 'paymentDate' | 'paymentType' | 'amount' | 'paymentMode' | 'referenceNo'
  >[],
  candidate: {
    partyId: string;
    paymentDate: string;
    paymentType: PartyPayment['paymentType'];
    amount: number;
    paymentMode: PartyPayment['paymentMode'];
    referenceNo: string;
  },
  excludeId?: string
): {
  reason: 'reference' | 'identical';
  existing: Pick<
    PartyPayment,
    'id' | 'partyId' | 'paymentDate' | 'paymentType' | 'amount' | 'paymentMode' | 'referenceNo'
  >;
} | null {
  const normRef = candidate.referenceNo.trim().toUpperCase().replace(/\s+/g, '');
  const normAmt = round2(candidate.amount);

  if (normRef.length > 0) {
    const byRef = existingPayments.find(
      (p) =>
        p.id !== excludeId &&
        p.partyId === candidate.partyId &&
        p.referenceNo.trim().toUpperCase().replace(/\s+/g, '') === normRef
    );
    if (byRef) {
      return { reason: 'reference', existing: byRef };
    }
  }

  const identical = existingPayments.find((p) => {
    if (
      p.id === excludeId ||
      p.partyId !== candidate.partyId ||
      p.paymentDate !== candidate.paymentDate ||
      round2(p.amount) !== normAmt ||
      p.paymentMode !== candidate.paymentMode ||
      p.paymentType !== candidate.paymentType
    ) {
      return false;
    }
    const existingRef = p.referenceNo.trim().toUpperCase().replace(/\s+/g, '');
    if (normRef.length > 0 && existingRef.length > 0 && normRef !== existingRef) {
      return false;
    }
    return true;
  });
  if (identical) {
    return { reason: 'identical', existing: identical };
  }

  return null;
}

export type CleanupCollectionName =
  | 'trips'
  | 'vehicles'
  | 'parties'
  | 'partyPayments'
  | 'drivers'
  | 'driverPayments'
  | 'maintenanceRecords'
  | 'bills';

export interface CleanupCandidateRecord {
  key: string; // collection:id
  collection: CleanupCollectionName;
  id: string;
  label: string;
  date: string;
  amount: number;
  classification: 'suspected-test' | 'regular-non-excel' | 'protected-excel';
  reason: string;
  isExcelLinked: boolean;
}

const TEST_DATA_PATTERN =
  /\b(test|testing|demo|sample|dummy|fake|temp|trial|asdf|qwerty|abc|xyz|smoke)\b|^test[-_\s]?/i;

function isTestText(text: string): boolean {
  if (!text) return false;
  return TEST_DATA_PATTERN.test(text);
}

/**
 * Scans current ERP records and classifies them so Admin can safely review exact records/counts,
 * keeping Excel-imported records strictly protected while surfacing unwanted/test records.
 */
export function classifyCleanupRecords(params: {
  vehicles: Vehicle[];
  parties: Party[];
  partyPayments?: PartyPayment[];
  trips: Trip[];
  drivers: Driver[];
  driverPayments: DriverPayment[];
  maintenanceRecords: MaintenanceRecord[];
  bills: Bill[];
  importedSheetRows: ImportedSheetRow[];
}): CleanupCandidateRecord[] {
  const excelMappedIds = new Set<string>();
  const excelVehicleRegs = new Set<string>();
  const excelPartyNames = new Set<string>();

  params.importedSheetRows.forEach((row) => {
    if (row.mappedRecordId) excelMappedIds.add(row.mappedRecordId);
    row.cells.forEach((cell) => {
      const h = cell.header.toLowerCase();
      if (cell.value && (h.includes('gadi') || h.includes('vehicle') || h.includes('truck'))) {
        const k = normalizeRegKey(cell.value);
        if (k) excelVehicleRegs.add(k);
      }
      if (cell.value && (h.includes('party') || h.includes('client') || h.includes('name'))) {
        const k = normalizeNameKey(cell.value);
        if (k) excelPartyNames.add(k);
      }
    });
  });

  const results: CleanupCandidateRecord[] = [];

  params.trips.forEach((t) => {
    const excelLinked =
      excelMappedIds.has(t.id) ||
      /^XLS-/i.test(t.lrNumber) ||
      /imported from sheet|excel/i.test(t.notes);
    const suspected =
      !excelLinked &&
      (isTestText(t.lrNumber) ||
        isTestText(t.partyName) ||
        isTestText(t.vehicleNumber) ||
        isTestText(t.origin) ||
        isTestText(t.destination) ||
        isTestText(t.notes));

    results.push({
      key: `trips:${t.id}`,
      collection: 'trips',
      id: t.id,
      label: `Trip LR ${t.lrNumber} · ${t.vehicleNumber} → ${t.partyName}`,
      date: t.tripDate,
      amount: t.freightAmount,
      classification: excelLinked
        ? 'protected-excel'
        : suspected
        ? 'suspected-test'
        : 'regular-non-excel',
      reason: excelLinked
        ? 'Linked to Excel workbook import'
        : suspected
        ? 'Matches test/demo keyword'
        : 'Manual ERP trip entry',
      isExcelLinked: excelLinked,
    });
  });

  const activeTripVehicleIds = new Set(params.trips.map((t) => t.vehicleId));
  params.vehicles.forEach((v) => {
    const excelLinked =
      excelMappedIds.has(v.id) ||
      excelVehicleRegs.has(normalizeRegKey(v.registrationNumber)) ||
      /imported from sheet|excel/i.test(v.notes);
    const suspected =
      !excelLinked &&
      (isTestText(v.registrationNumber) ||
        isTestText(v.driverName) ||
        isTestText(v.makeModel) ||
        isTestText(v.notes));

    results.push({
      key: `vehicles:${v.id}`,
      collection: 'vehicles',
      id: v.id,
      label: `Vehicle ${v.registrationNumber} (${v.vehicleType})`,
      date: '',
      amount: 0,
      classification: excelLinked
        ? 'protected-excel'
        : suspected
        ? 'suspected-test'
        : 'regular-non-excel',
      reason: excelLinked
        ? 'Linked to Excel workbook'
        : suspected
        ? 'Matches test/demo keyword'
        : activeTripVehicleIds.has(v.id)
        ? 'Active manual fleet vehicle (referenced by trips)'
        : 'Manual vehicle with 0 trips',
      isExcelLinked: excelLinked,
    });
  });

  const activeTripPartyIds = new Set(params.trips.map((t) => t.partyId));
  params.parties.forEach((p) => {
    const excelLinked =
      excelMappedIds.has(p.id) ||
      excelPartyNames.has(normalizeNameKey(p.partyName)) ||
      /imported from sheet|excel/i.test(p.notes);
    const suspected =
      !excelLinked &&
      (isTestText(p.partyName) ||
        isTestText(p.contactPerson) ||
        isTestText(p.notes));

    results.push({
      key: `parties:${p.id}`,
      collection: 'parties',
      id: p.id,
      label: `Party: ${p.partyName} (${p.partyType})`,
      date: '',
      amount: 0,
      classification: excelLinked
        ? 'protected-excel'
        : suspected
        ? 'suspected-test'
        : 'regular-non-excel',
      reason: excelLinked
        ? 'Linked to Excel workbook'
        : suspected
        ? 'Matches test/demo keyword'
        : activeTripPartyIds.has(p.id)
        ? 'Active manual party (referenced by trips)'
        : 'Manual party with 0 trips',
      isExcelLinked: excelLinked,
    });
  });

  params.drivers.forEach((d) => {
    const suspected = isTestText(d.driverName) || isTestText(d.notes);
    results.push({
      key: `drivers:${d.id}`,
      collection: 'drivers',
      id: d.id,
      label: `Driver: ${d.driverName}`,
      date: '',
      amount: d.monthlySalary,
      classification: suspected ? 'suspected-test' : 'regular-non-excel',
      reason: suspected ? 'Matches test/demo keyword' : 'Driver master record',
      isExcelLinked: false,
    });
  });

  params.driverPayments.forEach((dp) => {
    const suspected = isTestText(dp.driverName) || isTestText(dp.notes) || isTestText(dp.referenceNo);
    results.push({
      key: `driverPayments:${dp.id}`,
      collection: 'driverPayments',
      id: dp.id,
      label: `Driver Pay: ${dp.driverName} (${dp.paymentType})`,
      date: dp.paymentDate,
      amount: dp.amount,
      classification: suspected ? 'suspected-test' : 'regular-non-excel',
      reason: suspected ? 'Matches test/demo keyword' : 'Driver payment voucher',
      isExcelLinked: false,
    });
  });

  params.maintenanceRecords.forEach((m) => {
    const suspected = isTestText(m.description) || isTestText(m.vendorName) || isTestText(m.notes);
    results.push({
      key: `maintenanceRecords:${m.id}`,
      collection: 'maintenanceRecords',
      id: m.id,
      label: `Expense: ${m.vehicleNumber} · ${m.description}`,
      date: m.expenseDate,
      amount: m.amount,
      classification: suspected ? 'suspected-test' : 'regular-non-excel',
      reason: suspected ? 'Matches test/demo keyword' : 'Maintenance / Expense entry',
      isExcelLinked: false,
    });
  });

  params.bills.forEach((b) => {
    const suspected = isTestText(b.billNumber) || isTestText(b.partyName) || isTestText(b.notes);
    results.push({
      key: `bills:${b.id}`,
      collection: 'bills',
      id: b.id,
      label: `Bill ${b.billNumber} · ${b.partyName}`,
      date: b.billDate,
      amount: b.netPayable,
      classification: suspected ? 'suspected-test' : 'regular-non-excel',
      reason: suspected ? 'Matches test/demo keyword' : 'Generated freight bill',
      isExcelLinked: false,
    });
  });

  (params.partyPayments || []).forEach((pp) => {
    const suspected = isTestText(pp.partyName) || isTestText(pp.notes) || isTestText(pp.referenceNo);
    results.push({
      key: `partyPayments:${pp.id}`,
      collection: 'partyPayments',
      id: pp.id,
      label: `Party Pay: ${pp.partyName} (${pp.paymentType})`,
      date: pp.paymentDate,
      amount: pp.amount,
      classification: suspected ? 'suspected-test' : 'regular-non-excel',
      reason: suspected ? 'Matches test/demo keyword' : 'Party payment voucher',
      isExcelLinked: false,
    });
  });

  return results;
}

export type RestoreCollectionName =
  | 'vehicles'
  | 'parties'
  | 'partyPayments'
  | 'drivers'
  | 'trips'
  | 'driverPayments'
  | 'maintenanceRecords'
  | 'bills'
  | 'companySettings';

function asStr(val: unknown, fallback = ''): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return fallback;
}

function asNum(val: unknown, fallback = 0): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function pickEnum<T extends string>(val: unknown, allowed: readonly T[], fallback: T): T {
  return typeof val === 'string' && (allowed as readonly string[]).includes(val)
    ? (val as T)
    : fallback;
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Sanitizes and bounds a raw backup JSON record so it strictly matches
 * firestore.rules `hasAll` / `hasOnly` allowlists and blueprint constraints.
 * Returns null if the record lacks a valid ID or mandatory non-empty key fields.
 * Timestamps (`createdAt`/`updatedAt`) are intentionally omitted so the caller
 * attaches Firestore `serverTimestamp()` cleanly.
 */
export function sanitizeBackupRecordForRestore(
  collectionName: RestoreCollectionName,
  rawRow: Record<string, unknown>,
  ownerId: string
): Record<string, unknown> | null {
  if (!isPlainRecord(rawRow) || !BLUEPRINT_LIMITS.ID_PATTERN.test(ownerId)) {
    return null;
  }

  switch (collectionName) {
    case 'vehicles': {
      const reg = clampStr(
        asStr(rawRow.registrationNumber).toUpperCase(),
        BLUEPRINT_LIMITS.VEHICLE_REG_MAX
      );
      if (
        reg.length < BLUEPRINT_LIMITS.VEHICLE_REG_MIN ||
        !BLUEPRINT_LIMITS.REG_NO_PATTERN.test(reg)
      ) {
        return null;
      }
      return {
        registrationNumber: reg,
        vehicleType: pickEnum(rawRow.vehicleType, VEHICLE_TYPES, 'Truck'),
        makeModel: clampStr(asStr(rawRow.makeModel), BLUEPRINT_LIMITS.MAKE_MODEL_MAX),
        capacityTons: clampNum(asNum(rawRow.capacityTons, 0), 0, BLUEPRINT_LIMITS.CAPACITY_MAX),
        driverName: clampStr(asStr(rawRow.driverName), BLUEPRINT_LIMITS.DRIVER_NAME_MAX),
        driverPhone: clampStr(asStr(rawRow.driverPhone), BLUEPRINT_LIMITS.PHONE_MAX),
        fitnessExpiry: clampStr(asStr(rawRow.fitnessExpiry), BLUEPRINT_LIMITS.DATE_MAX),
        insuranceExpiry: clampStr(asStr(rawRow.insuranceExpiry), BLUEPRINT_LIMITS.DATE_MAX),
        permitExpiry: clampStr(asStr(rawRow.permitExpiry), BLUEPRINT_LIMITS.DATE_MAX),
        pucExpiry: clampStr(asStr(rawRow.pucExpiry), BLUEPRINT_LIMITS.DATE_MAX),
        taxExpiry: clampStr(asStr(rawRow.taxExpiry), BLUEPRINT_LIMITS.DATE_MAX),
        status: pickEnum(rawRow.status, VEHICLE_STATUSES, 'Available'),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'parties': {
      const partyName = clampStr(asStr(rawRow.partyName), BLUEPRINT_LIMITS.PARTY_NAME_MAX);
      if (partyName.length < BLUEPRINT_LIMITS.PARTY_NAME_MIN) return null;
      return {
        partyName,
        partyType: pickEnum(rawRow.partyType, PARTY_TYPES, 'Consignor'),
        contactPerson: clampStr(asStr(rawRow.contactPerson), BLUEPRINT_LIMITS.CONTACT_PERSON_MAX),
        phone: clampStr(asStr(rawRow.phone), BLUEPRINT_LIMITS.PHONE_MAX),
        email: clampStr(asStr(rawRow.email), BLUEPRINT_LIMITS.EMAIL_MAX),
        gstin: clampStr(asStr(rawRow.gstin).toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX),
        city: clampStr(asStr(rawRow.city), BLUEPRINT_LIMITS.CITY_MAX),
        state: clampStr(asStr(rawRow.state), BLUEPRINT_LIMITS.STATE_MAX),
        address: clampStr(asStr(rawRow.address), BLUEPRINT_LIMITS.ADDRESS_MAX),
        paymentTermsDays: clampNum(
          asNum(rawRow.paymentTermsDays, 15),
          0,
          BLUEPRINT_LIMITS.PAYMENT_TERMS_MAX
        ),
        status: pickEnum(rawRow.status, PARTY_STATUSES, 'Active'),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'partyPayments': {
      const partyId = clampStr(asStr(rawRow.partyId), 128);
      const partyName = clampStr(asStr(rawRow.partyName), BLUEPRINT_LIMITS.PARTY_NAME_MAX);
      const paymentDate = clampStr(asStr(rawRow.paymentDate), BLUEPRINT_LIMITS.DATE_MAX);
      const amount = clampNum(asNum(rawRow.amount, 0), 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
      if (
        !BLUEPRINT_LIMITS.ID_PATTERN.test(partyId) ||
        !partyName ||
        paymentDate.length < 4 ||
        amount <= 0
      ) {
        return null;
      }
      return {
        partyId,
        partyName,
        tripId: clampStr(asStr(rawRow.tripId), 128),
        tripLrNumber: clampStr(asStr(rawRow.tripLrNumber), BLUEPRINT_LIMITS.LR_NUMBER_MAX),
        paymentDate,
        paymentType: pickEnum(rawRow.paymentType, PARTY_PAYMENT_TYPES, 'Payment Received'),
        amount,
        paymentMode: pickEnum(rawRow.paymentMode, PAYMENT_MODES, 'Bank Transfer'),
        referenceNo: clampStr(asStr(rawRow.referenceNo), BLUEPRINT_LIMITS.REFERENCE_MAX),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'drivers': {
      const driverName = clampStr(asStr(rawRow.driverName), BLUEPRINT_LIMITS.DRIVER_NAME_MAX);
      if (driverName.length < 2) return null;
      return {
        driverName,
        phone: clampStr(asStr(rawRow.phone), BLUEPRINT_LIMITS.PHONE_MAX),
        licenseNumber: clampStr(asStr(rawRow.licenseNumber), BLUEPRINT_LIMITS.LICENSE_MAX),
        licenseExpiry: clampStr(asStr(rawRow.licenseExpiry), BLUEPRINT_LIMITS.DATE_MAX),
        assignedVehicleId: clampStr(asStr(rawRow.assignedVehicleId), 128),
        assignedVehicleNumber: clampStr(
          asStr(rawRow.assignedVehicleNumber).toUpperCase(),
          BLUEPRINT_LIMITS.VEHICLE_REG_MAX
        ),
        monthlySalary: clampNum(asNum(rawRow.monthlySalary, 0), 0, 10000000),
        openingBalance: clampNum(asNum(rawRow.openingBalance, 0), -10000000, 10000000),
        status: pickEnum(rawRow.status, DRIVER_STATUSES, 'Active'),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'trips': {
      const lrNumber = clampStr(asStr(rawRow.lrNumber), BLUEPRINT_LIMITS.LR_NUMBER_MAX);
      const tripDate = clampStr(asStr(rawRow.tripDate), BLUEPRINT_LIMITS.DATE_MAX);
      const vehicleId = clampStr(asStr(rawRow.vehicleId), 128);
      const vehicleNumber = clampStr(
        asStr(rawRow.vehicleNumber).toUpperCase(),
        BLUEPRINT_LIMITS.VEHICLE_REG_MAX
      );
      const partyId = clampStr(asStr(rawRow.partyId), 128);
      const partyName = clampStr(asStr(rawRow.partyName), BLUEPRINT_LIMITS.PARTY_NAME_MAX);
      const origin = clampStr(asStr(rawRow.origin), BLUEPRINT_LIMITS.LOCATION_MAX);
      const destination = clampStr(asStr(rawRow.destination), BLUEPRINT_LIMITS.LOCATION_MAX);

      if (
        !lrNumber ||
        tripDate.length < 4 ||
        !BLUEPRINT_LIMITS.ID_PATTERN.test(vehicleId) ||
        !vehicleNumber ||
        !BLUEPRINT_LIMITS.ID_PATTERN.test(partyId) ||
        !partyName ||
        !origin ||
        !destination
      ) {
        return null;
      }

      const freightAmount = clampNum(
        asNum(rawRow.freightAmount, 0),
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const advanceReceived = clampNum(
        asNum(rawRow.advanceReceived, 0),
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const dieselQuantity = clampNum(
        asNum(rawRow.dieselQuantity, 0),
        0,
        BLUEPRINT_LIMITS.DIESEL_QTY_MAX
      );
      const dieselRate = clampNum(
        asNum(rawRow.dieselRate, DEFAULT_DIESEL_RATE),
        0,
        BLUEPRINT_LIMITS.DIESEL_RATE_MAX
      );
      const dieselExpense = clampNum(
        asNum(rawRow.dieselExpense, 0),
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const tollExpense = clampNum(asNum(rawRow.tollExpense, 0), 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
      const driverAllowance = clampNum(
        asNum(rawRow.driverAllowance, 0),
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const otherExpense = clampNum(
        asNum(rawRow.otherExpense, 0),
        0,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const balanceAmount = clampNum(
        rawRow.balanceAmount !== undefined
          ? asNum(rawRow.balanceAmount, freightAmount - advanceReceived)
          : freightAmount - advanceReceived,
        -BLUEPRINT_LIMITS.CURRENCY_MAX,
        BLUEPRINT_LIMITS.CURRENCY_MAX
      );
      const totalExpense = clampNum(
        rawRow.totalExpense !== undefined
          ? asNum(rawRow.totalExpense, dieselExpense + tollExpense + driverAllowance + otherExpense)
          : dieselExpense + tollExpense + driverAllowance + otherExpense,
        0,
        400000000
      );

      return {
        srNo: clampStr(asStr(rawRow.srNo), BLUEPRINT_LIMITS.SR_NO_MAX),
        lrNumber,
        tripDate,
        vehicleId,
        vehicleNumber,
        partyId,
        partyName,
        driverName: clampStr(asStr(rawRow.driverName), BLUEPRINT_LIMITS.DRIVER_NAME_MAX),
        origin,
        destination,
        containerNo: clampStr(
          asStr(rawRow.containerNo).toUpperCase(),
          BLUEPRINT_LIMITS.CONTAINER_NO_MAX
        ),
        material: clampStr(asStr(rawRow.material), BLUEPRINT_LIMITS.MATERIAL_MAX),
        weightTons: clampNum(asNum(rawRow.weightTons, 0), 0, BLUEPRINT_LIMITS.WEIGHT_MAX),
        freightAmount,
        advanceReceived,
        dieselQuantity,
        dieselRate,
        dieselExpense,
        tollExpense,
        driverAllowance,
        otherExpense,
        balanceAmount,
        totalExpense,
        tripStatus: pickEnum(rawRow.tripStatus, TRIP_STATUSES, 'Delivered'),
        paymentStatus: pickEnum(
          rawRow.paymentStatus,
          PAYMENT_STATUSES,
          derivePaymentStatus(freightAmount, advanceReceived)
        ),
        podReceived: Boolean(rawRow.podReceived),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'driverPayments': {
      const driverId = clampStr(asStr(rawRow.driverId), 128);
      const driverName = clampStr(asStr(rawRow.driverName), BLUEPRINT_LIMITS.DRIVER_NAME_MAX);
      const paymentDate = clampStr(asStr(rawRow.paymentDate), BLUEPRINT_LIMITS.DATE_MAX);
      if (!BLUEPRINT_LIMITS.ID_PATTERN.test(driverId) || !driverName || paymentDate.length < 4) {
        return null;
      }
      return {
        driverId,
        driverName,
        vehicleId: clampStr(asStr(rawRow.vehicleId), 128),
        vehicleNumber: clampStr(
          asStr(rawRow.vehicleNumber).toUpperCase(),
          BLUEPRINT_LIMITS.VEHICLE_REG_MAX
        ),
        paymentDate,
        paymentType: pickEnum(rawRow.paymentType, DRIVER_PAYMENT_TYPES, 'Advance'),
        amount: clampNum(asNum(rawRow.amount, 0), 0, BLUEPRINT_LIMITS.CURRENCY_MAX),
        paymentMode: pickEnum(rawRow.paymentMode, PAYMENT_MODES, 'Cash'),
        referenceNo: clampStr(asStr(rawRow.referenceNo), BLUEPRINT_LIMITS.REFERENCE_MAX),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'maintenanceRecords': {
      const expenseDate = clampStr(asStr(rawRow.expenseDate), BLUEPRINT_LIMITS.DATE_MAX);
      const vehicleId = clampStr(asStr(rawRow.vehicleId), 128);
      const vehicleNumber = clampStr(
        asStr(rawRow.vehicleNumber).toUpperCase(),
        BLUEPRINT_LIMITS.VEHICLE_REG_MAX
      );
      const description = clampStr(asStr(rawRow.description), BLUEPRINT_LIMITS.DESCRIPTION_MAX);
      if (
        expenseDate.length < 4 ||
        !BLUEPRINT_LIMITS.ID_PATTERN.test(vehicleId) ||
        !vehicleNumber ||
        !description
      ) {
        return null;
      }
      return {
        expenseDate,
        vehicleId,
        vehicleNumber,
        category: pickEnum(rawRow.category, EXPENSE_CATEGORIES, 'Maintenance & Repair'),
        vendorName: clampStr(asStr(rawRow.vendorName), BLUEPRINT_LIMITS.VENDOR_MAX),
        description,
        dieselQuantity: clampNum(
          asNum(rawRow.dieselQuantity, 0),
          0,
          BLUEPRINT_LIMITS.DIESEL_QTY_MAX
        ),
        amount: clampNum(asNum(rawRow.amount, 0), 0, BLUEPRINT_LIMITS.CURRENCY_MAX),
        billNo: clampStr(asStr(rawRow.billNo), BLUEPRINT_LIMITS.BILL_NO_MAX),
        odometerKm: clampNum(asNum(rawRow.odometerKm, 0), 0, 10000000),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'bills': {
      const billNumber = clampStr(asStr(rawRow.billNumber), BLUEPRINT_LIMITS.BILL_NO_MAX);
      const billDate = clampStr(asStr(rawRow.billDate), BLUEPRINT_LIMITS.DATE_MAX);
      const partyId = clampStr(asStr(rawRow.partyId), 128);
      const partyName = clampStr(asStr(rawRow.partyName), BLUEPRINT_LIMITS.PARTY_NAME_MAX);
      const tripIds = Array.isArray(rawRow.tripIds)
        ? rawRow.tripIds.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 50)
        : [];
      const lineItems = Array.isArray(rawRow.lineItems)
        ? rawRow.lineItems.filter((item): item is Record<string, unknown> => isPlainRecord(item)).slice(0, 50)
        : [];

      if (
        !billNumber ||
        billDate.length < 4 ||
        !BLUEPRINT_LIMITS.ID_PATTERN.test(partyId) ||
        !partyName ||
        tripIds.length === 0 ||
        lineItems.length === 0
      ) {
        return null;
      }

      return {
        billNumber,
        billDate,
        partyId,
        partyName,
        partyGstin: clampStr(asStr(rawRow.partyGstin).toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX),
        partyAddress: clampStr(asStr(rawRow.partyAddress), BLUEPRINT_LIMITS.ADDRESS_MAX),
        tripIds,
        lineItems,
        freightTotal: clampNum(asNum(rawRow.freightTotal, 0), 0, 1000000000),
        expenseTotal: clampNum(asNum(rawRow.expenseTotal, 0), 0, 1000000000),
        advanceTotal: clampNum(asNum(rawRow.advanceTotal, 0), 0, 1000000000),
        netPayable: clampNum(asNum(rawRow.netPayable, 0), -1000000000, 1000000000),
        amountInWords: clampStr(asStr(rawRow.amountInWords), BLUEPRINT_LIMITS.WORDS_MAX),
        bankDetails: clampStr(asStr(rawRow.bankDetails), BLUEPRINT_LIMITS.NOTES_MAX),
        status: pickEnum(rawRow.status, BILL_STATUSES, 'Draft'),
        notes: clampStr(asStr(rawRow.notes), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }

    case 'companySettings': {
      const companyName = clampStr(
        asStr(rawRow.companyName, 'BAPASITARAM ENTERPRISE'),
        BLUEPRINT_LIMITS.PARTY_NAME_MAX
      );
      if (companyName.length < 2) return null;
      const rawLogo = asStr(rawRow.logoDataUrl).trim();
      const safeLogo =
        rawLogo === '' ||
        (rawLogo.length <= BLUEPRINT_LIMITS.LOGO_DATA_URL_MAX &&
          /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(rawLogo))
          ? rawLogo
          : '';
      return {
        companyName,
        address: clampStr(asStr(rawRow.address), BLUEPRINT_LIMITS.ADDRESS_MAX),
        gstin: clampStr(asStr(rawRow.gstin).toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX),
        pan: clampStr(asStr(rawRow.pan).toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX),
        phone: clampStr(asStr(rawRow.phone), 40),
        email: clampStr(asStr(rawRow.email), BLUEPRINT_LIMITS.EMAIL_MAX),
        bankName: clampStr(asStr(rawRow.bankName), BLUEPRINT_LIMITS.VENDOR_MAX),
        accountHolderName: clampStr(
          asStr(rawRow.accountHolderName, companyName),
          BLUEPRINT_LIMITS.PARTY_NAME_MAX
        ),
        accountNumber: clampStr(asStr(rawRow.accountNumber), 40),
        ifscCode: clampStr(asStr(rawRow.ifscCode).toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX),
        branchName: clampStr(asStr(rawRow.branchName), BLUEPRINT_LIMITS.VENDOR_MAX),
        billPrefix: clampStr(asStr(rawRow.billPrefix, 'BSE-'), 30),
        nextBillSeq: Math.max(1, Math.round(clampNum(asNum(rawRow.nextBillSeq, 1), 1, 1000000))),
        lrPrefix: clampStr(asStr(rawRow.lrPrefix, 'BSE-LR-'), BLUEPRINT_LIMITS.LR_PREFIX_MAX),
        nextLrSeq: Math.max(1, Math.round(clampNum(asNum(rawRow.nextLrSeq, 1), 1, 1000000))),
        logoDataUrl: safeLogo,
        defaultDieselRate: clampNum(
          asNum(rawRow.defaultDieselRate, DEFAULT_DIESEL_RATE),
          0,
          BLUEPRINT_LIMITS.DIESEL_RATE_MAX
        ),
        terms: clampStr(asStr(rawRow.terms), BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId,
      };
    }
  }
}

/**
 * Formats a Firestore/async write failure cleanly for inline UI display while
 * preserving structured context in console logs without crashing event handlers.
 */
export function extractReadableFirestoreError(
  error: unknown,
  actionLabel: string
): string {
  const rawMessage = error instanceof Error ? error.message : String(error || 'Unknown error');
  console.error(`[ERP Action Error] ${actionLabel}:`, error);

  if (/permission-denied|PERMISSION_DENIED/i.test(rawMessage)) {
    return `${actionLabel} failed: Permission denied by Firestore Security Rules. Verify your verified Google sign-in and account permissions.`;
  }
  if (/quota exceeded/i.test(rawMessage)) {
    return `${actionLabel} failed: Firestore daily free-tier quota exceeded. Please try again tomorrow.`;
  }
  if (/offline|network|unavailable/i.test(rawMessage)) {
    return `${actionLabel} could not reach the server right now (offline/network error). Check your connection and retry.`;
  }
  return `${actionLabel} failed: ${rawMessage}`;
}

