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
  AlertTriangle,
  CheckCircle2,
  Download,
  Edit3,
  Eye,
  FileCheck2,
  FileText,
  ImagePlus,
  Link2,
  Lock,
  MessageCircle,
  Phone,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Trash2,
  Truck,
  Upload,
  X,
} from 'lucide-react';
import { db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  DEFAULT_DIESEL_RATE,
  type CompanySettings,
  type Driver,
  type ErpUserRole,
  type LorryReceipt,
  type Party,
  type Trip,
  type UserPermissions,
  type Vehicle,
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
  sanitizePdfFileName,
  triggerPrintPreview,
  type RenderedA4PdfResult,
} from '../utils/pdfExport';
import {
  extractReadableFirestoreError,
  normalizeNameKey,
} from '../utils/erpHelpers';
import {
  buildLorryReceiptWhatsAppMessage,
  calculateLrBalance,
  compressLogoImageFile,
  DEFAULT_LR_PREFIX,
  filterLorryReceipts,
  findDuplicateLorryReceipt,
  generateNextUniqueLrNumber,
  isValidCompanyLogoDataUrl,
  LR_COMPANY_NAME,
  LR_CONTACT_LEFT,
  LR_CONTACT_RIGHT,
  LR_DEVOTIONAL_HEADER,
} from '../utils/lorryReceiptHelpers';
import { createPdfFileFromJsPdf } from '../utils/whatsappShare';
import { recordAuditLog } from '../utils/auditLogger';
import { ConfirmDialog } from './ConfirmDialog';
import { PdfPreviewModal } from './PdfPreviewModal';
import {
  WhatsAppShareModal,
  type WhatsAppPdfAttachment,
} from './WhatsAppShareModal';

interface LorryReceiptsViewProps {
  userId: string;
  actorRole: ErpUserRole;
  permissions: UserPermissions;
  lorryReceipts: LorryReceipt[];
  vehicles: Vehicle[];
  parties: Party[];
  trips: Trip[];
  drivers: Driver[];
  companySettings: CompanySettings | null;
  loading: boolean;
}

interface LrFormState {
  lrNumber: string;
  lrDate: string;
  tripId: string;
  tripRefLr: string;
  vehicleId: string;
  vehicleNumber: string;
  consignorPartyId: string;
  consignorName: string;
  consignorAddress: string;
  consignorPhone: string;
  consigneePartyId: string;
  consigneeName: string;
  consigneeAddress: string;
  consigneePhone: string;
  origin: string;
  destination: string;
  containerNo: string;
  goodsDescription: string;
  quantityWeight: string;
  freightRate: string;
  totalFreightAmount: string;
  advanceAmount: string;
  balanceAmount: string;
  driverName: string;
  driverMobile: string;
  remarks: string;
  senderSignature: string;
  receiverSignature: string;
}

type WhatsAppRecipientRole = 'consignor' | 'consignee' | 'driver';

function formatPartyFullAddress(party: Party): string {
  return [party.address, party.city, party.state]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(', ');
}

function createInitialLrForm(nextLrNumber: string): LrFormState {
  return {
    lrNumber: nextLrNumber,
    lrDate: getTodayISO(),
    tripId: '',
    tripRefLr: '',
    vehicleId: '',
    vehicleNumber: '',
    consignorPartyId: '',
    consignorName: '',
    consignorAddress: '',
    consignorPhone: '',
    consigneePartyId: '',
    consigneeName: '',
    consigneeAddress: '',
    consigneePhone: '',
    origin: '',
    destination: '',
    containerNo: '',
    goodsDescription: '',
    quantityWeight: '',
    freightRate: '',
    totalFreightAmount: '',
    advanceAmount: '0',
    balanceAmount: '0',
    driverName: '',
    driverMobile: '',
    remarks: '',
    senderSignature: '',
    receiverSignature: '',
  };
}

