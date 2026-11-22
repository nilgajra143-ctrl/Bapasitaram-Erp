import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  ReceiptText,
  Printer,
  Download,
  Plus,
  Building2,
  Trash2,
  Eye,
  X,
  Info,
  CheckCircle2,
  FileText,
  MessageCircle,
  Truck,
  Upload,
  Scissors,
  LayoutTemplate,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BILL_STATUSES,
  BLUEPRINT_LIMITS,
  DEFAULT_DIESEL_RATE,
  type Bill,
  type BillFormatType,
  type BillLineItem,
  type BillStatus,
  type CompanySettings,
  type ErpUserRole,
  type Party,
  type Trip,
  type UserPermissions,
} from '../types/erp';
import {
  clampNum,
  clampStr,
  formatDateIN,
  formatINR,
  generateSafeDocId,
  getTodayISO,
  rupeesInWords,
} from '../utils/formatters';
import {
  renderElementToA4Pdf,
  triggerPrintPreview,
  type RenderedA4PdfResult,
} from '../utils/pdfExport';
import { normalizeNameKey } from '../utils/erpHelpers';
import {
  buildBillShareWhatsAppMessage,
  createPdfFileFromJsPdf,
} from '../utils/whatsappShare';
import {
  BILL_HEADER_LEFT_TRUCK_REG,
  BILL_HEADER_RIGHT_TRUCK_REG,
  cropDualTruckPhotoInBrowser,
  isValidBillHeaderTruckDataUrl,
  prepareSingleTruckPhotoFromFile,
} from '../utils/billHeaderHelpers';
import { recordAuditLog } from '../utils/auditLogger';
import { BillFormatBDocument } from './BillFormatBDocument';
import { ConfirmDialog } from './ConfirmDialog';
import { PdfPreviewModal } from './PdfPreviewModal';
import {
  WhatsAppShareModal,
  type WhatsAppPdfAttachment,
} from './WhatsAppShareModal';

interface BillingViewProps {
  userId: string;
  actorRole: ErpUserRole;
  permissions: UserPermissions;
  parties: Party[];
  trips: Trip[];
  bills: Bill[];
  companySettings: CompanySettings | null;
  preselectedPartyId: string | null;
  onClearPreselectedParty: () => void;
  loading: boolean;
}

