import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  MessageCircle,
  RotateCcw,
  Share2,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  buildWhatsAppManualUrl,
  canSharePdfFileViaWebShare,
  sharePdfFileViaWebShare,
} from '../utils/whatsappShare';

export interface WhatsAppPdfAttachment {
  fileName: string;
  pageCount?: number;
  getFile: () => File;
  onDownloadPdf: () => void;
}

export interface WhatsAppShareModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  partyName: string;
  partyPhone: string;
  initialMessage: string;
  pdfAttachment?: WhatsAppPdfAttachment | null;
}

export const WhatsAppShareModal: React.FC<WhatsAppShareModalProps> = ({
  open,
  onClose,
  title,
  subtitle,
  partyName,
  partyPhone,
  initialMessage,
  pdfAttachment = null,
}) => {
  const [message, setMessage] = useState(initialMessage);
  const [copied, setCopied] = useState(false);
  const [sharingPdf, setSharingPdf] = useState(false);
  const [shareStatus, setShareStatus] = useState<{
    tone: 'success' | 'info' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(initialMessage);
    setCopied(false);
    setShareStatus(null);
  }, [open, initialMessage]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sharingPdf) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, sharingPdf, onClose]);

  const { url: whatsappUrl, phone } = useMemo(
    () => buildWhatsAppManualUrl(partyPhone, message),
    [partyPhone, message]
  );

  const supportsNativePdfShare = useMemo(() => {
    if (!open || !pdfAttachment) return false;
    try {
      return canSharePdfFileViaWebShare(pdfAttachment.getFile());
    } catch {
      return false;
    }
  }, [open, pdfAttachment]);

  if (!open) return null;

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setShareStatus({
        tone: 'error',
        text: 'Clipboard access was blocked. You can select and copy the message text manually.',
      });
    }
  };

  const handleSharePdfFile = async () => {
    if (!pdfAttachment || !phone.valid) return;
    setSharingPdf(true);
    setShareStatus(null);
    try {
      const file = pdfAttachment.getFile();
      const result = await sharePdfFileViaWebShare({
        file,
        title: `${title} — ${partyName}`,
        text: message,
      });
      if (result.outcome === 'shared') {
        setShareStatus({
          tone: 'success',
          text: `PDF file "${pdfAttachment.fileName}" handed off to share sheet. Review recipient (${phone.displayNumber}) and press Send in WhatsApp.`,
        });
      } else if (result.outcome === 'cancelled') {
        setShareStatus({
          tone: 'info',
          text: 'Share cancelled. Nothing was sent.',
        });
      } else {
        setShareStatus({
          tone: 'info',
          text:
            result.message ||
            'Direct PDF sharing is unavailable in this browser. Download the PDF and attach it in WhatsApp.',
        });
      }
    } finally {
      setSharingPdf(false);
    }
  };

  const handleDownloadPdfForWhatsApp = () => {
    if (!pdfAttachment) return;
    pdfAttachment.onDownloadPdf();
    setShareStatus({
      tone: 'success',
      text: `Saved "${pdfAttachment.fileName}" to your device. Now click "Open WhatsApp" below to open ${phone.displayNumber}, attach the PDF, review the message, and press Send.`,
    });
  };

  const isEdited = message !== initialMessage;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-950/60 overflow-y-auto no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whatsapp-share-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !sharingPdf) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-auto max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-white shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
              <MessageCircle className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="whatsapp-share-modal-title"
                className="font-display text-base sm:text-lg font-semibold text-slate-900 truncate"
              >
                {title}
              </h2>
              <p className="text-xs text-slate-500">
                {subtitle || 'Review recipient and message below — you press Send manually in WhatsApp.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={sharingPdf}
            onClick={onClose}
            aria-label="Close WhatsApp share modal"
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {/* Verified Recipient Guard */}
          {phone.valid ? (
            <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200 flex items-start gap-3">
              <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
              <div className="min-w-0 text-xs">
                <div className="font-semibold text-emerald-950">
                  Verified Party Recipient: {partyName}
                </div>
                <div className="font-mono text-emerald-900 mt-0.5">
                  WhatsApp Mobile: {phone.displayNumber}
                </div>
                <p className="text-[11px] text-emerald-800 mt-1">
                  Locked to the party&apos;s saved mobile number with country code. WhatsApp will open for your manual review — nothing is sent automatically.
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
                  Valid Saved Mobile Number Required for {partyName}
                </div>
                <p className="mt-1 text-amber-900">
                  {phone.reason} To protect private financial details from being sent to the wrong recipient, please save a valid mobile number (10 digits or with country code like +91) on this party&apos;s profile in Party Accounts first.
                </p>
              </div>
            </div>
          )}

          {/* Optional Bill PDF Attachment Block */}
          {pdfAttachment && (
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-4 h-4 text-slate-700 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 truncate">
                      {pdfAttachment.fileName}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Actual A4 PDF File
                      {pdfAttachment.pageCount
                        ? ` · ${pdfAttachment.pageCount} ${
                            pdfAttachment.pageCount === 1 ? 'Page' : 'Pages'
                          }`
                        : ''}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadPdfForWhatsApp}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download PDF</span>
                </button>
              </div>

              {phone.valid && (
                <div className="pt-2 border-t border-slate-200 flex flex-col gap-2">
                  {supportsNativePdfShare ? (
                    <button
                      type="button"
                      disabled={sharingPdf}
                      onClick={handleSharePdfFile}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                    >
                      <Share2 className="w-4 h-4" />
                      <span>
                        {sharingPdf
                          ? 'Opening Share Sheet...'
                          : `Share PDF File via WhatsApp (${phone.displayNumber})`}
                      </span>
                    </button>
                  ) : (
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      On desktop browsers, click <span className="font-semibold">Download PDF</span> above, then click <span className="font-semibold">Open WhatsApp</span> below to open <span className="font-mono font-medium">{phone.displayNumber}</span> with the prepared message and attach the downloaded PDF file before pressing Send.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Prepared Message Editor for Manual Review */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label
                htmlFor="whatsapp-share-message"
                className="text-xs font-medium text-slate-700"
              >
                Prepared WhatsApp Message (Review Before Sending)
              </label>
              <div className="flex items-center gap-2">
                {isEdited && (
                  <button
                    type="button"
                    onClick={() => setMessage(initialMessage)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCopyMessage}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                >
                  {copied ? (
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
              id="whatsapp-share-message"
              rows={9}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full px-3.5 py-2.5 text-xs sm:text-sm font-mono leading-relaxed text-slate-900 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-slate-900"
            />
          </div>

          {shareStatus && (
            <div
              role="status"
              className={`p-3 rounded-lg text-xs border ${
                shareStatus.tone === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : shareStatus.tone === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              {shareStatus.text}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <span className="text-[11px] text-slate-500">
            Manual send only — review in WhatsApp and press Send.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              Close
            </button>
            {whatsappUrl ? (
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors"
              >
                <MessageCircle className="w-4 h-4" />
                <span>Open WhatsApp</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            ) : (
              <button
                type="button"
                disabled
                className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-slate-400 bg-slate-200 rounded-lg cursor-not-allowed"
              >
                <MessageCircle className="w-4 h-4" />
                <span>Open WhatsApp</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
