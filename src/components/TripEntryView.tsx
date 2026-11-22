import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Fuel,
  Plus,
  Truck,
  Users,
  X,
} from 'lucide-react';
import { db } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  DEFAULT_DIESEL_RATE,
  PARTY_TYPES,
  TRIP_STATUSES,
  VEHICLE_TYPES,
  type CompanySettings,
  type NavSection,
  type Party,
  type PartyType,
  type PendingContainerPhoto,
  type Trip,
  type TripContainerPhoto,
  type TripStatus,
  type UserPermissions,
  type Vehicle,
  type VehicleType,
} from '../types/erp';
import {
  clampNum,
  clampStr,
  derivePaymentStatus,
  formatINR,
  formatNumberIN,
  generateSafeDocId,
  getTodayISO,
} from '../utils/formatters';
import {
  calculateDieselAmount,
  extractReadableFirestoreError,
  findDuplicateParty,
  findDuplicateVehicle,
  resolveEffectiveDieselRate,
} from '../utils/erpHelpers';
import {
  deriveTripNumber,
  type ContainerPhotoTripMetadata,
  type PreparedContainerPhoto,
} from '../utils/containerPhotoHelpers';
import { recordAuditLog } from '../utils/auditLogger';
import { ContainerPhotoCard } from './ContainerPhotoCard';

interface TripEntryViewProps {
  userId: string;
  actorRole: 'admin' | 'employee';
  isSuperAdmin: boolean;
  permissions: UserPermissions;
  companySettings: CompanySettings | null;
  vehicles: Vehicle[];
  parties: Party[];
  tripContainerPhotos: TripContainerPhoto[];
  pendingContainerPhotos: PendingContainerPhoto[];
  isOnline: boolean;
  syncingPhotos: boolean;
  editingTrip: Trip | null;
  onUploadContainerPhoto: (
    prepared: PreparedContainerPhoto,
    metadata: ContainerPhotoTripMetadata
  ) => Promise<{ syncedImmediately: boolean }>;
  onDeleteContainerPhoto: (photo: TripContainerPhoto) => Promise<void>;
  onDiscardPendingPhoto: (tripId: string) => Promise<void>;
  onSyncPendingPhotos: () => Promise<void>;
  onCancelEdit: () => void;
  onSuccessNavigate: (section: NavSection) => void;
}

interface TripFormState {
  srNo: string;
  lrNumber: string;
  tripDate: string;
  vehicleId: string;
  partyId: string;
  driverName: string;
  origin: string;
  destination: string;
  containerNo: string;
  freightAmount: string;
  advanceReceived: string;
  dieselQuantity: string;
  dieselRate: string;
  dieselExpense: string;
  tollExpense: string;
  driverAllowance: string;
  otherExpense: string;
  tripStatus: TripStatus;
  podReceived: boolean;
  notes: string;
  syncVehicleStatus: boolean;
}

function createInitialForm(
  editingTrip: Trip | null,
  vehicles: Vehicle[],
  parties: Party[],
  defaultDieselRate: number
): TripFormState {
  if (editingTrip) {
    const qty = editingTrip.dieselQuantity ?? 0;
    const savedRate =
      typeof editingTrip.dieselRate === 'number' && editingTrip.dieselRate > 0
        ? editingTrip.dieselRate
        : qty > 0 && editingTrip.dieselExpense > 0
        ? Math.round((editingTrip.dieselExpense / qty) * 100) / 100
        : defaultDieselRate;

    return {
      srNo: editingTrip.srNo || '',
      lrNumber: editingTrip.lrNumber,
      tripDate: editingTrip.tripDate,
      vehicleId: editingTrip.vehicleId,
      partyId: editingTrip.partyId,
      driverName: editingTrip.driverName,
      origin: editingTrip.origin,
      destination: editingTrip.destination,
      containerNo: editingTrip.containerNo || '',
      freightAmount: String(editingTrip.freightAmount),
      advanceReceived: String(editingTrip.advanceReceived),
      dieselQuantity: qty > 0 ? String(qty) : '',
      dieselRate: String(savedRate),
      dieselExpense:
        qty > 0
          ? String(calculateDieselAmount(qty, savedRate))
          : String(editingTrip.dieselExpense),
      tollExpense: String(editingTrip.tollExpense),
      driverAllowance: String(editingTrip.driverAllowance),
      otherExpense: String(editingTrip.otherExpense),
      tripStatus: editingTrip.tripStatus,
      podReceived: editingTrip.podReceived,
      notes: editingTrip.notes,
      syncVehicleStatus: false,
    };
  }

  const defaultVehicle =
    vehicles.find((v) => v.status === 'Available') || vehicles[0] || null;
  const defaultParty =
    parties.find((p) => p.status === 'Active') || parties[0] || null;

  return {
    srNo: '',
    lrNumber: '',
    tripDate: getTodayISO(),
    vehicleId: defaultVehicle ? defaultVehicle.id : '',
    partyId: defaultParty ? defaultParty.id : '',
    driverName: defaultVehicle ? defaultVehicle.driverName : '',
    origin: '',
    destination: '',
    containerNo: '',
    freightAmount: '',
    advanceReceived: '',
    dieselQuantity: '',
    dieselRate: String(defaultDieselRate),
    dieselExpense: '',
    tollExpense: '',
    driverAllowance: '',
    otherExpense: '',
    tripStatus: 'In Transit',
    podReceived: false,
    notes: '',
    syncVehicleStatus: true,
  };
}

