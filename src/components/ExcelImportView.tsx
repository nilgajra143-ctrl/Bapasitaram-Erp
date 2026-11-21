import React, { useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import {
  FileSpreadsheet,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Ban,
  Eye,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  FunctionSquare,
  Trash2,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type ErpMappableField,
  type ImportBatch,
  type ImportedSheetRow,
  type ImportTargetModule,
  type Party,
  type Trip,
  type UserPermissions,
  type Vehicle,
} from '../types/erp';
import {
  buildImportExecutionPlan,
  EXPECTED_WORKSHEETS,
  MAPPABLE_FIELD_OPTIONS,
  normalizeNameKey,
  normalizeRegKey,
  parseWorkbookFile,
  recomputeSheetRowMappings,
  type ParsedRowStatus,
  type ParsedWorksheet,
} from '../utils/excelImportParser';
import {
  clampStr,
  formatDateIN,
  formatINR,
  generateSafeDocId,
} from '../utils/formatters';
import { recordAuditLog } from '../utils/auditLogger';
import { ConfirmDialog } from './ConfirmDialog';

interface ExcelImportViewProps {
  userId: string;
  actorRole: 'admin' | 'employee';
  isSuperAdmin: boolean;
  permissions: UserPermissions;
  vehicles: Vehicle[];
  parties: Party[];
  trips: Trip[];
  importBatches: ImportBatch[];
  importedSheetRows: ImportedSheetRow[];
  loading: boolean;
}

type ImportTabMode = 'upload' | 'archive';

export const ExcelImportView: React.FC<ExcelImportViewProps> = ({
  userId,
  actorRole,
  isSuperAdmin,
  permissions,
  vehicles,
  parties,
  trips,
  importBatches,
  importedSheetRows,
  loading,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [tabMode, setTabMode] = useState<ImportTabMode>('upload');
  const [fileName, setFileName] = useState<string>('');
  const [parsedSheets, setParsedSheets] = useState<ParsedWorksheet[]>([]);
  const [activeSheetName, setActiveSheetName] = useState<string>('');
  const [rowStatusFilter, setRowStatusFilter] = useState<'all' | ParsedRowStatus>('all');
  const [showMappingPanel, setShowMappingPanel] = useState<boolean>(true);
  const [parseError, setParseError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // Archive view state
  const [archiveSheetFilter, setArchiveSheetFilter] = useState<string>('All');
  const [archiveBatchFilter, setArchiveBatchFilter] = useState<string>('All');
  const [archiveSearch, setArchiveSearch] = useState<string>('');
  const [deleteBatchTarget, setDeleteBatchTarget] = useState<ImportBatch | null>(null);
  const [deletingBatch, setDeletingBatch] = useState(false);

  const executionPlan = useMemo(() => {
    if (parsedSheets.length === 0) return null;
    return buildImportExecutionPlan(
      fileName,
      parsedSheets,
      vehicles,
      parties,
      trips,
      importedSheetRows
    );
  }, [fileName, parsedSheets, vehicles, parties, trips, importedSheetRows]);

  const activeSheet = useMemo(
    () => parsedSheets.find((s) => s.sheetName === activeSheetName) || parsedSheets[0] || null,
    [parsedSheets, activeSheetName]
  );

  const activeEvaluations = useMemo(() => {
    if (!executionPlan || !activeSheet) return [];
    const list = executionPlan.rowEvaluationsBySheet[activeSheet.sheetName] || [];
    if (rowStatusFilter === 'all') return list;
    return list.filter((item) => item.status === rowStatusFilter);
  }, [executionPlan, activeSheet, rowStatusFilter]);

  const expectedSheetsChecklist = useMemo(() => {
    const foundNorms = parsedSheets.map((s) => s.sheetName.trim().toLowerCase());
    return EXPECTED_WORKSHEETS.map((expected) => {
      const targetNorm = expected.toLowerCase();
      const matched = parsedSheets.find(
        (s) => s.sheetName.trim().toLowerCase() === targetNorm
      ) || parsedSheets.find((s) => s.sheetName.trim().toLowerCase().includes(targetNorm));
      return {
        expected,
        found: Boolean(matched),
        actualName: matched?.sheetName || '',
        exactMatch: foundNorms.includes(targetNorm),
      };
    });
  }, [parsedSheets]);

  const handleFileSelected = async (file: File | null) => {
    if (!file) return;
    setParseError(null);
    setImportSuccess(null);

    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!['xlsx', 'xls', 'xlsm', 'csv'].includes(ext)) {
      setParseError('Please upload a valid Excel workbook (.xlsx, .xls, .xlsm) or CSV file.');
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const sheets = parseWorkbookFile(buffer, vehicles);
      if (sheets.length === 0) {
        setParseError('No readable worksheets or data rows were found in the uploaded file.');
        return;
      }
      setFileName(file.name.slice(0, 160));
      setParsedSheets(sheets);
      setActiveSheetName(sheets[0].sheetName);
      setRowStatusFilter('all');
    } catch (err) {
      setParseError(
        err instanceof Error
          ? `Unable to parse Excel workbook: ${err.message}`
          : 'Unable to parse the uploaded workbook.'
      );
    }
  };

  const handleResetUpload = () => {
    setFileName('');
    setParsedSheets([]);
    setActiveSheetName('');
    setParseError(null);
    setImportSuccess(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const updateSheetConfig = (
    sheetName: string,
    updater: (sheet: ParsedWorksheet) => ParsedWorksheet
  ) => {
    setParsedSheets((prev) =>
      prev.map((s) => (s.sheetName === sheetName ? updater(s) : s))
    );
  };

  const handleColumnMappingChange = (
    sheetName: string,
    colIndex: number,
    newField: ErpMappableField
  ) => {
    updateSheetConfig(sheetName, (sheet) => {
      const updatedCols = sheet.columns.map((c) => {
        if (c.colIndex !== colIndex) return c;
        if (c.excludedKarja) return c; // Karja/Interest remains locked out
        return { ...c, mappedField: newField };
      });
      return recomputeSheetRowMappings({ ...sheet, columns: updatedCols });
    });
  };

  const handleExecuteConfirmedImport = async () => {
    if (!executionPlan) return;
    setImporting(true);
    setParseError(null);

    try {
      const batchSizeLimit = 400;

      // Build lookup maps of existing Vehicles & Parties (never overwrite existing!)
      const vehicleIdByKey = new Map<string, string>();
      vehicles.forEach((v) => {
        vehicleIdByKey.set(normalizeRegKey(v.registrationNumber), v.id);
      });

      const partyIdByKey = new Map<string, string>();
      parties.forEach((p) => {
        partyIdByKey.set(normalizeNameKey(p.partyName), p.id);
      });

      // Step 1: Create new Vehicles & Parties FIRST (required for Trip exists() rule)
      const masterOps: {
        type: 'vehicle' | 'party';
        id: string;
        data: Record<string, unknown>;
      }[] = [];

      for (const pv of executionPlan.vehiclesToCreate) {
        const key = normalizeRegKey(pv.registrationNumber);
        if (vehicleIdByKey.has(key)) continue;
        const newVehId = generateSafeDocId('veh');
        vehicleIdByKey.set(key, newVehId);
        masterOps.push({
          type: 'vehicle',
          id: newVehId,
          data: {
            registrationNumber: pv.registrationNumber,
            vehicleType: pv.vehicleType,
            makeModel: '',
            capacityTons: 0,
            driverName: pv.driverName,
            driverPhone: pv.driverPhone,
            fitnessExpiry: '',
            insuranceExpiry: '',
            permitExpiry: '',
            pucExpiry: '',
            taxExpiry: '',
            status: 'Available',
            notes: pv.notes,
            ownerId: userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }

      for (const pp of executionPlan.partiesToCreate) {
        const key = normalizeNameKey(pp.partyName);
        if (partyIdByKey.has(key)) continue;
        const newPartyId = generateSafeDocId('pty');
        partyIdByKey.set(key, newPartyId);
        masterOps.push({
          type: 'party',
          id: newPartyId,
          data: {
            partyName: pp.partyName,
            partyType: pp.partyType,
            contactPerson: '',
            phone: '',
            email: '',
            gstin: pp.gstin,
            city: '',
            state: '',
            address: '',
            paymentTermsDays: 15,
            status: 'Active',
            notes: pp.notes,
            ownerId: userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }

      for (let i = 0; i < masterOps.length; i += batchSizeLimit) {
        const chunk = masterOps.slice(i, i + batchSizeLimit);
        const batch = writeBatch(db);
        for (const op of chunk) {
          const ref = doc(
            collection(db, op.type === 'vehicle' ? 'vehicles' : 'parties'),
            op.id
          );
          batch.set(ref, op.data);
        }
        await batch.commit();
      }

      // Step 2: Create new Trips referencing committed Vehicle & Party IDs
      const tripIdByKey = new Map<string, string>();
      const tripOps: { id: string; data: Record<string, unknown> }[] = [];

      for (const pt of executionPlan.tripsToCreate) {
        const vKey = normalizeRegKey(pt.vehicleNumber);
        const pKey = normalizeNameKey(pt.partyName);
        const vehicleId =
          vehicleIdByKey.get(vKey) ||
          vehicles.find(
            (v) =>
              vKey.length >= 3 &&
              normalizeRegKey(v.registrationNumber).endsWith(vKey)
          )?.id ||
          '';
        const partyId = partyIdByKey.get(pKey) || '';

        if (!vehicleId || !partyId) {
          throw new Error(
            `Unable to resolve Vehicle (${pt.vehicleNumber}) or Party (${pt.partyName}) reference for trip ${pt.lrNumber}.`
          );
        }

        const newTripId = generateSafeDocId('trip');
        const lrDateKey = `${pt.lrNumber.toUpperCase()}|${pt.tripDate}|${vKey}`;
        tripIdByKey.set(lrDateKey, newTripId);

        tripOps.push({
          id: newTripId,
          data: {
            srNo: pt.srNo,
            lrNumber: pt.lrNumber,
            tripDate: pt.tripDate,
            vehicleId,
            vehicleNumber: pt.vehicleNumber,
            partyId,
            partyName: pt.partyName,
            driverName: pt.driverName,
            origin: pt.origin,
            destination: pt.destination,
            containerNo: pt.containerNo,
            material: pt.material,
            weightTons: pt.weightTons,
            freightAmount: pt.freightAmount,
            advanceReceived: pt.advanceReceived,
            dieselQuantity: pt.dieselQuantity,
            dieselExpense: pt.dieselExpense,
            tollExpense: pt.tollExpense,
            driverAllowance: pt.driverAllowance,
            otherExpense: pt.otherExpense,
            balanceAmount: pt.balanceAmount,
            totalExpense: pt.totalExpense,
            tripStatus: pt.tripStatus,
            paymentStatus: pt.paymentStatus,
            podReceived: pt.podReceived,
            notes: pt.notes,
            ownerId: userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }

      for (let i = 0; i < tripOps.length; i += batchSizeLimit) {
        const chunk = tripOps.slice(i, i + batchSizeLimit);
        const batch = writeBatch(db);
        for (const op of chunk) {
          batch.set(doc(collection(db, 'trips'), op.id), op.data);
        }
        await batch.commit();
      }

      // Step 3: Create ImportBatch document FIRST (required for ImportedSheetRow exists() rule)
      const batchId = generateSafeDocId('imp');
      const batchRef = doc(collection(db, 'importBatches'), batchId);
      const batchWrite = writeBatch(db);
      batchWrite.set(batchRef, {
        fileName: clampStr(executionPlan.fileName || 'workbook.xlsx', 160),
        sheetNames: executionPlan.sheetNames.slice(0, 20),
        vehiclesCreated: executionPlan.vehiclesToCreate.length,
        partiesCreated: executionPlan.partiesToCreate.length,
        tripsCreated: executionPlan.tripsToCreate.length,
        sheetRowsSaved: executionPlan.sheetRowsToSave.length,
        duplicatesSkipped: executionPlan.duplicatesSkipped.total,
        karjaExcludedCount: executionPlan.karjaExcludedCount,
        ownerId: userId,
        createdAt: serverTimestamp(),
      });
      await batchWrite.commit();

      // Step 4: Save preserved ImportedSheetRow records (original columns, formulas, dates, amounts, notes)
      const rowOps: { id: string; data: Record<string, unknown> }[] = [];
      for (const sr of executionPlan.sheetRowsToSave) {
        let mappedRecordId = '';
        if (sr.linkedTripKey && tripIdByKey.has(sr.linkedTripKey)) {
          mappedRecordId = tripIdByKey.get(sr.linkedTripKey) || '';
        } else if (sr.linkedVehicleReg) {
          mappedRecordId =
            vehicleIdByKey.get(normalizeRegKey(sr.linkedVehicleReg)) || '';
        } else if (sr.linkedPartyName) {
          mappedRecordId =
            partyIdByKey.get(normalizeNameKey(sr.linkedPartyName)) || '';
        }

        const safeCols = sr.columnsOrder.slice(0, 40);
        const safeCells = sr.cells.slice(0, 40).map((c) => ({
          header: String(c.header || '').slice(0, 60),
          cellAddress: String(c.cellAddress || '').slice(0, 16),
          value: String(c.value || '').slice(0, 200),
          formula: String(c.formula || '').slice(0, 200),
          note: String(c.note || '').slice(0, 200),
          dataType: c.dataType,
        }));

        if (safeCols.length === 0 || safeCells.length === 0) continue;

        rowOps.push({
          id: generateSafeDocId('srow'),
          data: {
            batchId,
            sheetName: clampStr(sr.sheetName, 80),
            rowIndex: sr.rowIndex,
            targetModule: sr.targetModule,
            mappedRecordId: clampStr(mappedRecordId, 128),
            rowSignature: clampStr(sr.rowSignature, 200),
            originalDate: clampStr(sr.originalDate, 30),
            primaryAmount: sr.primaryAmount,
            notes: clampStr(sr.notes, BLUEPRINT_LIMITS.NOTES_MAX),
            columnsOrder: safeCols,
            cells: safeCells,
            ownerId: userId,
            createdAt: serverTimestamp(),
          },
        });
      }

      for (let i = 0; i < rowOps.length; i += batchSizeLimit) {
        const chunk = rowOps.slice(i, i + batchSizeLimit);
        const batch = writeBatch(db);
        for (const op of chunk) {
          batch.set(doc(collection(db, 'importedSheetRows'), op.id), op.data);
        }
        await batch.commit();
      }

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'IMPORT',
        module: 'ExcelImport',
        recordId: batchId,
        summary: `Imported ${executionPlan.fileName}: +${executionPlan.vehiclesToCreate.length} vehicles, +${executionPlan.partiesToCreate.length} parties, +${executionPlan.tripsToCreate.length} trips, ${rowOps.length} preserved rows.`,
      });

      setConfirmOpen(false);
      setImportSuccess(
        `Import confirmed: ${executionPlan.vehiclesToCreate.length} vehicles, ${executionPlan.partiesToCreate.length} parties, ${executionPlan.tripsToCreate.length} trips, and ${rowOps.length} preserved worksheet rows saved. ${executionPlan.duplicatesSkipped.total} duplicate items were skipped without overwriting.`
      );
      setParsedSheets([]);
      setFileName('');
      setActiveSheetName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'excel-import');
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteBatchArchive = async () => {
    if (!deleteBatchTarget) return;
    setDeletingBatch(true);
    try {
      const rowsToDelete = importedSheetRows.filter(
        (r) => r.batchId === deleteBatchTarget.id
      );
      const batchLimit = 400;
      for (let i = 0; i < rowsToDelete.length; i += batchLimit) {
        const chunk = rowsToDelete.slice(i, i + batchLimit);
        const b = writeBatch(db);
        chunk.forEach((r) => b.delete(doc(db, 'importedSheetRows', r.id)));
        await b.commit();
      }
      const bBatch = writeBatch(db);
      bBatch.delete(doc(db, 'importBatches', deleteBatchTarget.id));
      await bBatch.commit();
      setDeleteBatchTarget(null);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `importBatches/${deleteBatchTarget.id}`
      );
    } finally {
      setDeletingBatch(false);
    }
  };

  // Filtered archive rows
  const archiveSheetNames = useMemo(() => {
    const names = new Set<string>();
    importedSheetRows.forEach((r) => names.add(r.sheetName));
    return ['All', ...Array.from(names)];
  }, [importedSheetRows]);

  const filteredArchiveRows = useMemo(() => {
    const q = archiveSearch.trim().toLowerCase();
    return importedSheetRows
      .filter((r) => {
        if (archiveSheetFilter !== 'All' && r.sheetName !== archiveSheetFilter) {
          return false;
        }
        if (archiveBatchFilter !== 'All' && r.batchId !== archiveBatchFilter) {
          return false;
        }
        if (!q) return true;
        return (
          r.sheetName.toLowerCase().includes(q) ||
          r.originalDate.toLowerCase().includes(q) ||
          r.notes.toLowerCase().includes(q) ||
          r.cells.some(
            (c) =>
              c.value.toLowerCase().includes(q) ||
              c.formula.toLowerCase().includes(q) ||
              c.note.toLowerCase().includes(q)
          )
        );
      })
      .sort((a, b) => a.rowIndex - b.rowIndex);
  }, [importedSheetRows, archiveSheetFilter, archiveBatchFilter, archiveSearch]);

  const totalNewCreates = executionPlan
    ? executionPlan.vehiclesToCreate.length +
      executionPlan.partiesToCreate.length +
      executionPlan.tripsToCreate.length +
      executionPlan.sheetRowsToSave.length
    : 0;

  return (
    <div className="space-y-6">
      {/* Top Mode Switcher */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Excel Workbook Import &amp; Preserved Ledger
          </h2>
          <p className="mt-1 text-xs sm:text-sm text-slate-600">
            Import <span className="font-medium text-slate-800">Gadi Master Hisab</span>,{' '}
            <span className="font-medium text-slate-800">Total Hisab</span>,{' '}
            <span className="font-medium text-slate-800">4312</span>, and{' '}
            <span className="font-medium text-slate-800">6552</span> with preview, duplicate protection, and Karja/Interest exclusion.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto shrink-0">
          <button
            type="button"
            onClick={() => setTabMode('upload')}
            className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              tabMode === 'upload'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Import Workbook
          </button>
          <button
            type="button"
            onClick={() => setTabMode('archive')}
            className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              tabMode === 'archive'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Preserved Ledger ({importedSheetRows.length})
          </button>
        </div>
      </div>

      {tabMode === 'upload' ? (
        <div className="space-y-6">
          {importSuccess && (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-start gap-2.5 text-sm text-emerald-900">
                <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                <span>{importSuccess}</span>
              </div>
              <button
                type="button"
                onClick={() => setTabMode('archive')}
                className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 underline whitespace-nowrap cursor-pointer self-start sm:self-auto"
              >
                Inspect Preserved Ledger →
              </button>
            </div>
          )}

          {parseError && (
            <div role="alert" className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-sm text-red-800">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <span>{parseError}</span>
            </div>
          )}

          {/* Upload Dropzone when no file loaded */}
          {parsedSheets.length === 0 ? (
            <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-10">
              <div className="max-w-2xl mx-auto text-center space-y-5">
                <div className="w-12 h-12 rounded-xl bg-slate-100 text-slate-800 flex items-center justify-center mx-auto">
                  <FileSpreadsheet className="w-6 h-6" />
                </div>

                <div>
                  <h3 className="font-display text-lg font-semibold text-slate-900">
                    Select Your Transport Hisab Excel Workbook
                  </h3>
                  <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                    Nothing is written to Firestore on upload. You will review all four worksheets, column mappings, formulas, dates, INR amounts, notes, and duplicate checks before confirming.
                  </p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-left">
                  {EXPECTED_WORKSHEETS.map((ws) => (
                    <div
                      key={ws}
                      className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      <div className="text-[11px] text-slate-500">Worksheet</div>
                      <div className="text-xs font-semibold text-slate-900 truncate mt-0.5">
                        {ws}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="pt-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.xlsm,.csv"
                    onChange={(e) => handleFileSelected(e.target.files?.[0] || null)}
                    className="hidden"
                    id="excel-workbook-input"
                  />
                  <label
                    htmlFor="excel-workbook-input"
                    className="inline-flex items-center gap-2.5 px-5 py-3 min-h-[44px] bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Choose Excel Workbook (.xlsx / .xls)</span>
                  </label>
                </div>

                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-slate-500">
                  <span>Preserves Original Formulas &amp; Notes</span>
                  <span aria-hidden="true">·</span>
                  <span>Excludes Karja &amp; Interest Automatically</span>
                  <span aria-hidden="true">·</span>
                  <span>Never Overwrites Existing Data</span>
                </div>
              </div>
            </section>
          ) : (
            /* Preview & Mapping Stage */
            executionPlan && activeSheet && (
              <div className="space-y-5">
                {/* Preview Action Bar + Worksheet Presence Check */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
                  <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-medium text-amber-700">
                        <Eye className="w-4 h-4 shrink-0" />
                        <span>Preview Mode — No data imported until Admin confirms</span>
                      </div>
                      <h3 className="mt-1 font-display text-base sm:text-lg font-semibold text-slate-900 break-all">
                        {fileName}
                      </h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        onClick={handleResetUpload}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span>Change File</span>
                      </button>

                      {permissions.canImportExcel && (
                        <button
                          type="button"
                          disabled={totalNewCreates === 0 || importing}
                          onClick={() => setConfirmOpen(true)}
                          className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          <span>Review &amp; Confirm Import</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 4 Expected Worksheets Status */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-slate-100">
                    {expectedSheetsChecklist.map((item) => (
                      <div
                        key={item.expected}
                        className={`px-3 py-2 rounded-lg border text-xs flex items-center justify-between gap-2 ${
                          item.found
                            ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                            : 'bg-amber-50/60 border-amber-200 text-amber-900'
                        }`}
                      >
                        <span className="font-medium truncate">{item.expected}</span>
                        <span className="text-[11px] shrink-0">
                          {item.found ? 'Detected' : 'Missing'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Dry-Run KPI Summary Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">New Vehicles</div>
                    <div className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums">
                      {executionPlan.vehiclesToCreate.length}
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">New Parties</div>
                    <div className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums">
                      {executionPlan.partiesToCreate.length}
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">New Trips</div>
                    <div className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums">
                      {executionPlan.tripsToCreate.length}
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">Duplicates Skipped</div>
                    <div className="mt-1 font-mono text-xl font-semibold text-amber-700 tabular-nums">
                      {executionPlan.duplicatesSkipped.total}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Existing data protected
                    </div>
                  </div>
                  <div className="col-span-2 lg:col-span-1 bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">Karja / Interest Excluded</div>
                    <div className="mt-1 font-mono text-xl font-semibold text-red-600 tabular-nums">
                      {executionPlan.karjaExcludedCount}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Preserved rows: {executionPlan.sheetRowsToSave.length}
                    </div>
                  </div>
                </div>

                {/* Worksheet Tabs */}
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5 overflow-x-auto">
                      {parsedSheets.map((s) => (
                        <button
                          key={s.sheetName}
                          type="button"
                          onClick={() => setActiveSheetName(s.sheetName)}
                          className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            activeSheet.sheetName === s.sheetName
                              ? 'bg-slate-900 text-white'
                              : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {s.sheetName} ({s.rawRows.length})
                        </button>
                      ))}
                    </div>

                    <div className="text-xs text-slate-500 tabular-nums">
                      {activeSheet.formulaCount} formulas · {activeSheet.noteCount} cell notes
                    </div>
                  </div>

                  {/* Sheet Target Module & Default Context Controls */}
                  <div className="p-4 sm:p-5 border-b border-slate-200 bg-white space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">
                          Target ERP Module for &ldquo;{activeSheet.sheetName}&rdquo;
                        </label>
                        <select
                          value={activeSheet.targetModule}
                          onChange={(e) =>
                            updateSheetConfig(activeSheet.sheetName, (sheet) => ({
                              ...sheet,
                              targetModule: e.target.value as ImportTargetModule,
                            }))
                          }
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                        >
                          <option value="trips">Trips Ledger (+ Auto-Link Vehicle &amp; Party)</option>
                          <option value="vehicles">Vehicles Master &amp; Hisab Summary</option>
                          <option value="parties">Parties Directory &amp; Total Hisab</option>
                          <option value="ledger-summary">Preserved Workbook Ledger Only</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">
                          Default Vehicle Reg. (if sheet omits Vehicle column)
                        </label>
                        <input
                          type="text"
                          maxLength={BLUEPRINT_LIMITS.VEHICLE_REG_MAX}
                          value={activeSheet.defaultVehicleNumber}
                          onChange={(e) =>
                            updateSheetConfig(activeSheet.sheetName, (sheet) => ({
                              ...sheet,
                              defaultVehicleNumber: e.target.value.toUpperCase(),
                            }))
                          }
                          placeholder="e.g. GJ-03-BW-4312 or 4312"
                          className="w-full px-3 py-2 text-sm font-mono uppercase bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">
                          Default Party Account (if sheet omits Party column)
                        </label>
                        <input
                          type="text"
                          maxLength={BLUEPRINT_LIMITS.PARTY_NAME_MAX}
                          value={activeSheet.defaultPartyName}
                          onChange={(e) =>
                            updateSheetConfig(activeSheet.sheetName, (sheet) => ({
                              ...sheet,
                              defaultPartyName: e.target.value,
                            }))
                          }
                          placeholder="General Transport Account"
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                        />
                      </div>
                    </div>

                    {/* Toggle Column Field Mapping Matrix */}
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => setShowMappingPanel((v) => !v)}
                        className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 hover:text-slate-900 cursor-pointer"
                      >
                        {showMappingPanel ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                        <span>
                          Column-to-ERP Field Mapping ({activeSheet.columns.length} columns detected)
                        </span>
                      </button>

                      {showMappingPanel && (
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                          {activeSheet.columns.map((col) => (
                            <div
                              key={col.colIndex}
                              className={`p-2.5 rounded-lg border flex flex-col gap-1.5 ${
                                col.excludedKarja
                                  ? 'bg-red-50/70 border-red-200'
                                  : 'bg-slate-50 border-slate-200'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="font-medium text-slate-900 truncate">
                                  {col.header}
                                </span>
                                {col.excludedKarja && (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 shrink-0">
                                    <Ban className="w-3 h-3" />
                                    <span>Excluded</span>
                                  </span>
                                )}
                              </div>
                              <select
                                disabled={col.excludedKarja}
                                value={col.mappedField}
                                onChange={(e) =>
                                  handleColumnMappingChange(
                                    activeSheet.sheetName,
                                    col.colIndex,
                                    e.target.value as ErpMappableField
                                  )
                                }
                                className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-slate-900 disabled:bg-red-50 disabled:text-red-700"
                              >
                                {MAPPABLE_FIELD_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Row Status Filter Bar */}
                  <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg overflow-x-auto">
                      {(
                        [
                          { id: 'all', label: 'All Rows' },
                          { id: 'new', label: 'New' },
                          { id: 'duplicate', label: 'Duplicates (Skip)' },
                          { id: 'summary', label: 'Summary / Formulas' },
                          { id: 'excluded_karja', label: 'Excluded (Karja/Int)' },
                        ] as const
                      ).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setRowStatusFilter(tab.id)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            rowStatusFilter === tab.id
                              ? 'bg-white text-slate-900 shadow-sm'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    <div className="text-xs text-slate-500 tabular-nums">
                      Showing {activeEvaluations.length} rows
                    </div>
                  </div>

                  {/* Preview Table Preserving Original Columns, Formulas, Dates, Amounts & Notes */}
                  {activeEvaluations.length === 0 ? (
                    <div className="p-8 text-center text-sm text-slate-500">
                      No rows match the selected row status filter in &ldquo;{activeSheet.sheetName}&rdquo;.
                    </div>
                  ) : (
                    <div className="overflow-x-auto max-h-[540px]">
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 z-10 bg-slate-100 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                          <tr>
                            <th className="py-2.5 px-3 whitespace-nowrap">Row</th>
                            <th className="py-2.5 px-3 whitespace-nowrap">Import Action</th>
                            <th className="py-2.5 px-3 whitespace-nowrap">Mapped Summary</th>
                            {activeSheet.columns
                              .filter((c) => !c.excludedKarja)
                              .map((col) => (
                                <th key={col.colIndex} className="py-2.5 px-3 whitespace-nowrap">
                                  <div>{col.header}</div>
                                  <div className="text-[10px] font-normal text-slate-400">
                                    → {col.mappedField}
                                  </div>
                                </th>
                              ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-xs">
                          {activeEvaluations.map((ev) => (
                            <tr
                              key={ev.row.rowIndex}
                              className={
                                ev.status === 'duplicate'
                                  ? 'bg-amber-50/40'
                                  : ev.status === 'excluded_karja'
                                  ? 'bg-red-50/40 text-slate-400'
                                  : 'hover:bg-slate-50'
                              }
                            >
                              <td className="py-2.5 px-3 font-mono text-slate-500 whitespace-nowrap align-top">
                                #{ev.row.rowIndex}
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap align-top">
                                <div
                                  className={`font-semibold ${
                                    ev.status === 'new'
                                      ? 'text-emerald-700'
                                      : ev.status === 'duplicate'
                                      ? 'text-amber-700'
                                      : ev.status === 'excluded_karja'
                                      ? 'text-red-600'
                                      : 'text-slate-700'
                                  }`}
                                >
                                  {ev.status === 'new'
                                    ? 'New'
                                    : ev.status === 'duplicate'
                                    ? 'Duplicate · Skip'
                                    : ev.status === 'excluded_karja'
                                    ? 'Excluded'
                                    : 'Archive'}
                                </div>
                                <div className="text-[11px] text-slate-500 max-w-[200px] truncate" title={ev.statusReason}>
                                  {ev.statusReason}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap align-top">
                                <div className="font-mono text-slate-800">
                                  {ev.resolvedVehicle || '—'} · {ev.resolvedParty || '—'}
                                </div>
                                <div className="text-[11px] text-slate-500 tabular-nums">
                                  {ev.row.originalDate ? formatDateIN(ev.row.originalDate) : 'No date'} ·{' '}
                                  {formatINR(ev.row.primaryAmount)}
                                </div>
                              </td>
                              {ev.row.cells.map((cell, cIdx) => (
                                <td
                                  key={`${ev.row.rowIndex}-${cIdx}`}
                                  className="py-2.5 px-3 align-top max-w-[220px]"
                                >
                                  <div
                                    className={`${
                                      cell.dataType === 'number'
                                        ? 'font-mono tabular-nums text-slate-900'
                                        : 'text-slate-800'
                                    } break-words`}
                                  >
                                    {cell.value || <span className="text-slate-300">—</span>}
                                  </div>
                                  {cell.formula && (
                                    <div
                                      className="mt-0.5 inline-flex items-center gap-1 font-mono text-[10px] text-blue-700 break-all"
                                      title={`Excel Formula (${cell.cellAddress}): ${cell.formula}`}
                                    >
                                      <FunctionSquare className="w-3 h-3 shrink-0" />
                                      <span>{cell.formula}</span>
                                    </div>
                                  )}
                                  {cell.note && (
                                    <div
                                      className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-amber-800"
                                      title={`Cell Note: ${cell.note}`}
                                    >
                                      <MessageSquareText className="w-3 h-3 shrink-0" />
                                      <span className="truncate max-w-[180px]">{cell.note}</span>
                                    </div>
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      ) : (
        /* Preserved Workbook Archive Tab */
        <div className="space-y-5">
          {/* Import Batches History */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Confirmed Excel Import History
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Audit log of confirmed workbook imports and preserved worksheet rows
                </p>
              </div>
            </div>

            {loading ? (
              <div className="p-6 space-y-3">
                {[1, 2].map((i) => (
                  <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : importBatches.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No Excel workbooks have been imported yet. Use the &ldquo;Import Workbook&rdquo; tab to preview and confirm an import.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {importBatches.map((b) => (
                  <div
                    key={b.id}
                    className="p-4 sm:px-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {b.fileName}
                      </div>
                      <div className="mt-1 text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>Sheets: {b.sheetNames.join(', ')}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          +{b.vehiclesCreated} Vehicles · +{b.partiesCreated} Parties · +{b.tripsCreated} Trips
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {b.sheetRowsSaved} rows archived · {b.duplicatesSkipped} duplicates skipped · {b.karjaExcludedCount} Karja/Int excluded
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setArchiveBatchFilter(
                            archiveBatchFilter === b.id ? 'All' : b.id
                          )
                        }
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer ${
                          archiveBatchFilter === b.id
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {archiveBatchFilter === b.id ? 'Showing Batch' : 'Filter Rows'}
                      </button>
                      {isSuperAdmin && permissions.canDeleteRecords && (
                        <button
                          type="button"
                          onClick={() => setDeleteBatchTarget(b)}
                          aria-label={`Delete archived batch ${b.fileName}`}
                          title="Admin only: remove archive metadata (keeps Vehicles, Parties, and Trips safe)"
                          className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Preserved Worksheet Rows Table */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                {archiveSheetNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setArchiveSheetFilter(name)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      archiveSheetFilter === name
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>

              <input
                type="text"
                value={archiveSearch}
                onChange={(e) => setArchiveSearch(e.target.value)}
                placeholder="Search values, formulas, dates, notes..."
                className="w-full sm:w-72 px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
              />
            </div>

            {filteredArchiveRows.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                No preserved worksheet rows match your current filter.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10 bg-slate-100 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                    <tr>
                      <th className="py-2.5 px-3 whitespace-nowrap">Worksheet &amp; Row</th>
                      <th className="py-2.5 px-3 whitespace-nowrap">Date / Primary INR</th>
                      <th className="py-2.5 px-3 whitespace-nowrap">Original Columns, Formulas &amp; Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredArchiveRows.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50">
                        <td className="py-3 px-3 whitespace-nowrap align-top">
                          <div className="font-semibold text-slate-900">{row.sheetName}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            Row #{row.rowIndex} · {row.targetModule}
                          </div>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap align-top">
                          <div className="font-mono text-slate-800 tabular-nums">
                            {row.originalDate ? formatDateIN(row.originalDate) : '—'}
                          </div>
                          <div className="font-mono font-semibold text-slate-900 tabular-nums">
                            {formatINR(row.primaryAmount)}
                          </div>
                          {row.notes && (
                            <div className="text-[11px] text-slate-500 max-w-[200px] truncate mt-0.5" title={row.notes}>
                              {row.notes}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 align-top">
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {row.cells.map((cell, idx) => (
                              <div
                                key={`${row.id}-${idx}`}
                                className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md"
                              >
                                <div className="text-[10px] font-medium text-slate-500 flex items-center justify-between gap-2">
                                  <span className="truncate">{cell.header}</span>
                                  <span className="font-mono text-slate-400">{cell.cellAddress}</span>
                                </div>
                                <div className="text-xs font-medium text-slate-900 mt-0.5 break-words">
                                  {cell.value || '—'}
                                </div>
                                {cell.formula && (
                                  <div className="text-[10px] font-mono text-blue-700 mt-0.5 break-all">
                                    fx {cell.formula}
                                  </div>
                                )}
                                {cell.note && (
                                  <div className="text-[10px] text-amber-800 mt-0.5 break-words">
                                    Note: {cell.note}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Explicit Admin Confirmation Dialog (Nothing imported until confirmed!) */}
      <ConfirmDialog
        open={confirmOpen}
        title="Confirm Excel Workbook Import"
        description={
          executionPlan
            ? `Proceed to import ${executionPlan.vehiclesToCreate.length} new vehicles, ${executionPlan.partiesToCreate.length} new parties, ${executionPlan.tripsToCreate.length} new trips, and ${executionPlan.sheetRowsToSave.length} preserved worksheet rows? ${executionPlan.duplicatesSkipped.total} duplicate records will be skipped without overwriting existing data, and ${executionPlan.karjaExcludedCount} Karja/Interest items are excluded.`
            : ''
        }
        confirmLabel="Confirm Import"
        busy={importing}
        onConfirm={handleExecuteConfirmedImport}
        onCancel={() => setConfirmOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(deleteBatchTarget)}
        title="Delete Archived Import Batch"
        description={`Remove archived worksheet rows for "${deleteBatchTarget?.fileName || ''}"? Core Vehicles, Parties, and Trips already in the ERP will not be deleted.`}
        confirmLabel="Delete Archive"
        destructive
        busy={deletingBatch}
        onConfirm={handleDeleteBatchArchive}
        onCancel={() => setDeleteBatchTarget(null)}
      />
    </div>
  );
};