export const BillingView: React.FC<BillingViewProps> = ({
  userId,
  actorRole,
  permissions,
  parties,
  trips,
  bills,
  companySettings,
  preselectedPartyId,
  onClearPreselectedParty,
  loading,
}) => {
  const [activeTab, setActiveTab] = useState<'bills' | 'settings'>('bills');

  // Bill generator drawer
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedPartyId, setSelectedPartyId] = useState<string>('');
  const [selectedTripIds, setSelectedTripIds] = useState<string[]>([]);
  const [billNumber, setBillNumber] = useState<string>('');
  const [billDate, setBillDate] = useState<string>(getTodayISO());
  const [billNotes, setBillNotes] = useState<string>('');
  const [billError, setBillError] = useState<string | null>(null);
  const [savingBill, setSavingBill] = useState(false);

  // Printable Preview Modal
  const [previewBill, setPreviewBill] = useState<Bill | null>(null);
  const [billFormat, setBillFormat] = useState<BillFormatType>('format-b');
  const [deleteTarget, setDeleteTarget] = useState<Bill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const billPrintRef = useRef<HTMLDivElement | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [renderedPdfPreview, setRenderedPdfPreview] = useState<RenderedA4PdfResult | null>(null);
  const [generatedBillPdf, setGeneratedBillPdf] = useState<{
    billId: string;
    format: BillFormatType;
    rendered: RenderedA4PdfResult;
  } | null>(null);
  const [whatsAppBillShare, setWhatsAppBillShare] = useState<{
    partyName: string;
    partyPhone: string;
    message: string;
    attachment: WhatsAppPdfAttachment;
  } | null>(null);

  // Admin Format B Header — Dual-Truck Real Photo Cropper (GJ12 BV6552 & GJ12 CT4312)
  const [dualSourceDataUrl, setDualSourceDataUrl] = useState<string>('');
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [topTrimPercent, setTopTrimPercent] = useState<number>(2);
  const [bottomTrimPercent, setBottomTrimPercent] = useState<number>(2);
  const [draftLeftTruckDataUrl, setDraftLeftTruckDataUrl] = useState<string>(
    companySettings?.billHeaderLeftTruckDataUrl || ''
  );
  const [draftRightTruckDataUrl, setDraftRightTruckDataUrl] = useState<string>(
    companySettings?.billHeaderRightTruckDataUrl || ''
  );
  const [truckBusy, setTruckBusy] = useState(false);
  const [truckError, setTruckError] = useState<string | null>(null);
  const [truckSavedMsg, setTruckSavedMsg] = useState<string | null>(null);

  // Company & Bank Settings Form
  const [settingsForm, setSettingsForm] = useState({
    companyName: companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
    address: companySettings?.address || '',
    gstin: companySettings?.gstin || '',
    pan: companySettings?.pan || '',
    phone: companySettings?.phone || '',
    email: companySettings?.email || '',
    bankName: companySettings?.bankName || '',
    accountHolderName: companySettings?.accountHolderName || 'BAPASITARAM ENTERPRISE',
    accountNumber: companySettings?.accountNumber || '',
    ifscCode: companySettings?.ifscCode || '',
    branchName: companySettings?.branchName || '',
    billPrefix: companySettings?.billPrefix || 'BSE-',
    nextBillSeq: String(companySettings?.nextBillSeq || 1),
    defaultDieselRate: String(companySettings?.defaultDieselRate ?? DEFAULT_DIESEL_RATE),
    terms: companySettings?.terms || 'Payment due within credit terms. Subject to jurisdiction.',
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (companySettings) {
      setSettingsForm({
        companyName: companySettings.companyName,
        address: companySettings.address,
        gstin: companySettings.gstin,
        pan: companySettings.pan,
        phone: companySettings.phone,
        email: companySettings.email,
        bankName: companySettings.bankName,
        accountHolderName: companySettings.accountHolderName,
        accountNumber: companySettings.accountNumber,
        ifscCode: companySettings.ifscCode,
        branchName: companySettings.branchName,
        billPrefix: companySettings.billPrefix,
        nextBillSeq: String(companySettings.nextBillSeq),
        defaultDieselRate: String(companySettings.defaultDieselRate ?? DEFAULT_DIESEL_RATE),
        terms: companySettings.terms,
      });
      setDraftLeftTruckDataUrl(companySettings.billHeaderLeftTruckDataUrl || '');
      setDraftRightTruckDataUrl(companySettings.billHeaderRightTruckDataUrl || '');
    }
  }, [companySettings]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('printing-modal-active', Boolean(previewBill));
    return () => {
      document.body.classList.remove('printing-modal-active');
    };
  }, [previewBill]);

  const resolvePartyForBill = (bill: Bill): Party | undefined => {
    const byId = parties.find((p) => p.id === bill.partyId);
    if (byId) return byId;
    const key = normalizeNameKey(bill.partyName);
    return key ? parties.find((p) => normalizeNameKey(p.partyName) === key) : undefined;
  };

  const openWhatsAppShareForBillPdf = (bill: Bill, rendered: RenderedA4PdfResult) => {
    const matchedParty = resolvePartyForBill(bill);
    const message = buildBillShareWhatsAppMessage({
      companyName: settingsForm.companyName || companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
      bill,
      pdfFileName: rendered.fileName,
    });
    setWhatsAppBillShare({
      partyName: matchedParty?.partyName || bill.partyName,
      partyPhone: matchedParty?.phone || '',
      message,
      attachment: {
        fileName: rendered.fileName,
        pageCount: rendered.pageCount,
        getFile: () => createPdfFileFromJsPdf(rendered.pdf, rendered.fileName),
        onDownloadPdf: () => rendered.pdf.save(rendered.fileName),
      },
    });
  };

  const buildBillPdfFileName = (bill: Bill, format: BillFormatType) => {
    const suffix = format === 'format-b' ? 'FormatB' : 'FormatA';
    return `Bill-${bill.billNumber}-${suffix}-${bill.partyName}.pdf`;
  };

  const handleSelectBillFormat = (nextFormat: BillFormatType) => {
    setBillFormat(nextFormat);
    setPdfError(null);
    setRenderedPdfPreview(null);
    setGeneratedBillPdf(null);
  };

  const handlePreviewBillPdf = async () => {
    if (!previewBill || !billPrintRef.current) return;
    setPdfError(null);
    setPdfBusy(true);
    try {
      const rendered = await renderElementToA4Pdf(
        billPrintRef.current,
        buildBillPdfFileName(previewBill, billFormat),
        'portrait'
      );
      setGeneratedBillPdf({ billId: previewBill.id, format: billFormat, rendered });
      setRenderedPdfPreview(rendered);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Unable to render A4 PDF preview.');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleDownloadBillPdf = async () => {
    if (!previewBill || !billPrintRef.current) return;
    setPdfError(null);
    setPdfBusy(true);
    try {
      const rendered = await renderElementToA4Pdf(
        billPrintRef.current,
        buildBillPdfFileName(previewBill, billFormat),
        'portrait'
      );
      rendered.pdf.save(rendered.fileName);
      setGeneratedBillPdf({ billId: previewBill.id, format: billFormat, rendered });
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Unable to generate PDF file.');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleShareGeneratedBillPdf = async () => {
    if (!previewBill || previewBill.id === '__sample_preview__') return;
    if (
      generatedBillPdf &&
      generatedBillPdf.billId === previewBill.id &&
      generatedBillPdf.format === billFormat
    ) {
      openWhatsAppShareForBillPdf(previewBill, generatedBillPdf.rendered);
      return;
    }
    if (!billPrintRef.current) return;
    setPdfError(null);
    setPdfBusy(true);
    try {
      const rendered = await renderElementToA4Pdf(
        billPrintRef.current,
        buildBillPdfFileName(previewBill, billFormat),
        'portrait'
      );
      setGeneratedBillPdf({ billId: previewBill.id, format: billFormat, rendered });
      openWhatsAppShareForBillPdf(previewBill, rendered);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Unable to prepare Bill PDF for WhatsApp.');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleOpenSampleFormatBBill = () => {
    setPdfError(null);
    setRenderedPdfPreview(null);
    setGeneratedBillPdf(null);
    setBillFormat('format-b');

    if (bills.length > 0) {
      const existing = bills[0];
      setPreviewBill({
        ...existing,
        id: '__sample_preview__',
      });
      return;
    }

    const sampleParty = parties[0];
    const sampleDate = getTodayISO();
    const sampleLineItems: BillLineItem[] = [
      {
        tripId: 'sample_trip_1',
        srNo: '1',
        tripDate: sampleDate,
        lrNumber: 'LR-SAMPLE-01',
        vehicleNumber: BILL_HEADER_LEFT_TRUCK_REG,
        containerNo: 'MSCU1234567',
        origin: 'Mundra Port',
        destination: 'Morbi',
        rate: 32000,
        kharcha: 0,
        dieselQuantity: 0,
        dieselAmount: 0,
        toll: 0,
        jama: 7000,
        hisab: 25000,
        note: '',
      },
      {
        tripId: 'sample_trip_2',
        srNo: '2',
        tripDate: sampleDate,
        lrNumber: 'LR-SAMPLE-02',
        vehicleNumber: BILL_HEADER_RIGHT_TRUCK_REG,
        containerNo: 'TCNU7654321',
        origin: 'Kandla',
        destination: 'Morbi',
        rate: 28000,
        kharcha: 0,
        dieselQuantity: 0,
        dieselAmount: 0,
        toll: 0,
        jama: 3000,
        hisab: 25000,
        note: '',
      },
    ];

    setPreviewBill({
      id: '__sample_preview__',
      billNumber: `${settingsForm.billPrefix || 'BSE-'}SAMPLE`,
      billDate: sampleDate,
      partyId: sampleParty?.id || '',
      partyName: sampleParty?.partyName || 'Sample Consignor Party',
      partyGstin: sampleParty?.gstin || '',
      partyAddress: sampleParty
        ? [sampleParty.address, sampleParty.city, sampleParty.state].filter(Boolean).join(', ')
        : '',
      tripIds: ['sample_trip_1', 'sample_trip_2'],
      lineItems: sampleLineItems,
      freightTotal: 60000,
      expenseTotal: 0,
      advanceTotal: 10000,
      netPayable: 50000,
      amountInWords: rupeesInWords(50000),
      bankDetails: '',
      status: 'Draft',
      notes: 'Non-persistent A4 Format B preview sample (not saved to records).',
      ownerId: userId,
      createdAt: null,
      updatedAt: null,
    });
  };

  const computeSuggestedBillNo = () => {
    const prefix = companySettings?.billPrefix || 'BSE-';
    const seq = companySettings?.nextBillSeq || bills.length + 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  };

  useEffect(() => {
    if (preselectedPartyId) {
      setSelectedPartyId(preselectedPartyId);
      setSelectedTripIds([]);
      setBillNumber(computeSuggestedBillNo());
      setBillDate(getTodayISO());
      setBillError(null);
      setActiveTab('bills');
      setCreateOpen(true);
      onClearPreselectedParty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectedPartyId]);

  const partyTrips = useMemo(() => {
    if (!selectedPartyId) return [];
    return trips.filter((t) => t.partyId === selectedPartyId && t.tripStatus !== 'Cancelled');
  }, [trips, selectedPartyId]);

  const tripToActiveBillsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    bills
      .filter((b) => b.status !== 'Cancelled')
      .forEach((b) => {
        b.tripIds.forEach((tId) => {
          const prev = map.get(tId) || [];
          if (!prev.includes(b.billNumber)) {
            prev.push(b.billNumber);
          }
          map.set(tId, prev);
        });
      });
    return map;
  }, [bills]);

  const draftTotals = useMemo(() => {
    const chosen = partyTrips.filter((t) => selectedTripIds.includes(t.id));
    const freightTotal = Math.round(chosen.reduce((s, t) => s + t.freightAmount, 0) * 100) / 100;
    const expenseTotal = Math.round(chosen.reduce((s, t) => s + t.totalExpense, 0) * 100) / 100;
    const advanceTotal = Math.round(chosen.reduce((s, t) => s + t.advanceReceived, 0) * 100) / 100;
    const netPayable = Math.round(chosen.reduce((s, t) => s + t.balanceAmount, 0) * 100) / 100;
    const hisabAdjustment = Math.round((netPayable - (freightTotal - advanceTotal)) * 100) / 100;
    return { chosen, freightTotal, expenseTotal, advanceTotal, netPayable, hisabAdjustment };
  }, [partyTrips, selectedTripIds]);

  const toggleTripSelection = (tripId: string) => {
    setSelectedTripIds((prev) =>
      prev.includes(tripId) ? prev.filter((id) => id !== tripId) : [...prev, tripId]
    );
  };

  const openNewBillDrawer = () => {
    setSelectedPartyId(parties[0]?.id || '');
    setSelectedTripIds([]);
    setBillNumber(computeSuggestedBillNo());
    setBillDate(getTodayISO());
    setBillNotes('');
    setBillError(null);
    setCreateOpen(true);
  };

  const handleSaveBill = async (e: React.FormEvent) => {
    e.preventDefault();
    setBillError(null);

    const party = parties.find((p) => p.id === selectedPartyId);
    if (!party) {
      setBillError('Please select a registered party.');
      return;
    }

    if (draftTotals.chosen.length === 0) {
      setBillError('Select at least one trip to include in this bill.');
      return;
    }

    if (draftTotals.chosen.length > 50) {
      setBillError('Maximum 50 trips per bill are supported.');
      return;
    }

    const cleanBillNo = clampStr(billNumber, BLUEPRINT_LIMITS.BILL_NO_MAX);
    if (!cleanBillNo) {
      setBillError('Bill number is required.');
      return;
    }

    if (
      bills.some(
        (b) =>
          b.status !== 'Cancelled' &&
          b.billNumber.trim().toLowerCase() === cleanBillNo.toLowerCase()
      )
    ) {
      setBillError(`Bill number "${cleanBillNo}" already exists on an active bill.`);
      return;
    }

    const lineItems: BillLineItem[] = draftTotals.chosen.map((t, idx) => ({
      tripId: t.id,
      srNo: t.srNo || String(idx + 1),
      tripDate: t.tripDate,
      lrNumber: t.lrNumber,
      vehicleNumber: t.vehicleNumber,
      containerNo: t.containerNo || '',
      origin: t.origin,
      destination: t.destination,
      rate: t.freightAmount,
      kharcha: t.otherExpense,
      dieselQuantity: t.dieselQuantity ?? 0,
      dieselAmount: t.dieselExpense,
      toll: t.tollExpense,
      jama: t.advanceReceived,
      hisab: t.balanceAmount,
      note: t.notes,
    }));

    const bankSnapshot = [
      settingsForm.bankName ? `Bank: ${settingsForm.bankName}` : '',
      settingsForm.accountHolderName ? `A/c Name: ${settingsForm.accountHolderName}` : '',
      settingsForm.accountNumber ? `A/c No: ${settingsForm.accountNumber}` : '',
      settingsForm.ifscCode ? `IFSC: ${settingsForm.ifscCode}` : '',
      settingsForm.branchName ? `Branch: ${settingsForm.branchName}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    const billId = generateSafeDocId('bil');
    const amountInWords = rupeesInWords(draftTotals.netPayable);

    setSavingBill(true);
    try {
      const payload = {
        billNumber: cleanBillNo,
        billDate: clampStr(billDate || getTodayISO(), BLUEPRINT_LIMITS.DATE_MAX),
        partyId: party.id,
        partyName: party.partyName,
        partyGstin: party.gstin || '',
        partyAddress: clampStr(
          [party.address, party.city, party.state].filter(Boolean).join(', '),
          BLUEPRINT_LIMITS.ADDRESS_MAX
        ),
        tripIds: draftTotals.chosen.map((t) => t.id),
        lineItems,
        freightTotal: draftTotals.freightTotal,
        expenseTotal: draftTotals.expenseTotal,
        advanceTotal: draftTotals.advanceTotal,
        netPayable: draftTotals.netPayable,
        amountInWords,
        bankDetails: clampStr(bankSnapshot, BLUEPRINT_LIMITS.NOTES_MAX),
        status: 'Issued' as BillStatus,
        notes: clampStr(billNotes, BLUEPRINT_LIMITS.NOTES_MAX),
        ownerId: userId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      await setDoc(doc(collection(db, 'bills'), billId), payload);

      if (companySettings) {
        await updateDoc(doc(db, 'companySettings', companySettings.id), {
          nextBillSeq: (companySettings.nextBillSeq || 1) + 1,
          updatedAt: serverTimestamp(),
        });
      }

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'BILL',
        module: 'Billing',
        recordId: billId,
        summary: `Issued bill ${cleanBillNo} to ${party.partyName} (${formatINR(draftTotals.netPayable)})`,
      });

      setCreateOpen(false);
      setPreviewBill({
        id: billId,
        ...payload,
        createdAt: null,
        updatedAt: null,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to generate bill.';
      setBillError(msg);
      console.error('Billing save error:', error);
    } finally {
      setSavingBill(false);
    }
  };

  const handleStatusChange = async (bill: Bill, nextStatus: BillStatus) => {
    try {
      await updateDoc(doc(db, 'bills', bill.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      await recordAuditLog({
        ownerId: bill.ownerId || userId,
        actorRole,
        action: 'UPDATE',
        module: 'Billing',
        recordId: bill.id,
        summary: `Changed bill ${bill.billNumber} status to ${nextStatus}`,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `bills/${bill.id}`);
    }
  };

  const handleDeleteBill = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, 'bills', deleteTarget.id));
      await recordAuditLog({
        ownerId: deleteTarget.ownerId || userId,
        actorRole,
        action: 'DELETE',
        module: 'Billing',
        recordId: deleteTarget.id,
        summary: `Deleted bill ${deleteTarget.billNumber}`,
      });
      setDeleteTarget(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `bills/${deleteTarget.id}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsSavedMsg(null);

    const payload = {
      companyName: clampStr(settingsForm.companyName, 120) || 'BAPASITARAM ENTERPRISE',
      address: clampStr(settingsForm.address, 300),
      gstin: clampStr(settingsForm.gstin.toUpperCase(), 20),
      pan: clampStr(settingsForm.pan.toUpperCase(), 20),
      phone: clampStr(settingsForm.phone, 40),
      email: clampStr(settingsForm.email, 120),
      bankName: clampStr(settingsForm.bankName, 100),
      accountHolderName: clampStr(settingsForm.accountHolderName, 120),
      accountNumber: clampStr(settingsForm.accountNumber, 40),
      ifscCode: clampStr(settingsForm.ifscCode.toUpperCase(), 20),
      branchName: clampStr(settingsForm.branchName, 100),
      billPrefix: clampStr(settingsForm.billPrefix, 30) || 'BSE-',
      nextBillSeq: Math.max(1, Math.floor(clampNum(settingsForm.nextBillSeq || '1', 1, 1000000))),
      defaultDieselRate: clampNum(
        settingsForm.defaultDieselRate || String(DEFAULT_DIESEL_RATE),
        0,
        BLUEPRINT_LIMITS.DIESEL_RATE_MAX
      ),
      terms: clampStr(settingsForm.terms, 500),
    };

    setSavingSettings(true);
    try {
      const targetId = companySettings?.id || userId;
      if (companySettings) {
        await updateDoc(doc(db, 'companySettings', targetId), {
          ...payload,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(collection(db, 'companySettings'), targetId), {
          ...payload,
          ownerId: userId,
          updatedAt: serverTimestamp(),
        });
      }
      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'UPDATE',
        module: 'Company Settings',
        recordId: targetId,
        summary: 'Updated company billing & bank details',
      });
      setSettingsSavedMsg('Company billing & bank profile saved.');
    } catch (error) {
      handleFirestoreError(
        error,
        companySettings ? OperationType.UPDATE : OperationType.CREATE,
        `companySettings/${companySettings?.id || userId}`
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const handleUploadDualTruckPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !permissions.isAdmin) return;
    setTruckError(null);
    setTruckSavedMsg(null);
    setTruckBusy(true);
    try {
      const result = await cropDualTruckPhotoInBrowser(file, {
        splitPercent,
        topTrimPercent,
        bottomTrimPercent,
      });
      setDualSourceDataUrl(result.sourceDataUrl);
      setDraftLeftTruckDataUrl(result.leftTruckDataUrl);
      setDraftRightTruckDataUrl(result.rightTruckDataUrl);
    } catch (err) {
      setTruckError(
        err instanceof Error ? err.message : 'Unable to crop the uploaded dual-truck photograph.'
      );
    } finally {
      setTruckBusy(false);
    }
  };

  const handleAdjustDualCrop = async (nextSplit: number, nextTop: number, nextBottom: number) => {
    setSplitPercent(nextSplit);
    setTopTrimPercent(nextTop);
    setBottomTrimPercent(nextBottom);
    if (!dualSourceDataUrl) return;
    setTruckError(null);
    try {
      const result = await cropDualTruckPhotoInBrowser(dualSourceDataUrl, {
        splitPercent: nextSplit,
        topTrimPercent: nextTop,
        bottomTrimPercent: nextBottom,
      });
      setDraftLeftTruckDataUrl(result.leftTruckDataUrl);
      setDraftRightTruckDataUrl(result.rightTruckDataUrl);
    } catch (err) {
      setTruckError(err instanceof Error ? err.message : 'Unable to adjust crop bounds.');
    }
  };

  const handleUploadSingleTruckPhoto = async (
    side: 'left' | 'right',
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !permissions.isAdmin) return;
    setTruckError(null);
    setTruckSavedMsg(null);
    setTruckBusy(true);
    try {
      const optimized = await prepareSingleTruckPhotoFromFile(file);
      if (side === 'left') {
        setDraftLeftTruckDataUrl(optimized);
      } else {
        setDraftRightTruckDataUrl(optimized);
      }
    } catch (err) {
      setTruckError(
        err instanceof Error ? err.message : 'Unable to process the uploaded truck photograph.'
      );
    } finally {
      setTruckBusy(false);
    }
  };

  const handleSaveTruckHeaderPhotos = async () => {
    if (!permissions.isAdmin) return;
    setTruckError(null);
    setTruckSavedMsg(null);
    if (
      !isValidBillHeaderTruckDataUrl(draftLeftTruckDataUrl) ||
      !isValidBillHeaderTruckDataUrl(draftRightTruckDataUrl)
    ) {
      setTruckError('Truck header images must be valid PNG, JPEG, or WebP photos under 200 KB.');
      return;
    }

    setTruckBusy(true);
    try {
      const targetId = companySettings?.id || userId;
      if (companySettings) {
        await updateDoc(doc(db, 'companySettings', targetId), {
          billHeaderLeftTruckDataUrl: draftLeftTruckDataUrl,
          billHeaderRightTruckDataUrl: draftRightTruckDataUrl,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(collection(db, 'companySettings'), targetId), {
          companyName: clampStr(settingsForm.companyName, 120) || 'BAPASITARAM ENTERPRISE',
          address: clampStr(settingsForm.address, 300),
          gstin: clampStr(settingsForm.gstin.toUpperCase(), 20),
          pan: clampStr(settingsForm.pan.toUpperCase(), 20),
          phone: clampStr(settingsForm.phone, 40),
          email: clampStr(settingsForm.email, 120),
          bankName: clampStr(settingsForm.bankName, 100),
          accountHolderName: clampStr(settingsForm.accountHolderName, 120),
          accountNumber: clampStr(settingsForm.accountNumber, 40),
          ifscCode: clampStr(settingsForm.ifscCode.toUpperCase(), 20),
          branchName: clampStr(settingsForm.branchName, 100),
          billPrefix: clampStr(settingsForm.billPrefix, 30) || 'BSE-',
          nextBillSeq: Math.max(1, Math.floor(clampNum(settingsForm.nextBillSeq || '1', 1, 1000000))),
          defaultDieselRate: clampNum(
            settingsForm.defaultDieselRate || String(DEFAULT_DIESEL_RATE),
            0,
            BLUEPRINT_LIMITS.DIESEL_RATE_MAX
          ),
          terms: clampStr(settingsForm.terms, 500),
          billHeaderLeftTruckDataUrl: draftLeftTruckDataUrl,
          billHeaderRightTruckDataUrl: draftRightTruckDataUrl,
          ownerId: userId,
          updatedAt: serverTimestamp(),
        });
      }

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'UPDATE',
        module: 'Company Settings',
        recordId: targetId,
        summary: `Updated Format B Bill Header truck photos (${BILL_HEADER_LEFT_TRUCK_REG} & ${BILL_HEADER_RIGHT_TRUCK_REG})`,
      });
      setTruckSavedMsg(
        `Saved real truck photos for ${BILL_HEADER_LEFT_TRUCK_REG} (Left) and ${BILL_HEADER_RIGHT_TRUCK_REG} (Right) in Format B Bill Header.`
      );
    } catch (error) {
      handleFirestoreError(
        error,
        companySettings ? OperationType.UPDATE : OperationType.CREATE,
        `companySettings/${companySettings?.id || userId}`
      );
    } finally {
      setTruckBusy(false);
    }
  };

  const handleClearTruckHeaderPhotos = async () => {
    if (!permissions.isAdmin) return;
    setTruckError(null);
    setTruckSavedMsg(null);
    setTruckBusy(true);
    try {
      const targetId = companySettings?.id || userId;
      setDualSourceDataUrl('');
      setDraftLeftTruckDataUrl('');
      setDraftRightTruckDataUrl('');
      if (companySettings) {
        await updateDoc(doc(db, 'companySettings', targetId), {
          billHeaderLeftTruckDataUrl: '',
          billHeaderRightTruckDataUrl: '',
          updatedAt: serverTimestamp(),
        });
      }
      setTruckSavedMsg('Removed Format B bill header truck photos.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `companySettings/${companySettings?.id || userId}`);
    } finally {
      setTruckBusy(false);
    }
  };

  const hasSavedTruckPhotos = Boolean(
    companySettings?.billHeaderLeftTruckDataUrl && companySettings?.billHeaderRightTruckDataUrl
  );

  return (
    <div className="space-y-5">
      {/* Bill Format A & Format B status banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 no-print">
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-blue-900 shrink-0 mt-0.5" />
          <div className="text-xs text-blue-950 leading-relaxed">
            <span className="font-semibold">Approved Bill Header (Modern Minimal Format B) Active:</span>{' '}
            Royal Blue, White &amp; Red header with Gujarati devotional header, left truck{' '}
            <span className="font-mono font-semibold">{BILL_HEADER_LEFT_TRUCK_REG}</span>, center company logo &amp; verified Admin address, and right truck{' '}
            <span className="font-mono font-semibold">{BILL_HEADER_RIGHT_TRUCK_REG}</span>.{' '}
            <span className="font-medium">Original Bill Format A</span> remains preserved unchanged.
            {!hasSavedTruckPhotos && (
              <span className="block mt-1 text-red-700 font-medium">
                Upload your actual dual-truck photo in Company &amp; Bank Details to crop and display both real trucks (AI-generated replacements are never used).
              </span>
            )}
          </div>
        </div>
        {!hasSavedTruckPhotos && permissions.isAdmin && activeTab !== 'settings' && (
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg cursor-pointer shrink-0 self-start sm:self-center"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Dual-Truck Photo</span>
          </button>
        )}
      </div>

      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 no-print">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setActiveTab('bills')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'bills' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Party Bills ({bills.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'settings' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Company &amp; Bank Details
          </button>
        </div>

        {activeTab === 'bills' && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleOpenSampleFormatBBill}
              className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] bg-blue-50 hover:bg-blue-100 text-blue-900 border border-blue-200 text-xs sm:text-sm font-semibold rounded-lg cursor-pointer"
            >
              <LayoutTemplate className="w-4 h-4" />
              <span>Preview Sample Bill (Format B)</span>
            </button>
            {permissions.canManageBilling && (
              <button
                type="button"
                onClick={openNewBillDrawer}
                disabled={parties.length === 0 || trips.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg cursor-pointer disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                <span>Generate Party Bill</span>
              </button>
            )}
          </div>
        )}
      </div>

      {activeTab === 'bills' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden no-print">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : bills.length === 0 ? (
            <div className="p-10 sm:p-14 text-center">
              <ReceiptText className="w-9 h-9 text-slate-300 mx-auto" />
              <h3 className="mt-3 text-base font-semibold text-slate-900">No Party Bills Generated</h3>
              <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
                Configure your Company &amp; Bank Details, then select any party&apos;s recorded trips to generate printable PDF bills with automatic INR in words.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 font-semibold text-slate-500">
                    <th className="py-3 px-4">Bill No &amp; Date</th>
                    <th className="py-3 px-4">Party</th>
                    <th className="py-3 px-4 text-right">Trips</th>
                    <th className="py-3 px-4 text-right">Freight Total</th>
                    <th className="py-3 px-4 text-right">Advance (Jama)</th>
                    <th className="py-3 px-4 text-right">Net Payable</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bills.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="font-mono font-semibold text-slate-900">{b.billNumber}</div>
                        <div className="text-slate-500 font-mono">{formatDateIN(b.billDate)}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{b.partyName}</div>
                        {b.partyGstin && <div className="font-mono text-[11px] text-slate-500">{b.partyGstin}</div>}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{b.lineItems.length}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{formatINR(b.freightTotal)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700">
                        {formatINR(b.advanceTotal)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900">
                        {formatINR(b.netPayable)}
                      </td>
                      <td className="py-3 px-4">
                        {permissions.canManageBilling && !(b.status === 'Paid' || b.status === 'Cancelled') ? (
                          <select
                            value={b.status}
                            onChange={(e) => handleStatusChange(b, e.target.value as BillStatus)}
                            className="px-2 py-1 text-xs border border-slate-200 rounded bg-white"
                          >
                            {BILL_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="font-medium text-slate-800">{b.status}</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setPreviewBill(b)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View / Print</span>
                          </button>
                          {permissions.canDeleteRecords && !(b.status === 'Paid' || b.status === 'Cancelled') && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(b)}
                              className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                              aria-label="Delete bill"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={handleSaveSettings} className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 no-print">
          <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
            <Building2 className="w-4 h-4 text-slate-600" />
            <h3 className="text-base font-semibold text-slate-900">Company Header &amp; Bank Details for Bills</h3>
          </div>

          {settingsSavedMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              <span>{settingsSavedMsg}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Company Name *</label>
              <input
                type="text"
                required
                value={settingsForm.companyName}
                onChange={(e) => setSettingsForm({ ...settingsForm, companyName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">GSTIN</label>
              <input
                type="text"
                value={settingsForm.gstin}
                onChange={(e) => setSettingsForm({ ...settingsForm, gstin: e.target.value.toUpperCase() })}
                className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">PAN</label>
              <input
                type="text"
                value={settingsForm.pan}
                onChange={(e) => setSettingsForm({ ...settingsForm, pan: e.target.value.toUpperCase() })}
                className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
              <input
                type="text"
                value={settingsForm.phone}
                onChange={(e) => setSettingsForm({ ...settingsForm, phone: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={settingsForm.email}
                onChange={(e) => setSettingsForm({ ...settingsForm, email: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Bill Prefix</label>
                <input
                  type="text"
                  value={settingsForm.billPrefix}
                  onChange={(e) => setSettingsForm({ ...settingsForm, billPrefix: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Next Bill #</label>
                <input
                  type="number"
                  min="1"
                  value={settingsForm.nextBillSeq}
                  onChange={(e) => setSettingsForm({ ...settingsForm, nextBillSeq: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Diesel Rate (₹/L)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max={BLUEPRINT_LIMITS.DIESEL_RATE_MAX}
                  value={settingsForm.defaultDieselRate}
                  onChange={(e) => setSettingsForm({ ...settingsForm, defaultDieselRate: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Registered Office Address</label>
            <input
              type="text"
              value={settingsForm.address}
              onChange={(e) => setSettingsForm({ ...settingsForm, address: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2 border-t border-slate-200">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Bank Name</label>
              <input
                type="text"
                value={settingsForm.bankName}
                onChange={(e) => setSettingsForm({ ...settingsForm, bankName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Account Holder Name</label>
              <input
                type="text"
                value={settingsForm.accountHolderName}
                onChange={(e) => setSettingsForm({ ...settingsForm, accountHolderName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Account Number</label>
              <input
                type="text"
                value={settingsForm.accountNumber}
                onChange={(e) => setSettingsForm({ ...settingsForm, accountNumber: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">IFSC Code</label>
              <input
                type="text"
                value={settingsForm.ifscCode}
                onChange={(e) => setSettingsForm({ ...settingsForm, ifscCode: e.target.value.toUpperCase() })}
                className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-200 rounded-lg"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Branch Name</label>
              <input
                type="text"
                value={settingsForm.branchName}
                onChange={(e) => setSettingsForm({ ...settingsForm, branchName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Invoice Terms &amp; Conditions</label>
            <textarea
              rows={2}
              value={settingsForm.terms}
              onChange={(e) => setSettingsForm({ ...settingsForm, terms: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="flex justify-end">
            {permissions.canManageBilling ? (
              <button
                type="submit"
                disabled={savingSettings}
                className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
              >
                {savingSettings ? 'Saving...' : 'Save Billing Profile'}
              </button>
            ) : (
              <span className="text-xs text-slate-500">
                Billing profile edits require Billing Management permission.
              </span>
            )}
          </div>
        </form>
      )}

      {/* Admin Format B Header Real Dual-Truck Photo Upload & Split-Cropper */}
      {activeTab === 'settings' && (
        <div className="bg-white border border-blue-200 rounded-xl p-6 space-y-5 no-print">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-blue-900" />
              <h3 className="text-base font-semibold text-blue-950">
                Format B Bill Header — Real Dual-Truck Photo Cropper ({BILL_HEADER_LEFT_TRUCK_REG} &amp; {BILL_HEADER_RIGHT_TRUCK_REG})
              </h3>
            </div>
            <span className="text-[11px] font-medium text-blue-900 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-md self-start sm:self-center">
              Applies to Modern Minimal Format B Only
            </span>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            Upload your actual photograph containing <span className="font-semibold text-slate-900">BOTH vehicles</span>. The ERP crops the left vehicle separately for{' '}
            <span className="font-mono font-semibold text-blue-900">{BILL_HEADER_LEFT_TRUCK_REG}</span> and the right vehicle separately for{' '}
            <span className="font-mono font-semibold text-blue-900">{BILL_HEADER_RIGHT_TRUCK_REG}</span> while preserving exact aspect ratio and registration identity. AI-generated replacement truck images are never used.
          </p>

          {truckError && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {truckError}
            </div>
          )}

          {truckSavedMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{truckSavedMsg}</span>
            </div>
          )}

          {permissions.isAdmin ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg cursor-pointer">
                  <Scissors className="w-3.5 h-3.5" />
                  <span>Upload Dual-Truck Photo (Auto-Crop Left &amp; Right)</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleUploadDualTruckPhoto}
                    disabled={truckBusy}
                    className="sr-only"
                  />
                </label>

                <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Left Only ({BILL_HEADER_LEFT_TRUCK_REG})</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => handleUploadSingleTruckPhoto('left', e)}
                    disabled={truckBusy}
                    className="sr-only"
                  />
                </label>

                <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Right Only ({BILL_HEADER_RIGHT_TRUCK_REG})</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => handleUploadSingleTruckPhoto('right', e)}
                    disabled={truckBusy}
                    className="sr-only"
                  />
                </label>
              </div>

              {dualSourceDataUrl && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="text-xs font-semibold text-slate-800">
                    Fine-Tune Dual-Photo Split &amp; Framing (Live Preview)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                    <div>
                      <div className="flex justify-between text-slate-600 mb-1">
                        <label htmlFor="dual-split-slider">Center Split Point</label>
                        <span className="font-mono font-semibold text-slate-900">{splitPercent}%</span>
                      </div>
                      <input
                        id="dual-split-slider"
                        type="range"
                        min={35}
                        max={65}
                        step={1}
                        value={splitPercent}
                        onChange={(e) =>
                          handleAdjustDualCrop(Number(e.target.value), topTrimPercent, bottomTrimPercent)
                        }
                        className="w-full accent-blue-900"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-slate-600 mb-1">
                        <label htmlFor="dual-top-slider">Top Trim</label>
                        <span className="font-mono font-semibold text-slate-900">{topTrimPercent}%</span>
                      </div>
                      <input
                        id="dual-top-slider"
                        type="range"
                        min={0}
                        max={25}
                        step={1}
                        value={topTrimPercent}
                        onChange={(e) =>
                          handleAdjustDualCrop(splitPercent, Number(e.target.value), bottomTrimPercent)
                        }
                        className="w-full accent-blue-900"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-slate-600 mb-1">
                        <label htmlFor="dual-bottom-slider">Bottom Trim</label>
                        <span className="font-mono font-semibold text-slate-900">{bottomTrimPercent}%</span>
                      </div>
                      <input
                        id="dual-bottom-slider"
                        type="range"
                        min={0}
                        max={25}
                        step={1}
                        value={bottomTrimPercent}
                        onChange={(e) =>
                          handleAdjustDualCrop(splitPercent, topTrimPercent, Number(e.target.value))
                        }
                        className="w-full accent-blue-900"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-3 rounded-xl border border-blue-200 bg-slate-50/70 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-blue-950">
                      Left Header Vehicle
                    </span>
                    <span className="px-2 py-0.5 rounded bg-blue-900 text-white font-mono text-[11px] font-bold">
                      {BILL_HEADER_LEFT_TRUCK_REG}
                    </span>
                  </div>
                  <div className="h-32 rounded-lg border border-slate-200 bg-white flex items-center justify-center overflow-hidden p-1.5">
                    {draftLeftTruckDataUrl ? (
                      <img
                        src={draftLeftTruckDataUrl}
                        alt={`Cropped preview ${BILL_HEADER_LEFT_TRUCK_REG}`}
                        className="max-w-full max-h-full w-auto h-auto object-contain block"
                      />
                    ) : (
                      <span className="text-xs text-slate-400">
                        No photo uploaded yet for {BILL_HEADER_LEFT_TRUCK_REG}
                      </span>
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-xl border border-blue-200 bg-slate-50/70 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-blue-950">
                      Right Header Vehicle
                    </span>
                    <span className="px-2 py-0.5 rounded bg-blue-900 text-white font-mono text-[11px] font-bold">
                      {BILL_HEADER_RIGHT_TRUCK_REG}
                    </span>
                  </div>
                  <div className="h-32 rounded-lg border border-slate-200 bg-white flex items-center justify-center overflow-hidden p-1.5">
                    {draftRightTruckDataUrl ? (
                      <img
                        src={draftRightTruckDataUrl}
                        alt={`Cropped preview ${BILL_HEADER_RIGHT_TRUCK_REG}`}
                        className="max-w-full max-h-full w-auto h-auto object-contain block"
                      />
                    ) : (
                      <span className="text-xs text-slate-400">
                        No photo uploaded yet for {BILL_HEADER_RIGHT_TRUCK_REG}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                <div className="text-[11px] text-slate-500">
                  Company Logo is shared with Admin Logo Settings ({companySettings?.logoDataUrl ? 'Logo Uploaded' : 'Upload logo in Lorry Receipt → Admin Logo Settings'}).
                </div>
                <div className="flex items-center gap-2">
                  {(draftLeftTruckDataUrl || draftRightTruckDataUrl) && (
                    <button
                      type="button"
                      disabled={truckBusy}
                      onClick={handleClearTruckHeaderPhotos}
                      className="px-3.5 py-2 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      Remove Truck Photos
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={truckBusy}
                    onClick={handleSaveTruckHeaderPhotos}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-50"
                  >
                    {truckBusy ? 'Saving...' : 'Save Format B Truck Photos'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
              Only Admin users can upload or modify Format B bill header truck photos.
            </div>
          )}
        </div>
      )}

      {/* Bill Creation Drawer */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 no-print" role="dialog" aria-modal="true">
          <div className="w-full max-w-2xl bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 className="font-display text-lg font-semibold text-slate-900">Generate Party Bill</h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveBill} className="p-6 space-y-5 flex-1">
              {billError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {billError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Bill Number *</label>
                  <input
                    type="text"
                    required
                    value={billNumber}
                    onChange={(e) => setBillNumber(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div className="sm:col-span-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Bill Date *</label>
                  <input
                    type="date"
                    required
                    value={billDate}
                    onChange={(e) => setBillDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div className="sm:col-span-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Select Party *</label>
                  <select
                    required
                    value={selectedPartyId}
                    onChange={(e) => {
                      setSelectedPartyId(e.target.value);
                      setSelectedTripIds([]);
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="">Choose party...</option>
                    {parties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partyName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-slate-700">
                    Select Trips for Bill ({selectedTripIds.length} selected)
                  </label>
                  {partyTrips.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedTripIds(
                          selectedTripIds.length === partyTrips.length
                            ? []
                            : partyTrips.slice(0, 50).map((t) => t.id)
                        )
                      }
                      className="text-xs font-medium text-slate-700 hover:underline cursor-pointer"
                    >
                      {selectedTripIds.length === partyTrips.length ? 'Deselect All' : 'Select All (max 50)'}
                    </button>
                  )}
                </div>

                {partyTrips.length === 0 ? (
                  <p className="text-xs text-slate-500 p-4 border border-slate-200 rounded-lg">
                    No active trips found for this party.
                  </p>
                ) : (
                  <div className="border border-slate-200 rounded-xl max-h-64 overflow-y-auto divide-y divide-slate-100">
                    {partyTrips.map((t) => {
                      const checked = selectedTripIds.includes(t.id);
                      const billedIn = tripToActiveBillsMap.get(t.id) || [];
                      return (
                        <label
                          key={t.id}
                          className={`flex items-center justify-between gap-3 p-3 text-xs hover:bg-slate-50 cursor-pointer ${
                            billedIn.length > 0 ? 'bg-amber-50/40' : ''
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleTripSelection(t.id)}
                              className="w-4 h-4 accent-slate-900"
                            />
                            <div className="min-w-0">
                              <div className="font-mono font-semibold text-slate-900">
                                {formatDateIN(t.tripDate)} · {t.lrNumber} · {t.vehicleNumber}
                              </div>
                              <div className="text-slate-500 truncate">
                                {t.origin} → {t.destination} {t.containerNo ? `· Cont: ${t.containerNo}` : ''}
                              </div>
                              {billedIn.length > 0 && (
                                <div className="text-[11px] font-medium text-amber-800 mt-0.5">
                                  Already included in Bill: {billedIn.join(', ')}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-right font-mono shrink-0">
                            <div className="text-slate-900 font-semibold">Rate: {formatINR(t.freightAmount)}</div>
                            <div className="text-amber-700">Hisab: {formatINR(t.balanceAmount)}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-600">Freight Total (Rate)</span>
                  <span className="font-mono font-semibold">{formatINR(draftTotals.freightTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Recorded Trip Expenses (Reference)</span>
                  <span className="font-mono">{formatINR(draftTotals.expenseTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Advance Received (Jama)</span>
                  <span className="font-mono text-emerald-700">- {formatINR(draftTotals.advanceTotal)}</span>
                </div>
                {Math.abs(draftTotals.hisabAdjustment) >= 0.01 && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Trip Hisab / Expense Adjustment</span>
                    <span className="font-mono text-amber-700">
                      {draftTotals.hisabAdjustment >= 0 ? '+' : '-'} {formatINR(Math.abs(draftTotals.hisabAdjustment))}
                    </span>
                  </div>
                )}
                <div className="flex justify-between pt-2 border-t border-slate-200 text-sm font-semibold">
                  <span>Net Payable Balance (Hisab)</span>
                  <span className="font-mono">{formatINR(draftTotals.netPayable)}</span>
                </div>
                <div className="text-[11px] text-slate-600 pt-1">
                  <span className="font-medium">In Words:</span> {rupeesInWords(draftTotals.netPayable)}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Bill Remarks</label>
                <input
                  type="text"
                  maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                  value={billNotes}
                  onChange={(e) => setBillNotes(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBill}
                  className="px-5 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  {savingBill ? 'Generating...' : 'Save & Preview Bill'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Printable Bill Modal */}
      {previewBill && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 overflow-y-auto p-4 sm:p-8 flex justify-center items-start print-modal-root">
          <div className="bg-white w-full max-w-4xl rounded-xl shadow-2xl overflow-hidden print-modal-sheet">
            <div className="px-6 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50 no-print">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold text-slate-700">
                  {previewBill.id === '__sample_preview__'
                    ? `Sample Bill Preview — ${previewBill.billNumber}`
                    : `Bill Preview — ${previewBill.billNumber}`}
                </span>
                <div
                  className="inline-flex items-center p-0.5 bg-slate-200/80 rounded-lg"
                  role="group"
                  aria-label="Select Bill Format"
                >
                  <button
                    type="button"
                    onClick={() => handleSelectBillFormat('format-a')}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-md cursor-pointer ${
                      billFormat === 'format-a'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Format A (Original)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectBillFormat('format-b')}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-md cursor-pointer ${
                      billFormat === 'format-b'
                        ? 'bg-blue-900 text-white shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Format B (Modern Minimal)
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handlePreviewBillPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Rendering...' : 'Preview A4 PDF'}</span>
                </button>
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handleDownloadBillPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Generating PDF...' : 'Download PDF'}</span>
                </button>
                {previewBill.id !== '__sample_preview__' &&
                  generatedBillPdf?.billId === previewBill.id &&
                  generatedBillPdf?.format === billFormat && (
                    <button
                      type="button"
                      disabled={pdfBusy}
                      onClick={handleShareGeneratedBillPdf}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-60"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      <span>WhatsApp Share</span>
                    </button>
                  )}
                <button
                  type="button"
                  onClick={() => triggerPrintPreview()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Bill</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPdfError(null);
                    setRenderedPdfPreview(null);
                    setGeneratedBillPdf(null);
                    setPreviewBill(null);
                  }}
                  aria-label="Close bill preview"
                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {previewBill.id !== '__sample_preview__' &&
              generatedBillPdf?.billId === previewBill.id &&
              generatedBillPdf?.format === billFormat && (
                <div className="px-6 py-2.5 bg-emerald-50 border-b border-emerald-200 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-900 no-print">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span>
                      Bill PDF <span className="font-mono font-medium">{generatedBillPdf.rendered.fileName}</span> is ready to share manually via WhatsApp.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleShareGeneratedBillPdf}
                    className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>WhatsApp Share PDF</span>
                  </button>
                </div>
              )}

            {pdfError && (
              <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 no-print">
                {pdfError}
              </div>
            )}

            <div id="freight-bill-a4-content" ref={billPrintRef} className="text-slate-900 bg-white">
              {billFormat === 'format-b' ? (
                <BillFormatBDocument
                  bill={previewBill}
                  companySettings={companySettings}
                  companyNameOverride={settingsForm.companyName}
                  addressOverride={settingsForm.address}
                  gstinOverride={settingsForm.gstin}
                  panOverride={settingsForm.pan}
                  termsOverride={settingsForm.terms}
                />
              ) : (
                <div className="p-8 space-y-6">
              {/* Header */}
              <div className="flex flex-col sm:flex-row sm:justify-between gap-4 border-b-2 border-slate-900 pb-4">
                <div>
                  <h2 className="font-display text-2xl font-bold tracking-tight">
                    {settingsForm.companyName || 'BAPASITARAM ENTERPRISE'}
                  </h2>
                  {settingsForm.address && <p className="text-xs text-slate-600 mt-1">{settingsForm.address}</p>}
                  <div className="text-xs text-slate-600 mt-1 space-x-3 font-mono">
                    {settingsForm.gstin && <span>GSTIN: {settingsForm.gstin}</span>}
                    {settingsForm.pan && <span>PAN: {settingsForm.pan}</span>}
                    {settingsForm.phone && <span>Ph: {settingsForm.phone}</span>}
                  </div>
                </div>
                <div className="sm:text-right">
                  <div className="text-sm font-bold uppercase tracking-wider text-slate-700">Freight Bill</div>
                  <div className="font-mono text-base font-bold mt-1">{previewBill.billNumber}</div>
                  <div className="text-xs text-slate-600 font-mono">Date: {formatDateIN(previewBill.billDate)}</div>
                </div>
              </div>

              {/* Party Block */}
              <div className="p-4 border border-slate-300 rounded-lg text-xs space-y-1">
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Bill To</div>
                <div className="text-sm font-bold">{previewBill.partyName}</div>
                {previewBill.partyAddress && <div className="text-slate-700">{previewBill.partyAddress}</div>}
                {previewBill.partyGstin && <div className="font-mono text-slate-700">GSTIN: {previewBill.partyGstin}</div>}
              </div>

              {/* Trips Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-[11px] sm:text-xs border border-slate-300">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-300 font-semibold">
                      <th className="py-2 px-2 border-r border-slate-300">Sr</th>
                      <th className="py-2 px-2 border-r border-slate-300">Date</th>
                      <th className="py-2 px-2 border-r border-slate-300">LR No</th>
                      <th className="py-2 px-2 border-r border-slate-300">Vehicle No</th>
                      <th className="py-2 px-2 border-r border-slate-300">Container</th>
                      <th className="py-2 px-2 border-r border-slate-300">From → To</th>
                      <th className="py-2 px-2 border-r border-slate-300 text-right">Rate</th>
                      <th className="py-2 px-2 border-r border-slate-300 text-right">Jama</th>
                      <th className="py-2 px-2 text-right">Hisab</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {previewBill.lineItems.map((item, idx) => (
                      <tr key={`${item.tripId}-${idx}`}>
                        <td className="py-1.5 px-2 border-r border-slate-200 font-mono">{item.srNo || idx + 1}</td>
                        <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                          {formatDateIN(item.tripDate)}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-200 font-mono">{item.lrNumber}</td>
                        <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">{item.vehicleNumber}</td>
                        <td className="py-1.5 px-2 border-r border-slate-200 font-mono break-words">{item.containerNo || '—'}</td>
                        <td className="py-1.5 px-2 border-r border-slate-200 break-words">
                          {item.origin} → {item.destination}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatINR(item.rate)}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatINR(item.jama)}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                          {formatINR(item.hisab)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-100 border-t-2 border-slate-400 font-semibold text-slate-900">
                    <tr>
                      <td className="py-2 px-2 border-r border-slate-300" colSpan={6}>
                        Total ({previewBill.lineItems.length} {previewBill.lineItems.length === 1 ? 'Trip' : 'Trips'})
                      </td>
                      <td className="py-2 px-2 border-r border-slate-300 text-right font-mono tabular-nums whitespace-nowrap">
                        {formatINR(previewBill.freightTotal)}
                      </td>
                      <td className="py-2 px-2 border-r border-slate-300 text-right font-mono tabular-nums whitespace-nowrap">
                        {formatINR(previewBill.advanceTotal)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                        {formatINR(previewBill.netPayable)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Totals + Words + Bank + Signature */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2">
                <div className="space-y-3 text-xs">
                  <div>
                    <div className="font-semibold text-slate-600">Amount Chargeable (in words):</div>
                    <div className="font-semibold text-slate-900 mt-0.5">{previewBill.amountInWords}</div>
                  </div>
                  <div className="p-3 border border-slate-200 rounded bg-slate-50">
                    <div className="font-semibold text-slate-700 mb-1">Bank Details</div>
                    <div className="font-mono text-[11px] text-slate-700">
                      {previewBill.bankDetails || 'Configure bank details in Company & Bank Details tab.'}
                    </div>
                  </div>
                  {settingsForm.terms && (
                    <div className="text-[11px] text-slate-500">
                      <span className="font-semibold">Terms:</span> {settingsForm.terms}
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="border border-slate-300 rounded p-4 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span>Freight Total</span>
                      <span className="font-mono font-semibold">{formatINR(previewBill.freightTotal)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Less: Advance Received (Jama)</span>
                      <span className="font-mono">{formatINR(previewBill.advanceTotal)}</span>
                    </div>
                    {Math.abs(
                      Math.round((previewBill.netPayable - (previewBill.freightTotal - previewBill.advanceTotal)) * 100) /
                        100
                    ) >= 0.01 && (
                      <div className="flex justify-between">
                        <span>Trip Hisab / Expense Adjustment</span>
                        <span className="font-mono">
                          {formatINR(
                            Math.round((previewBill.netPayable - (previewBill.freightTotal - previewBill.advanceTotal)) * 100) /
                              100
                          )}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between pt-2 border-t border-slate-300 text-sm font-bold">
                      <span>Net Payable Total</span>
                      <span className="font-mono">{formatINR(previewBill.netPayable)}</span>
                    </div>
                  </div>

                  <div className="pt-8 text-right text-xs">
                    <div className="font-semibold">For {settingsForm.companyName || 'BAPASITARAM ENTERPRISE'}</div>
                    <div className="mt-10 border-t border-slate-400 inline-block pt-1 px-6 text-slate-600">
                      Authorized Signatory
                    </div>
                  </div>
                </div>
              </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <PdfPreviewModal
        preview={renderedPdfPreview}
        title={previewBill ? `Freight Bill — ${previewBill.billNumber}` : 'Freight Bill A4 PDF'}
        onDownload={() => renderedPdfPreview?.pdf.save(renderedPdfPreview.fileName)}
        onPrint={() => triggerPrintPreview()}
        onWhatsAppShare={
          previewBill && previewBill.id !== '__sample_preview__' && renderedPdfPreview
            ? () => openWhatsAppShareForBillPdf(previewBill, renderedPdfPreview)
            : undefined
        }
        whatsAppLabel="WhatsApp Share"
        onClose={() => setRenderedPdfPreview(null)}
      />

      <WhatsAppShareModal
        open={Boolean(whatsAppBillShare)}
        onClose={() => setWhatsAppBillShare(null)}
        title="Share Freight Bill PDF via WhatsApp"
        subtitle="Verify the party mobile number, review the message, and share the PDF manually."
        partyName={whatsAppBillShare?.partyName || ''}
        partyPhone={whatsAppBillShare?.partyPhone || ''}
        initialMessage={whatsAppBillShare?.message || ''}
        pdfAttachment={whatsAppBillShare?.attachment || null}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Party Bill"
        description={`Delete bill ${deleteTarget?.billNumber || ''}? Underlying trip records will not be affected.`}
        confirmLabel="Delete Bill"
        destructive
        busy={deleting}
        onConfirm={handleDeleteBill}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
