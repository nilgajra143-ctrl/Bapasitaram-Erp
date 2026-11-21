import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Copy,
  ExternalLink,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { CompanySettings, NavSection } from '../types/erp';
import { resolveEffectiveDieselRate } from '../utils/erpHelpers';

interface Phase1ChecklistDrawerProps {
  open: boolean;
  userId: string;
  companySettings: CompanySettings | null;
  vehicleCount: number;
  partyCount: number;
  billCount: number;
  onClose: () => void;
  onNavigate: (section: NavSection) => void;
  onProgressChange?: (completed: number) => void;
}

interface ChecklistStep {
  id: string;
  number: number;
  group: string;
  title: string;
  whereToClick: string;
  whatToCheck: string;
  actions: { label: string; section: NavSection }[];
}

const CHECKLIST_STEPS: ChecklistStep[] = [
  {
    id: 'pdf_preview_a4',
    number: 1,
    group: 'PDF, Print & Download',
    title: 'PDF Preview & A4 Formatting',
    whereToClick:
      'Open Billing & Invoices → click "View / Print" on any bill (or create a draft bill) → click "Preview A4 PDF". (Also works in Reports & P&L or Trip History → View LR.)',
    whatToCheck:
      'Popup shows "A4 Page 1 of ..." cleanly formatted for A4 paper. No columns clipped, Hindi/English text clear, and Trip Bill bottom "Total" row matches Net Payable & Amount in Words.',
    actions: [
      { label: 'Open Billing & Invoices', section: 'billing' },
      { label: 'Open Reports', section: 'reports' },
    ],
  },
  {
    id: 'print_functionality',
    number: 2,
    group: 'PDF, Print & Download',
    title: 'Print Functionality',
    whereToClick:
      'Inside the A4 PDF Preview popup click "Print", or inside the Bill modal click "Print Bill".',
    whatToCheck:
      'Browser Print Preview opens with sidebar, buttons, and overlays hidden. All table columns, totals, and Hindi/English text fit inside A4 margins. (Click Cancel after checking.)',
    actions: [{ label: 'Open Billing & Invoices', section: 'billing' }],
  },
  {
    id: 'pdf_download',
    number: 3,
    group: 'PDF, Print & Download',
    title: 'PDF Download',
    whereToClick:
      'Inside the A4 PDF Preview popup or Bill modal toolbar, click "Download PDF".',
    whatToCheck:
      'A .pdf file saves to your Downloads folder. Open the PDF file and verify all pages, ₹ amounts, tables, totals, and Hindi/English text match the preview.',
    actions: [{ label: 'Open Billing & Invoices', section: 'billing' }],
  },
  {
    id: 'diesel_calc',
    number: 4,
    group: 'Diesel, Party & Vehicle Creation',
    title: 'Diesel Calculation: 10 Litres × ₹98.34 = ₹983.40',
    whereToClick:
      'Open Trip Entry → Section 02 ("Diesel Calculation") → type "10" in Diesel Quantity (Litres). Also test Expenses & Maint. → "+ Log Expense / Maint." → Category "Diesel" → "10" Litres.',
    whatToCheck:
      'Diesel Amount (₹) automatically calculates to 983.40 and displays "Auto-Calculated: 10.00 L × ₹98.34/L = ₹983.40" without manual override errors.',
    actions: [
      { label: 'Open Trip Entry', section: 'trip-entry' },
      { label: 'Open Expenses', section: 'expenses' },
    ],
  },
  {
    id: 'add_test_party',
    number: 5,
    group: 'Diesel, Party & Vehicle Creation',
    title: 'Add a Test Party & Verify in Trip Entry',
    whereToClick:
      'Open Parties → click "Add New Party" → enter "Phase1 Test Party" → click "Save Party". Then open Trip Entry → click "Party Account *" dropdown.',
    whatToCheck:
      'Green save banner confirms the party was added, and "Phase1 Test Party" appears immediately in the Trip Entry Party Account dropdown.',
    actions: [
      { label: 'Open Parties', section: 'parties' },
      { label: 'Check Trip Entry', section: 'trip-entry' },
    ],
  },
  {
    id: 'add_test_vehicle',
    number: 6,
    group: 'Diesel, Party & Vehicle Creation',
    title: 'Add a Test Vehicle & Verify in Trip Entry',
    whereToClick:
      'Open Vehicles → click "Add New Vehicle" → enter Registration "GJ-03-TEST-01" → click "Save Vehicle". Then open Trip Entry → click "Fleet Vehicle *" dropdown.',
    whatToCheck:
      'Green save banner confirms registration, and "GJ-03-TEST-01" appears immediately in the Trip Entry Fleet Vehicle dropdown.',
    actions: [
      { label: 'Open Vehicles', section: 'vehicles' },
      { label: 'Check Trip Entry', section: 'trip-entry' },
    ],
  },
  {
    id: 'download_json_backup',
    number: 7,
    group: 'Backup, Persistence & Safe Scan',
    title: 'Download a Complete JSON Backup',
    whereToClick:
      'Open Security & Backup → "Backup, Restore & Offline Plan" tab → click "Download Full JSON Backup".',
    whatToCheck:
      'File "bapasitaram-erp-backup-YYYY-MM-DD.json" downloads and green "Complete Backup Verified" banner shows total record counts.',
    actions: [{ label: 'Open Security & Backup', section: 'security' }],
  },
  {
    id: 'verify_backup_valid',
    number: 8,
    group: 'Backup, Persistence & Safe Scan',
    title: 'Verify Backup File is Valid',
    whereToClick:
      'On Security & Backup → "Backup, Restore & Offline Plan", click "Restore from JSON Backup" and select the .json file from Step 7.',
    whatToCheck:
      'Amber "Restore Preview" opens with zero errors and shows "Existing records preserved untouched (skipped)" matching your records. Click "Cancel" to close without modifying data.',
    actions: [{ label: 'Open Security & Backup', section: 'security' }],
  },
  {
    id: 'data_persistence',
    number: 9,
    group: 'Backup, Persistence & Safe Scan',
    title: 'Test Data Persistence After Refresh & Reopen',
    whereToClick:
      'Press browser Refresh (F5), then close the browser tab completely, reopen the app URL, and open Parties & Vehicles.',
    whatToCheck:
      '"Phase1 Test Party", "GJ-03-TEST-01", and all existing records remain saved and load back cleanly. Your checklist ticks stay saved too.',
    actions: [
      { label: 'Check Parties', section: 'parties' },
      { label: 'Check Vehicles', section: 'vehicles' },
    ],
  },
  {
    id: 'scan_old_test_records',
    number: 10,
    group: 'Backup, Persistence & Safe Scan',
    title: 'Scan Old/Test Records Before Any Deletion',
    whereToClick:
      'Open Security & Backup → "Backup, Restore & Offline Plan" → scroll to "Safe Old & Test Data Cleanup" → click "2. Scan ERP Records".',
    whatToCheck:
      'Review the exact records under "Suspected Test / Demo", "Other Manual Entries", and "Protected Excel Records". Do NOT click Delete — confirm the list first.',
    actions: [{ label: 'Open Cleanup Scanner', section: 'security' }],
  },
];

