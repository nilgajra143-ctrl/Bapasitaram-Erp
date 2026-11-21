import React, { useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  Plus,
  Search,
  Users,
  Pencil,
  Trash2,
  X,
  Phone,
  MapPin,
  Eye,
  ReceiptText,
  CheckCircle2,
  IndianRupee,
  FileText,
  Download,
  Printer,
  MessageCircle,
} from 'lucide-react';
import { db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  PARTY_STATUSES,
  PARTY_TYPES,
  type Bill,
  type CompanySettings,
  type ErpUserRole,
  type Party,
  type PartyPayment,
  type PartyStatus,
  type PartyType,
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
  buildDateWisePartyStatement,
  computePartyLedgerSummary,
  computeTripLinkedPaymentTotals,
  extractReadableFirestoreError,
  findDuplicateParty,
  findDuplicatePartyPayment,
  matchesStatementPaymentMethod,
  normalizeNameKey,
  STATEMENT_PAYMENT_METHOD_FILTERS,
  type PartyLedgerSummary,
  type StatementPaymentMethodFilter,
} from '../utils/erpHelpers';
import {
  downloadElementAsA4Pdf,
  renderElementToA4Pdf,
  triggerPrintPreview,
  type RenderedA4PdfResult,
} from '../utils/pdfExport';
import { downloadPartyStatementPdf } from '../utils/partyStatementPdf';
import {
  buildPaymentReceiptWhatsAppMessage,
  buildPaymentReminderWhatsAppMessage,
  type PendingTripDueItem,
} from '../utils/whatsappShare';
import { recordAuditLog } from '../utils/auditLogger';
import {
  AddPaymentModal,
  type AddPaymentModalProps,
  type SavedPartyPaymentSummary,
} from './AddPaymentModal';
import { ConfirmDialog } from './ConfirmDialog';
import { PdfPreviewModal } from './PdfPreviewModal';
import { WhatsAppShareModal } from './WhatsAppShareModal';

export { AddPaymentModal, type AddPaymentModalProps, type SavedPartyPaymentSummary };

interface PartiesViewProps {
  userId: string;
  actorRole: ErpUserRole;
  permissions: UserPermissions;
  parties: Party[];
  partyPayments: PartyPayment[];
  trips: Trip[];
  bills?: Bill[];
  companySettings: CompanySettings | null;
  loading: boolean;
  onGenerateBillForParty: (partyId: string) => void;
}

interface PartyFormState {
  partyName: string;
  partyType: PartyType;
  contactPerson: string;
  phone: string;
  email: string;
  gstin: string;
  city: string;
  state: string;
  address: string;
  paymentTermsDays: string;
  status: PartyStatus;
  notes: string;
}

const EMPTY_FORM: PartyFormState = {
  partyName: '',
  partyType: 'Consignor',
  contactPerson: '',
  phone: '',
  email: '',
  gstin: '',
  city: '',
  state: '',
  address: '',
  paymentTermsDays: '15',
  status: 'Active',
  notes: '',
};

const EMPTY_LEDGER_SUMMARY: PartyLedgerSummary = {
  tripCount: 0,
  totalFreight: 0,
  tripAdvanceReceived: 0,
  tripHisabBalance: 0,
  paymentsReceivedTotal: 0,
  ledgerAdvancesTotal: 0,
  deductionsTotal: 0,
  separatePaymentsTotal: 0,
  partyPaymentsTotal: 0,
  totalReceived: 0,
  totalCredited: 0,
  netOutstanding: 0,
  paymentCount: 0,
};

