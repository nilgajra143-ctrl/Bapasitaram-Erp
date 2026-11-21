import React from 'react';
import { Download, Printer, X, FileText, MessageCircle } from 'lucide-react';
import type { RenderedA4PdfResult } from '../utils/pdfExport';

interface PdfPreviewModalProps {
  preview: RenderedA4PdfResult | null;
  title: string;
  onDownload: () => void;
  onPrint: () => void;
  onClose: () => void;
  onWhatsAppShare?: () => void;
  whatsAppLabel?: string;
}

export const PdfPreviewModal: React.FC<PdfPreviewModalProps> = ({
  preview,
  title,
  onDownload,
  onPrint,
  onClose,
  onWhatsAppShare,
  whatsAppLabel = 'WhatsApp Share',
}) => {
  if (!preview) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-950/75 flex flex-col no-print"
      role="dialog"
      aria-modal="true"
      aria-label={`A4 PDF Preview - ${title}`}
    >
      {/* Top Action Bar */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileText className="w-4 h-4 text-slate-700 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate">{title}</div>
            <div className="text-[11px] text-slate-500 font-mono">
              A4 {preview.orientation === 'landscape' ? 'Landscape' : 'Portrait'} ·{' '}
              {preview.pageCount} {preview.pageCount === 1 ? 'Page' : 'Pages'} · {preview.fileName}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onWhatsAppShare && (
            <button
              type="button"
              onClick={onWhatsAppShare}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              <span>{whatsAppLabel}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onDownload}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download PDF</span>
          </button>
          <button
            type="button"
            onClick={onPrint}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close PDF preview"
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Rendered A4 Pages Canvas */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-8 flex flex-col items-center gap-6 bg-slate-800">
        {preview.pageImages.map((imgSrc, idx) => (
          <div
            key={`${preview.fileName}-p-${idx + 1}`}
            className={`bg-white shadow-2xl border border-slate-300 w-full ${
              preview.orientation === 'landscape' ? 'max-w-5xl' : 'max-w-3xl'
            }`}
          >
            <div className="px-4 py-1.5 bg-slate-100 border-b border-slate-200 flex items-center justify-between text-[11px] font-mono text-slate-600">
              <span>A4 Page {idx + 1} of {preview.pageCount}</span>
              <span>BAPASITARAM ENTERPRISE</span>
            </div>
            <div className="p-3 sm:p-5 bg-white">
              <img
                src={imgSrc}
                alt={`A4 PDF Page ${idx + 1}`}
                className="w-full h-auto block border border-slate-100"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