export const LorryReceiptsView: React.FC<LorryReceiptsViewProps> = ({
  userId,
  actorRole,
  permissions,
  lorryReceipts,
  vehicles,
  parties,
  trips,
  drivers,
  companySettings,
  loading,
}) => {
  const canCreateLr =
    permissions.isAdmin || permissions.canEditTrips || permissions.canManageMasters;
  const canEditLr = permissions.isAdmin;
  const canDeleteLr = permissions.isAdmin && permissions.canDeleteRecords;
  const canManageBranding = permissions.isAdmin;

  const [activeTab, setActiveTab] = useState<'list' | 'branding'>('list');

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [vehicleFilter, setVehicleFilter] = useState('');

  // Create / Edit LR drawer state
  const [formOpen, setFormOpen] = useState(false);
  const [editingLr, setEditingLr] = useState<LorryReceipt | null>(null);
  const [form, setForm] = useState<LrFormState>(() =>
    createInitialLrForm(
      generateNextUniqueLrNumber(lorryReceipts, trips, companySettings).lrNumber
    )
  );
  const [totalManuallyEdited, setTotalManuallyEdited] = useState(false);
  const [balanceManuallyEdited, setBalanceManuallyEdited] = useState(false);
  const [savingLr, setSavingLr] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  // Printable Preview & PDF state
  const [previewLr, setPreviewLr] = useState<LorryReceipt | null>(null);
  const lrPrintRef = useRef<HTMLDivElement | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [renderedPdfPreview, setRenderedPdfPreview] =
    useState<RenderedA4PdfResult | null>(null);
  const [generatedLrPdf, setGeneratedLrPdf] = useState<{
    lrId: string;
    rendered: RenderedA4PdfResult;
  } | null>(null);

  // WhatsApp manual share state
  const [whatsAppRecipientRole, setWhatsAppRecipientRole] =
    useState<WhatsAppRecipientRole>('consignor');
  const [whatsAppShareState, setWhatsAppShareState] = useState<{
    partyName: string;
    partyPhone: string;
    message: string;
    attachment: WhatsAppPdfAttachment | null;
  } | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<LorryReceipt | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Admin Branding & Logo Upload state
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const [logoPreviewDataUrl, setLogoPreviewDataUrl] = useState<string>(
    companySettings?.logoDataUrl || ''
  );
  const [lrPrefixInput, setLrPrefixInput] = useState<string>(
    companySettings?.lrPrefix || DEFAULT_LR_PREFIX
  );
  const [nextLrSeqInput, setNextLrSeqInput] = useState<string>(
    String(companySettings?.nextLrSeq || 1)
  );
  const [processingLogo, setProcessingLogo] = useState(false);
  const [savingBranding, setSavingBranding] = useState(false);
  const [brandingStatus, setBrandingStatus] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    setLogoPreviewDataUrl(companySettings?.logoDataUrl || '');
    setLrPrefixInput(companySettings?.lrPrefix || DEFAULT_LR_PREFIX);
    setNextLrSeqInput(String(companySettings?.nextLrSeq || 1));
  }, [companySettings]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('printing-modal-active', Boolean(previewLr));
    return () => {
      document.body.classList.remove('printing-modal-active');
    };
  }, [previewLr]);

  const nextAutoLr = useMemo(
    () => generateNextUniqueLrNumber(lorryReceipts, trips, companySettings),
    [lorryReceipts, trips, companySettings]
  );

  const filteredLrs = useMemo(
    () =>
      filterLorryReceipts(lorryReceipts, {
        searchQuery,
        fromDate,
        toDate,
        vehicleFilter,
      }),
    [lorryReceipts, searchQuery, fromDate, toDate, vehicleFilter]
  );

  const uniqueVehicleNumbers = useMemo(() => {
    const set = new Set<string>();
    lorryReceipts.forEach((lr) => {
      if (lr.vehicleNumber) set.add(lr.vehicleNumber.toUpperCase());
    });
    vehicles.forEach((v) => {
      if (v.registrationNumber) set.add(v.registrationNumber.toUpperCase());
    });
    return Array.from(set).sort();
  }, [lorryReceipts, vehicles]);

  const kpiSummary = useMemo(() => {
    let totalFreight = 0;
    let totalAdvance = 0;
    let totalBalance = 0;
    let linkedTripCount = 0;
    for (const lr of filteredLrs) {
      totalFreight += Number(lr.totalFreightAmount) || 0;
      totalAdvance += Number(lr.advanceAmount) || 0;
      totalBalance += Number(lr.balanceAmount) || 0;
      if (lr.tripId) linkedTripCount += 1;
    }
    return {
      count: filteredLrs.length,
      linkedTripCount,
      totalFreight,
      totalAdvance,
      totalBalance,
    };
  }, [filteredLrs]);

  const activeLogoDataUrl = useMemo(() => {
    const raw = (companySettings?.logoDataUrl || '').trim();
    return raw && isValidCompanyLogoDataUrl(raw) ? raw : '';
  }, [companySettings?.logoDataUrl]);

  const resolveRecipientForLr = (
    lr: LorryReceipt,
    role: WhatsAppRecipientRole
  ): { name: string; phone: string; label: string } => {
    if (role === 'driver') {
      return {
        name: lr.driverName || 'Driver',
        phone: lr.driverMobile || '',
        label: 'Driver',
      };
    }

    if (role === 'consignee') {
      const party =
        parties.find((p) => p.id === lr.consigneePartyId) ||
        parties.find(
          (p) => normalizeNameKey(p.partyName) === normalizeNameKey(lr.consigneeName)
        );
      return {
        name: lr.consigneeName || 'Consignee',
        phone: lr.consigneePhone || party?.phone || '',
        label: 'Consignee',
      };
    }

    const party =
      parties.find((p) => p.id === lr.consignorPartyId) ||
      parties.find(
        (p) => normalizeNameKey(p.partyName) === normalizeNameKey(lr.consignorName)
      );
    return {
      name: lr.consignorName || 'Consignor',
      phone: lr.consignorPhone || party?.phone || '',
      label: 'Consignor',
    };
  };

  const openCreateDrawer = () => {
    if (!canCreateLr) return;
    setEditingLr(null);
    setFormError(null);
    setTotalManuallyEdited(false);
    setBalanceManuallyEdited(false);
    setForm(createInitialLrForm(nextAutoLr.lrNumber));
    setFormOpen(true);
  };

  const openEditDrawer = (lr: LorryReceipt) => {
    if (!canEditLr) {
      setBannerMessage({
        tone: 'error',
        text: 'Only Administrators can edit saved Lorry Receipts.',
      });
      return;
    }
    setEditingLr(lr);
    setFormError(null);
    setTotalManuallyEdited(true);
    setBalanceManuallyEdited(false);
    setForm({
      lrNumber: lr.lrNumber,
      lrDate: lr.lrDate,
      tripId: lr.tripId || '',
      tripRefLr: lr.tripRefLr || '',
      vehicleId: lr.vehicleId || '',
      vehicleNumber: lr.vehicleNumber,
      consignorPartyId: lr.consignorPartyId || '',
      consignorName: lr.consignorName,
      consignorAddress: lr.consignorAddress,
      consignorPhone: lr.consignorPhone || '',
      consigneePartyId: lr.consigneePartyId || '',
      consigneeName: lr.consigneeName,
      consigneeAddress: lr.consigneeAddress,
      consigneePhone: lr.consigneePhone || '',
      origin: lr.origin,
      destination: lr.destination,
      containerNo: lr.containerNo || '',
      goodsDescription: lr.goodsDescription,
      quantityWeight: lr.quantityWeight || '',
      freightRate: lr.freightRate ? String(lr.freightRate) : '',
      totalFreightAmount: String(lr.totalFreightAmount),
      advanceAmount: String(lr.advanceAmount),
      balanceAmount: String(lr.balanceAmount),
      driverName: lr.driverName || '',
      driverMobile: lr.driverMobile || '',
      remarks: lr.remarks || '',
      senderSignature: lr.senderSignature || '',
      receiverSignature: lr.receiverSignature || '',
    });
    setFormOpen(true);
  };

  const handleLinkTripSelect = (selectedTripId: string) => {
    if (!selectedTripId) {
      setForm((prev) => ({ ...prev, tripId: '', tripRefLr: '' }));
      return;
    }
    const trip = trips.find((t) => t.id === selectedTripId);
    if (!trip) return;

    const matchedParty =
      parties.find((p) => p.id === trip.partyId) ||
      parties.find(
        (p) => normalizeNameKey(p.partyName) === normalizeNameKey(trip.partyName)
      );
    const matchedVehicle =
      vehicles.find((v) => v.id === trip.vehicleId) ||
      vehicles.find(
        (v) =>
          v.registrationNumber.toUpperCase() === trip.vehicleNumber.toUpperCase()
      );
    const matchedDriver = drivers.find(
      (d) =>
        normalizeNameKey(d.driverName) ===
        normalizeNameKey(trip.driverName || matchedVehicle?.driverName || '')
    );

    const freight = Number(trip.freightAmount) || 0;
    const adv = Number(trip.advanceReceived) || 0;
    const bal = calculateLrBalance(freight, adv);

    setTotalManuallyEdited(false);
    setBalanceManuallyEdited(false);
    setForm((prev) => ({
      ...prev,
      tripId: trip.id,
      tripRefLr: trip.lrNumber || '',
      lrDate: trip.tripDate || prev.lrDate,
      vehicleId: matchedVehicle?.id || trip.vehicleId || '',
      vehicleNumber: trip.vehicleNumber || prev.vehicleNumber,
      consignorPartyId: matchedParty?.id || trip.partyId || '',
      consignorName: matchedParty?.partyName || trip.partyName || prev.consignorName,
      consignorAddress: matchedParty
        ? formatPartyFullAddress(matchedParty)
        : prev.consignorAddress,
      consignorPhone: matchedParty?.phone || prev.consignorPhone,
      origin: trip.origin || prev.origin,
      destination: trip.destination || prev.destination,
      containerNo: trip.containerNo || prev.containerNo,
      goodsDescription: trip.material || prev.goodsDescription,
      quantityWeight:
        typeof trip.weightTons === 'number' && trip.weightTons > 0
          ? `${trip.weightTons} MT`
          : prev.quantityWeight,
      freightRate: freight > 0 ? String(freight) : prev.freightRate,
      totalFreightAmount: String(freight),
      advanceAmount: String(adv),
      balanceAmount: String(bal),
      driverName: trip.driverName || matchedVehicle?.driverName || prev.driverName,
      driverMobile:
        matchedDriver?.phone || matchedVehicle?.driverPhone || prev.driverMobile,
      remarks: prev.remarks || trip.notes || '',
    }));
  };

  const handleSelectVehicle = (selectedVehicleId: string) => {
    if (!selectedVehicleId) {
      setForm((prev) => ({ ...prev, vehicleId: '' }));
      return;
    }
    const v = vehicles.find((item) => item.id === selectedVehicleId);
    if (!v) return;
    setForm((prev) => ({
      ...prev,
      vehicleId: v.id,
      vehicleNumber: v.registrationNumber,
      driverName: prev.driverName || v.driverName || '',
      driverMobile: prev.driverMobile || v.driverPhone || '',
    }));
  };

  const handleSelectConsignorParty = (partyId: string) => {
    if (!partyId) {
      setForm((prev) => ({ ...prev, consignorPartyId: '' }));
      return;
    }
    const p = parties.find((item) => item.id === partyId);
    if (!p) return;
    setForm((prev) => ({
      ...prev,
      consignorPartyId: p.id,
      consignorName: p.partyName,
      consignorAddress: formatPartyFullAddress(p),
      consignorPhone: p.phone || '',
    }));
  };

  const handleSelectConsigneeParty = (partyId: string) => {
    if (!partyId) {
      setForm((prev) => ({ ...prev, consigneePartyId: '' }));
      return;
    }
    const p = parties.find((item) => item.id === partyId);
    if (!p) return;
    setForm((prev) => ({
      ...prev,
      consigneePartyId: p.id,
      consigneeName: p.partyName,
      consigneeAddress: formatPartyFullAddress(p),
      consigneePhone: p.phone || '',
    }));
  };

  const handleSelectDriver = (driverId: string) => {
    const d = drivers.find((item) => item.id === driverId);
    if (!d) return;
    setForm((prev) => ({
      ...prev,
      driverName: d.driverName,
      driverMobile: d.phone || prev.driverMobile,
    }));
  };

  const handleFreightRateChange = (val: string) => {
    const rateNum = parseFloat(val);
    setForm((prev) => {
      const nextTotal =
        !totalManuallyEdited && Number.isFinite(rateNum) && rateNum >= 0
          ? String(rateNum)
          : prev.totalFreightAmount;
      const totalNum = parseFloat(nextTotal) || 0;
      const advNum = parseFloat(prev.advanceAmount) || 0;
      const nextBalance = !balanceManuallyEdited
        ? String(calculateLrBalance(totalNum, advNum))
        : prev.balanceAmount;
      return {
        ...prev,
        freightRate: val,
        totalFreightAmount: nextTotal,
        balanceAmount: nextBalance,
      };
    });
  };

  const handleTotalFreightChange = (val: string) => {
    setTotalManuallyEdited(true);
    const totalNum = parseFloat(val) || 0;
    setForm((prev) => {
      const advNum = parseFloat(prev.advanceAmount) || 0;
      const nextBalance = !balanceManuallyEdited
        ? String(calculateLrBalance(totalNum, advNum))
        : prev.balanceAmount;
      return {
        ...prev,
        totalFreightAmount: val,
        balanceAmount: nextBalance,
      };
    });
  };

  const handleAdvanceChange = (val: string) => {
    const advNum = parseFloat(val) || 0;
    setForm((prev) => {
      const totalNum = parseFloat(prev.totalFreightAmount) || 0;
      const nextBalance = !balanceManuallyEdited
        ? String(calculateLrBalance(totalNum, advNum))
        : prev.balanceAmount;
      return {
        ...prev,
        advanceAmount: val,
        balanceAmount: nextBalance,
      };
    });
  };

  const handleSaveLr = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (editingLr && !canEditLr) {
      setFormError('Editing saved Lorry Receipts is restricted to Admin users.');
      return;
    }
    if (!editingLr && !canCreateLr) {
      setFormError('Your account does not have permission to create Lorry Receipts.');
      return;
    }

    const lrNumber = clampStr(form.lrNumber, BLUEPRINT_LIMITS.LR_NUMBER_MAX);
    const lrDate = clampStr(form.lrDate, BLUEPRINT_LIMITS.DATE_MAX);
    const vehicleNumber = clampStr(
      form.vehicleNumber.toUpperCase(),
      BLUEPRINT_LIMITS.VEHICLE_REG_MAX
    );
    const consignorName = clampStr(form.consignorName, BLUEPRINT_LIMITS.PARTY_NAME_MAX);
    const consigneeName = clampStr(form.consigneeName, BLUEPRINT_LIMITS.PARTY_NAME_MAX);
    const origin = clampStr(form.origin, BLUEPRINT_LIMITS.LOCATION_MAX);
    const destination = clampStr(form.destination, BLUEPRINT_LIMITS.LOCATION_MAX);
    const goodsDescription = clampStr(
      form.goodsDescription,
      BLUEPRINT_LIMITS.GOODS_DESC_MAX
    );

    if (!lrNumber) {
      setFormError('LR Number is required.');
      return;
    }
    if (lrDate.length < 4) {
      setFormError('Valid LR Date is required.');
      return;
    }
    if (!vehicleNumber) {
      setFormError('Vehicle Number is required.');
      return;
    }
    if (!consignorName) {
      setFormError('Consignor Name is required.');
      return;
    }
    if (!consigneeName) {
      setFormError('Consignee Name is required.');
      return;
    }
    if (!origin || !destination) {
      setFormError('Both From (Origin) and To (Destination) locations are required.');
      return;
    }
    if (!goodsDescription) {
      setFormError('Goods Description is required.');
      return;
    }

    const duplicate = findDuplicateLorryReceipt(
      lorryReceipts,
      lrNumber,
      editingLr?.id
    );
    if (duplicate) {
      setFormError(
        `Duplicate LR Number "${duplicate.lrNumber}" already exists. Click "Auto-Generate" to assign a unique LR number.`
      );
      return;
    }

    const freightRate = clampNum(form.freightRate || 0, 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    const totalFreightAmount = clampNum(
      form.totalFreightAmount || freightRate || 0,
      0,
      BLUEPRINT_LIMITS.CURRENCY_MAX
    );
    const advanceAmount = clampNum(
      form.advanceAmount || 0,
      0,
      BLUEPRINT_LIMITS.CURRENCY_MAX
    );
    const balanceAmount = clampNum(
      form.balanceAmount !== ''
        ? form.balanceAmount
        : calculateLrBalance(totalFreightAmount, advanceAmount),
      -BLUEPRINT_LIMITS.CURRENCY_MAX,
      BLUEPRINT_LIMITS.CURRENCY_MAX
    );

    // Ensure linked IDs actually match existing records to preserve Firestore referential integrity
    const validTripId =
      form.tripId && trips.some((t) => t.id === form.tripId) ? form.tripId : '';
    const validVehicleId =
      form.vehicleId && vehicles.some((v) => v.id === form.vehicleId)
        ? form.vehicleId
        : '';
    const validConsignorPartyId =
      form.consignorPartyId && parties.some((p) => p.id === form.consignorPartyId)
        ? form.consignorPartyId
        : '';
    const validConsigneePartyId =
      form.consigneePartyId && parties.some((p) => p.id === form.consigneePartyId)
        ? form.consigneePartyId
        : '';

    const coreFields = {
      lrNumber,
      lrDate,
      vehicleId: validVehicleId,
      vehicleNumber,
      tripId: validTripId,
      tripRefLr: clampStr(form.tripRefLr, BLUEPRINT_LIMITS.LR_NUMBER_MAX),
      consignorPartyId: validConsignorPartyId,
      consignorName,
      consignorAddress: clampStr(form.consignorAddress, BLUEPRINT_LIMITS.ADDRESS_MAX),
      consignorPhone: clampStr(form.consignorPhone, BLUEPRINT_LIMITS.PHONE_MAX),
      consigneePartyId: validConsigneePartyId,
      consigneeName,
      consigneeAddress: clampStr(form.consigneeAddress, BLUEPRINT_LIMITS.ADDRESS_MAX),
      consigneePhone: clampStr(form.consigneePhone, BLUEPRINT_LIMITS.PHONE_MAX),
      origin,
      destination,
      containerNo: clampStr(
        form.containerNo.toUpperCase(),
        BLUEPRINT_LIMITS.CONTAINER_NO_MAX
      ),
      goodsDescription,
      quantityWeight: clampStr(form.quantityWeight, BLUEPRINT_LIMITS.QTY_WEIGHT_MAX),
      freightRate,
      totalFreightAmount,
      advanceAmount,
      balanceAmount,
      driverName: clampStr(form.driverName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX),
      driverMobile: clampStr(form.driverMobile, BLUEPRINT_LIMITS.PHONE_MAX),
      remarks: clampStr(form.remarks, BLUEPRINT_LIMITS.NOTES_MAX),
      senderSignature: clampStr(form.senderSignature, BLUEPRINT_LIMITS.SIGNATURE_MAX),
      receiverSignature: clampStr(
        form.receiverSignature,
        BLUEPRINT_LIMITS.SIGNATURE_MAX
      ),
    };

    setSavingLr(true);
    try {
      if (editingLr) {
        await updateDoc(doc(db, 'lorryReceipts', editingLr.id), {
          ...coreFields,
          updatedAt: serverTimestamp(),
        });
        await recordAuditLog({
          ownerId: userId,
          actorRole,
          action: 'UPDATE',
          module: 'Lorry Receipts',
          recordId: editingLr.id,
          summary: `Updated LR ${lrNumber} (${vehicleNumber}, ${consignorName} → ${consigneeName})`,
        });
        setBannerMessage({
          tone: 'success',
          text: `Lorry Receipt ${lrNumber} updated successfully.`,
        });
        if (previewLr && previewLr.id === editingLr.id) {
          setPreviewLr({
            ...editingLr,
            ...coreFields,
          });
        }
      } else {
        const newId = generateSafeDocId('lr');
        await setDoc(doc(collection(db, 'lorryReceipts'), newId), {
          ...coreFields,
          ownerId: userId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Advance nextLrSeq cleanly if Admin and settings doc exists
        if (permissions.isAdmin && companySettings) {
          try {
            const computedNext = generateNextUniqueLrNumber(
              [...lorryReceipts, { lrNumber }],
              trips,
              companySettings
            );
            await updateDoc(doc(db, 'companySettings', companySettings.id), {
              nextLrSeq: computedNext.nextSeq,
              updatedAt: serverTimestamp(),
            });
          } catch {
            // Non-blocking: sequence calculation always scans existing records dynamically too
          }
        }

        await recordAuditLog({
          ownerId: userId,
          actorRole,
          action: 'CREATE',
          module: 'Lorry Receipts',
          recordId: newId,
          summary: `Created LR ${lrNumber} (${vehicleNumber}, ${origin} → ${destination}, Total ${formatINR(totalFreightAmount)})`,
        });

        const createdRecord: LorryReceipt = {
          id: newId,
          ...coreFields,
          ownerId: userId,
          createdAt: null,
          updatedAt: null,
        };
        setBannerMessage({
          tone: 'success',
          text: `Lorry Receipt ${lrNumber} saved. You can preview, print, save PDF, or share on WhatsApp below.`,
        });
        setPreviewLr(createdRecord);
      }

      setFormOpen(false);
      setEditingLr(null);
    } catch (err) {
      setFormError(extractReadableFirestoreError(err, 'Saving Lorry Receipt'));
    } finally {
      setSavingLr(false);
    }
  };

  const handleConfirmDeleteLr = async () => {
    if (!deleteTarget || !canDeleteLr) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, 'lorryReceipts', deleteTarget.id));
      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'DELETE',
        module: 'Lorry Receipts',
        recordId: deleteTarget.id,
        summary: `Deleted LR ${deleteTarget.lrNumber} (${deleteTarget.vehicleNumber})`,
      });
      if (previewLr?.id === deleteTarget.id) {
        setPreviewLr(null);
      }
      setBannerMessage({
        tone: 'success',
        text: `Lorry Receipt ${deleteTarget.lrNumber} deleted.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      setBannerMessage({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Deleting Lorry Receipt'),
      });
    } finally {
      setDeleting(false);
    }
  };

  const buildLrPdfFileName = (lr: LorryReceipt) =>
    sanitizePdfFileName(`LR-${lr.lrNumber}-${lr.vehicleNumber}`);

  const renderPreviewLrPdf = async (
    lr: LorryReceipt
  ): Promise<RenderedA4PdfResult | null> => {
    if (!lrPrintRef.current) {
      setPdfError('LR preview sheet is not ready yet. Please try again.');
      return null;
    }
    setPdfBusy(true);
    setPdfError(null);
    try {
      const rendered = await renderElementToA4Pdf(
        lrPrintRef.current,
        buildLrPdfFileName(lr),
        'portrait'
      );
      setGeneratedLrPdf({ lrId: lr.id, rendered });
      return rendered;
    } catch (err) {
      setPdfError(
        err instanceof Error
          ? err.message
          : 'Failed to generate A4 PDF for this Lorry Receipt.'
      );
      return null;
    } finally {
      setPdfBusy(false);
    }
  };

  const handleOpenA4PdfPreview = async () => {
    if (!previewLr) return;
    const rendered = await renderPreviewLrPdf(previewLr);
    if (rendered) {
      setRenderedPdfPreview(rendered);
    }
  };

  const handleDirectSaveLrPdf = async () => {
    if (!previewLr) return;
    const rendered = await renderPreviewLrPdf(previewLr);
    if (rendered) {
      rendered.pdf.save(rendered.fileName);
    }
  };

  const openWhatsAppForLr = (
    lr: LorryReceipt,
    role: WhatsAppRecipientRole,
    renderedPdf?: RenderedA4PdfResult | null
  ) => {
    const recipient = resolveRecipientForLr(lr, role);
    const pdfFileName = renderedPdf?.fileName || buildLrPdfFileName(lr);
    const message = buildLorryReceiptWhatsAppMessage(
      lr,
      renderedPdf ? pdfFileName : undefined
    );

    const attachment: WhatsAppPdfAttachment | null = renderedPdf
      ? {
          fileName: renderedPdf.fileName,
          pageCount: renderedPdf.pageCount,
          getFile: () => createPdfFileFromJsPdf(renderedPdf.pdf, renderedPdf.fileName),
          onDownloadPdf: () => renderedPdf.pdf.save(renderedPdf.fileName),
        }
      : null;

    setWhatsAppShareState({
      partyName: `${recipient.name} (${recipient.label})`,
      partyPhone: recipient.phone,
      message,
      attachment,
    });
  };

  const handleSharePreviewLrOnWhatsApp = async (role: WhatsAppRecipientRole) => {
    if (!previewLr) return;
    let rendered =
      generatedLrPdf && generatedLrPdf.lrId === previewLr.id
        ? generatedLrPdf.rendered
        : null;
    if (!rendered && lrPrintRef.current) {
      rendered = await renderPreviewLrPdf(previewLr);
    }
    openWhatsAppForLr(previewLr, role, rendered);
  };

  // Admin Logo Upload handlers
  const handleLogoFileSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !canManageBranding) return;

    setProcessingLogo(true);
    setBrandingStatus(null);
    try {
      const compressedDataUrl = await compressLogoImageFile(file);
      setLogoPreviewDataUrl(compressedDataUrl);
      setBrandingStatus({
        tone: 'success',
        text: 'Logo loaded and optimized for A4 LR printing. Click "Save LR Branding & Logo" to apply across all Lorry Receipts.',
      });
    } catch (err) {
      setBrandingStatus({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Unable to process logo file.',
      });
    } finally {
      setProcessingLogo(false);
    }
  };

  const handleSaveBrandingSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageBranding) return;

    setBrandingStatus(null);
    const cleanPrefix =
      clampStr(lrPrefixInput, BLUEPRINT_LIMITS.LR_PREFIX_MAX) || DEFAULT_LR_PREFIX;
    const cleanNextSeq = Math.max(
      1,
      Math.round(clampNum(nextLrSeqInput || 1, 1, 1000000))
    );

    if (!isValidCompanyLogoDataUrl(logoPreviewDataUrl)) {
      setBrandingStatus({
        tone: 'error',
        text: 'Logo image format or size is invalid. Please re-upload a PNG, JPG, or WebP logo.',
      });
      return;
    }

    setSavingBranding(true);
    try {
      if (companySettings) {
        await updateDoc(doc(db, 'companySettings', companySettings.id), {
          logoDataUrl: logoPreviewDataUrl,
          lrPrefix: cleanPrefix,
          nextLrSeq: cleanNextSeq,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, 'companySettings', 'primary'), {
          companyName: LR_COMPANY_NAME,
          address: '',
          gstin: '',
          pan: '',
          phone: `${LR_CONTACT_LEFT} / ${LR_CONTACT_RIGHT}`,
          email: '',
          bankName: '',
          accountHolderName: LR_COMPANY_NAME,
          accountNumber: '',
          ifscCode: '',
          branchName: '',
          billPrefix: 'BSE-',
          nextBillSeq: 1,
          lrPrefix: cleanPrefix,
          nextLrSeq: cleanNextSeq,
          logoDataUrl: logoPreviewDataUrl,
          defaultDieselRate: DEFAULT_DIESEL_RATE,
          terms: '',
          ownerId: userId,
          updatedAt: serverTimestamp(),
        });
      }

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'UPDATE',
        module: 'Company Settings',
        recordId: companySettings?.id || 'primary',
        summary: logoPreviewDataUrl
          ? `Updated approved company logo and LR numbering (${cleanPrefix})`
          : `Cleared company logo and updated LR numbering (${cleanPrefix})`,
      });

      setBrandingStatus({
        tone: 'success',
        text: 'Approved company logo and LR numbering settings saved successfully.',
      });
    } catch (err) {
      setBrandingStatus({
        tone: 'error',
        text: extractReadableFirestoreError(err, 'Saving LR Branding Settings'),
      });
    } finally {
      setSavingBranding(false);
    }
  };

  const renderRoyalBlueLrHeader = (logoSrc: string, compact = false) => (
    <div className="bg-blue-900 text-white px-4 sm:px-6 pt-3 pb-4 border-b-4 border-blue-950">
      {/* Top Devotional Line in Gujarati */}
      <div className="text-center text-xs sm:text-sm font-semibold tracking-wide text-blue-100 pb-2 border-b border-blue-700/80">
        {LR_DEVOTIONAL_HEADER}
      </div>

      {/* Main Header Row: Left Contact | Center Logo + Company Name | Right Contact */}
      <div className="grid grid-cols-1 sm:grid-cols-12 items-center gap-3 pt-3">
        {/* Left Contact */}
        <div className="sm:col-span-3 flex sm:flex-col items-center sm:items-start justify-center gap-1 text-left">
          <span className="text-[10px] uppercase tracking-wider text-blue-200 font-semibold">
            Office / Dispatch
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-sm sm:text-base font-bold text-white tracking-wide">
            <Phone className="w-3.5 h-3.5 text-blue-200 shrink-0" />
            {LR_CONTACT_LEFT}
          </span>
        </div>

        {/* Center Logo + Company Name */}
        <div className="sm:col-span-6 flex flex-col items-center justify-center text-center gap-1.5">
          {logoSrc ? (
            <div className="bg-white rounded-lg px-3 py-1.5 shadow-sm border border-blue-200 inline-flex items-center justify-center">
              <img
                src={logoSrc}
                alt="BAPASITARAM ENTERPRISE Approved Logo"
                className={
                  compact
                    ? 'max-h-12 max-w-[180px] object-contain'
                    : 'max-h-16 max-w-[220px] object-contain'
                }
              />
            </div>
          ) : null}
          <h2
            className={`font-display font-bold tracking-wider text-white ${
              compact ? 'text-lg sm:text-xl' : 'text-xl sm:text-2xl'
            }`}
          >
            {LR_COMPANY_NAME}
          </h2>
          {companySettings?.address ? (
            <p className="text-[11px] text-blue-100 leading-snug max-w-md">
              {companySettings.address}
            </p>
          ) : (
            <p className="text-[11px] uppercase tracking-widest text-blue-200 font-medium">
              Fleet Owners &amp; Transport Contractors
            </p>
          )}
          {companySettings?.gstin ? (
            <p className="text-[10px] font-mono text-blue-200">
              GSTIN: {companySettings.gstin}
            </p>
          ) : null}
        </div>

        {/* Right Contact */}
        <div className="sm:col-span-3 flex sm:flex-col items-center sm:items-end justify-center gap-1 text-right">
          <span className="text-[10px] uppercase tracking-wider text-blue-200 font-semibold">
            Booking / Support
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-sm sm:text-base font-bold text-white tracking-wide">
            <Phone className="w-3.5 h-3.5 text-blue-200 shrink-0" />
            {LR_CONTACT_RIGHT}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Top Royal Blue Module Banner */}
      <div className="bg-blue-900 text-white rounded-2xl p-5 sm:p-6 shadow-sm border border-blue-950 no-print">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            {activeLogoDataUrl ? (
              <div className="bg-white rounded-xl p-2 shrink-0 border border-blue-200 shadow-sm hidden sm:flex items-center justify-center">
                <img
                  src={activeLogoDataUrl}
                  alt="Company Logo"
                  className="max-h-12 max-w-[110px] object-contain"
                />
              </div>
            ) : (
              <div className="w-12 h-12 rounded-xl bg-blue-800 border border-blue-700 flex items-center justify-center shrink-0">
                <FileCheck2 className="w-6 h-6 text-white" />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold text-blue-200 tracking-wide">
                {LR_DEVOTIONAL_HEADER}
              </div>
              <h2 className="font-display text-lg sm:text-xl font-bold text-white tracking-tight mt-0.5">
                Lorry Receipt (LR) Register — {LR_COMPANY_NAME}
              </h2>
              <p className="text-xs text-blue-100 mt-1">
                Standalone consignment note module kept separate from Billing &amp; Invoices. Contacts:{' '}
                <span className="font-mono font-semibold text-white">
                  {LR_CONTACT_LEFT}
                </span>{' '}
                /{' '}
                <span className="font-mono font-semibold text-white">
                  {LR_CONTACT_RIGHT}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('list')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                activeTab === 'list'
                  ? 'bg-white text-blue-900'
                  : 'bg-blue-800 text-blue-100 hover:bg-blue-700'
              }`}
            >
              <FileText className="w-4 h-4" />
              <span>Lorry Receipts ({lorryReceipts.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('branding')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                activeTab === 'branding'
                  ? 'bg-white text-blue-900'
                  : 'bg-blue-800 text-blue-100 hover:bg-blue-700'
              }`}
            >
              <ImagePlus className="w-4 h-4" />
              <span>Admin Logo &amp; LR Settings</span>
            </button>
            {canCreateLr && (
              <button
                type="button"
                onClick={openCreateDrawer}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold bg-white text-blue-900 hover:bg-blue-50 rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>New Lorry Receipt (LR)</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Status Banner */}
      {bannerMessage && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs sm:text-sm flex items-center justify-between gap-3 no-print ${
            bannerMessage.tone === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {bannerMessage.tone === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            <span>{bannerMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setBannerMessage(null)}
            aria-label="Dismiss notification"
            className="p-1 rounded hover:bg-black/5 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* TAB 1: LORRY RECEIPTS REGISTER */}
      {activeTab === 'list' && (
        <div className="space-y-5 no-print">
          {/* KPI Summary Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-medium text-slate-500">Total Lorry Receipts</div>
              <div className="mt-1.5 text-2xl font-display font-bold text-blue-900 tabular-nums">
                {kpiSummary.count}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Next Auto LR: <span className="font-mono font-semibold text-blue-800">{nextAutoLr.lrNumber}</span>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-medium text-slate-500">Linked to Existing Trips</div>
              <div className="mt-1.5 text-2xl font-display font-bold text-slate-900 tabular-nums">
                {kpiSummary.linkedTripCount}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                No duplicate trips created
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-medium text-slate-500">Shown LR Freight Total</div>
              <div className="mt-1.5 text-xl sm:text-2xl font-display font-bold text-slate-900 tabular-nums">
                {formatINR(kpiSummary.totalFreight)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Advance: {formatINR(kpiSummary.totalAdvance)}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-blue-200 bg-blue-50/40 p-4">
              <div className="text-xs font-medium text-blue-900">Shown LR Balance Total</div>
              <div className="mt-1.5 text-xl sm:text-2xl font-display font-bold text-blue-900 tabular-nums">
                {formatINR(kpiSummary.totalBalance)}
              </div>
              <div className="text-[11px] text-blue-700 mt-0.5">
                Separate from Party Ledger &amp; Bills
              </div>
            </div>
          </div>

          {/* Search & Filter Controls */}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 items-end">
              <div className="lg:col-span-4">
                <label
                  htmlFor="lr-search-input"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1"
                >
                  Search LR No, Party, Vehicle, Date
                </label>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="lr-search-input"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="LR No, Consignor, Consignee, Vehicle, Container..."
                    className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                  />
                </div>
              </div>

              <div className="lg:col-span-3">
                <label
                  htmlFor="lr-vehicle-filter"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1"
                >
                  Vehicle Filter
                </label>
                <select
                  id="lr-vehicle-filter"
                  value={vehicleFilter}
                  onChange={(e) => setVehicleFilter(e.target.value)}
                  className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                >
                  <option value="">All Vehicles</option>
                  {uniqueVehicleNumbers.map((reg) => (
                    <option key={reg} value={reg}>
                      {reg}
                    </option>
                  ))}
                </select>
              </div>

              <div className="lg:col-span-2">
                <label
                  htmlFor="lr-from-date"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1"
                >
                  From Date
                </label>
                <input
                  id="lr-from-date"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                />
              </div>

              <div className="lg:col-span-2">
                <label
                  htmlFor="lr-to-date"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1"
                >
                  To Date
                </label>
                <input
                  id="lr-to-date"
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                />
              </div>

              <div className="lg:col-span-1">
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setFromDate('');
                    setToDate('');
                    setVehicleFilter('');
                  }}
                  className="w-full px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          {/* LR Register Table */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-900">
                  Saved Lorry Receipts
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  ({filteredLrs.length} of {lorryReceipts.length})
                </span>
              </div>
              {!canEditLr && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
                  <Lock className="w-3.5 h-3.5 text-slate-500" />
                  Editing saved LRs requires Admin permissions
                </span>
              )}
            </div>

            {loading ? (
              <div className="p-10 text-center text-sm text-slate-500">
                Loading Lorry Receipts...
              </div>
            ) : filteredLrs.length === 0 ? (
              <div className="p-10 text-center space-y-3">
                <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 flex items-center justify-center mx-auto">
                  <FileCheck2 className="w-6 h-6" />
                </div>
                <div className="text-sm font-semibold text-slate-900">
                  {lorryReceipts.length === 0
                    ? 'No Lorry Receipts created yet'
                    : 'No Lorry Receipts match your search filters'}
                </div>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Create a professional Royal Blue &amp; White Lorry Receipt (LR) with automatic unique numbering, A4 PDF export, print preview, and WhatsApp manual sharing.
                </p>
                {canCreateLr && lorryReceipts.length === 0 && (
                  <button
                    type="button"
                    onClick={openCreateDrawer}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Create First Lorry Receipt</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-blue-900 text-white text-[11px] uppercase tracking-wider">
                      <th className="py-3 px-4 font-semibold">LR No &amp; Date</th>
                      <th className="py-3 px-4 font-semibold">Vehicle &amp; Link</th>
                      <th className="py-3 px-4 font-semibold">Consignor → Consignee</th>
                      <th className="py-3 px-4 font-semibold">Route &amp; Goods</th>
                      <th className="py-3 px-4 font-semibold text-right">Freight / Bal</th>
                      <th className="py-3 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs sm:text-sm">
                    {filteredLrs.map((lr) => (
                      <tr key={lr.id} className="hover:bg-blue-50/40 transition-colors">
                        <td className="py-3 px-4 align-top whitespace-nowrap">
                          <div className="font-mono font-bold text-blue-900">
                            {lr.lrNumber}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {formatDateIN(lr.lrDate)}
                          </div>
                        </td>
                        <td className="py-3 px-4 align-top whitespace-nowrap">
                          <div className="font-mono font-semibold text-slate-900">
                            {lr.vehicleNumber}
                          </div>
                          {lr.containerNo && (
                            <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                              Ctr: {lr.containerNo}
                            </div>
                          )}
                          {lr.tripId && (
                            <div className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-[10px] font-medium text-blue-800">
                              <Link2 className="w-3 h-3" />
                              <span>Trip {lr.tripRefLr || 'Linked'}</span>
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 align-top max-w-[260px]">
                          <div className="font-medium text-slate-900 truncate">
                            {lr.consignorName}
                          </div>
                          <div className="text-xs text-slate-500 truncate mt-0.5">
                            To: {lr.consigneeName}
                          </div>
                          {lr.driverName && (
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              Driver: {lr.driverName}
                              {lr.driverMobile ? ` (${lr.driverMobile})` : ''}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 align-top max-w-[240px]">
                          <div className="font-medium text-slate-800">
                            {lr.origin} → {lr.destination}
                          </div>
                          <div className="text-xs text-slate-600 truncate mt-0.5">
                            {lr.goodsDescription}
                          </div>
                          {lr.quantityWeight && (
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              Qty/Wt: {lr.quantityWeight}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 align-top text-right whitespace-nowrap tabular-nums">
                          <div className="font-semibold text-slate-900">
                            {formatINR(lr.totalFreightAmount)}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Adv: {formatINR(lr.advanceAmount)}
                          </div>
                          <div className="text-xs font-bold text-blue-900 mt-0.5">
                            Bal: {formatINR(lr.balanceAmount)}
                          </div>
                        </td>
                        <td className="py-3 px-4 align-top text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setPdfError(null);
                                setPreviewLr(lr);
                              }}
                              title="Preview, Print & Save A4 PDF"
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Preview / PDF</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setWhatsAppRecipientRole('consignor');
                                openWhatsAppForLr(lr, 'consignor', null);
                              }}
                              title="Manual WhatsApp Share"
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg cursor-pointer"
                            >
                              <MessageCircle className="w-3.5 h-3.5" />
                              <span className="hidden xl:inline">WhatsApp</span>
                            </button>
                            {canEditLr && (
                              <button
                                type="button"
                                onClick={() => openEditDrawer(lr)}
                                title="Edit Lorry Receipt (Admin Only)"
                                className="p-1.5 text-slate-600 hover:text-blue-900 hover:bg-slate-100 rounded-lg cursor-pointer"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                            )}
                            {canDeleteLr && (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(lr)}
                                title="Delete Lorry Receipt (Admin Only)"
                                className="p-1.5 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded-lg cursor-pointer"
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
        </div>
      )}

      {/* TAB 2: ADMIN LOGO UPLOAD & LR NUMBERING SETTINGS */}
      {activeTab === 'branding' && (
        <div className="space-y-6 no-print">
          {!canManageBranding ? (
            <div className="bg-white rounded-xl border border-amber-200 p-6 flex items-start gap-3">
              <Lock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Admin Access Required
                </h3>
                <p className="text-xs sm:text-sm text-slate-600">
                  Only the BAPASITARAM ENTERPRISE Administrator can upload or replace the approved company logo and configure automatic LR numbering.
                </p>
              </div>
            </div>
          ) : (
            <form
              onSubmit={handleSaveBrandingSettings}
              className="grid grid-cols-1 lg:grid-cols-12 gap-6"
            >
              {/* Left Column: Upload & Numbering Controls */}
              <div className="lg:col-span-5 bg-white rounded-xl border border-slate-200 p-5 space-y-5">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-900">
                    Admin Company Logo Upload
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Upload your approved BAPASITARAM ENTERPRISE logo (PNG, JPG, or WebP). It will automatically appear in the Royal Blue &amp; White LR header and A4 PDFs.
                  </p>
                </div>

                <div className="border-2 border-dashed border-blue-200 rounded-xl p-5 bg-blue-50/40 text-center space-y-3">
                  {logoPreviewDataUrl ? (
                    <div className="space-y-3">
                      <div className="bg-white rounded-xl p-4 border border-slate-200 inline-flex items-center justify-center shadow-sm">
                        <img
                          src={logoPreviewDataUrl}
                          alt="Uploaded Company Logo Preview"
                          className="max-h-24 max-w-[220px] object-contain"
                        />
                      </div>
                      <div className="text-[11px] text-emerald-700 font-medium">
                        Approved logo ready for LR Header
                      </div>
                    </div>
                  ) : (
                    <div className="py-4 space-y-2">
                      <Upload className="w-8 h-8 text-blue-800 mx-auto" />
                      <div className="text-xs font-medium text-slate-700">
                        No company logo uploaded yet
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Recommended: Transparent PNG or crisp horizontal logo (auto-optimized for A4 print)
                      </div>
                    </div>
                  )}

                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleLogoFileSelected}
                    className="hidden"
                  />

                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={processingLogo}
                      onClick={() => logoInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-60"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>
                        {processingLogo
                          ? 'Optimizing Logo...'
                          : logoPreviewDataUrl
                          ? 'Replace Logo'
                          : 'Upload Approved Logo'}
                      </span>
                    </button>
                    {logoPreviewDataUrl && (
                      <button
                        type="button"
                        onClick={() => setLogoPreviewDataUrl('')}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remove Logo</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* LR Automatic Numbering Controls */}
                <div className="pt-2 border-t border-slate-200 space-y-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-700">
                    Automatic Unique LR Numbering
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="lr-prefix-input"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        LR Number Prefix
                      </label>
                      <input
                        id="lr-prefix-input"
                        type="text"
                        maxLength={BLUEPRINT_LIMITS.LR_PREFIX_MAX}
                        value={lrPrefixInput}
                        onChange={(e) => setLrPrefixInput(e.target.value)}
                        placeholder="BSE-LR-"
                        className="w-full px-3 py-2 text-xs sm:text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="lr-seq-input"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Next Sequence No.
                      </label>
                      <input
                        id="lr-seq-input"
                        type="number"
                        min={1}
                        max={1000000}
                        value={nextLrSeqInput}
                        onChange={(e) => setNextLrSeqInput(e.target.value)}
                        className="w-full px-3 py-2 text-xs sm:text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Next generated unique LR preview:{' '}
                    <span className="font-mono font-semibold text-blue-900">
                      {
                        generateNextUniqueLrNumber(lorryReceipts, trips, {
                          lrPrefix: lrPrefixInput || DEFAULT_LR_PREFIX,
                          nextLrSeq: Number(nextLrSeqInput) || 1,
                        }).lrNumber
                      }
                    </span>
                  </p>
                </div>

                {brandingStatus && (
                  <div
                    role="status"
                    className={`p-3 rounded-lg border text-xs ${
                      brandingStatus.tone === 'success'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : 'bg-red-50 border-red-200 text-red-800'
                    }`}
                  >
                    {brandingStatus.text}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={savingBranding || processingLogo}
                  className="w-full py-2.5 px-4 text-xs sm:text-sm font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                >
                  {savingBranding ? 'Saving Settings...' : 'Save LR Branding & Logo'}
                </button>
              </div>

              {/* Right Column: Live Royal Blue & White LR Header Preview */}
              <div className="lg:col-span-7 bg-white rounded-xl border border-slate-200 p-5 space-y-4">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-900">
                    Live LR Header Preview (Royal Blue &amp; White)
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    This exact branding banner prints at the top of every A4 Lorry Receipt PDF.
                  </p>
                </div>

                <div className="border-2 border-blue-900 rounded-xl overflow-hidden shadow-sm">
                  {renderRoyalBlueLrHeader(logoPreviewDataUrl, true)}
                  <div className="bg-blue-50 px-4 py-2.5 flex items-center justify-between text-xs border-b border-blue-200">
                    <span className="font-bold text-blue-900 tracking-wide uppercase">
                      LORRY RECEIPT (CONSIGNMENT NOTE)
                    </span>
                    <span className="font-mono font-bold text-blue-900">
                      LR No: {nextAutoLr.lrNumber}
                    </span>
                  </div>
                  <div className="p-4 bg-white text-xs text-slate-500 text-center">
                    Clean Royal Blue &amp; White sections for Consignor, Consignee, Goods, Freight &amp; Signatures — zero invented bank details or QR codes.
                  </div>
                </div>
              </div>
            </form>
          )}
        </div>
      )}

      {/* LR ENTRY / EDIT MODAL DRAWER */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/65 flex items-center justify-center p-3 sm:p-5 overflow-y-auto no-print"
          role="dialog"
          aria-modal="true"
          aria-label={editingLr ? 'Edit Lorry Receipt' : 'Create New Lorry Receipt'}
        >
          <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl border border-slate-200 my-auto max-h-[94vh] flex flex-col overflow-hidden">
            {/* Drawer Header */}
            <div className="px-5 sm:px-6 py-4 bg-blue-900 text-white flex items-center justify-between gap-3 shrink-0">
              <div>
                <div className="text-[11px] text-blue-200 font-medium">
                  {LR_DEVOTIONAL_HEADER}
                </div>
                <h3 className="font-display text-base sm:text-lg font-bold text-white">
                  {editingLr
                    ? `Edit Lorry Receipt — ${editingLr.lrNumber}`
                    : 'New Lorry Receipt (LR) Entry'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFormOpen(false);
                  setEditingLr(null);
                }}
                aria-label="Close LR form"
                className="p-2 text-blue-200 hover:text-white rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveLr} className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
              {/* Info Notice + Optional Link to Existing Trip */}
              <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 space-y-3">
                <div className="flex items-start gap-2.5 text-xs text-blue-950">
                  <Link2 className="w-4 h-4 text-blue-800 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Optional Trip &amp; Vehicle Linking:</span>{' '}
                    Select an existing Trip below to auto-fill vehicle, route, consignor, goods, freight, and driver details. Saving an LR{' '}
                    <span className="font-semibold">never creates duplicate trips or modifies party ledgers/bills</span>.
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="lr-link-trip"
                    className="block text-[11px] font-semibold uppercase tracking-wider text-blue-900 mb-1"
                  >
                    Link Existing Trip (Optional Auto-Fill)
                  </label>
                  <select
                    id="lr-link-trip"
                    value={form.tripId}
                    onChange={(e) => handleLinkTripSelect(e.target.value)}
                    className="w-full px-3 py-2 text-xs sm:text-sm bg-white border border-blue-300 rounded-lg focus:outline-none focus:border-blue-900"
                  >
                    <option value="">— Standalone LR (Not Linked to a Trip) —</option>
                    {trips.slice(0, 150).map((t) => (
                      <option key={t.id} value={t.id}>
                        {formatDateIN(t.tripDate)} · {t.lrNumber} · {t.vehicleNumber} ·{' '}
                        {t.partyName} ({t.origin} → {t.destination})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {formError && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs sm:text-sm text-red-800 flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Section 1: LR Number, Date, Vehicle, Container */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-blue-900 border-b border-blue-100 pb-1.5">
                  1. Receipt &amp; Vehicle Details
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <label
                      htmlFor="lr-number"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      1. LR Number *
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        id="lr-number"
                        type="text"
                        required
                        maxLength={BLUEPRINT_LIMITS.LR_NUMBER_MAX}
                        value={form.lrNumber}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, lrNumber: e.target.value }))
                        }
                        className="w-full px-3 py-2 text-xs sm:text-sm font-mono font-semibold bg-blue-50/50 border border-blue-300 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                      />
                      {!editingLr && (
                        <button
                          type="button"
                          title="Auto-Generate Unique LR Number"
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              lrNumber: nextAutoLr.lrNumber,
                            }))
                          }
                          className="px-2.5 py-2 text-blue-900 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg cursor-pointer shrink-0"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="lr-date"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      2. LR Date *
                    </label>
                    <input
                      id="lr-date"
                      type="date"
                      required
                      value={form.lrDate}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, lrDate: e.target.value }))
                      }
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="lr-vehicle-number"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      3. Vehicle Number *
                    </label>
                    <input
                      id="lr-vehicle-number"
                      type="text"
                      required
                      maxLength={BLUEPRINT_LIMITS.VEHICLE_REG_MAX}
                      value={form.vehicleNumber}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          vehicleNumber: e.target.value.toUpperCase(),
                          vehicleId: '',
                        }))
                      }
                      placeholder="GJ-03-BW-4312"
                      className="w-full px-3 py-2 text-xs sm:text-sm font-mono uppercase bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="lr-vehicle-pick"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Quick-Pick Fleet Vehicle
                    </label>
                    <select
                      id="lr-vehicle-pick"
                      value={form.vehicleId}
                      onChange={(e) => handleSelectVehicle(e.target.value)}
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    >
                      <option value="">Select fleet vehicle...</option>
                      {vehicles.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.registrationNumber} ({v.vehicleType})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Section 2: Consignor & Consignee */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-blue-900 border-b border-blue-100 pb-1.5">
                  2. Consignor &amp; Consignee Details
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Consignor */}
                  <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-blue-900">
                        4. Consignor (Sender) *
                      </span>
                      <select
                        aria-label="Quick-pick Consignor Party"
                        value={form.consignorPartyId}
                        onChange={(e) => handleSelectConsignorParty(e.target.value)}
                        className="px-2 py-1 text-[11px] bg-white border border-slate-300 rounded-md max-w-[180px]"
                      >
                        <option value="">Pick saved party...</option>
                        {parties.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.partyName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      required
                      maxLength={BLUEPRINT_LIMITS.PARTY_NAME_MAX}
                      value={form.consignorName}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          consignorName: e.target.value,
                        }))
                      }
                      placeholder="Consignor Name"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-900"
                    />
                    <textarea
                      rows={2}
                      maxLength={BLUEPRINT_LIMITS.ADDRESS_MAX}
                      value={form.consignorAddress}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          consignorAddress: e.target.value,
                        }))
                      }
                      placeholder="Consignor Address"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-900"
                    />
                    <input
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                      value={form.consignorPhone}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          consignorPhone: e.target.value,
                        }))
                      }
                      placeholder="Consignor Mobile (for WhatsApp Share)"
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-900"
                    />
                  </div>

                  {/* Consignee */}
                  <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-blue-900">
                        5. Consignee (Receiver) *
                      </span>
                      <select
                        aria-label="Quick-pick Consignee Party"
                        value={form.consigneePartyId}
                        onChange={(e) => handleSelectConsigneeParty(e.target.value)}
                        className="px-2 py-1 text-[11px] bg-white border border-slate-300 rounded-md max-w-[180px]"
                      >
                        <option value="">Pick saved party...</option>
                        {parties.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.partyName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      required
                      maxLength={BLUEPRINT_LIMITS.PARTY_NAME_MAX}
                      value={form.consigneeName}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          consigneeName: e.target.value,
                        }))
                      }
                      placeholder="Consignee Name"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-900"
                    />
                    <textarea
                      rows={2}
                      maxLength={BLUEPRINT_LIMITS.ADDRESS_MAX}
                      value={form.consigneeAddress}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          consigneeAddress: e.target.value,
                        }))
                      }
                      placeholder="Consignee Address"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-900"
                    />
                    <input
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                      value={form.consigneePhone}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          consigneePhone: e.target.value,
                        }))
                      }
                      placeholder="Consignee Mobile (for WhatsApp Share)"
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-900"
                    />
                  </div>
                </div>
              </div>

              {/* Section 3: Route, Container & Goods */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-blue-900 border-b border-blue-100 pb-1.5">
                  3. Route, Container &amp; Goods Details
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="lr-origin"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      6. From *
                    </label>
                    <input
                      id="lr-origin"
                      type="text"
                      required
                      maxLength={BLUEPRINT_LIMITS.LOCATION_MAX}
                      value={form.origin}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, origin: e.target.value }))
                      }
                      placeholder="e.g. Morbi"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-destination"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      7. To *
                    </label>
                    <input
                      id="lr-destination"
                      type="text"
                      required
                      maxLength={BLUEPRINT_LIMITS.LOCATION_MAX}
                      value={form.destination}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, destination: e.target.value }))
                      }
                      placeholder="e.g. Mundra Port"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-container"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      8. Container Number
                    </label>
                    <input
                      id="lr-container"
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.CONTAINER_NO_MAX}
                      value={form.containerNo}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          containerNo: e.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="e.g. MSCU1234567"
                      className="w-full px-3 py-2 text-xs sm:text-sm font-mono uppercase bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label
                      htmlFor="lr-goods"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      9. Goods Description *
                    </label>
                    <input
                      id="lr-goods"
                      type="text"
                      required
                      maxLength={BLUEPRINT_LIMITS.GOODS_DESC_MAX}
                      value={form.goodsDescription}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          goodsDescription: e.target.value,
                        }))
                      }
                      placeholder="e.g. Ceramic Floor Tiles (Packed in Boxes)"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-qty-weight"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      10. Quantity / Weight
                    </label>
                    <input
                      id="lr-qty-weight"
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.QTY_WEIGHT_MAX}
                      value={form.quantityWeight}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          quantityWeight: e.target.value,
                        }))
                      }
                      placeholder="e.g. 26 MT / 1200 Boxes"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                </div>
              </div>

              {/* Section 4: Freight Charges */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-blue-900 border-b border-blue-100 pb-1.5">
                  4. Freight Calculation (INR)
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <label
                      htmlFor="lr-freight-rate"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      11. Freight Rate (₹)
                    </label>
                    <input
                      id="lr-freight-rate"
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.freightRate}
                      onChange={(e) => handleFreightRateChange(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 text-xs sm:text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-total-freight"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      12. Total Freight Amount (₹) *
                    </label>
                    <input
                      id="lr-total-freight"
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={form.totalFreightAmount}
                      onChange={(e) => handleTotalFreightChange(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 text-xs sm:text-sm font-mono font-semibold bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-advance"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      13. Advance Amount (₹)
                    </label>
                    <input
                      id="lr-advance"
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.advanceAmount}
                      onChange={(e) => handleAdvanceChange(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 text-xs sm:text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-balance"
                      className="block text-xs font-medium text-blue-900 mb-1"
                    >
                      14. Balance Amount (₹)
                    </label>
                    <input
                      id="lr-balance"
                      type="number"
                      step="0.01"
                      value={form.balanceAmount}
                      onChange={(e) => {
                        setBalanceManuallyEdited(true);
                        setForm((prev) => ({
                          ...prev,
                          balanceAmount: e.target.value,
                        }));
                      }}
                      className="w-full px-3 py-2 text-xs sm:text-sm font-mono font-bold text-blue-900 bg-blue-50 border border-blue-300 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                </div>
              </div>

              {/* Section 5: Driver, Remarks & Signatures */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-blue-900 border-b border-blue-100 pb-1.5">
                  5. Driver, Remarks &amp; Signatures
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="lr-driver-name"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      15. Driver Name
                    </label>
                    <input
                      id="lr-driver-name"
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.DRIVER_NAME_MAX}
                      value={form.driverName}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, driverName: e.target.value }))
                      }
                      placeholder="Driver full name"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-driver-mobile"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      16. Driver Mobile Number
                    </label>
                    <input
                      id="lr-driver-mobile"
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                      value={form.driverMobile}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          driverMobile: e.target.value,
                        }))
                      }
                      placeholder="10-digit mobile number"
                      className="w-full px-3 py-2 text-xs sm:text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-driver-pick"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Quick-Pick Driver
                    </label>
                    <select
                      id="lr-driver-pick"
                      value=""
                      onChange={(e) => handleSelectDriver(e.target.value)}
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    >
                      <option value="">Select saved driver...</option>
                      {drivers.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.driverName} {d.phone ? `(${d.phone})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="lr-remarks"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    17. Remarks
                  </label>
                  <textarea
                    id="lr-remarks"
                    rows={2}
                    maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                    value={form.remarks}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, remarks: e.target.value }))
                    }
                    placeholder="Delivery instructions, seal number, or special transport remarks..."
                    className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="lr-sender-sig"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      18. Sender Signature (Name / Authorized Sign)
                    </label>
                    <input
                      id="lr-sender-sig"
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.SIGNATURE_MAX}
                      value={form.senderSignature}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          senderSignature: e.target.value,
                        }))
                      }
                      placeholder="Sender signatory name (optional)"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="lr-receiver-sig"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      19. Receiver Signature (Name / Authorized Sign)
                    </label>
                    <input
                      id="lr-receiver-sig"
                      type="text"
                      maxLength={BLUEPRINT_LIMITS.SIGNATURE_MAX}
                      value={form.receiverSignature}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          receiverSignature: e.target.value,
                        }))
                      }
                      placeholder="Receiver signatory name (optional)"
                      className="w-full px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-900"
                    />
                  </div>
                </div>
              </div>

              {/* Drawer Footer Actions */}
              <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setFormOpen(false);
                    setEditingLr(null);
                  }}
                  className="px-4 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLr}
                  className="inline-flex items-center gap-2 px-5 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                >
                  <FileCheck2 className="w-4 h-4" />
                  <span>
                    {savingLr
                      ? 'Saving LR...'
                      : editingLr
                      ? 'Save LR Changes'
                      : 'Create & Preview LR'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PRINTABLE A4 LORRY RECEIPT PREVIEW MODAL */}
      {previewLr && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 flex items-center justify-center p-2 sm:p-5 overflow-y-auto print-modal-root"
          role="dialog"
          aria-modal="true"
          aria-label={`Lorry Receipt Preview - ${previewLr.lrNumber}`}
        >
          <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl border border-slate-300 overflow-hidden my-auto max-h-[95vh] flex flex-col print-modal-sheet">
            {/* Modal Action Bar (Hidden on Print) */}
            <div className="px-4 sm:px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 no-print shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Truck className="w-4 h-4 text-blue-900 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-blue-900 truncate">
                    LR {previewLr.lrNumber}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {formatDateIN(previewLr.lrDate)} · {previewLr.vehicleNumber}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Recipient selector for WhatsApp Share */}
                <div className="inline-flex items-center gap-1 bg-white border border-slate-300 rounded-lg px-2 py-1">
                  <label
                    htmlFor="lr-wa-recipient-select"
                    className="text-[11px] text-slate-500 font-medium"
                  >
                    Share To:
                  </label>
                  <select
                    id="lr-wa-recipient-select"
                    value={whatsAppRecipientRole}
                    onChange={(e) =>
                      setWhatsAppRecipientRole(e.target.value as WhatsAppRecipientRole)
                    }
                    className="text-xs font-semibold text-slate-800 bg-transparent focus:outline-none cursor-pointer"
                  >
                    <option value="consignor">Consignor</option>
                    <option value="consignee">Consignee</option>
                    <option value="driver">Driver</option>
                  </select>
                </div>

                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={() => handleSharePreviewLrOnWhatsApp(whatsAppRecipientRole)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>WhatsApp Share</span>
                </button>

                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handleOpenA4PdfPreview}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-900 bg-blue-50 border border-blue-300 hover:bg-blue-100 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>{pdfBusy ? 'Rendering...' : 'Preview A4 PDF'}</span>
                </button>

                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={handleDirectSaveLrPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-900 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Save PDF</span>
                </button>

                <button
                  type="button"
                  onClick={() => triggerPrintPreview()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print</span>
                </button>

                {canEditLr && (
                  <button
                    type="button"
                    onClick={() => openEditDrawer(previewLr)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Edit</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setPreviewLr(null)}
                  aria-label="Close LR preview"
                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {pdfError && (
              <div
                role="alert"
                className="mx-6 mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 no-print"
              >
                {pdfError}
              </div>
            )}

            {/* Printable A4 Lorry Receipt Sheet (Royal Blue & White) */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-slate-100 print:p-0 print:bg-white">
              <div
                id="lorry-receipt-a4-sheet"
                ref={lrPrintRef}
                className="print-area-card max-w-[794px] mx-auto bg-white border-2 border-blue-900 rounded-sm overflow-hidden shadow-md"
              >
                {/* Royal Blue Company Header with Gujarati Devotional Line, Left/Right Contacts, Approved Logo */}
                {renderRoyalBlueLrHeader(activeLogoDataUrl, false)}

                {/* Document Title & LR No / Date Strip */}
                <div className="bg-blue-50 border-b-2 border-blue-900 px-5 py-2.5 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs sm:text-sm font-bold tracking-wider uppercase text-blue-900">
                      LORRY RECEIPT (CONSIGNMENT NOTE)
                    </div>
                    <div className="text-[10px] font-medium text-blue-800 uppercase tracking-wider">
                      Subject to Morbi Jurisdiction · Goods Carried at Owner&apos;s Risk
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="bg-white border border-blue-900 rounded px-3 py-1 text-right">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-blue-800">
                        LR Number
                      </div>
                      <div className="font-mono text-sm sm:text-base font-bold text-blue-950">
                        {previewLr.lrNumber}
                      </div>
                    </div>
                    <div className="bg-white border border-blue-900 rounded px-3 py-1 text-right">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-blue-800">
                        LR Date
                      </div>
                      <div className="font-mono text-xs sm:text-sm font-bold text-slate-900">
                        {formatDateIN(previewLr.lrDate)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Body Content */}
                <div className="p-4 sm:p-5 space-y-4 text-slate-900">
                  {/* Vehicle, Route & Container Strip */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 border border-blue-900/40 rounded overflow-hidden">
                    <div className="p-2.5 border-b sm:border-b-0 border-r border-blue-900/30 bg-white">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                        Vehicle Number
                      </div>
                      <div className="font-mono text-sm font-bold text-slate-950 mt-0.5">
                        {previewLr.vehicleNumber}
                      </div>
                    </div>
                    <div className="p-2.5 border-b sm:border-b-0 sm:border-r border-blue-900/30 bg-white">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                        Container Number
                      </div>
                      <div className="font-mono text-sm font-semibold text-slate-900 mt-0.5">
                        {previewLr.containerNo || '—'}
                      </div>
                    </div>
                    <div className="p-2.5 border-r border-blue-900/30 bg-blue-50/40">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                        From (Origin)
                      </div>
                      <div className="text-sm font-bold text-slate-950 mt-0.5">
                        {previewLr.origin}
                      </div>
                    </div>
                    <div className="p-2.5 bg-blue-50/40">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                        To (Destination)
                      </div>
                      <div className="text-sm font-bold text-slate-950 mt-0.5">
                        {previewLr.destination}
                      </div>
                    </div>
                  </div>

                  {/* Consignor & Consignee Side-by-Side Boxes */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div className="border border-blue-900/40 rounded overflow-hidden flex flex-col">
                      <div className="bg-blue-900 text-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider">
                        Consignor Name &amp; Address
                      </div>
                      <div className="p-3 bg-white flex-1 space-y-1">
                        <div className="text-sm font-bold text-slate-950">
                          {previewLr.consignorName}
                        </div>
                        <div className="text-xs text-slate-700 whitespace-pre-line leading-relaxed">
                          {previewLr.consignorAddress || '—'}
                        </div>
                        {previewLr.consignorPhone && (
                          <div className="text-[11px] font-mono text-blue-900 pt-1">
                            Mob: {previewLr.consignorPhone}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="border border-blue-900/40 rounded overflow-hidden flex flex-col">
                      <div className="bg-blue-900 text-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider">
                        Consignee Name &amp; Address
                      </div>
                      <div className="p-3 bg-white flex-1 space-y-1">
                        <div className="text-sm font-bold text-slate-950">
                          {previewLr.consigneeName}
                        </div>
                        <div className="text-xs text-slate-700 whitespace-pre-line leading-relaxed">
                          {previewLr.consigneeAddress || '—'}
                        </div>
                        {previewLr.consigneePhone && (
                          <div className="text-[11px] font-mono text-blue-900 pt-1">
                            Mob: {previewLr.consigneePhone}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Goods Description & Freight Table */}
                  <div className="border border-blue-900/50 rounded overflow-hidden">
                    <table className="w-full border-collapse text-left">
                      <thead>
                        <tr className="bg-blue-900 text-white text-[11px] uppercase tracking-wider">
                          <th className="py-2 px-3 font-semibold border-r border-blue-800">
                            Goods Description
                          </th>
                          <th className="py-2 px-3 font-semibold border-r border-blue-800 w-36">
                            Quantity / Weight
                          </th>
                          <th className="py-2 px-3 font-semibold text-right border-r border-blue-800 w-32">
                            Freight Rate
                          </th>
                          <th className="py-2 px-3 font-semibold text-right w-36">
                            Total Freight
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="bg-white text-xs sm:text-sm align-top">
                          <td className="py-3.5 px-3 border-r border-blue-900/25 font-medium text-slate-900">
                            {previewLr.goodsDescription}
                            {previewLr.tripRefLr ? (
                              <div className="text-[10px] font-mono text-blue-800 mt-1">
                                Linked Trip Ref: {previewLr.tripRefLr}
                              </div>
                            ) : null}
                          </td>
                          <td className="py-3.5 px-3 border-r border-blue-900/25 font-medium text-slate-800">
                            {previewLr.quantityWeight || '—'}
                          </td>
                          <td className="py-3.5 px-3 border-r border-blue-900/25 text-right font-mono tabular-nums text-slate-800">
                            {previewLr.freightRate > 0
                              ? formatINR(previewLr.freightRate)
                              : '—'}
                          </td>
                          <td className="py-3.5 px-3 text-right font-mono font-bold tabular-nums text-slate-950">
                            {formatINR(previewLr.totalFreightAmount)}
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    {/* Freight Summary Footer */}
                    <div className="grid grid-cols-1 sm:grid-cols-12 border-t border-blue-900/40 bg-blue-50/40">
                      <div className="sm:col-span-7 p-3 sm:border-r border-blue-900/30 flex flex-col justify-between gap-2">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                            Total Freight in Words
                          </div>
                          <div className="text-xs font-semibold text-slate-800 mt-0.5">
                            {rupeesInWords(previewLr.totalFreightAmount)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                            Remarks
                          </div>
                          <div className="text-xs text-slate-700 mt-0.5 whitespace-pre-line">
                            {previewLr.remarks || '—'}
                          </div>
                        </div>
                      </div>

                      <div className="sm:col-span-5 divide-y divide-blue-900/25 bg-white">
                        <div className="px-3 py-2 flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-700">
                            Total Freight Amount
                          </span>
                          <span className="font-mono font-bold text-slate-900 tabular-nums">
                            {formatINR(previewLr.totalFreightAmount)}
                          </span>
                        </div>
                        <div className="px-3 py-2 flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-700">
                            Advance Amount
                          </span>
                          <span className="font-mono font-semibold text-slate-800 tabular-nums">
                            {formatINR(previewLr.advanceAmount)}
                          </span>
                        </div>
                        <div className="px-3 py-2.5 bg-blue-900 text-white flex items-center justify-between text-xs sm:text-sm">
                          <span className="font-bold uppercase tracking-wide">
                            Balance Amount
                          </span>
                          <span className="font-mono font-bold tabular-nums">
                            {formatINR(previewLr.balanceAmount)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Driver Details Bar */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 border border-blue-900/40 rounded overflow-hidden bg-blue-50/30">
                    <div className="px-3 py-2 sm:border-r border-b sm:border-b-0 border-blue-900/25 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-blue-900">
                        Driver Name
                      </span>
                      <span className="text-xs sm:text-sm font-semibold text-slate-900">
                        {previewLr.driverName || '—'}
                      </span>
                    </div>
                    <div className="px-3 py-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-blue-900">
                        Driver Mobile Number
                      </span>
                      <span className="text-xs sm:text-sm font-mono font-semibold text-slate-900">
                        {previewLr.driverMobile || '—'}
                      </span>
                    </div>
                  </div>

                  {/* Signature Boxes (Sender Signature | Receiver Signature | Authorized Signatory) */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                    <div className="border border-blue-900/40 rounded p-3 flex flex-col justify-between min-h-[92px] bg-white">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                        Sender Signature
                      </div>
                      <div className="pt-6 border-t border-dashed border-slate-300 mt-4 text-xs font-medium text-slate-800 text-center">
                        {previewLr.senderSignature || 'Consignor / Sender Sign'}
                      </div>
                    </div>

                    <div className="border border-blue-900/40 rounded p-3 flex flex-col justify-between min-h-[92px] bg-white">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                        Receiver Signature
                      </div>
                      <div className="pt-6 border-t border-dashed border-slate-300 mt-4 text-xs font-medium text-slate-800 text-center">
                        {previewLr.receiverSignature || 'Consignee / Receiver Sign'}
                      </div>
                    </div>

                    <div className="border border-blue-900 rounded p-3 flex flex-col justify-between min-h-[92px] bg-blue-50/40">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900 text-center">
                        For {LR_COMPANY_NAME}
                      </div>
                      <div className="pt-6 border-t border-blue-900/40 mt-4 text-[11px] font-semibold text-blue-950 text-center">
                        Authorized Signatory
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bottom Royal Blue Contact Footer */}
                <div className="bg-blue-900 text-blue-100 px-5 py-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono">
                  <span>{LR_COMPANY_NAME}</span>
                  <span>
                    Contacts: {LR_CONTACT_LEFT} | {LR_CONTACT_RIGHT}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* A4 PDF Preview Modal */}
      <PdfPreviewModal
        preview={renderedPdfPreview}
        title={previewLr ? `Lorry Receipt — ${previewLr.lrNumber}` : 'Lorry Receipt PDF'}
        onDownload={() => {
          if (renderedPdfPreview) {
            renderedPdfPreview.pdf.save(renderedPdfPreview.fileName);
          }
        }}
        onPrint={() => {
          setRenderedPdfPreview(null);
          setTimeout(() => triggerPrintPreview(), 120);
        }}
        onClose={() => setRenderedPdfPreview(null)}
        onWhatsAppShare={
          previewLr && renderedPdfPreview
            ? () => {
                openWhatsAppForLr(
                  previewLr,
                  whatsAppRecipientRole,
                  renderedPdfPreview
                );
              }
            : undefined
        }
        whatsAppLabel="WhatsApp Share LR PDF"
      />

      {/* WhatsApp Manual Share Modal */}
      <WhatsAppShareModal
        open={Boolean(whatsAppShareState)}
        onClose={() => setWhatsAppShareState(null)}
        title="Share Lorry Receipt (LR) on WhatsApp"
        subtitle="Review recipient mobile, message, and PDF before pressing Send manually in WhatsApp."
        partyName={whatsAppShareState?.partyName || ''}
        partyPhone={whatsAppShareState?.partyPhone || ''}
        initialMessage={whatsAppShareState?.message || ''}
        pdfAttachment={whatsAppShareState?.attachment || null}
      />

      {/* Delete Confirmation Dialog (Admin Only) */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Lorry Receipt?"
        description={
          deleteTarget
            ? `Permanently delete Lorry Receipt ${deleteTarget.lrNumber} (${deleteTarget.vehicleNumber})? Linked Trip, Vehicle, Party, and Payment records will NOT be affected.`
            : ''
        }
        confirmLabel="Delete LR"
        destructive
        busy={deleting}
        onConfirm={handleConfirmDeleteLr}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