export const PartiesView: React.FC<PartiesViewProps> = ({
  userId,
  actorRole,
  permissions,
  parties,
  partyPayments,
  trips,
  bills = [],
  companySettings,
  loading,
  onGenerateBillForParty,
}) => {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'All' | PartyType>('All');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingParty, setEditingParty] = useState<Party | null>(null);
  const [form, setForm] = useState<PartyFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reusable Add Payment modal state
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentModalPartyId, setPaymentModalPartyId] = useState('');
  const [paymentModalTripId, setPaymentModalTripId] = useState('');

  // Ledger & Statement modal state
  const [inspectParty, setInspectParty] = useState<Party | null>(null);
  const [ledgerPaymentMethod, setLedgerPaymentMethod] =
    useState<StatementPaymentMethodFilter>('All');
  const [statementParty, setStatementParty] = useState<Party | null>(null);
  const [statementFromDate, setStatementFromDate] = useState('');
  const [statementToDate, setStatementToDate] = useState('');
  const [statementPaymentMethod, setStatementPaymentMethod] =
    useState<StatementPaymentMethodFilter>('All');
  const statementPrintRef = useRef<HTMLDivElement | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [downloadingStatement, setDownloadingStatement] = useState(false);
  const [statementDownloadError, setStatementDownloadError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [renderedPdfPreview, setRenderedPdfPreview] = useState<RenderedA4PdfResult | null>(null);

  // Delete confirmations
  const [deleteTarget, setDeleteTarget] = useState<Party | null>(null);
  const [deletePaymentTarget, setDeletePaymentTarget] = useState<PartyPayment | null>(null);
  const [deleting, setDeleting] = useState(false);

  // WhatsApp Manual Share state (Payment Receipt & Payment Reminder)
  const [lastSavedPayment, setLastSavedPayment] = useState<SavedPartyPaymentSummary | null>(null);
  const [whatsAppModal, setWhatsAppModal] = useState<{
    title: string;
    subtitle: string;
    partyName: string;
    partyPhone: string;
    message: string;
  } | null>(null);

  const canRecordPayments = permissions.canManageBilling || permissions.canManageMasters;
  const canAddParty = permissions.canManageMasters || permissions.isAdmin;
  const canEditParty = permissions.isAdmin;

  const ledgerByParty = useMemo(() => {
    const map = new Map<string, PartyLedgerSummary>();
    parties.forEach((p) => {
      map.set(p.id, computePartyLedgerSummary(p.id, trips, partyPayments, p.partyName));
    });
    return map;
  }, [parties, trips, partyPayments]);

  const billsByParty = useMemo(() => {
    const map = new Map<string, { count: number; totalNet: number }>();
    for (const b of bills) {
      if (b.status === 'Cancelled') continue;
      const cur = map.get(b.partyId) || { count: 0, totalNet: 0 };
      cur.count += 1;
      cur.totalNet = Math.round((cur.totalNet + (Number(b.netPayable) || 0)) * 100) / 100;
      map.set(b.partyId, cur);
    }
    return map;
  }, [bills]);

  const filteredParties = useMemo(() => {
    const q = search.trim().toLowerCase();
    return parties.filter((p) => {
      if (typeFilter !== 'All' && p.partyType !== typeFilter) return false;
      if (!q) return true;
      return (
        p.partyName.toLowerCase().includes(q) ||
        p.contactPerson.toLowerCase().includes(q) ||
        p.city.toLowerCase().includes(q) ||
        p.gstin.toLowerCase().includes(q) ||
        p.phone.toLowerCase().includes(q)
      );
    });
  }, [parties, search, typeFilter]);

  const directoryTotals = useMemo(() => {
    let tripCount = 0;
    let totalFreight = 0;
    let totalTripAdvance = 0;
    let totalPartyPayments = 0;
    let totalDeductions = 0;
    let totalReceived = 0;
    let totalCredited = 0;
    let totalOutstanding = 0;
    let pendingPartyCount = 0;
    let paymentCount = 0;

    for (const p of filteredParties) {
      const ledger = ledgerByParty.get(p.id) || EMPTY_LEDGER_SUMMARY;
      tripCount += ledger.tripCount;
      totalFreight += ledger.totalFreight;
      totalTripAdvance += ledger.tripAdvanceReceived;
      totalPartyPayments += ledger.partyPaymentsTotal;
      totalDeductions += ledger.deductionsTotal;
      totalReceived += ledger.totalReceived;
      totalCredited += ledger.totalCredited;
      totalOutstanding += ledger.netOutstanding;
      paymentCount += ledger.paymentCount;
      if (ledger.netOutstanding > 0) {
        pendingPartyCount += 1;
      }
    }

    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      tripCount,
      totalFreight: r2(totalFreight),
      totalTripAdvance: r2(totalTripAdvance),
      totalPartyPayments: r2(totalPartyPayments),
      totalDeductions: r2(totalDeductions),
      totalReceived: r2(totalReceived),
      totalCredited: r2(totalCredited),
      totalOutstanding: r2(totalOutstanding),
      pendingPartyCount,
      paymentCount,
    };
  }, [filteredParties, ledgerByParty]);

  const activeInspectParty = useMemo(
    () => (inspectParty ? parties.find((p) => p.id === inspectParty.id) || inspectParty : null),
    [inspectParty, parties]
  );

  const activeStatementParty = useMemo(
    () =>
      statementParty ? parties.find((p) => p.id === statementParty.id) || statementParty : null,
    [statementParty, parties]
  );

  const inspectLedger = useMemo(() => {
    if (!activeInspectParty) return null;
    const fallbackNameKey = normalizeNameKey(activeInspectParty.partyName);
    const matchesInspectParty = (recordPartyId: string, recordPartyName: string) =>
      recordPartyId === activeInspectParty.id ||
      (!recordPartyId &&
        fallbackNameKey !== '' &&
        normalizeNameKey(recordPartyName) === fallbackNameKey);
    const partyTrips = trips
      .filter((t) => matchesInspectParty(t.partyId, t.partyName))
      .slice()
      .sort((a, b) => b.tripDate.localeCompare(a.tripDate));
    const allPayments = partyPayments
      .filter((pp) => matchesInspectParty(pp.partyId, pp.partyName))
      .slice()
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
    const payments = allPayments.filter((pp) =>
      matchesStatementPaymentMethod(pp.paymentMode, ledgerPaymentMethod)
    );
    const filteredPaymentsTotal =
      Math.round(payments.reduce((acc, pp) => acc + (Number(pp.amount) || 0), 0) * 100) / 100;
    const summary = ledgerByParty.get(activeInspectParty.id) || EMPTY_LEDGER_SUMMARY;
    const tripLinkedTotals = computeTripLinkedPaymentTotals(
      activeInspectParty.id,
      partyPayments,
      activeInspectParty.partyName
    );
    const partyBills = bills.filter(
      (b) => matchesInspectParty(b.partyId, b.partyName) && b.status !== 'Cancelled'
    );
    const billSummary = billsByParty.get(activeInspectParty.id) || { count: 0, totalNet: 0 };
    return {
      partyTrips,
      allPayments,
      payments,
      filteredPaymentsTotal,
      summary,
      tripLinkedTotals,
      partyBills,
      billSummary,
    };
  }, [activeInspectParty, trips, partyPayments, ledgerPaymentMethod, ledgerByParty, bills, billsByParty]);

  const statementData = useMemo(() => {
    if (!activeStatementParty) return null;
    const fallbackNameKey = normalizeNameKey(activeStatementParty.partyName);
    const matchesStatementParty = (recordPartyId: string, recordPartyName: string) =>
      recordPartyId === activeStatementParty.id ||
      (!recordPartyId &&
        fallbackNameKey !== '' &&
        normalizeNameKey(recordPartyName) === fallbackNameKey);
    const partyTrips = trips
      .filter((t) => matchesStatementParty(t.partyId, t.partyName) && t.tripStatus !== 'Cancelled')
      .slice()
      .sort((a, b) => a.tripDate.localeCompare(b.tripDate));
    const payments = partyPayments
      .filter((pp) => {
        if (!matchesStatementParty(pp.partyId, pp.partyName)) return false;
        if (!matchesStatementPaymentMethod(pp.paymentMode, statementPaymentMethod)) return false;
        if (statementFromDate && pp.paymentDate && pp.paymentDate < statementFromDate) return false;
        if (statementToDate && pp.paymentDate && pp.paymentDate > statementToDate) return false;
        return true;
      })
      .slice()
      .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
    const filteredPaymentsTotal =
      Math.round(payments.reduce((acc, pp) => acc + (Number(pp.amount) || 0), 0) * 100) / 100;
    const summary = ledgerByParty.get(activeStatementParty.id) || EMPTY_LEDGER_SUMMARY;
    const dateWise = buildDateWisePartyStatement(
      activeStatementParty.id,
      trips,
      partyPayments,
      statementFromDate,
      statementToDate,
      activeStatementParty.partyName,
      statementPaymentMethod
    );
    return { partyTrips, payments, filteredPaymentsTotal, summary, dateWise };
  }, [
    activeStatementParty,
    trips,
    partyPayments,
    ledgerByParty,
    statementFromDate,
    statementToDate,
    statementPaymentMethod,
  ]);

  const openAddDrawer = () => {
    setEditingParty(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (p: Party) => {
    if (!canEditParty) {
      setActionError('Only Administrators can edit existing party details.');
      return;
    }
    setEditingParty(p);
    setForm({
      partyName: p.partyName,
      partyType: p.partyType,
      contactPerson: p.contactPerson,
      phone: p.phone,
      email: p.email,
      gstin: p.gstin,
      city: p.city,
      state: p.state,
      address: p.address,
      paymentTermsDays: String(p.paymentTermsDays ?? 0),
      status: p.status,
      notes: p.notes,
    });
    setFormError(null);
    setDrawerOpen(true);
  };

  const openPaymentDrawer = (preselectParty?: Party, preselectTripId = '') => {
    const target = preselectParty || parties[0];
    setPaymentModalPartyId(target?.id || '');
    setPaymentModalTripId(preselectTripId);
    setPaymentModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const partyName = clampStr(form.partyName, BLUEPRINT_LIMITS.PARTY_NAME_MAX);
    if (partyName.length < BLUEPRINT_LIMITS.PARTY_NAME_MIN) {
      setFormError('Party name must be at least 2 characters.');
      return;
    }

    const cleanGstin = clampStr(form.gstin.toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX);
    const duplicate = findDuplicateParty(parties, partyName, cleanGstin, editingParty?.id);
    if (duplicate) {
      setFormError(
        duplicate.reason === 'gstin'
          ? `Duplicate GSTIN: Party "${duplicate.existing.partyName}" already uses GSTIN ${duplicate.existing.gstin}.`
          : `Duplicate Party: "${duplicate.existing.partyName}" is already registered.`
      );
      return;
    }

    const payload = {
      partyName,
      partyType: form.partyType,
      contactPerson: clampStr(form.contactPerson, BLUEPRINT_LIMITS.CONTACT_PERSON_MAX),
      phone: clampStr(form.phone, BLUEPRINT_LIMITS.PHONE_MAX),
      email: clampStr(form.email, BLUEPRINT_LIMITS.EMAIL_MAX),
      gstin: clampStr(form.gstin.toUpperCase(), BLUEPRINT_LIMITS.GSTIN_MAX),
      city: clampStr(form.city, BLUEPRINT_LIMITS.CITY_MAX),
      state: clampStr(form.state, BLUEPRINT_LIMITS.STATE_MAX),
      address: clampStr(form.address, BLUEPRINT_LIMITS.ADDRESS_MAX),
      paymentTermsDays: clampNum(
        form.paymentTermsDays || '0',
        0,
        BLUEPRINT_LIMITS.PAYMENT_TERMS_MAX
      ),
      status: form.status,
      notes: clampStr(form.notes, BLUEPRINT_LIMITS.NOTES_MAX),
    };

    setSaving(true);
    try {
      if (editingParty) {
        await updateDoc(doc(db, 'parties', editingParty.id), {
          ...payload,
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: editingParty.ownerId || userId,
          actorRole,
          action: 'UPDATE',
          module: 'Parties',
          recordId: editingParty.id,
          summary: `Updated party ${payload.partyName}`,
        });
      } else {
        const newId = generateSafeDocId('pty');
        await setDoc(doc(collection(db, 'parties'), newId), {
          ...payload,
          ownerId: userId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: userId,
          actorRole,
          action: 'CREATE',
          module: 'Parties',
          recordId: newId,
          summary: `Created party ${payload.partyName} (${payload.partyType})`,
        });
      }
      setLastSavedPayment(null);
      setSaveBanner(
        editingParty
          ? `Party "${payload.partyName}" updated successfully.`
          : `Party "${payload.partyName}" added — now available in Trip Entry and Billing.`
      );
      setActionError(null);
      setDrawerOpen(false);
    } catch (error) {
      setFormError(
        extractReadableFirestoreError(
          error,
          editingParty ? 'Update Party' : 'Save New Party'
        )
      );
    } finally {
      setSaving(false);
    }
  };

  const handlePaymentSaved = (saved: SavedPartyPaymentSummary) => {
    setLastSavedPayment(saved);
    setSaveBanner(
      `${saved.paymentType} of ${formatINR(saved.amount)} recorded for "${saved.partyName}"${
        saved.tripLrNumber ? ` (linked to ${saved.tripLrNumber})` : ''
      }. Party outstanding updated automatically.`
    );
    setActionError(null);
  };

  const openWhatsAppPaymentReceipt = (params: {
    partyId: string;
    partyName: string;
    paymentDate: string;
    amount: number;
    paymentMode: string;
    paymentType: string;
    referenceNo?: string;
    tripLrNumber?: string;
    fallbackRemainingBalance?: number;
  }) => {
    const matchedParty =
      parties.find((p) => p.id === params.partyId) ||
      parties.find((p) => normalizeNameKey(p.partyName) === normalizeNameKey(params.partyName));
    const liveLedger = matchedParty ? ledgerByParty.get(matchedParty.id) : undefined;
    const remainingBalance =
      liveLedger !== undefined
        ? liveLedger.netOutstanding
        : params.fallbackRemainingBalance ?? 0;

    const message = buildPaymentReceiptWhatsAppMessage({
      companyName: companySettings?.companyName || 'BAPASITARAM ENTERPRISE',
      partyName: matchedParty?.partyName || params.partyName,
      amount: params.amount,
      paymentDate: params.paymentDate,
      paymentMode: params.paymentMode,
      paymentType: params.paymentType,
      referenceNo: params.referenceNo,
      tripLrNumber: params.tripLrNumber,
      remainingBalance,
    });

    setWhatsAppModal({
      title: 'Share Payment Receipt via WhatsApp',
      subtitle: 'Review the party mobile number and receipt details before pressing Send in WhatsApp.',
      partyName: matchedParty?.partyName || params.partyName,
      partyPhone: matchedParty?.phone || '',
      message,
    });
  };

  const openWhatsAppPaymentReminder = (party: Party) => {
    const summary = ledgerByParty.get(party.id) || EMPTY_LEDGER_SUMMARY;
    const linkedTotals = computeTripLinkedPaymentTotals(party.id, partyPayments, party.partyName);
    const fallbackNameKey = normalizeNameKey(party.partyName);
    const pendingTrips: PendingTripDueItem[] = trips
      .filter((t) => {
        if (t.tripStatus === 'Cancelled') return false;
        return (
          t.partyId === party.id ||
          (!t.partyId && fallbackNameKey !== '' && normalizeNameKey(t.partyName) === fallbackNameKey)
        );
      })
      .map((t) => {
        const linked = linkedTotals.get(t.id) || 0;
        const hasExplicit = typeof t.balanceAmount === 'number' && Number.isFinite(t.balanceAmount);
        const baseBalance = hasExplicit
          ? t.balanceAmount
          : Math.round(((Number(t.freightAmount) || 0) - (Number(t.advanceReceived) || 0)) * 100) /
            100;
        const remainingDue = Math.max(0, Math.round((baseBalance - linked) * 100) / 100);
        return {
          lrNumber: t.lrNumber,
          tripDate: t.tripDate,
          vehicleNumber: t.vehicleNumber,
          remainingDue,
        };
      })
      .filter((item) => item.remainingDue > 0);

    const message = buildPaymentReminderWhatsAppMessage({
      companySettings,
      partyName: party.partyName,
      outstandingBalance: summary.netOutstanding,
      totalFreight: summary.totalFreight,
      totalPaid: summary.totalCredited,
      paymentTermsDays: party.paymentTermsDays,
      pendingTrips,
      todayISO: getTodayISO(),
    });

    setWhatsAppModal({
      title: 'Send Payment Reminder via WhatsApp',
      subtitle: 'Review outstanding balance and due details before pressing Send manually in WhatsApp.',
      partyName: party.partyName,
      partyPhone: party.phone || '',
      message,
    });
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteDoc(doc(db, 'parties', deleteTarget.id));
      await recordAuditLog({
        ownerId: deleteTarget.ownerId || userId,
        actorRole,
        action: 'DELETE',
        module: 'Parties',
        recordId: deleteTarget.id,
        summary: `Removed party ${deleteTarget.partyName}`,
      });
      if (inspectParty?.id === deleteTarget.id) {
        setInspectParty(null);
      }
      setLastSavedPayment(null);
      setSaveBanner(`Party "${deleteTarget.partyName}" removed.`);
      setDeleteTarget(null);
    } catch (error) {
      setActionError(extractReadableFirestoreError(error, 'Delete Party'));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const handleConfirmDeletePayment = async () => {
    if (!deletePaymentTarget) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteDoc(doc(db, 'partyPayments', deletePaymentTarget.id));
      await recordAuditLog({
        ownerId: deletePaymentTarget.ownerId || userId,
        actorRole,
        action: 'DELETE',
        module: 'Party Payments',
        recordId: deletePaymentTarget.id,
        summary: `Deleted ${deletePaymentTarget.paymentType} (${formatINR(deletePaymentTarget.amount)}) for ${deletePaymentTarget.partyName}`,
      });
      setLastSavedPayment(null);
      setSaveBanner(
        `Removed payment voucher (${formatINR(deletePaymentTarget.amount)}) for "${deletePaymentTarget.partyName}".`
      );
      setDeletePaymentTarget(null);
    } catch (error) {
      setActionError(extractReadableFirestoreError(error, 'Delete Party Payment'));
      setDeletePaymentTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const getStatementFileName = (party: Party) => {
    const cleanName = party.partyName
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'Party';
    const methodSuffix = statementPaymentMethod !== 'All' ? `-${statementPaymentMethod}` : '';
    return `Party-Statement-${cleanName}${methodSuffix}-${getTodayISO()}.pdf`;
  };

  const handlePreviewStatementPdf = async () => {
    if (!activeStatementParty || !statementPrintRef.current) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const preview = await renderElementToA4Pdf(
        statementPrintRef.current,
        getStatementFileName(activeStatementParty)
      );
      setRenderedPdfPreview(preview);
    } catch (err) {
      setPdfError(extractReadableFirestoreError(err, 'Preview Party Statement PDF'));
    } finally {
      setPdfBusy(false);
    }
  };

  const handleDownloadStatementPdf = async () => {
    if (!activeStatementParty || !statementPrintRef.current) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      await downloadElementAsA4Pdf(
        statementPrintRef.current,
        getStatementFileName(activeStatementParty)
      );
    } catch (err) {
      setPdfError(extractReadableFirestoreError(err, 'Download Party Statement PDF'));
    } finally {
      setPdfBusy(false);
    }
  };

  const handleDirectDownloadStatement = async (party: Party) => {
    setDownloadingStatement(true);
    setStatementDownloadError(null);
    try {
      const result = await downloadPartyStatementPdf({
        party,
        trips,
        partyPayments,
        bills,
        companySettings,
        paymentMethodFilter: ledgerPaymentMethod,
      });
      setLastSavedPayment(null);
      setSaveBanner(
        `Statement PDF "${result.fileName}" downloaded for ${party.partyName}${
          ledgerPaymentMethod !== 'All' ? ` (${ledgerPaymentMethod} filter)` : ''
        } (Outstanding: ${formatINR(result.summary.netOutstanding)}).`
      );
    } catch (err) {
      setStatementDownloadError(
        extractReadableFirestoreError(err, 'Download Party Statement PDF')
      );
    } finally {
      setDownloadingStatement(false);
    }
  };

  const bankSummaryLine = useMemo(() => {
    if (!companySettings) return '';
    return [
      companySettings.bankName && `Bank: ${companySettings.bankName}`,
      companySettings.accountHolderName && `A/c Name: ${companySettings.accountHolderName}`,
      companySettings.accountNumber && `A/c No: ${companySettings.accountNumber}`,
      companySettings.ifscCode && `IFSC: ${companySettings.ifscCode}`,
      companySettings.branchName && `Branch: ${companySettings.branchName}`,
    ]
      .filter(Boolean)
      .join(' | ');
  }, [companySettings]);

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 no-print">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search party, GSTIN, city, contact..."
              className="w-full pl-9 pr-3 py-2 min-h-[40px] text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
            {(['All', ...PARTY_TYPES] as const).map((pt) => (
              <button
                key={pt}
                type="button"
                onClick={() => setTypeFilter(pt)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  typeFilter === pt
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {pt}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {parties.length > 0 && canRecordPayments && (
            <button
              type="button"
              onClick={() => openPaymentDrawer()}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 min-h-[40px] bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <IndianRupee className="w-4 h-4" />
              <span>Add Payment</span>
            </button>
          )}
          {canAddParty && (
            <button
              type="button"
              onClick={openAddDrawer}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add New Party</span>
            </button>
          )}
        </div>
      </div>

      {saveBanner && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs sm:text-sm text-emerald-900 flex flex-wrap items-center justify-between gap-3 no-print">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{saveBanner}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {lastSavedPayment && (
              <button
                type="button"
                onClick={() =>
                  openWhatsAppPaymentReceipt({
                    partyId: lastSavedPayment.partyId,
                    partyName: lastSavedPayment.partyName,
                    paymentDate: lastSavedPayment.paymentDate,
                    amount: lastSavedPayment.amount,
                    paymentMode: lastSavedPayment.paymentMode,
                    paymentType: lastSavedPayment.paymentType,
                    referenceNo: lastSavedPayment.referenceNo,
                    tripLrNumber: lastSavedPayment.tripLrNumber,
                    fallbackRemainingBalance: lastSavedPayment.remainingBalance,
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors cursor-pointer"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                <span>WhatsApp Share</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSaveBanner(null);
                setLastSavedPayment(null);
              }}
              className="p-1 text-emerald-700 hover:text-emerald-950 cursor-pointer"
              aria-label="Dismiss notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700 no-print"
        >
          {actionError}
        </div>
      )}

      {/* Real-Time Party Ledger Totals Strip */}
      {!loading && parties.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 no-print">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">Total Freight Bills</div>
            <div className="mt-1 font-mono text-lg font-semibold text-slate-900 tabular-nums">
              {formatINR(directoryTotals.totalFreight)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {directoryTotals.tripCount} active trips across {filteredParties.length}{' '}
              {filteredParties.length === 1 ? 'party' : 'parties'}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">Total Payments Received</div>
            <div className="mt-1 font-mono text-lg font-semibold text-emerald-700 tabular-nums">
              {formatINR(directoryTotals.totalCredited)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              Party Payments: {formatINR(directoryTotals.totalPartyPayments, true)} (
              {directoryTotals.paymentCount}) · Trip Jama:{' '}
              {formatINR(directoryTotals.totalTripAdvance, true)}
              {directoryTotals.totalDeductions > 0
                ? ` · Ded: ${formatINR(directoryTotals.totalDeductions, true)}`
                : ''}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">Real-Time Outstanding Balance</div>
            <div
              className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
                directoryTotals.totalOutstanding > 0 ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              {formatINR(directoryTotals.totalOutstanding)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {directoryTotals.pendingPartyCount}{' '}
              {directoryTotals.pendingPartyCount === 1 ? 'party' : 'parties'} with pending dues
            </div>
          </div>
        </div>
      )}

      {/* Party Directory Table / Cards */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden no-print">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : parties.length === 0 ? (
          <div className="p-10 sm:p-14 text-center">
            <Users className="w-9 h-9 text-slate-300 mx-auto" />
            <h3 className="mt-3 text-base font-semibold text-slate-900">
              No Parties Registered Yet
            </h3>
            <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
              Add your consignor, consignee, or transport broker accounts with GSTIN and credit terms to track freight billing and ledgers in INR.
            </p>
            {permissions.canManageMasters && (
              <button
                type="button"
                onClick={openAddDrawer}
                className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Add New Party</span>
              </button>
            )}
          </div>
        ) : filteredParties.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No parties match your current search or filter.
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500">
                    <th className="py-3 px-4 whitespace-nowrap">Party Name</th>
                    <th className="py-3 px-4 whitespace-nowrap">Type &amp; GSTIN</th>
                    <th className="py-3 px-4 whitespace-nowrap">Contact &amp; Location</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Trips</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Total Freight Bills</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Payments Received</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Outstanding Balance</th>
                    <th className="py-3 px-4 whitespace-nowrap">Status</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredParties.map((p) => {
                    const ledger = ledgerByParty.get(p.id) || EMPTY_LEDGER_SUMMARY;
                    return (
                      <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-4">
                          <div className="text-xs font-semibold text-slate-900">
                            {p.partyName}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Terms: {p.paymentTermsDays} days
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-xs font-medium text-slate-700">{p.partyType}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {p.gstin || 'No GSTIN'}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-xs text-slate-800">
                            {p.contactPerson || '—'} {p.phone ? `· ${p.phone}` : ''}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {[p.city, p.state].filter(Boolean).join(', ') || '—'}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs text-slate-700 tabular-nums">
                          {ledger.tripCount}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                          {formatINR(ledger.totalFreight)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="font-mono text-xs text-emerald-700 tabular-nums">
                            {formatINR(ledger.totalCredited)}
                          </div>
                          {ledger.paymentCount > 0 && (
                            <div className="text-[10px] text-slate-500">
                              {formatINR(ledger.partyPaymentsTotal, true)} ({ledger.paymentCount}{' '}
                              {ledger.paymentCount === 1 ? 'payment' : 'payments'}
                              {ledger.deductionsTotal > 0
                                ? `, incl. ${formatINR(ledger.deductionsTotal, true)} ded.`
                                : ''}
                              )
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                          <span
                            className={
                              ledger.netOutstanding > 0
                                ? 'text-amber-700 font-medium'
                                : 'text-emerald-700 font-medium'
                            }
                          >
                            {formatINR(ledger.netOutstanding)}
                          </span>
                          {ledger.netOutstanding < 0 && (
                            <div className="text-[10px] text-emerald-700 font-sans">Adv. Credit</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs whitespace-nowrap">
                          <span
                            className={
                              p.status === 'Active'
                                ? 'text-emerald-700 font-medium'
                                : 'text-slate-500 font-medium'
                            }
                          >
                            {p.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {canRecordPayments && (
                              <button
                                type="button"
                                onClick={() => openPaymentDrawer(p)}
                                title={`Record payment for ${p.partyName}`}
                                aria-label={`Record payment for ${p.partyName}`}
                                className="p-2 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors cursor-pointer"
                              >
                                <IndianRupee className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setInspectParty(p)}
                              aria-label={`View ledger for ${p.partyName}`}
                              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {canEditParty && (
                              <button
                                type="button"
                                onClick={() => openEditDrawer(p)}
                                aria-label={`Edit ${p.partyName}`}
                                className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                            )}
                            {permissions.canDeleteRecords && (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(p)}
                                aria-label={`Delete ${p.partyName}`}
                                className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 border-t border-slate-200 text-xs font-semibold text-slate-900">
                  <tr>
                    <td className="py-3 px-4" colSpan={3}>
                      Total ({filteredParties.length}{' '}
                      {filteredParties.length === 1 ? 'Party' : 'Parties'})
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {directoryTotals.tripCount}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                      {formatINR(directoryTotals.totalFreight)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-700 whitespace-nowrap">
                      {formatINR(directoryTotals.totalCredited)}
                    </td>
                    <td
                      className={`py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap ${
                        directoryTotals.totalOutstanding > 0 ? 'text-amber-700' : 'text-emerald-700'
                      }`}
                    >
                      {formatINR(directoryTotals.totalOutstanding)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile Card List */}
            <div className="md:hidden divide-y divide-slate-200">
              {filteredParties.map((p) => {
                const ledger = ledgerByParty.get(p.id) || EMPTY_LEDGER_SUMMARY;
                return (
                  <div key={p.id} className="p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 truncate">
                          {p.partyName}
                        </div>
                        <div className="text-xs text-slate-500">
                          {p.partyType} {p.gstin ? `· ${p.gstin}` : ''}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-semibold shrink-0 ${
                          p.status === 'Active' ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {p.status}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                      {p.phone && (
                        <span className="inline-flex items-center gap-1 font-mono">
                          <Phone className="w-3 h-3" />
                          {p.phone}
                        </span>
                      )}
                      {(p.city || p.state) && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {[p.city, p.state].filter(Boolean).join(', ')}
                        </span>
                      )}
                    </div>

                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs tabular-nums">
                      <span className="text-slate-500">
                        {ledger.tripCount} trips · {ledger.paymentCount} pay
                      </span>
                      <span className="font-mono font-medium text-slate-900">
                        Bill: {formatINR(ledger.totalFreight, true)} · Paid:{' '}
                        {formatINR(ledger.totalCredited, true)} · Bal:{' '}
                        {formatINR(ledger.netOutstanding, true)}
                      </span>
                    </div>

                    <div className="pt-1 flex flex-wrap items-center justify-end gap-2">
                      {canRecordPayments && (
                        <button
                          type="button"
                          onClick={() => openPaymentDrawer(p)}
                          className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg cursor-pointer"
                        >
                          + Add Payment
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setInspectParty(p)}
                        className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                      >
                        Ledger
                      </button>
                      {canEditParty && (
                        <button
                          type="button"
                          onClick={() => openEditDrawer(p)}
                          className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                        >
                          Edit
                        </button>
                      )}
                      {permissions.canDeleteRecords && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(p)}
                          className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg cursor-pointer"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Add / Edit Party Slide-Over Drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 no-print"
          role="dialog"
          aria-modal="true"
          aria-labelledby="party-drawer-title"
        >
          <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 id="party-drawer-title" className="font-display text-lg font-semibold text-slate-900">
                {editingParty ? 'Edit Party Account' : 'Add Party Account'}
              </h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close form"
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4 flex-1">
              {formError && (
                <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700">
                  {formError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Party / Business Name *
                </label>
                <input
                  type="text"
                  required
                  minLength={BLUEPRINT_LIMITS.PARTY_NAME_MIN}
                  maxLength={BLUEPRINT_LIMITS.PARTY_NAME_MAX}
                  value={form.partyName}
                  onChange={(e) => setForm({ ...form, partyName: e.target.value })}
                  placeholder="Shree Ceramic & Minerals Pvt Ltd"
                  className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Party Type *
                  </label>
                  <select
                    value={form.partyType}
                    onChange={(e) =>
                      setForm({ ...form, partyType: e.target.value as PartyType })
                    }
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  >
                    {PARTY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    GSTIN (15-Char)
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.GSTIN_MAX}
                    value={form.gstin}
                    onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
                    placeholder="24AABCS1429B1ZS"
                    className="w-full px-3 py-2.5 text-sm font-mono uppercase bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Contact Person
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.CONTACT_PERSON_MAX}
                    value={form.contactPerson}
                    onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                    placeholder="Kishorebhai Mehta"
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+91 98250 00000"
                    className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Billing Email
                  </label>
                  <input
                    type="email"
                    maxLength={BLUEPRINT_LIMITS.EMAIL_MAX}
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="accounts@company.in"
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Credit Terms (Days)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max={BLUEPRINT_LIMITS.PAYMENT_TERMS_MAX}
                    value={form.paymentTermsDays}
                    onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">City</label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.CITY_MAX}
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    placeholder="Morbi"
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">State</label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.STATE_MAX}
                    value={form.state}
                    onChange={(e) => setForm({ ...form, state: e.target.value })}
                    placeholder="Gujarat"
                    className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Billing Address
                </label>
                <input
                  type="text"
                  maxLength={BLUEPRINT_LIMITS.ADDRESS_MAX}
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Plot 12, Industrial Estate, 8A National Highway"
                  className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as PartyStatus })}
                  className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                >
                  {PARTY_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Notes</label>
                <textarea
                  rows={2}
                  maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Billing preferences or dispatch instructions..."
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  disabled={saving}
                  className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Saving...' : editingParty ? 'Update Party' : 'Save Party'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reusable Add Payment Modal */}
      <AddPaymentModal
        open={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        userId={userId}
        actorRole={actorRole}
        parties={parties}
        trips={trips}
        partyPayments={partyPayments}
        initialPartyId={paymentModalPartyId}
        initialTripId={paymentModalTripId}
        companyName={companySettings?.companyName || 'BAPASITARAM ENTERPRISE'}
        ledgerByParty={ledgerByParty}
        duplicateChecker={findDuplicatePartyPayment}
        onPaymentSaved={handlePaymentSaved}
      />

      {/* Complete Party Ledger & Payment History Drawer */}
      {activeInspectParty && inspectLedger && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 no-print"
          role="dialog"
          aria-modal="true"
          aria-labelledby="party-ledger-title"
        >
          <div className="w-full max-w-4xl bg-white h-full overflow-y-auto shadow-xl flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 sticky top-0 bg-white z-10">
              <div className="min-w-0">
                <h2 id="party-ledger-title" className="font-display text-lg font-semibold text-slate-900 truncate">
                  {activeInspectParty.partyName} — Party Ledger
                </h2>
                <p className="text-xs text-slate-500">
                  {activeInspectParty.partyType}{' '}
                  {activeInspectParty.gstin ? `· GSTIN: ${activeInspectParty.gstin}` : ''} · Terms:{' '}
                  {activeInspectParty.paymentTermsDays} days
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {canRecordPayments && (
                  <button
                    type="button"
                    onClick={() => openPaymentDrawer(activeInspectParty)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                  >
                    <IndianRupee className="w-3.5 h-3.5" />
                    <span>Add Payment</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openWhatsAppPaymentReminder(activeInspectParty)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>WhatsApp Reminder</span>
                </button>
                <button
                  type="button"
                  disabled={downloadingStatement}
                  onClick={() => handleDirectDownloadStatement(activeInspectParty)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{downloadingStatement ? 'Generating PDF...' : 'Download Statement'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPdfError(null);
                    setStatementFromDate('');
                    setStatementToDate('');
                    setStatementPaymentMethod(ledgerPaymentMethod);
                    setStatementParty(activeInspectParty);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Print / PDF Statement</span>
                </button>
                {permissions.canManageBilling && (
                  <button
                    type="button"
                    onClick={() => {
                      const pId = activeInspectParty.id;
                      setInspectParty(null);
                      onGenerateBillForParty(pId);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                  >
                    <ReceiptText className="w-3.5 h-3.5" />
                    <span>Generate Party Bill</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setStatementDownloadError(null);
                    setLedgerPaymentMethod('All');
                    setInspectParty(null);
                  }}
                  aria-label="Close party ledger"
                  className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {lastSavedPayment && lastSavedPayment.partyId === activeInspectParty.id && (
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span>
                      Recorded {lastSavedPayment.paymentType} of{' '}
                      <span className="font-mono font-semibold">
                        {formatINR(lastSavedPayment.amount)}
                      </span>{' '}
                      ({lastSavedPayment.paymentMode}).
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        openWhatsAppPaymentReceipt({
                          partyId: lastSavedPayment.partyId,
                          partyName: lastSavedPayment.partyName,
                          paymentDate: lastSavedPayment.paymentDate,
                          amount: lastSavedPayment.amount,
                          paymentMode: lastSavedPayment.paymentMode,
                          paymentType: lastSavedPayment.paymentType,
                          referenceNo: lastSavedPayment.referenceNo,
                          tripLrNumber: lastSavedPayment.tripLrNumber,
                          fallbackRemainingBalance: lastSavedPayment.remainingBalance,
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      <span>WhatsApp Share</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setLastSavedPayment(null)}
                      aria-label="Dismiss payment receipt banner"
                      className="p-1 text-emerald-700 hover:text-emerald-950 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
              {statementDownloadError && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700"
                >
                  {statementDownloadError}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Total Freight &amp; Bills</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                    {formatINR(inspectLedger.summary.totalFreight)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {inspectLedger.summary.tripCount} trips · {inspectLedger.billSummary.count} bills
                  </div>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Payments Received</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-emerald-700 tabular-nums">
                    {formatINR(
                      inspectLedger.summary.paymentsReceivedTotal +
                        inspectLedger.summary.tripAdvanceReceived
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    Trip Jama {formatINR(inspectLedger.summary.tripAdvanceReceived, true)} + Receipts{' '}
                    {formatINR(inspectLedger.summary.paymentsReceivedTotal, true)}
                  </div>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Advance Payments</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-emerald-700 tabular-nums">
                    {formatINR(inspectLedger.summary.ledgerAdvancesTotal)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    On-account advances
                  </div>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-[11px] font-medium text-slate-500">Deductions / TDS</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-slate-700 tabular-nums">
                    {formatINR(inspectLedger.summary.deductionsTotal)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {inspectLedger.summary.paymentCount} ledger vouchers
                  </div>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl col-span-2 sm:col-span-1">
                  <div className="text-[11px] font-medium text-slate-500">Remaining Outstanding</div>
                  <div
                    className={`mt-1 font-mono text-sm font-semibold tabular-nums ${
                      inspectLedger.summary.netOutstanding > 0 ? 'text-amber-700' : 'text-emerald-700'
                    }`}
                  >
                    {formatINR(inspectLedger.summary.netOutstanding)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {inspectLedger.summary.netOutstanding < 0 ? (
                      <span className="text-emerald-700 font-medium">Advance Credit</span>
                    ) : (
                      <span>Freight − Payments</span>
                    )}
                  </div>
                </div>
              </div>

              {(activeInspectParty.address || activeInspectParty.phone || activeInspectParty.email) && (
                <div className="p-4 bg-white border border-slate-200 rounded-xl text-xs text-slate-600 space-y-1">
                  {activeInspectParty.address && (
                    <div>
                      <span className="font-medium text-slate-800">Address:</span> {activeInspectParty.address}{' '}
                      {[activeInspectParty.city, activeInspectParty.state].filter(Boolean).join(', ')}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-6 gap-y-1">
                    {activeInspectParty.contactPerson && (
                      <span>
                        <span className="font-medium text-slate-800">Contact:</span> {activeInspectParty.contactPerson}
                      </span>
                    )}
                    {activeInspectParty.phone && (
                      <span className="font-mono">
                        <span className="font-sans font-medium text-slate-800">Phone:</span> {activeInspectParty.phone}
                      </span>
                    )}
                    {activeInspectParty.email && (
                      <span>
                        <span className="font-medium text-slate-800">Email:</span> {activeInspectParty.email}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Payment History */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                  <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                    Payment &amp; Advance History ({inspectLedger.payments.length}
                    {ledgerPaymentMethod !== 'All'
                      ? ` of ${inspectLedger.allPayments.length} · ${ledgerPaymentMethod}`
                      : ''}
                    )
                  </h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Filter party payments by method"
                      value={ledgerPaymentMethod}
                      onChange={(e) =>
                        setLedgerPaymentMethod(e.target.value as StatementPaymentMethodFilter)
                      }
                      className="px-2.5 py-1 text-xs bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:border-slate-900 cursor-pointer"
                    >
                      {STATEMENT_PAYMENT_METHOD_FILTERS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    {canRecordPayments && (
                      <button
                        type="button"
                        onClick={() => openPaymentDrawer(activeInspectParty)}
                        className="text-xs font-medium text-slate-700 hover:text-slate-900 underline cursor-pointer"
                      >
                        + Add Payment
                      </button>
                    )}
                  </div>
                </div>

                {inspectLedger.payments.length === 0 ? (
                  <p className="text-xs text-slate-500 p-4 border border-slate-200 rounded-lg">
                    {ledgerPaymentMethod !== 'All'
                      ? `No ${ledgerPaymentMethod} payments recorded for this party yet.`
                      : 'No separate payment receipts recorded yet. Direct trip-level Jama entries remain visible below.'}
                  </p>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                          <th className="py-2 px-3 whitespace-nowrap">Date</th>
                          <th className="py-2 px-3 whitespace-nowrap">Type</th>
                          <th className="py-2 px-3 whitespace-nowrap">Mode</th>
                          <th className="py-2 px-3 whitespace-nowrap">Reference / Trip</th>
                          <th className="py-2 px-3">Notes</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Amount</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inspectLedger.payments.map((pp) => (
                          <tr key={pp.id}>
                            <td className="py-2 px-3 font-mono whitespace-nowrap">
                              {formatDateIN(pp.paymentDate)}
                            </td>
                            <td className="py-2 px-3 font-medium text-slate-900 whitespace-nowrap">
                              {pp.paymentType}
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap text-slate-700">
                              {pp.paymentMode}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-600 whitespace-nowrap">
                              <div>{pp.referenceNo || '—'}</div>
                              {pp.tripLrNumber && (
                                <div className="text-[10px] text-slate-500">Trip: {pp.tripLrNumber}</div>
                              )}
                            </td>
                            <td className="py-2 px-3 text-slate-600 max-w-[200px] truncate">
                              {pp.notes || '—'}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums text-emerald-700 whitespace-nowrap">
                              {formatINR(pp.amount)}
                            </td>
                            <td className="py-2 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    openWhatsAppPaymentReceipt({
                                      partyId: activeInspectParty.id,
                                      partyName: activeInspectParty.partyName,
                                      paymentDate: pp.paymentDate,
                                      amount: pp.amount,
                                      paymentMode: pp.paymentMode,
                                      paymentType: pp.paymentType,
                                      referenceNo: pp.referenceNo,
                                      tripLrNumber: pp.tripLrNumber,
                                      fallbackRemainingBalance: inspectLedger.summary.netOutstanding,
                                    })
                                  }
                                  title="Share payment receipt on WhatsApp"
                                  aria-label={`Share payment receipt ${pp.referenceNo || pp.paymentDate} via WhatsApp`}
                                  className="p-1 text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50 rounded cursor-pointer"
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                </button>
                                {permissions.canDeleteRecords && (
                                  <button
                                    type="button"
                                    onClick={() => setDeletePaymentTarget(pp)}
                                    aria-label={`Delete payment ${pp.referenceNo || pp.paymentDate}`}
                                    className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold text-slate-900">
                        <tr>
                          <td className="py-2 px-3" colSpan={5}>
                            {ledgerPaymentMethod !== 'All'
                              ? `Total ${ledgerPaymentMethod} Payments (${inspectLedger.payments.length})`
                              : `Total Logged Payments & Adjustments (${inspectLedger.payments.length})`}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-emerald-700 whitespace-nowrap">
                            {formatINR(inspectLedger.filteredPaymentsTotal)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>

              {/* Trip-Wise Freight Ledger */}
              <div>
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2.5">
                  Party-Wise Trip Transaction History ({inspectLedger.partyTrips.length})
                </h3>
                {inspectLedger.partyTrips.length === 0 ? (
                  <p className="text-xs text-slate-500 p-4 border border-slate-200 rounded-lg">
                    No trips recorded for this party yet.
                  </p>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                          <th className="py-2 px-3 whitespace-nowrap">Sr / Date</th>
                          <th className="py-2 px-3 whitespace-nowrap">LR / Container</th>
                          <th className="py-2 px-3 whitespace-nowrap">Vehicle &amp; Route</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Rate</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Trip Jama</th>
                          <th className="py-2 px-3 whitespace-nowrap text-right">Trip Hisab</th>
                          <th className="py-2 px-3 whitespace-nowrap">Status</th>
                          {canRecordPayments && (
                            <th className="py-2 px-3 whitespace-nowrap text-right">Pay</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inspectLedger.partyTrips.map((t, idx) => {
                          const linkedPaid = inspectLedger.tripLinkedTotals.get(t.id) || 0;
                          const hasExplicitTripBalance =
                            typeof t.balanceAmount === 'number' && Number.isFinite(t.balanceAmount);
                          const baseTripBalance = hasExplicitTripBalance
                            ? t.balanceAmount
                            : Math.round(
                                ((Number(t.freightAmount) || 0) - (Number(t.advanceReceived) || 0)) *
                                  100
                              ) / 100;
                          const netTripPending = Math.max(
                            0,
                            Math.round((baseTripBalance - linkedPaid) * 100) / 100
                          );
                          return (
                            <tr key={t.id}>
                              <td className="py-2 px-3 whitespace-nowrap">
                                <div className="font-mono text-slate-900">
                                  #{t.srNo || idx + 1} · {formatDateIN(t.tripDate)}
                                </div>
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">
                                <div className="font-mono text-slate-900">{t.lrNumber}</div>
                                {t.containerNo && (
                                  <div className="text-[11px] font-mono text-slate-500">{t.containerNo}</div>
                                )}
                              </td>
                              <td className="py-2 px-3">
                                <div className="font-mono text-slate-800">{t.vehicleNumber}</div>
                                <div className="text-[11px] text-slate-500 truncate max-w-[180px]">
                                  {t.origin} → {t.destination}
                                </div>
                              </td>
                              <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-900">
                                {formatINR(t.freightAmount)}
                              </td>
                              <td className="py-2 px-3 text-right font-mono tabular-nums text-emerald-700">
                                <div>{formatINR(t.advanceReceived)}</div>
                                {linkedPaid > 0 && (
                                  <div className="text-[10px] text-emerald-700">
                                    +{formatINR(linkedPaid, true)} linked
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right font-mono tabular-nums text-amber-700 font-medium">
                                <div>{formatINR(netTripPending)}</div>
                                {linkedPaid > 0 && (
                                  <div className="text-[10px] text-slate-500">
                                    Orig: {formatINR(baseTripBalance, true)}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">{t.tripStatus}</td>
                              {canRecordPayments && (
                                <td className="py-2 px-3 text-right">
                                  {t.tripStatus !== 'Cancelled' && netTripPending > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => openPaymentDrawer(activeInspectParty, t.id)}
                                      className="px-2 py-1 text-[11px] font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded cursor-pointer"
                                    >
                                      Pay
                                    </button>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold text-slate-900">
                        <tr>
                          <td className="py-2 px-3" colSpan={3}>
                            Active Trip Totals ({inspectLedger.summary.tripCount})
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">
                            {formatINR(inspectLedger.summary.totalFreight)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-emerald-700">
                            {formatINR(inspectLedger.summary.tripAdvanceReceived)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-amber-700">
                            {formatINR(inspectLedger.summary.tripHisabBalance)}
                          </td>
                          <td colSpan={canRecordPayments ? 2 : 1} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Printable / A4 PDF Party Account Statement Modal */}
      {activeStatementParty && statementData && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 overflow-y-auto p-4 sm:p-8 flex justify-center items-start print-modal-root">
          <div className="bg-white w-full max-w-4xl rounded-xl shadow-2xl overflow-hidden print-modal-sheet">
            <div className="px-6 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50 no-print">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-slate-700">
                  Date-Wise Party Statement — {activeStatementParty.partyName}
                </span>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <select
                    aria-label="Filter statement by payment method"
                    value={statementPaymentMethod}
                    onChange={(e) =>
                      setStatementPaymentMethod(e.target.value as StatementPaymentMethodFilter)
                    }
                    className="px-2 py-1 border border-slate-200 rounded bg-white text-[11px] font-medium text-slate-700 focus:outline-none focus:border-slate-900 cursor-pointer"
                  >
                    {STATEMENT_PAYMENT_METHOD_FILTERS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    aria-label="Statement From Date"
                    value={statementFromDate}
                    onChange={(e) => setStatementFromDate(e.target.value)}
                    className="px-2 py-1 border border-slate-200 rounded bg-white font-mono text-[11px]"
                  />
                  <span className="text-slate-400">to</span>
                  <input
                    type="date"
                    aria-label="Statement To Date"
                    value={statementToDate}
                    onChange={(e) => setStatementToDate(e.target.value)}
                    className="px-2 py-1 border border-slate-200 rounded bg-white font-mono text-[11px]"
                  />
                  {(statementFromDate || statementToDate || statementPaymentMethod !== 'All') && (
                    <button
                      type="button"
                      onClick={() => {
                        setStatementFromDate('');
                        setStatementToDate('');
                        setStatementPaymentMethod('All');
                      }}
                      className="px-2 py-1 text-[11px] text-slate-600 hover:text-slate-900 underline cursor-pointer"
                    >
                      Reset Filters
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handlePreviewStatementPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Rendering...' : 'Preview A4 PDF'}</span>
                </button>
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handleDownloadStatementPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Generating PDF...' : 'Download PDF'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => triggerPrintPreview()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Statement</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPdfError(null);
                    setRenderedPdfPreview(null);
                    setStatementPaymentMethod('All');
                    setStatementParty(null);
                  }}
                  aria-label="Close statement preview"
                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {pdfError && (
              <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 no-print">
                {pdfError}
              </div>
            )}

            <div
              id="party-statement-a4-content"
              ref={statementPrintRef}
              className="p-8 space-y-6 text-slate-900 bg-white"
            >
              {/* Company & Statement Header */}
              <div className="flex flex-col sm:flex-row sm:justify-between gap-4 border-b-2 border-slate-900 pb-4">
                <div>
                  <h2 className="font-display text-2xl font-bold tracking-tight">
                    {companySettings?.companyName || 'BAPASITARAM ENTERPRISE'}
                  </h2>
                  {companySettings?.address && (
                    <p className="text-xs text-slate-600 mt-1">{companySettings.address}</p>
                  )}
                  <div className="text-xs text-slate-600 mt-1 space-x-3 font-mono">
                    {companySettings?.gstin && <span>GSTIN: {companySettings.gstin}</span>}
                    {companySettings?.pan && <span>PAN: {companySettings.pan}</span>}
                    {companySettings?.phone && <span>Ph: {companySettings.phone}</span>}
                  </div>
                </div>
                <div className="sm:text-right">
                  <div className="text-sm font-bold uppercase tracking-wider text-slate-700">
                    Date-Wise Party Account Statement
                  </div>
                  <div className="text-xs text-slate-600 font-mono mt-1">
                    Generated: {formatDateIN(getTodayISO())}
                  </div>
                  {(statementFromDate || statementToDate) && (
                    <div className="text-xs text-slate-700 font-mono">
                      Period: {statementFromDate ? formatDateIN(statementFromDate) : 'Start'} to{' '}
                      {statementToDate ? formatDateIN(statementToDate) : 'Today'}
                    </div>
                  )}
                  {statementPaymentMethod !== 'All' && (
                    <div className="text-xs font-semibold text-emerald-800">
                      Payment Method Filter: {statementPaymentMethod}
                    </div>
                  )}
                  <div className="text-xs text-slate-600">
                    Credit Terms: {activeStatementParty.paymentTermsDays} days
                  </div>
                </div>
              </div>

              {/* Party Block */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 border border-slate-300 rounded-lg text-xs space-y-1">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                    Account Holder
                  </div>
                  <div className="text-sm font-bold">{activeStatementParty.partyName}</div>
                  <div className="text-slate-600">{activeStatementParty.partyType}</div>
                  {activeStatementParty.address && (
                    <div className="text-slate-700">
                      {activeStatementParty.address}{' '}
                      {[activeStatementParty.city, activeStatementParty.state]
                        .filter(Boolean)
                        .join(', ')}
                    </div>
                  )}
                  {activeStatementParty.gstin && (
                    <div className="font-mono text-slate-700">
                      GSTIN: {activeStatementParty.gstin}
                    </div>
                  )}
                  {(activeStatementParty.contactPerson || activeStatementParty.phone) && (
                    <div className="text-slate-700">
                      {activeStatementParty.contactPerson}{' '}
                      {activeStatementParty.phone ? `· ${activeStatementParty.phone}` : ''}
                    </div>
                  )}
                </div>

                <div className="p-4 border border-slate-300 rounded-lg text-xs space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                    Overall Account Summary
                  </div>
                  <div className="flex justify-between">
                    <span>Total Freight ({statementData.summary.tripCount} trips)</span>
                    <span className="font-mono font-semibold">
                      {formatINR(statementData.summary.totalFreight)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Payments Received (Jama + Receipts)</span>
                    <span className="font-mono text-emerald-700">
                      - {formatINR(statementData.summary.tripAdvanceReceived + statementData.summary.paymentsReceivedTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Advance Payments Logged</span>
                    <span className="font-mono text-emerald-700">
                      - {formatINR(statementData.summary.ledgerAdvancesTotal)}
                    </span>
                  </div>
                  {statementData.summary.deductionsTotal > 0 && (
                    <div className="flex justify-between">
                      <span>Deductions / Adjustments</span>
                      <span className="font-mono text-emerald-700">
                        - {formatINR(statementData.summary.deductionsTotal)}
                      </span>
                    </div>
                  )}
                  {statementPaymentMethod !== 'All' && (
                    <div className="flex justify-between text-emerald-800 font-medium">
                      <span>
                        Filtered {statementPaymentMethod} Receipts ({statementData.payments.length})
                      </span>
                      <span className="font-mono">
                        {formatINR(statementData.filteredPaymentsTotal)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between pt-1.5 border-t border-slate-300 text-sm font-bold">
                    <span>Remaining Outstanding</span>
                    <span className="font-mono">
                      {formatINR(statementData.summary.netOutstanding)}
                      {statementData.summary.netOutstanding < 0 ? ' Cr' : ''}
                    </span>
                  </div>
                </div>
              </div>

              {/* Section 1: Chronological Date-Wise Ledger Statement */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  {statementPaymentMethod !== 'All'
                    ? `1. Date-Wise ${statementPaymentMethod} Reconciliation (${statementData.dateWise.rows.length} entries)`
                    : `1. Date-Wise Chronological Statement (${statementData.dateWise.rows.length} entries)`}
                </h3>
                <table className="w-full text-left border-collapse text-[11px] border border-slate-300">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-300 font-semibold">
                      <th className="py-1.5 px-2 border-r border-slate-300 whitespace-nowrap">Date</th>
                      <th className="py-1.5 px-2 border-r border-slate-300">Particulars</th>
                      <th className="py-1.5 px-2 border-r border-slate-300">LR / Ref</th>
                      <th className="py-1.5 px-2 border-r border-slate-300 text-right">Debit (Freight)</th>
                      <th className="py-1.5 px-2 border-r border-slate-300 text-right">Credit (Paid / Adj)</th>
                      <th className="py-1.5 px-2 text-right">
                        {statementPaymentMethod !== 'All' ? 'Cumulative Paid' : 'Balance'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {statementFromDate && (
                      <tr className="bg-slate-50 font-semibold">
                        <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                          {formatDateIN(statementFromDate)}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-200" colSpan={4}>
                          {statementPaymentMethod !== 'All'
                            ? `Prior ${statementPaymentMethod} Receipts Brought Forward`
                            : 'Opening Balance Brought Forward'}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatINR(statementData.dateWise.openingBalance)}
                        </td>
                      </tr>
                    )}
                    {statementData.dateWise.rows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-3 px-3 text-center text-slate-500">
                          {statementPaymentMethod !== 'All'
                            ? `No ${statementPaymentMethod} payment transactions found in the selected period.`
                            : 'No ledger transactions found in the selected period.'}
                        </td>
                      </tr>
                    ) : (
                      statementData.dateWise.rows.map((row) => (
                        <tr key={row.id}>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                            {formatDateIN(row.date)}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 break-words">
                            <div className="font-medium text-slate-900">{row.particulars}</div>
                            {row.note && (
                              <div className="text-[10px] text-slate-500">{row.note}</div>
                            )}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono break-words">
                            {row.reference}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap">
                            {row.debit > 0 ? formatINR(row.debit) : '—'}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap text-emerald-700">
                            {row.credit > 0 ? formatINR(row.credit) : '—'}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                            {formatINR(row.runningBalance)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot className="bg-slate-100 border-t-2 border-slate-400 font-semibold text-slate-900">
                    <tr>
                      <td className="py-1.5 px-2 border-r border-slate-300" colSpan={3}>
                        {statementPaymentMethod !== 'All'
                          ? `Total ${statementPaymentMethod} Receipts Reconciled`
                          : 'Period Totals & Closing Balance'}
                      </td>
                      <td className="py-1.5 px-2 border-r border-slate-300 text-right font-mono tabular-nums whitespace-nowrap">
                        {formatINR(statementData.dateWise.periodDebit)}
                      </td>
                      <td className="py-1.5 px-2 border-r border-slate-300 text-right font-mono tabular-nums whitespace-nowrap text-emerald-700">
                        {formatINR(statementData.dateWise.periodCredit)}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                        {formatINR(statementData.dateWise.closingBalance)}
                        {statementPaymentMethod === 'All' && statementData.dateWise.closingBalance < 0
                          ? ' Cr'
                          : ''}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Section 2: Trip-Wise Breakdown */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  2. Trip-Wise Freight Breakdown ({statementData.partyTrips.length})
                </h3>
                {statementData.partyTrips.length === 0 ? (
                  <div className="p-3 border border-slate-200 rounded text-xs text-slate-500">
                    No active trips recorded for this party.
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-[11px] border border-slate-300">
                    <thead>
                      <tr className="bg-slate-100 border-b border-slate-300 font-semibold">
                        <th className="py-1.5 px-2 border-r border-slate-300">Sr</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">Date</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">LR / Container</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">Vehicle</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">From → To</th>
                        <th className="py-1.5 px-2 border-r border-slate-300 text-right">Rate</th>
                        <th className="py-1.5 px-2 border-r border-slate-300 text-right">Trip Jama</th>
                        <th className="py-1.5 px-2 text-right">Trip Hisab</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {statementData.partyTrips.map((t, idx) => (
                        <tr key={t.id}>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono">
                            {t.srNo || idx + 1}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                            {formatDateIN(t.tripDate)}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono break-words">
                            {t.lrNumber}
                            {t.containerNo ? ` (${t.containerNo})` : ''}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                            {t.vehicleNumber}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 break-words">
                            {t.origin} → {t.destination}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap">
                            {formatINR(t.freightAmount)}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 text-right font-mono tabular-nums whitespace-nowrap">
                            {formatINR(t.advanceReceived)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                            {formatINR(t.balanceAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-100 border-t-2 border-slate-400 font-semibold text-slate-900">
                      <tr>
                        <td className="py-1.5 px-2 border-r border-slate-300" colSpan={5}>
                          Trip Subtotal ({statementData.summary.tripCount} Trips)
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-300 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatINR(statementData.summary.totalFreight)}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-300 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatINR(statementData.summary.tripAdvanceReceived)}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatINR(statementData.summary.tripHisabBalance)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>

              {/* Section 3: Payment History Table */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  {statementPaymentMethod !== 'All'
                    ? `3. ${statementPaymentMethod} Payment Receipts & Advances (${statementData.payments.length})`
                    : `3. Payment Receipts & Advances (${statementData.payments.length})`}
                </h3>
                {statementData.payments.length === 0 ? (
                  <div className="p-3 border border-slate-200 rounded text-xs text-slate-500">
                    {statementPaymentMethod !== 'All'
                      ? `No ${statementPaymentMethod} payment receipts match the active statement filter.`
                      : 'No separate payment receipts recorded against this ledger.'}
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-[11px] border border-slate-300">
                    <thead>
                      <tr className="bg-slate-100 border-b border-slate-300 font-semibold">
                        <th className="py-1.5 px-2 border-r border-slate-300">Date</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">Type</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">Method</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">Reference / Trip</th>
                        <th className="py-1.5 px-2 border-r border-slate-300">Notes</th>
                        <th className="py-1.5 px-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {statementData.payments.map((pp) => (
                        <tr key={pp.id}>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono whitespace-nowrap">
                            {formatDateIN(pp.paymentDate)}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-medium">
                            {pp.paymentType}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200">{pp.paymentMode}</td>
                          <td className="py-1.5 px-2 border-r border-slate-200 font-mono">
                            {pp.referenceNo || '—'}
                            {pp.tripLrNumber ? ` (${pp.tripLrNumber})` : ''}
                          </td>
                          <td className="py-1.5 px-2 border-r border-slate-200 break-words">
                            {pp.notes || '—'}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                            {formatINR(pp.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-100 border-t-2 border-slate-400 font-semibold text-slate-900">
                      <tr>
                        <td className="py-1.5 px-2 border-r border-slate-300" colSpan={5}>
                          {statementPaymentMethod !== 'All'
                            ? `Total ${statementPaymentMethod} Payments (${statementData.payments.length})`
                            : `Total Payments & Adjustments Logged (${statementData.payments.length})`}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatINR(statementData.filteredPaymentsTotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>

              {/* Statement Footer */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2 text-xs">
                <div className="space-y-2">
                  {statementData.summary.netOutstanding > 0 && (
                    <div>
                      <div className="font-semibold text-slate-600">Outstanding in Words:</div>
                      <div className="font-semibold text-slate-900 mt-0.5">
                        {rupeesInWords(statementData.summary.netOutstanding)}
                      </div>
                    </div>
                  )}
                  {bankSummaryLine && (
                    <div className="p-3 border border-slate-200 rounded bg-slate-50">
                      <div className="font-semibold text-slate-700 mb-1">Bank Details for Payment</div>
                      <div className="font-mono text-[11px] text-slate-700">{bankSummaryLine}</div>
                    </div>
                  )}
                </div>

                <div className="pt-4 sm:text-right">
                  <div className="font-semibold">
                    For {companySettings?.companyName || 'BAPASITARAM ENTERPRISE'}
                  </div>
                  <div className="mt-10 border-t border-slate-400 inline-block pt-1 px-6 text-slate-600">
                    Authorized Signatory
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <PdfPreviewModal
        preview={renderedPdfPreview}
        title={
          activeStatementParty
            ? `Party Statement — ${activeStatementParty.partyName}`
            : 'Party Statement PDF'
        }
        onDownload={() => renderedPdfPreview?.pdf.save(renderedPdfPreview.fileName)}
        onPrint={() => triggerPrintPreview()}
        onClose={() => setRenderedPdfPreview(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Party Account"
        description={`Remove ${deleteTarget?.partyName || 'this party'} from your party directory? Existing historical trips referencing this party name will remain intact.`}
        confirmLabel="Delete Party"
        destructive
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deletePaymentTarget)}
        title="Delete Party Payment Entry"
        description={`Delete ${deletePaymentTarget?.paymentType || 'payment'} of ${
          deletePaymentTarget ? formatINR(deletePaymentTarget.amount) : ''
        } for ${deletePaymentTarget?.partyName || 'this party'}? Party outstanding balance will recalculate automatically.`}
        confirmLabel="Delete Payment"
        destructive
        busy={deleting}
        onConfirm={handleConfirmDeletePayment}
        onCancel={() => setDeletePaymentTarget(null)}
      />

      <WhatsAppShareModal
        open={Boolean(whatsAppModal)}
        onClose={() => setWhatsAppModal(null)}
        title={whatsAppModal?.title || 'WhatsApp Manual Share'}
        subtitle={whatsAppModal?.subtitle}
        partyName={whatsAppModal?.partyName || ''}
        partyPhone={whatsAppModal?.partyPhone || ''}
        initialMessage={whatsAppModal?.message || ''}
      />
    </div>
  );
};