function getStorageKey(userId: string): string {
  return `bapasitaram_phase1_checklist_${userId || 'default'}`;
}

export function loadChecklistCompletion(userId: string): Record<string, boolean> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    const raw = window.localStorage.getItem(getStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveChecklistCompletion(
  userId: string,
  state: Record<string, boolean>
): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(getStorageKey(userId), JSON.stringify(state));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

export const Phase1ChecklistDrawer: React.FC<Phase1ChecklistDrawerProps> = ({
  open,
  userId,
  companySettings,
  vehicleCount,
  partyCount,
  billCount,
  onClose,
  onNavigate,
  onProgressChange,
}) => {
  const [checkedMap, setCheckedMap] = useState<Record<string, boolean>>(() =>
    loadChecklistCompletion(userId)
  );
  const [copiedNotice, setCopiedNotice] = useState(false);

  useEffect(() => {
    setCheckedMap(loadChecklistCompletion(userId));
  }, [userId]);

  const completedCount = useMemo(
    () => CHECKLIST_STEPS.filter((s) => Boolean(checkedMap[s.id])).length,
    [checkedMap]
  );

  useEffect(() => {
    onProgressChange?.(completedCount);
  }, [completedCount, onProgressChange]);

  const effectiveRate = resolveEffectiveDieselRate(
    companySettings?.defaultDieselRate,
    null
  );

  const toggleStep = (id: string) => {
    setCheckedMap((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveChecklistCompletion(userId, next);
      return next;
    });
  };

  const handleReset = () => {
    setCheckedMap({});
    saveChecklistCompletion(userId, {});
  };

  const handleJump = (section: NavSection) => {
    onNavigate(section);
    onClose();
  };

  const handleCopySummary = async () => {
    const lines = CHECKLIST_STEPS.map(
      (s) => `${checkedMap[s.id] ? '[PASS]' : '[PENDING]'} ${s.number}. ${s.title}`
    );
    const text = `BAPASITARAM ENTERPRISE — Phase 1 Verification (${completedCount}/${CHECKLIST_STEPS.length})\n${lines.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedNotice(true);
      window.setTimeout(() => setCopiedNotice(false), 2500);
    } catch {
      // Clipboard API unavailable in restricted iframe
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="phase1-checklist-title"
    >
      <div className="w-full max-w-2xl bg-white h-full overflow-y-auto shadow-2xl flex flex-col">
        {/* Sticky Header */}
        <div className="px-6 py-4 border-b border-slate-200 bg-white sticky top-0 z-10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
              <ClipboardCheck className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="phase1-checklist-title"
                className="font-display text-base sm:text-lg font-semibold text-slate-900 truncate"
              >
                Phase 1 Verification Checklist
              </h2>
              <p className="text-xs text-slate-500">
                {completedCount} of {CHECKLIST_STEPS.length} checks verified · Progress saves automatically across refresh
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Phase 1 checklist"
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress & Live ERP Context Bar */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 space-y-3">
          <div className="grid grid-cols-10 gap-1" aria-label={`Progress: ${completedCount} of ${CHECKLIST_STEPS.length}`}>
            {CHECKLIST_STEPS.map((s) => (
              <div
                key={s.id}
                className={`h-2 rounded-sm transition-colors ${
                  checkedMap[s.id] ? 'bg-emerald-600' : 'bg-slate-200'
                }`}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono">
              <span>Vehicles: <strong className="text-slate-900">{vehicleCount}</strong></span>
              <span>Parties: <strong className="text-slate-900">{partyCount}</strong></span>
              <span>Bills: <strong className="text-slate-900">{billCount}</strong></span>
              <span>Diesel Rate: <strong className="text-slate-900">₹{effectiveRate.toFixed(2)}/L</strong></span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopySummary}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copiedNotice ? 'Copied Summary!' : 'Copy Summary'}</span>
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
            <span>
              Safety hold active: Do not delete records or re-import your real Excel workbook during this walkthrough. Click any jump button below to test that module directly.
            </span>
          </div>
        </div>

        {/* Checklist Items */}
        <div className="p-6 space-y-4 flex-1">
          {CHECKLIST_STEPS.map((step) => {
            const checked = Boolean(checkedMap[step.id]);
            return (
              <div
                key={step.id}
                className={`border rounded-xl p-4 transition-colors ${
                  checked
                    ? 'bg-emerald-50/50 border-emerald-200'
                    : 'bg-white border-slate-200'
                }`}
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => toggleStep(step.id)}
                    aria-pressed={checked}
                    aria-label={`Mark step ${step.number} as ${checked ? 'incomplete' : 'complete'}`}
                    className="mt-0.5 shrink-0 cursor-pointer text-slate-400 hover:text-slate-900"
                  >
                    {checked ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    ) : (
                      <Circle className="w-5 h-5" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => toggleStep(step.id)}
                        className="text-left cursor-pointer"
                      >
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 block">
                          Step {step.number} · {step.group}
                        </span>
                        <span
                          className={`text-sm font-semibold ${
                            checked ? 'text-emerald-900 line-through' : 'text-slate-900'
                          }`}
                        >
                          {step.title}
                        </span>
                      </button>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {step.actions.map((act) => (
                          <button
                            key={`${step.id}-${act.label}`}
                            type="button"
                            onClick={() => handleJump(act.section)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                          >
                            <span>{act.label}</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="text-xs text-slate-600 space-y-1 leading-relaxed">
                      <div>
                        <span className="font-semibold text-slate-800">Where to click:</span>{' '}
                        {step.whereToClick}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-800">What to check:</span>{' '}
                        {step.whatToCheck}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
