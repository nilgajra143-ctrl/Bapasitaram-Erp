import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  IndianRupee,
  MessageCircle,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  PARTY_PAYMENT_TYPES,
  type ErpUserRole,
  type Party,
  type PartyPayment,
  type PartyPaymentType,
  type PaymentMode,
  type Trip,
} from '../types/erp';
import {
  clampNum,
  clampStr,
  formatDateIN,
  formatINR,
  generateSafeDocId,
  getTodayISO,
} from '../utils/formatters';
import {
  computePartyLedgerSummary,
  computeTripLinkedPaymentTotals,
  extractReadableFirestoreError,
  findDuplicatePartyPayment,
  type PartyLedgerSummary,
} from '../utils/erpHelpers';
import { recordAuditLog } from '../utils/auditLogger';
import {
  buildPaymentReceiptWhatsAppMessage,
  buildWhatsAppManualUrl,
} from '../utils/whatsappShare';

export interface PaymentMethodOption {
  label: string;
  value: PaymentMode;
  hint: string;
}

/**
 * Primary payment methods exposed in the Add Payment modal.
 * Maps "Bank" to Firestore's validated 'Bank Transfer' enum value.
 */
export const ADD_PAYMENT_METHOD_OPTIONS: readonly PaymentMethodOption[] = [
  { label: 'Cash', value: 'Cash', hint: 'Cash Receipt No' },
  { label: 'Bank', value: 'Bank Transfer', hint: 'NEFT / RTGS / IMPS / UTR No' },
  { label: 'UPI', value: 'UPI', hint: 'UPI Transaction / UTR Ref' },
  { label: 'Cheque', value: 'Cheque', hint: 'Cheque Number & Bank' },
] as const;

export interface SavedPartyPaymentSummary {
  paymentId: string;
  partyId: string;
  partyName: string;
  paymentDate: string;
  amount: number;
  paymentType: PartyPaymentType;
  paymentMode: PaymentMode;
  referenceNo: string;
  notes: string;
  tripLrNumber: string;
  remainingBalance: number;
}

export interface AddPaymentModalProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  actorRole: ErpUserRole;
  parties: Party[];
  trips: Trip[];
  partyPayments: PartyPayment[];
  initialPartyId?: string;
  initialTripId?: string;
  lockPartySelection?: boolean;
  companyName?: string;
  ledgerByParty?: Map<string, PartyLedgerSummary>;
  duplicateChecker?: typeof findDuplicatePartyPayment;
  onPaymentSaved?: (saved: SavedPartyPaymentSummary) => void;
}

interface AddPaymentFormState {
  partyId: string;
  tripId: string;
  paymentDate: string;
  paymentType: PartyPaymentType;
  amount: string;
  paymentMode: PaymentMode;
  referenceNo: string;
  notes: string;
}

function createInitialFormState(
  parties: Party[],
  initialPartyId?: string,
  initialTripId?: string
): AddPaymentFormState {
  const resolvedPartyId =
    initialPartyId && parties.some((p) => p.id === initialPartyId)
      ? initialPartyId
      : parties[0]?.id || '';
  return {
    partyId: resolvedPartyId,
    tripId: initialTripId || '',
    paymentDate: getTodayISO(),
    paymentType: 'Payment Received',
    amount: '',
    paymentMode: 'Bank Transfer',
    referenceNo: '',
    notes: '',
  };
}