export const TripEntryView: React.FC<TripEntryViewProps> = ({
  userId,
  actorRole,
  isSuperAdmin,
  permissions,
  companySettings,
  vehicles,
  parties,
  tripContainerPhotos,
  pendingContainerPhotos,
  isOnline,
  syncingPhotos,
  editingTrip,
  onUploadContainerPhoto,
  onDeleteContainerPhoto,
  onDiscardPendingPhoto,
  onSyncPendingPhotos,
  onCancelEdit,
  onSuccessNavigate,
}) => {
  const configuredDefaultRate = resolveEffectiveDieselRate(
    companySettings?.defaultDieselRate,
    null
  );

  const [form, setForm] = useState<TripFormState>(() =>
    createInitialForm(editingTrip, vehicles, parties, configuredDefaultRate)
  );
  const [stagedContainerPhoto, setStagedContainerPhoto] =
    useState<PreparedContainerPhoto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Admin inline default diesel rate updater
  const [editingRateOpen, setEditingRateOpen] = useState(false);
  const [defaultRateInput, setDefaultRateInput] = useState(
    String(configuredDefaultRate)
  );
  const [savingDefaultRate, setSavingDefaultRate] = useState(false);
  const [rateUpdateMsg, setRateUpdateMsg] = useState<string | null>(null);

  // Quick-add Vehicle modal inside Trip Entry
  const [quickVehicleOpen, setQuickVehicleOpen] = useState(false);
  const [quickVehForm, setQuickVehForm] = useState({
    registrationNumber: '',
    vehicleType: 'Truck' as VehicleType,
    driverName: '',
    driverPhone: '',
  });
  const [quickVehError, setQuickVehError] = useState<string | null>(null);
  const [savingQuickVeh, setSavingQuickVeh] = useState(false);

  // Quick-add Party modal inside Trip Entry
  const [quickPartyOpen, setQuickPartyOpen] = useState(false);
  const [quickPartyForm, setQuickPartyForm] = useState({
    partyName: '',
    partyType: 'Consignor' as PartyType,
    phone: '',
    gstin: '',
    city: '',
    address: '',
  });
  const [quickPartyError, setQuickPartyError] = useState<string | null>(null);
  const [savingQuickParty, setSavingQuickParty] = useState(false);

  useEffect(() => {
    setForm(
      createInitialForm(editingTrip, vehicles, parties, configuredDefaultRate)
    );
    setStagedContainerPhoto(null);
    setFormError(null);
    setSavedBanner(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTrip]);

  const currentTripSyncedPhoto = useMemo(
    () =>
      editingTrip
        ? tripContainerPhotos.find((p) => p.tripId === editingTrip.id) || null
        : null,
    [editingTrip, tripContainerPhotos]
  );

  const currentTripPendingPhoto = useMemo(
    () =>
      editingTrip
        ? pendingContainerPhotos.find((p) => p.tripId === editingTrip.id) || null
        : null,
    [editingTrip, pendingContainerPhotos]
  );

  const selectedVehicleNumber = useMemo(() => {
    const matched = vehicles.find((v) => v.id === form.vehicleId);
    return matched?.registrationNumber || editingTrip?.vehicleNumber || '';
  }, [vehicles, form.vehicleId, editingTrip?.vehicleNumber]);

  // Sync newly updated Admin default rate into fresh new trips if user hasn't entered litres yet
  useEffect(() => {
    setDefaultRateInput(String(configuredDefaultRate));
    if (!editingTrip && !form.dieselQuantity) {
      setForm((prev) => ({
        ...prev,
        dieselRate: String(configuredDefaultRate),
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuredDefaultRate, editingTrip]);

  // Populate default vehicle/party when data loads on fresh new trip
  useEffect(() => {
    if (!editingTrip) {
      setForm((prev) => {
        const next = { ...prev };
        if (!next.vehicleId && vehicles.length > 0) {
          const v =
            vehicles.find((item) => item.status === 'Available') || vehicles[0];
          next.vehicleId = v.id;
          if (!next.driverName) next.driverName = v.driverName;
        }
        if (!next.partyId && parties.length > 0) {
          const p =
            parties.find((item) => item.status === 'Active') || parties[0];
          next.partyId = p.id;
        }
        return next;
      });
    }
  }, [vehicles, parties, editingTrip]);

  const handleVehicleChange = (newVehicleId: string) => {
    const selected = vehicles.find((v) => v.id === newVehicleId);
    setForm((prev) => ({
      ...prev,
      vehicleId: newVehicleId,
      driverName: selected?.driverName || prev.driverName,
    }));
  };

  const handleDieselQuantityChange = (rawQty: string) => {
    const qtyNum = clampNum(rawQty || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX);
    const rateNum = clampNum(
      form.dieselRate || String(configuredDefaultRate),
      0,
      BLUEPRINT_LIMITS.DIESEL_RATE_MAX
    );
    const autoAmt = rawQty.trim() === '' ? '' : String(calculateDieselAmount(qtyNum, rateNum));
    setForm((prev) => ({
      ...prev,
      dieselQuantity: rawQty,
      dieselExpense: autoAmt,
    }));
  };

  const handleTripDieselRateChange = (rawRate: string) => {
    if (!permissions.isAdmin) return;
    const rateNum = clampNum(rawRate || '0', 0, BLUEPRINT_LIMITS.DIESEL_RATE_MAX);
    const qtyNum = clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX);
    setForm((prev) => ({
      ...prev,
      dieselRate: rawRate,
      dieselExpense:
        prev.dieselQuantity.trim() !== '' && qtyNum > 0
          ? String(calculateDieselAmount(qtyNum, rateNum))
          : prev.dieselExpense,
    }));
  };

  const handleSaveDefaultDieselRate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!permissions.isAdmin) return;
    const nextRate = clampNum(defaultRateInput || '0', 0, BLUEPRINT_LIMITS.DIESEL_RATE_MAX);
    if (nextRate <= 0) {
      setRateUpdateMsg('Enter a valid diesel rate greater than ₹0.');
      return;
    }
    setSavingDefaultRate(true);
    setRateUpdateMsg(null);
    try {
      const targetId = companySettings?.id || userId;
      if (companySettings) {
        await updateDoc(doc(db, 'companySettings', targetId), {
          defaultDieselRate: nextRate,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(collection(db, 'companySettings'), targetId), {
          companyName: 'BAPASITARAM ENTERPRISE',
          address: '',
          gstin: '',
          pan: '',
          phone: '',
          email: '',
          bankName: '',
          accountHolderName: 'BAPASITARAM ENTERPRISE',
          accountNumber: '',
          ifscCode: '',
          branchName: '',
          billPrefix: 'BSE-',
          nextBillSeq: 1,
          defaultDieselRate: nextRate,
          terms: 'Payment due within credit terms. Subject to jurisdiction.',
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
        summary: `Updated company default diesel rate to ₹${nextRate}/L (historical trips preserved)`,
      });

      if (!editingTrip) {
        const qtyNum = clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX);
        setForm((prev) => ({
          ...prev,
          dieselRate: String(nextRate),
          dieselExpense:
            qtyNum > 0 ? String(calculateDieselAmount(qtyNum, nextRate)) : prev.dieselExpense,
        }));
      }
      setEditingRateOpen(false);
      setRateUpdateMsg(`Default diesel rate updated to ₹${nextRate.toFixed(2)}/L for new trips.`);
    } catch (error) {
      setRateUpdateMsg(extractReadableFirestoreError(error, 'Update Default Diesel Rate'));
    } finally {
      setSavingDefaultRate(false);
    }
  };

  const handleQuickAddVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    setQuickVehError(null);
    const regNo = clampStr(
      quickVehForm.registrationNumber.toUpperCase(),
      BLUEPRINT_LIMITS.VEHICLE_REG_MAX
    );
    if (
      regNo.length < BLUEPRINT_LIMITS.VEHICLE_REG_MIN ||
      !BLUEPRINT_LIMITS.REG_NO_PATTERN.test(regNo)
    ) {
      setQuickVehError(
        'Enter a valid vehicle registration number (4-20 uppercase characters, e.g. GJ-03-BW-4521).'
      );
      return;
    }
    const dup = findDuplicateVehicle(vehicles, regNo);
    if (dup) {
      setQuickVehError(
        `Duplicate Vehicle: "${dup.registrationNumber}" is already registered.`
      );
      return;
    }

    setSavingQuickVeh(true);
    try {
      const newId = generateSafeDocId('veh');
      const driverName = clampStr(quickVehForm.driverName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX);
      await setDoc(doc(collection(db, 'vehicles'), newId), {
        registrationNumber: regNo,
        vehicleType: quickVehForm.vehicleType,
        makeModel: '',
        capacityTons: 0,
        driverName,
        driverPhone: clampStr(quickVehForm.driverPhone, BLUEPRINT_LIMITS.PHONE_MAX),
        fitnessExpiry: '',
        insuranceExpiry: '',
        pucExpiry: '',
        taxExpiry: '',
        permitExpiry: '',
        status: 'Available',
        notes: '',
        ownerId: userId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: 'CREATE',
        module: 'Vehicles',
        recordId: newId,
        summary: `Quick-added vehicle ${regNo} from Trip Entry`,
      });
      setForm((prev) => ({
        ...prev,
        vehicleId: newId,
        driverName: driverName || prev.driverName,
      }));
      setQuickVehForm({
        registrationNumber: '',
        vehicleType: 'Truck',
        driverName: '',
        driverPhone: '',
      });
      setQuickVehicleOpen(false);
    } catch (error) {
      setQuickVehError(extractReadableFirestoreError(error, 'Quick-Add Vehicle'));
    } finally {
      setSavingQuickVeh(false);
    }
  };

  const handleQuickAddParty = async (e: React.FormEvent) => {
    e.preventDefault();
    setQuickPartyError(null);
    const partyName = clampStr(
      quickPartyForm.partyName,
      BLUEPRINT_LIMITS.PARTY_NAME_MAX
    );
    if (partyName.length < BLUEPRINT_LIMITS.PARTY_NAME_MIN) {
      setQuickPartyError('Party name must be at least 2 characters.');
      return;
    }
    const gstin = clampStr(
      quickPartyForm.gstin.toUpperCase(),
      BLUEPRINT_LIMITS.GSTIN_MAX
    );
    const dup = findDuplicateParty(parties, partyName, gstin);
    if (dup) {
      setQuickPartyError(
        dup.reason === 'gstin'
          ? `Duplicate GSTIN: "${dup.existing.partyName}" already uses GSTIN ${dup.existing.gstin}.`
          : `Duplicate Party: "${dup.existing.partyName}" is already registered.`
      );
      return;
    }

    setSavingQuickParty(true);
    try {
      const newId = generateSafeDocId('pty');
      await setDoc(doc(collection(db, 'parties'), newId), {
        partyName,
        partyType: quickPartyForm.partyType,
        contactPerson: '',
        phone: clampStr(quickPartyForm.phone, BLUEPRINT_LIMITS.PHONE_MAX),
        email: '',
        gstin,
        city: clampStr(quickPartyForm.city, BLUEPRINT_LIMITS.CITY_MAX),
        state: '',
        address: clampStr(quickPartyForm.address, BLUEPRINT_LIMITS.ADDRESS_MAX),
        paymentTermsDays: 15,
        status: 'Active',
        notes: '',
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
        summary: `Quick-added party ${partyName} from Trip Entry`,
      });
      setForm((prev) => ({
        ...prev,
        partyId: newId,
      }));
      setQuickPartyForm({
        partyName: '',
        partyType: 'Consignor',
        phone: '',
        gstin: '',
        city: '',
        address: '',
      });
      setQuickPartyOpen(false);
    } catch (error) {
      setQuickPartyError(extractReadableFirestoreError(error, 'Quick-Add Party'));
    } finally {
      setSavingQuickParty(false);
    }
  };

  const liveCalculations = useMemo(() => {
    const freight = clampNum(form.freightAmount || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    const advance = clampNum(form.advanceReceived || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    const dieselQty = clampNum(form.dieselQuantity || '0', 0, BLUEPRINT_LIMITS.DIESEL_QTY_MAX);
    const dieselRate = clampNum(
      form.dieselRate || String(configuredDefaultRate),
      0,
      BLUEPRINT_LIMITS.DIESEL_RATE_MAX
    );
    const diesel =
      dieselQty > 0
        ? calculateDieselAmount(dieselQty, dieselRate)
        : clampNum(form.dieselExpense || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    const toll = clampNum(form.tollExpense || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    const bhatta = clampNum(form.driverAllowance || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);
    const other = clampNum(form.otherExpense || '0', 0, BLUEPRINT_LIMITS.CURRENCY_MAX);

    const balanceAmount = Math.round((freight - advance) * 100) / 100;
    const totalExpense = Math.round((diesel + toll + bhatta + other) * 100) / 100;
    const netMargin = Math.round((freight - totalExpense) * 100) / 100;
    const paymentStatus = derivePaymentStatus(freight, advance);

    return {
      freight,
      advance,
      dieselQty,
      dieselRate,
      diesel,
      toll,
      bhatta,
      other,
      balanceAmount,
      totalExpense,
      netMargin,
      paymentStatus,
    };
  }, [
    form.freightAmount,
    form.advanceReceived,
    form.dieselQuantity,
    form.dieselRate,
    form.dieselExpense,
    form.tollExpense,
    form.driverAllowance,
    form.otherExpense,
    configuredDefaultRate,
  ]);

  const prerequisitesMissing = vehicles.length === 0 || parties.length === 0;

  if (!permissions.canEditTrips) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center max-w-xl">
        <AlertCircle className="w-8 h-8 text-amber-600 mx-auto" />
        <h2 className="mt-3 font-display text-base font-semibold text-slate-900">
          Trip Entry Restricted
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Your account currently has read-only permissions. Contact the BAPASITARAM ENTERPRISE Administrator to grant Trip Entry access.
        </p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSavedBanner(null);

    const lrNumber = clampStr(form.lrNumber.toUpperCase(), BLUEPRINT_LIMITS.LR_NUMBER_MAX);
    const tripDate = clampStr(form.tripDate, BLUEPRINT_LIMITS.DATE_MAX);
    const origin = clampStr(form.origin, BLUEPRINT_LIMITS.LOCATION_MAX);
    const destination = clampStr(form.destination, BLUEPRINT_LIMITS.LOCATION_MAX);

    if (!lrNumber) {
      setFormError('LR / Bilty Number is required.');
      return;
    }
    if (!tripDate) {
      setFormError('Trip Date is required.');
      return;
    }

    const selectedVehicle = vehicles.find((v) => v.id === form.vehicleId);
    const selectedParty = parties.find((p) => p.id === form.partyId);

    if (!selectedVehicle) {
      setFormError('Please select a valid fleet vehicle.');
      return;
    }
    if (!selectedParty) {
      setFormError('Please select a valid party account.');
      return;
    }
    if (!origin || !destination) {
      setFormError('Origin and Destination locations are required.');
      return;
    }

    const payload = {
      srNo: clampStr(form.srNo, BLUEPRINT_LIMITS.SR_NO_MAX),
      lrNumber,
      tripDate,
      vehicleId: selectedVehicle.id,
      vehicleNumber: clampStr(selectedVehicle.registrationNumber, BLUEPRINT_LIMITS.VEHICLE_REG_MAX),
      partyId: selectedParty.id,
      partyName: clampStr(selectedParty.partyName, BLUEPRINT_LIMITS.PARTY_NAME_MAX),
      driverName: clampStr(form.driverName, BLUEPRINT_LIMITS.DRIVER_NAME_MAX),
      origin,
      destination,
      containerNo: clampStr(form.containerNo.toUpperCase(), BLUEPRINT_LIMITS.CONTAINER_NO_MAX),
      freightAmount: liveCalculations.freight,
      advanceReceived: liveCalculations.advance,
      dieselQuantity: liveCalculations.dieselQty,
      dieselRate: liveCalculations.dieselRate,
      dieselExpense: liveCalculations.diesel,
      tollExpense: liveCalculations.toll,
      driverAllowance: liveCalculations.bhatta,
      otherExpense: liveCalculations.other,
      balanceAmount: liveCalculations.balanceAmount,
      totalExpense: liveCalculations.totalExpense,
      tripStatus: form.tripStatus,
      paymentStatus: liveCalculations.paymentStatus,
      podReceived: form.podReceived,
      notes: clampStr(form.notes, BLUEPRINT_LIMITS.NOTES_MAX),
    };

    setSaving(true);
    try {
      let savedTripId = editingTrip?.id || '';
      if (editingTrip) {
        await updateDoc(doc(db, 'trips', editingTrip.id), {
          ...payload,
          updatedAt: serverTimestamp(),
        });
      } else {
        const newId = generateSafeDocId('trip');
        savedTripId = newId;
        await setDoc(doc(collection(db, 'trips'), newId), {
          ...payload,
          ownerId: userId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await recordAuditLog({
        ownerId: userId,
        actorRole,
        action: editingTrip ? 'UPDATE' : 'CREATE',
        module: 'Trips',
        recordId: savedTripId,
        summary: `${editingTrip ? 'Updated' : 'Recorded'} trip LR ${lrNumber} (${selectedVehicle.registrationNumber} -> ${selectedParty.partyName}) Rate ₹${liveCalculations.freight} · Diesel ${liveCalculations.dieselQty}L @ ₹${liveCalculations.dieselRate}/L`,
      });

      // Optionally sync vehicle operational status
      if (form.syncVehicleStatus) {
        const targetStatus =
          form.tripStatus === 'In Transit'
            ? 'On Trip'
            : form.tripStatus === 'Delivered' ||
              form.tripStatus === 'Settled' ||
              form.tripStatus === 'Cancelled'
            ? 'Available'
            : null;
        if (targetStatus && selectedVehicle.status !== targetStatus) {
          await updateDoc(doc(db, 'vehicles', selectedVehicle.id), {
            status: targetStatus,
            updatedAt: serverTimestamp(),
          });
        }
      }

      if (stagedContainerPhoto && savedTripId) {
        const tripNumber = clampStr(
          payload.srNo || payload.lrNumber || savedTripId,
          BLUEPRINT_LIMITS.TRIP_NUMBER_MAX
        );
        await onUploadContainerPhoto(stagedContainerPhoto, {
          tripId: savedTripId,
          tripNumber,
          lrNumber: payload.lrNumber,
          vehicleNumber: payload.vehicleNumber,
          containerNumber: payload.containerNo,
        });
        setStagedContainerPhoto(null);
      }

      if (editingTrip) {
        onCancelEdit();
        onSuccessNavigate('trip-history');
      } else {
        setSavedBanner(
          stagedContainerPhoto
            ? `Trip ${lrNumber} recorded and rear container door photo ${
                isOnline ? 'uploaded securely' : 'saved safely offline for auto-sync'
              }.`
            : `Trip ${lrNumber} recorded successfully.`
        );
        setForm(createInitialForm(null, vehicles, parties, configuredDefaultRate));
      }
    } catch (error) {
      setFormError(
        extractReadableFirestoreError(
          error,
          editingTrip ? 'Update Trip Entry' : 'Save Trip Entry'
        )
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Prerequisite Notice if Vehicles or Parties are empty */}
      {prerequisitesMissing && !editingTrip && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-semibold text-amber-950">
                Fleet Vehicle and Party Required Before Dispatch
              </h3>
              <p className="mt-1 text-xs sm:text-sm text-amber-800">
                Add at least one Vehicle and one Party account before recording a trip.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {vehicles.length === 0 && permissions.canManageMasters && (
              <button
                type="button"
                onClick={() => setQuickVehicleOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                <Truck className="w-3.5 h-3.5" />
                <span>Add New Vehicle</span>
              </button>
            )}
            {parties.length === 0 && permissions.canManageMasters && (
              <button
                type="button"
                onClick={() => setQuickPartyOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                <Users className="w-3.5 h-3.5" />
                <span>Add New Party</span>
              </button>
            )}
          </div>
        </div>
      )}

      {editingTrip && (
        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => {
              onCancelEdit();
              onSuccessNavigate('trip-history');
            }}
            className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Trip History</span>
          </button>
          <span className="font-mono text-xs font-medium text-slate-500">
            Editing LR: {editingTrip.lrNumber}
          </span>
        </div>
      )}

      {savedBanner && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5 text-sm font-medium text-emerald-900">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{savedBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => onSuccessNavigate('trip-history')}
            className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 underline cursor-pointer self-start sm:self-auto"
          >
            View in Trip History →
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {formError && (
          <div role="alert" className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
            {formError}
          </div>
        )}

        {/* Section 1: Dispatch Details */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="border-b border-slate-100 pb-3">
            <h2 className="font-display text-base font-semibold text-slate-900">
              01. Dispatch &amp; Consignment Details
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Lorry Receipt reference, assigned vehicle, party account, and route
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Sr No
                </label>
                <input
                  type="text"
                  maxLength={BLUEPRINT_LIMITS.SR_NO_MAX}
                  value={form.srNo}
                  onChange={(e) => setForm({ ...form, srNo: e.target.value })}
                  placeholder="1"
                  className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  LR / Bilty No. *
                </label>
                <input
                  type="text"
                  required
                  maxLength={BLUEPRINT_LIMITS.LR_NUMBER_MAX}
                  value={form.lrNumber}
                  onChange={(e) =>
                    setForm({ ...form, lrNumber: e.target.value.toUpperCase() })
                  }
                  placeholder="LR-2026-001"
                  className="w-full px-3 py-2.5 text-sm font-mono uppercase bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Date *
              </label>
              <input
                type="date"
                required
                value={form.tripDate}
                onChange={(e) => setForm({ ...form, tripDate: e.target.value })}
                className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700">
                  Fleet Vehicle *
                </label>
                {permissions.canManageMasters && !editingTrip && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuickVehError(null);
                      setQuickVehicleOpen(true);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 hover:text-slate-950 underline cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add New Vehicle</span>
                  </button>
                )}
              </div>
              <select
                required
                disabled={Boolean(editingTrip) && !isSuperAdmin}
                value={form.vehicleId}
                onChange={(e) => handleVehicleChange(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900 disabled:bg-slate-100"
              >
                <option value="">Select vehicle...</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.registrationNumber} ({v.vehicleType} · {v.status})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700">
                  Party Account *
                </label>
                {permissions.canManageMasters && !editingTrip && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuickPartyError(null);
                      setQuickPartyOpen(true);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 hover:text-slate-950 underline cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add New Party</span>
                  </button>
                )}
              </div>
              <select
                required
                disabled={Boolean(editingTrip) && !isSuperAdmin}
                value={form.partyId}
                onChange={(e) => setForm({ ...form, partyId: e.target.value })}
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900 disabled:bg-slate-100"
              >
                <option value="">Select party...</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.partyName} ({p.partyType})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Driver Name
              </label>
              <input
                type="text"
                maxLength={BLUEPRINT_LIMITS.DRIVER_NAME_MAX}
                value={form.driverName}
                onChange={(e) => setForm({ ...form, driverName: e.target.value })}
                placeholder="Driver full name"
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Trip Status
              </label>
              <select
                value={form.tripStatus}
                onChange={(e) =>
                  setForm({ ...form, tripStatus: e.target.value as TripStatus })
                }
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              >
                {TRIP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                From (Origin) *
              </label>
              <input
                type="text"
                required
                maxLength={BLUEPRINT_LIMITS.LOCATION_MAX}
                value={form.origin}
                onChange={(e) => setForm({ ...form, origin: e.target.value })}
                placeholder="Mundra / Morbi"
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                To (Destination) *
              </label>
              <input
                type="text"
                required
                maxLength={BLUEPRINT_LIMITS.LOCATION_MAX}
                value={form.destination}
                onChange={(e) => setForm({ ...form, destination: e.target.value })}
                placeholder="Ahmedabad / Bhiwandi"
                className="w-full px-3 py-2.5 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Container No
              </label>
              <input
                type="text"
                maxLength={BLUEPRINT_LIMITS.CONTAINER_NO_MAX}
                value={form.containerNo}
                onChange={(e) => setForm({ ...form, containerNo: e.target.value.toUpperCase() })}
                placeholder="MSKU1234567"
                className="w-full px-3 py-2.5 text-sm font-mono uppercase bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>
          </div>
        </section>

        {/* Section 2: INR Freight & Expenses */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <section className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
            <div className="border-b border-slate-100 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900">
                  02. Freight &amp; Trip Expenses (INR)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Diesel amount auto-calculates cleanly from Litres × Saved Trip Rate
                </p>
              </div>
              <div className="text-xs flex items-center gap-2">
                <span className="font-mono text-slate-600">
                  Default Rate: <strong className="text-slate-900">₹{configuredDefaultRate.toFixed(2)}/L</strong>
                </span>
                {permissions.isAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      setDefaultRateInput(String(configuredDefaultRate));
                      setEditingRateOpen((v) => !v);
                    }}
                    className="text-xs font-semibold text-slate-800 underline hover:text-slate-950 cursor-pointer"
                  >
                    {editingRateOpen ? 'Close' : 'Update Rate'}
                  </button>
                )}
              </div>
            </div>

            {editingRateOpen && permissions.isAdmin && (
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">Update Default Diesel Rate (₹/Litre)</div>
                  <div className="text-slate-500">Applies to new trips only; historical saved trips retain their recorded rate.</div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max={BLUEPRINT_LIMITS.DIESEL_RATE_MAX}
                    step="0.01"
                    value={defaultRateInput}
                    onChange={(e) => setDefaultRateInput(e.target.value)}
                    className="w-28 px-2.5 py-1.5 text-sm font-mono bg-white border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    disabled={savingDefaultRate}
                    onClick={handleSaveDefaultDieselRate}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                  >
                    {savingDefaultRate ? 'Saving...' : 'Save Rate'}
                  </button>
                </div>
              </div>
            )}

            {rateUpdateMsg && (
              <div
                className={`p-3 rounded-lg border text-xs ${
                  rateUpdateMsg.toLowerCase().includes('failed') ||
                  rateUpdateMsg.toLowerCase().includes('enter a valid') ||
                  rateUpdateMsg.toLowerCase().includes('could not')
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                }`}
              >
                {rateUpdateMsg}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Rate / Freight (₹) *
                </label>
                <input
                  type="number"
                  required
                  min="0"
                  max={BLUEPRINT_LIMITS.CURRENCY_MAX}
                  step="0.01"
                  value={form.freightAmount}
                  onChange={(e) => setForm({ ...form, freightAmount: e.target.value })}
                  placeholder="0.00"
                  className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Jama / Advance Received (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  max={BLUEPRINT_LIMITS.CURRENCY_MAX}
                  step="0.01"
                  value={form.advanceReceived}
                  onChange={(e) => setForm({ ...form, advanceReceived: e.target.value })}
                  placeholder="0.00"
                  className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              {/* Automatic Diesel Calculation Block */}
              <div className="sm:col-span-2 p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                    <Fuel className="w-4 h-4 text-slate-600" />
                    <span>Diesel Calculation (Litres × Rate = Amount)</span>
                  </div>
                  {editingTrip && (
                    <span className="font-mono text-[11px] text-slate-500">
                      Locked historical rate saved on trip
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Diesel Quantity (Litres)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max={BLUEPRINT_LIMITS.DIESEL_QTY_MAX}
                      step="0.01"
                      value={form.dieselQuantity}
                      onChange={(e) => handleDieselQuantityChange(e.target.value)}
                      placeholder="0.00 L"
                      className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Diesel Rate (₹ / Litre)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max={BLUEPRINT_LIMITS.DIESEL_RATE_MAX}
                      step="0.01"
                      readOnly={!permissions.isAdmin}
                      value={form.dieselRate}
                      onChange={(e) => handleTripDieselRateChange(e.target.value)}
                      className={`w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none ${
                        permissions.isAdmin
                          ? 'bg-white focus:border-slate-900'
                          : 'bg-slate-100 text-slate-700 cursor-not-allowed'
                      }`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Diesel Amount (₹)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max={BLUEPRINT_LIMITS.CURRENCY_MAX}
                      step="0.01"
                      readOnly={liveCalculations.dieselQty > 0}
                      value={
                        liveCalculations.dieselQty > 0
                          ? liveCalculations.diesel.toFixed(2)
                          : form.dieselExpense
                      }
                      onChange={(e) => {
                        if (liveCalculations.dieselQty === 0) {
                          setForm({ ...form, dieselExpense: e.target.value });
                        }
                      }}
                      placeholder="0.00"
                      className={`w-full px-3 py-2 text-sm font-mono font-semibold border border-slate-200 rounded-lg focus:outline-none ${
                        liveCalculations.dieselQty > 0
                          ? 'bg-slate-100 text-slate-900 cursor-not-allowed'
                          : 'bg-white focus:border-slate-900'
                      }`}
                    />
                  </div>
                </div>

                <div className="text-xs font-mono text-slate-600 tabular-nums">
                  {liveCalculations.dieselQty > 0 ? (
                    <span>
                      Auto-Calculated:{' '}
                      <strong className="text-slate-900">
                        {formatNumberIN(liveCalculations.dieselQty)} L × ₹
                        {liveCalculations.dieselRate.toFixed(2)}/L ={' '}
                        {formatINR(liveCalculations.diesel)}
                      </strong>
                    </span>
                  ) : (
                    <span>
                      Enter diesel litres above to auto-calculate at ₹
                      {liveCalculations.dieselRate.toFixed(2)}/L.
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Toll (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  max={BLUEPRINT_LIMITS.CURRENCY_MAX}
                  step="0.01"
                  value={form.tollExpense}
                  onChange={(e) => setForm({ ...form, tollExpense: e.target.value })}
                  placeholder="0.00"
                  className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Kharcha / Trip Expense (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  max={BLUEPRINT_LIMITS.CURRENCY_MAX}
                  step="0.01"
                  value={form.otherExpense}
                  onChange={(e) => setForm({ ...form, otherExpense: e.target.value })}
                  placeholder="0.00"
                  className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Driver Allowance / Bhatta (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  max={BLUEPRINT_LIMITS.CURRENCY_MAX}
                  step="0.01"
                  value={form.driverAllowance}
                  onChange={(e) => setForm({ ...form, driverAllowance: e.target.value })}
                  placeholder="0.00"
                  className="w-full px-3 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>
            </div>

            <div className="pt-2 space-y-3">
              <div className="flex flex-wrap items-center gap-6">
                <label className="inline-flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.podReceived}
                    onChange={(e) => setForm({ ...form, podReceived: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span>POD (Proof of Delivery) Received</span>
                </label>

                <label className="inline-flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.syncVehicleStatus}
                    onChange={(e) =>
                      setForm({ ...form, syncVehicleStatus: e.target.checked })
                    }
                    className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span>Sync vehicle status with trip stage</span>
                </label>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Trip Notes / Challan Remarks
                </label>
                <textarea
                  rows={2}
                  maxLength={BLUEPRINT_LIMITS.NOTES_MAX}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="E-way bill reference, detention remarks, or delivery instructions..."
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-900"
                />
              </div>
            </div>
          </section>

          {/* Section 3: Single Container Rear-Door Photo (1 Photo Per Trip) */}
          <section className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
            <div className="border-b border-slate-100 pb-3">
              <h2 className="font-display text-base font-semibold text-slate-900">
                03. Container Rear-Door Photo (Optional · 1 Photo Per Trip)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Rear-side photograph of shipping container doors clearly showing the printed Container Identification Number
              </p>
            </div>

            <ContainerPhotoCard
              tripNumber={
                editingTrip
                  ? deriveTripNumber(editingTrip)
                  : form.srNo.trim() || form.lrNumber.trim() || 'Auto on Save'
              }
              lrNumber={form.lrNumber.trim().toUpperCase() || editingTrip?.lrNumber || '—'}
              vehicleNumber={selectedVehicleNumber || '—'}
              containerNumber={form.containerNo.trim().toUpperCase()}
              syncedPhoto={currentTripSyncedPhoto}
              pendingPhoto={currentTripPendingPhoto}
              stagedPhoto={!editingTrip ? stagedContainerPhoto : null}
              permissions={permissions}
              isOnline={isOnline}
              syncing={syncingPhotos}
              canCapture={permissions.canEditTrips}
              onCapturePrepared={async (prepared) => {
                if (editingTrip) {
                  await onUploadContainerPhoto(prepared, {
                    tripId: editingTrip.id,
                    tripNumber: clampStr(
                      form.srNo.trim() || editingTrip.srNo || form.lrNumber.trim() || editingTrip.lrNumber,
                      BLUEPRINT_LIMITS.TRIP_NUMBER_MAX
                    ),
                    lrNumber: form.lrNumber.trim().toUpperCase() || editingTrip.lrNumber,
                    vehicleNumber: selectedVehicleNumber || editingTrip.vehicleNumber,
                    containerNumber: form.containerNo.trim().toUpperCase() || editingTrip.containerNo || '',
                  });
                } else {
                  setStagedContainerPhoto(prepared);
                }
              }}
              onClearStaged={!editingTrip ? () => setStagedContainerPhoto(null) : undefined}
              onDeleteSynced={editingTrip ? onDeleteContainerPhoto : undefined}
              onDiscardPending={editingTrip ? onDiscardPendingPhoto : undefined}
              onSyncNow={onSyncPendingPhotos}
            />
          </section>

          {/* Live INR Ledger Summary Box */}
          <aside className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-slate-900 border-b border-slate-100 pb-3">
              Live INR Calculation
            </h3>

            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Rate / Freight</dt>
                <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatINR(liveCalculations.freight)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Jama (Received)</dt>
                <dd className="font-mono text-slate-700 tabular-nums">
                  {formatINR(liveCalculations.advance)}
                </dd>
              </div>
              <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                <dt className="font-medium text-slate-700">Hisab (Balance)</dt>
                <dd
                  className={`font-mono font-semibold tabular-nums ${
                    liveCalculations.balanceAmount > 0 ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {formatINR(liveCalculations.balanceAmount)}
                </dd>
              </div>

              <div className="pt-3 border-t border-slate-100 space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2 text-slate-500">
                  <dt>
                    Diesel ({formatNumberIN(liveCalculations.dieselQty)} L @ ₹
                    {liveCalculations.dieselRate.toFixed(2)})
                  </dt>
                  <dd className="font-mono text-slate-800 tabular-nums">
                    {formatINR(liveCalculations.diesel)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <dt className="text-slate-500">Total Trip Expenses</dt>
                  <dd className="font-mono text-slate-800 tabular-nums">
                    {formatINR(liveCalculations.totalExpense)}
                  </dd>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="font-medium text-slate-700">Estimated Net Margin</dt>
                <dd
                  className={`font-mono font-semibold tabular-nums ${
                    liveCalculations.netMargin >= 0 ? 'text-emerald-700' : 'text-red-600'
                  }`}
                >
                  {formatINR(liveCalculations.netMargin)}
                </dd>
              </div>
              <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
                <dt className="text-slate-500">Derived Payment Status</dt>
                <dd className="font-semibold text-slate-900">
                  {liveCalculations.paymentStatus}
                </dd>
              </div>
            </dl>

            <div className="pt-3 space-y-2.5">
              <button
                type="submit"
                disabled={saving || prerequisitesMissing}
                className="w-full min-h-[44px] px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                {saving
                  ? 'Saving Entry...'
                  : editingTrip
                  ? 'Update Trip Entry'
                  : 'Save Trip Entry'}
              </button>
              {editingTrip && (
                <button
                  type="button"
                  onClick={() => {
                    onCancelEdit();
                    onSuccessNavigate('trip-history');
                  }}
                  className="w-full min-h-[40px] px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
              )}
            </div>
          </aside>
        </div>
      </form>

      {/* Quick Add Vehicle Modal */}
      {quickVehicleOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Add New Vehicle
              </h3>
              <button
                type="button"
                onClick={() => setQuickVehicleOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleQuickAddVehicle} className="p-5 space-y-4">
              {quickVehError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {quickVehError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Vehicle Registration No. *
                </label>
                <input
                  type="text"
                  required
                  maxLength={BLUEPRINT_LIMITS.VEHICLE_REG_MAX}
                  value={quickVehForm.registrationNumber}
                  onChange={(e) =>
                    setQuickVehForm({
                      ...quickVehForm,
                      registrationNumber: e.target.value.toUpperCase(),
                    })
                  }
                  placeholder="GJ-03-BW-4521"
                  className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Vehicle Type *
                </label>
                <select
                  value={quickVehForm.vehicleType}
                  onChange={(e) =>
                    setQuickVehForm({
                      ...quickVehForm,
                      vehicleType: e.target.value as VehicleType,
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {VEHICLE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Driver Name
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.DRIVER_NAME_MAX}
                    value={quickVehForm.driverName}
                    onChange={(e) =>
                      setQuickVehForm({ ...quickVehForm, driverName: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Driver Mobile
                  </label>
                  <input
                    type="tel"
                    maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                    value={quickVehForm.driverPhone}
                    onChange={(e) =>
                      setQuickVehForm({ ...quickVehForm, driverPhone: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
              </div>
              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setQuickVehicleOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingQuickVeh}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  {savingQuickVeh ? 'Saving...' : 'Save & Select Vehicle'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Quick Add Party Modal */}
      {quickPartyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Add New Party
              </h3>
              <button
                type="button"
                onClick={() => setQuickPartyOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleQuickAddParty} className="p-5 space-y-4">
              {quickPartyError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {quickPartyError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Party / Business Name *
                </label>
                <input
                  type="text"
                  required
                  minLength={BLUEPRINT_LIMITS.PARTY_NAME_MIN}
                  maxLength={BLUEPRINT_LIMITS.PARTY_NAME_MAX}
                  value={quickPartyForm.partyName}
                  onChange={(e) =>
                    setQuickPartyForm({ ...quickPartyForm, partyName: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Party Type
                  </label>
                  <select
                    value={quickPartyForm.partyType}
                    onChange={(e) =>
                      setQuickPartyForm({
                        ...quickPartyForm,
                        partyType: e.target.value as PartyType,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {PARTY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Mobile
                  </label>
                  <input
                    type="tel"
                    maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                    value={quickPartyForm.phone}
                    onChange={(e) =>
                      setQuickPartyForm({ ...quickPartyForm, phone: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    GSTIN
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.GSTIN_MAX}
                    value={quickPartyForm.gstin}
                    onChange={(e) =>
                      setQuickPartyForm({
                        ...quickPartyForm,
                        gstin: e.target.value.toUpperCase(),
                      })
                    }
                    className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    City
                  </label>
                  <input
                    type="text"
                    maxLength={BLUEPRINT_LIMITS.CITY_MAX}
                    value={quickPartyForm.city}
                    onChange={(e) =>
                      setQuickPartyForm({ ...quickPartyForm, city: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Address
                </label>
                <input
                  type="text"
                  maxLength={BLUEPRINT_LIMITS.ADDRESS_MAX}
                  value={quickPartyForm.address}
                  onChange={(e) =>
                    setQuickPartyForm({ ...quickPartyForm, address: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setQuickPartyOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingQuickParty}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  {savingQuickParty ? 'Saving...' : 'Save & Select Party'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