export const AddPaymentModal: React.FC<AddPaymentModalProps> = ({
  open,
  onClose,
  userId,
  actorRole,
  parties,
  trips,
  partyPayments,
  initialPartyId,
  initialTripId,
  lockPartySelection = false,
  companyName = 'BAPASITARAM ENTERPRISE',
  ledgerByParty,
  duplicateChecker = findDuplicatePartyPayment,
  onPaymentSaved,
}) => {
  const [form, setForm] = useState<AddPaymentFormState>(() =>
    createInitialFormState(parties, initialPartyId, initialTripId)
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmedPayment, setConfirmedPayment] = useState<
    (SavedPartyPaymentSummary & { partyPhone: string }) | null
  >(null);
  const [whatsAppMessage, setWhatsAppMessage] = useState('');
  const [whatsAppMessageEdited, setWhatsAppMessageEdited] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const wasOpenRef = useRef(false);

  // Reset form and confirmation state cleanly when the modal opens or closes
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      setConfirmedPayment(null);
      setWhatsAppMessage('');
      setWhatsAppMessageEdited(false);
      setCopiedMessage(false);
      return;
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      setForm(createInitialFormState(parties, initialPartyId, initialTripId));
      setError(null);
      setConfirmedPayment(null);
      setWhatsAppMessage('');
      setWhatsAppMessageEdited(false);
      setCopiedMessage(false);
    }
  }, [open, initialPartyId, initialTripId, parties]);

  // Close on Escape when not actively submitting
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, saving, onClose]);

  const selectedParty = useMemo(
    () => parties.find((p) => p.id === form.partyId) || null,
    [parties, form.partyId]
  );

  const selectedPartySummary = useMemo(() => {
    if (!selectedParty) return null;
    if (ledgerByParty?.has(selectedParty.id)) {
      return ledgerByParty.get(selectedParty.id) || null;
    }
    return computePartyLedgerSummary(
      selectedParty.id,
      trips,
      partyPayments,
      selectedParty.partyName
    );
  }, [selectedParty, ledgerByParty, trips, partyPayments]);

  const partyTrips = useMemo(() => {
    if (!selectedParty) return [];
    const linkedMap = computeTripLinkedPaymentTotals(selectedParty.id, partyPayments);
    return trips
      .filter((t) => t.partyId === selectedParty.id && t.tripStatus !== 'Cancelled')
      .slice()
      .sort((a, b) => b.tripDate.localeCompare(a.tripDate))
      .map((t) => {
        const linked = linkedMap.get(t.id) || 0;
        const baseBalance =
          typeof t.balanceAmount === 'number' && Number.isFinite(t.balanceAmount)
            ? t.balanceAmount
            : Math.round(((Number(t.freightAmount) || 0) - (Number(t.advanceReceived) || 0)) * 100) /
              100;
        const remaining = Math.max(0, Math.round((baseBalance - linked) * 100) / 100);
        return { trip: t, linked, remaining };
      });
  }, [selectedParty, trips, partyPayments]);

  const selectedTripInfo = useMemo(() => {
    if (!form.tripId) return null;
    return partyTrips.find((item) => item.trip.id === form.tripId) || null;
  }, [form.tripId, partyTrips]);

  const projectedOutstanding = useMemo(() => {
    if (!selectedPartySummary) return null;
    const parsedAmt = parseFloat(form.amount || '0');
    const validAmt = Number.isFinite(parsedAmt) && parsedAmt > 0 ? parsedAmt : 0;
    return Math.round((selectedPartySummary.netOutstanding - validAmt) * 100) / 100;
  }, [selectedPartySummary, form.amount]);

  const activeMethodOption = useMemo(
    () =>
      ADD_PAYMENT_METHOD_OPTIONS.find((opt) => opt.value === form.paymentMode) ||
      ADD_PAYMENT_METHOD_OPTIONS[1],
    [form.paymentMode]
  );

  const confirmedPartyPhone = useMemo(() => {
    if (!confirmedPayment) return '';
    const liveParty = parties.find((p) => p.id === confirmedPayment.partyId);
    return liveParty?.phone || confirmedPayment.partyPhone || '';
  }, [confirmedPayment, parties]);

  const confirmedRemainingBalance = useMemo(() => {
    if (!confirmedPayment) return 0;
    const syncedInSnapshot = partyPayments.some((pp) => pp.id === confirmedPayment.paymentId);
    const liveSummary = ledgerByParty?.get(confirmedPayment.partyId);
    if (syncedInSnapshot && liveSummary) {
      return liveSummary.netOutstanding;
    }
    return confirmedPayment.remainingBalance;
  }, [confirmedPayment, partyPayments, ledgerByParty]);

  const defaultConfirmedMessage = useMemo(() => {
    if (!confirmedPayment) return '';
    return buildPaymentReceiptWhatsAppMessage({
      companyName,
      partyName: confirmedPayment.partyName,
      amount: confirmedPayment.amount,
      paymentDate: confirmedPayment.paymentDate,
      paymentMode: confirmedPayment.paymentMode,
      paymentType: confirmedPayment.paymentType,
      referenceNo: confirmedPayment.referenceNo,
      tripLrNumber: confirmedPayment.tripLrNumber,
      remainingBalance: confirmedRemainingBalance,
    });
  }, [confirmedPayment, companyName, confirmedRemainingBalance]);

  useEffect(() => {
    if (confirmedPayment && !whatsAppMessageEdited) {
      setWhatsAppMessage(defaultConfirmedMessage);
    }
  }, [confirmedPayment, defaultConfirmedMessage, whatsAppMessageEdited]);

  const confirmedWhatsApp = useMemo(
    () => buildWhatsAppManualUrl(confirmedPartyPhone, whatsAppMessage),
    [confirmedPartyPhone, whatsAppMessage]
  );

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedParty) {
      setError('Please select a registered party account.');
      return;
    }

    const paymentDate = clampStr(form.paymentDate || getTodayISO(), BLUEPRINT_LIMITS.DATE_MAX);
    if (paymentDate.length < 4) {
      setError('Please select a valid payment date.');
      return;
    }

    const amount = clampNum(form.amount || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    if (amount <= 0) {
      setError('Enter a payment amount greater than ₹0.');
      return;
    }

    const referenceNo = clampStr(form.referenceNo, BLUEPRINT_LIMITS.REFERENCE_MAX);
    const notes = clampStr(form.notes, BLUEPRINT_LIMITS.NOTES_MAX);

    const duplicate = duplicateChecker(partyPayments, {
      partyId: selectedParty.id,
      paymentDate,
      paymentType: form.paymentType,
      amount,
      paymentMode: form.paymentMode,
      referenceNo,
    });

    if (duplicate) {
      setError(
        duplicate.reason === 'reference'
          ? `Duplicate Payment Blocked: Reference/UTR "${duplicate.existing.referenceNo}" is already logged for ${selectedParty.partyName} (${formatDateIN(duplicate.existing.paymentDate)}, ${formatINR(duplicate.existing.amount)}).`
          : `Duplicate Payment Blocked: An identical ${duplicate.existing.paymentType} of ${formatINR(duplicate.existing.amount)} via ${duplicate.existing.paymentMode} on ${formatDateIN(duplicate.existing.paymentDate)} already exists for ${selectedParty.partyName}.`
      );
      return;
    }

    const linkedTrip = form.tripId
      ? trips.find((t) => t.id === form.tripId && t.partyId === selectedParty.id)
      : undefined;
    const tripId = linkedTrip ? linkedTrip.id : '';
    const tripLrNumber = linkedTrip ? clampStr(linkedTrip.lrNumber, 40) : '';

    const paymentId = generateSafeDocId('ptyp');
    setSaving(true);
    try {
      await setDoc(doc(collection(db, 'partyPayments'), paymentId), {
        partyId: selectedParty.id,
        partyName: clampStr(selectedParty.partyName, BLUEPRINT_LIMITS.PARTY_NAME_MAX),
        tripId,
        tripLrNumber,
        paymentDate,
        paymentType: form.paymentType,
        amount,
        paymentMode: form.paymentMode,
        referenceNo,
        notes,
        ownerId: userId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'CREATE',
        module: 'Party Payments',
        recordId: paymentId,
        summary: `Recorded ${form.paymentType} of ${formatINR(amount)} (${form.paymentMode}) from ${selectedParty.partyName}${tripLrNumber ? ` [Trip ${tripLrNumber}]` : ''}`,
      });

      const remainingBalance = selectedPartySummary
        ? Math.round((selectedPartySummary.netOutstanding - amount) * 100) / 100
        : 0;

      const savedSummary: SavedPartyPaymentSummary = {
        paymentId,
        partyId: selectedParty.id,
        partyName: selectedParty.partyName,
        paymentDate,
        amount,
        paymentType: form.paymentType,
        paymentMode: form.paymentMode,
        referenceNo,
        notes,
        tripLrNumber,
        remainingBalance,
      };

      const initialReceiptMsg = buildPaymentReceiptWhatsAppMessage({
        companyName,
        partyName: savedSummary.partyName,
        amount: savedSummary.amount,
        paymentDate: savedSummary.paymentDate,
        paymentMode: savedSummary.paymentMode,
        paymentType: savedSummary.paymentType,
        referenceNo: savedSummary.referenceNo,
        tripLrNumber: savedSummary.tripLrNumber,
        remainingBalance: savedSummary.remainingBalance,
      });

      onPaymentSaved?.(savedSummary);
      setConfirmedPayment({
        ...savedSummary,
        partyPhone: selectedParty.phone || '',
      });
      setWhatsAppMessage(initialReceiptMsg);
      setWhatsAppMessageEdited(false);
      setCopiedMessage(false);
    } catch (err) {
      setError(extractReadableFirestoreError(err, 'Save Party Payment'));
    } finally {
      setSaving(false);
    }
  };

  const handleCopyWhatsAppMessage = async () => {
    try {
      await navigator.clipboard.writeText(whatsAppMessage);
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 2000);
    } catch {
      // Clipboard may be restricted in some environments; message textarea remains selectable
    }
  };

  const handleRecordAnotherPayment = () => {
    const nextPartyId = confirmedPayment?.partyId || initialPartyId;
    setConfirmedPayment(null);
    setWhatsAppMessage('');
    setWhatsAppMessageEdited(false);
    setCopiedMessage(false);
    setError(null);
    setForm(createInitialFormState(parties, nextPartyId, ''));
  };

  const quickFillBalance =
    selectedTripInfo && selectedTripInfo.remaining > 0
      ? selectedTripInfo.remaining
      : selectedPartySummary && selectedPartySummary.netOutstanding > 0
      ? selectedPartySummary.netOutstanding
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 overflow-y-auto no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-payment-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-auto max-h-[92vh] flex flex-col">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-white shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
              {confirmedPayment ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <IndianRupee className="w-4 h-4" />
              )}
            </div>
            <div className="min-w-0">
              <h2
                id="add-payment-modal-title"
                className="font-display text-base sm:text-lg font-semibold text-slate-900 truncate"
              >
                {confirmedPayment ? 'Payment Confirmed' : 'Add Party Payment'}
              </h2>
              <p className="text-xs text-slate-500">
                {confirmedPayment
                  ? 'Payment saved to ledger. Review the receipt and share manually on WhatsApp.'
                  : 'Records receipt or advance in partyPayments without altering historical trips.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            aria-label="Close Add Payment modal"
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        {confirmedPayment ? (
          <div className="p-6 space-y-4 overflow-y-auto flex-1">
            {/* Confirmed Receipt Summary */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200">
                <span className="font-semibold text-slate-900 truncate">
                  {confirmedPayment.partyName}
                </span>
                <span className="font-mono text-[11px] text-slate-500 shrink-0">
                  {formatDateIN(confirmedPayment.paymentDate)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">
                  Amount Paid ({confirmedPayment.paymentMode})
                </span>
                <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                  {formatINR(confirmedPayment.amount)}
                </span>
              </div>
              {confirmedPayment.referenceNo && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Reference / UTR</span>
                  <span className="font-mono text-slate-800">{confirmedPayment.referenceNo}</span>
                </div>
              )}
              {confirmedPayment.tripLrNumber && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Linked Trip / LR</span>
                  <span className="font-mono text-slate-800">{confirmedPayment.tripLrNumber}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-slate-200 font-semibold">
                <span className="text-slate-800">Remaining Balance</span>
                <span
                  className={`font-mono tabular-nums ${
                    confirmedRemainingBalance > 0 ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {formatINR(confirmedRemainingBalance)}
                  {confirmedRemainingBalance < 0
                    ? ' (Adv. Credit)'
                    : confirmedRemainingBalance === 0
                    ? ' (Settled)'
                    : ''}
                </span>
              </div>
            </div>

            {/* Verified Party Mobile Guard */}
            {confirmedWhatsApp.phone.valid ? (
              <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200 flex items-start gap-3">
                <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                <div className="min-w-0 text-xs">
                  <div className="font-semibold text-emerald-950">
                    Registered Party Mobile: {confirmedWhatsApp.phone.displayNumber}
                  </div>
                  <p className="text-[11px] text-emerald-800 mt-0.5">
                    WhatsApp will open directly to {confirmedPayment.partyName}&apos;s registered mobile number so you can review and press Send manually.
                  </p>
                </div>
              </div>
            ) : (
              <div
                role="alert"
                className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3"
              >
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div className="min-w-0 text-xs text-amber-950">
                  <div className="font-semibold">
                    No Valid Registered Mobile Number for {confirmedPayment.partyName}
                  </div>
                  <p className="mt-0.5 text-amber-900">
                    {confirmedWhatsApp.phone.reason} Add a valid mobile number in Party Accounts first to enable Share on WhatsApp safely.
                  </p>
                </div>
              </div>
            )}

            {/* Prepared WhatsApp Receipt Preview */}
            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label
                  htmlFor="payment-whatsapp-preview"
                  className="text-xs font-medium text-slate-700"
                >
                  WhatsApp Receipt Message Preview
                </label>
                <div className="flex items-center gap-2.5">
                  {whatsAppMessageEdited && (
                    <button
                      type="button"
                      onClick={() => {
                        setWhatsAppMessage(defaultConfirmedMessage);
                        setWhatsAppMessageEdited(false);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Reset</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleCopyWhatsAppMessage}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                  >
                    {copiedMessage ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-700" />
                        <span className="text-emerald-700">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Text</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
              <textarea
                id="payment-whatsapp-preview"
                rows={8}
                value={whatsAppMessage}
                onChange={(e) => {
                  setWhatsAppMessage(e.target.value);
                  setWhatsAppMessageEdited(true);
                }}
                className="w-full px-3.5 py-2.5 text-xs font-mono leading-relaxed text-slate-900 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-slate-900"
              />
            </div>

            {/* Confirmed Footer Actions */}
            <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2.5">
              <button
                type="button"
                onClick={handleRecordAnotherPayment}
                className="px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
              >
                Record Another
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  Done
                </button>
                {confirmedWhatsApp.url ? (
                  <a
                    href={confirmedWhatsApp.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>Share on WhatsApp</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-slate-400 bg-slate-200 rounded-lg cursor-not-allowed"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>Share on WhatsApp</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto flex-1">
          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700"
            >
              {error}
            </div>
          )}

          {/* Party Selection */}
          <div>
            <label
              htmlFor="add-payment-party"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              Party Account *
            </label>
            <select
              id="add-payment-party"
              required
              disabled={lockPartySelection || saving}
              value={form.partyId}
              onChange={(e) => setForm({ ...form, partyId: e.target.value, tripId: '' })}
              className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900 disabled:bg-slate-50 disabled:text-slate-600"
            >
              <option value="">Select party account...</option>
              {parties.map((p) => {
                const bal = ledgerByParty?.get(p.id)?.netOutstanding;
                const balSuffix =
                  typeof bal === 'number' && bal > 0 ? ` — Due ${formatINR(bal, true)}` : '';
                return (
                  <option key={p.id} value={p.id}>
                    {p.partyName}
                    {p.city ? ` (${p.city})` : ''}
                    {balSuffix}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Optional Trip Link for Partial Payments */}
          {form.partyId && partyTrips.length > 0 && (
            <div>
              <label
                htmlFor="add-payment-trip"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Link to Trip / LR (Optional — Supports Partial Payments)
              </label>
              <select
                id="add-payment-trip"
                disabled={saving}
                value={form.tripId}
                onChange={(e) => setForm({ ...form, tripId: e.target.value })}
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              >
                <option value="">On-Account / General Party Ledger</option>
                {partyTrips.map(({ trip: t, remaining }) => (
                  <option key={t.id} value={t.id}>
                    {formatDateIN(t.tripDate)} · {t.lrNumber} ({t.vehicleNumber}) — Rate{' '}
                    {formatINR(t.freightAmount, true)} | Bal {formatINR(remaining)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Amount + Date + Entry Type */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="add-payment-amount"
                  className="block text-xs font-medium text-slate-700"
                >
                  Amount (INR) *
                </label>
                {quickFillBalance > 0 && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setForm({ ...form, amount: String(quickFillBalance) })}
                    className="text-[11px] font-medium text-emerald-700 hover:text-emerald-900 underline cursor-pointer"
                  >
                    Fill Due
                  </button>
                )}
              </div>
              <input
                id="add-payment-amount"
                type="number"
                required
                min="0.01"
                step="0.01"
                max={BLUEPRINT_LIMITS.CURRENCY_MAX}
                disabled={saving}
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="0.00"
                className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="add-payment-date"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Payment Date *
              </label>
              <input
                id="add-payment-date"
                type="date"
                required
                disabled={saving}
                value={form.paymentDate}
                onChange={(e) => setForm({ ...form, paymentDate: e.target.value })}
                className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="add-payment-type"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Entry Type *
              </label>
              <select
                id="add-payment-type"
                disabled={saving}
                value={form.paymentType}
                onChange={(e) =>
                  setForm({ ...form, paymentType: e.target.value as PartyPaymentType })
                }
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              >
                {PARTY_PAYMENT_TYPES.map((typeOption) => (
                  <option key={typeOption} value={typeOption}>
                    {typeOption}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Payment Method (Cash / Bank / UPI / Cheque) */}
          <div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">
              Payment Method *
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ADD_PAYMENT_METHOD_OPTIONS.map((option) => {
                const selected = form.paymentMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={saving}
                    aria-pressed={selected}
                    onClick={() => setForm({ ...form, paymentMode: option.value })}
                    className={`px-3 py-2.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                      selected
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {form.paymentType === 'Deduction' && (
              <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                <span>TDS / Deduction adjustment?</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setForm({ ...form, paymentMode: 'Ledger Adjustment' })}
                  className={`font-medium underline cursor-pointer ${
                    form.paymentMode === 'Ledger Adjustment'
                      ? 'text-slate-900'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {form.paymentMode === 'Ledger Adjustment'
                    ? 'Using Ledger Adjustment'
                    : 'Use Ledger Adjustment'}
                </button>
              </div>
            )}
          </div>

          {/* Reference Number */}
          <div>
            <label
              htmlFor="add-payment-reference"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              Reference Number ({activeMethodOption.hint})
            </label>
            <input
              id="add-payment-reference"
              type="text"
              disabled={saving}
              maxLength={BLUEPRINT_LIMITS.REFERENCE_MAX}
              value={form.referenceNo}
              onChange={(e) => setForm({ ...form, referenceNo: e.target.value })}
              placeholder={`Enter ${activeMethodOption.hint}...`}
              className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Duplicate reference numbers or identical same-day payments are blocked automatically.
            </p>
          </div>

          {/* Notes */}
          <div>
            <label
              htmlFor="add-payment-notes"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              Notes
            </label>
            <textarea
              id="add-payment-notes"
              rows={2}
              disabled={saving}
              maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Part-payment remark, invoice reference, or settlement notes..."
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
            />
          </div>

          {/* Live Outstanding Impact Preview */}
          {selectedPartySummary && projectedOutstanding !== null && (
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
              <div className="font-semibold text-slate-700">Live Party Balance Preview</div>
              <div className="flex justify-between">
                <span className="text-slate-600">Current Outstanding</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatINR(selectedPartySummary.netOutstanding)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">
                  This {form.paymentType} ({activeMethodOption.label})
                </span>
                <span className="font-mono text-emerald-700 tabular-nums">
                  - {formatINR(parseFloat(form.amount || '0') || 0)}
                </span>
              </div>
              {selectedTripInfo && (
                <div className="flex justify-between text-slate-600">
                  <span>Trip {selectedTripInfo.trip.lrNumber} Remaining After Payment</span>
                  <span className="font-mono font-medium text-slate-900 tabular-nums">
                    {formatINR(
                      Math.max(
                        0,
                        Math.round(
                          (selectedTripInfo.remaining - (parseFloat(form.amount || '0') || 0)) * 100
                        ) / 100
                      )
                    )}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-1.5 border-t border-slate-200 font-semibold">
                <span className="text-slate-800">Projected Outstanding After Save</span>
                <span
                  className={`font-mono tabular-nums ${
                    projectedOutstanding > 0 ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {formatINR(projectedOutstanding)}
                  {projectedOutstanding < 0 ? ' (Adv. Credit)' : ''}
                </span>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || parties.length === 0}
              className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
            >
              {saving ? 'Saving Payment...' : 'Save Payment'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
};
