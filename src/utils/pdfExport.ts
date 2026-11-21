import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';

export interface RenderedA4PdfResult {
  pdf: jsPDF;
  fileName: string;
  orientation: 'portrait' | 'landscape';
  pageCount: number;
  pageImages: string[];
}

export function sanitizePdfFileName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9\-_. ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  const base = cleaned || 'bapasitaram-document';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

/**
 * Renders any DOM element onto true A4 paginated canvas slices + jsPDF document.
 * Preserves Hindi Devanagari + English text, INR (₹) symbols, tables, and totals cleanly.
 */
export async function renderElementToA4Pdf(
  sourceElement: HTMLElement,
  fileName: string,
  orientation: 'portrait' | 'landscape' = 'portrait'
): Promise<RenderedA4PdfResult> {
  if (typeof document === 'undefined') {
    throw new Error('PDF rendering requires a browser environment.');
  }

  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // Proceed with fallback system fonts if font readiness rejects
    }
  }

  const a4WidthPx = orientation === 'landscape' ? 1122 : 794;

  const sandbox = document.createElement('div');
  sandbox.style.position = 'fixed';
  sandbox.style.left = '-100000px';
  sandbox.style.top = '0';
  sandbox.style.width = `${a4WidthPx}px`;
  sandbox.style.backgroundColor = '#ffffff';
  sandbox.style.color = '#0f172a';
  sandbox.style.fontFamily =
    '"Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, -apple-system, sans-serif';
  sandbox.style.zIndex = '-1';
  sandbox.style.padding = '24px';
  sandbox.style.boxSizing = 'border-box';

  const clone = sourceElement.cloneNode(true) as HTMLElement;
  clone.style.maxHeight = 'none';
  clone.style.height = 'auto';
  clone.style.overflow = 'visible';
  clone.style.width = '100%';
  clone.style.backgroundColor = '#ffffff';

  clone.querySelectorAll('.no-print').forEach((node) => node.remove());
  clone.querySelectorAll<HTMLElement>('*').forEach((el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls.includes('overflow-') || cls.includes('max-h-')) {
      el.style.overflow = 'visible';
      el.style.maxHeight = 'none';
    }
    if (el.tagName === 'TABLE') {
      el.style.width = '100%';
      el.style.borderCollapse = 'collapse';
    }
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      el.style.overflowWrap = 'anywhere';
    }
  });

  sandbox.appendChild(clone);
  document.body.appendChild(sandbox);

  try {
    const canvas = await html2canvas(sandbox, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: a4WidthPx,
    });

    const pdf = new jsPDF({
      orientation,
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const pageWidthMm = pdf.internal.pageSize.getWidth();
    const pageHeightMm = pdf.internal.pageSize.getHeight();
    const marginMm = 10;
    const printableWidthMm = pageWidthMm - marginMm * 2;
    const printableHeightMm = pageHeightMm - marginMm * 2;

    const pxPerMm = canvas.width / printableWidthMm;
    const pageHeightPx = Math.max(1, Math.floor(printableHeightMm * pxPerMm));

    const pageImages: string[] = [];
    let offsetY = 0;
    let pageIndex = 0;

    while (offsetY < canvas.height) {
      const sliceHeightPx = Math.min(pageHeightPx, canvas.height - offsetY);
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceHeightPx;

      const ctx = pageCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Unable to initialize canvas 2D context for PDF pagination.');
      }

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      ctx.drawImage(
        canvas,
        0,
        offsetY,
        canvas.width,
        sliceHeightPx,
        0,
        0,
        canvas.width,
        sliceHeightPx
      );

      const imgData = pageCanvas.toDataURL('image/png', 1.0);
      pageImages.push(imgData);
      const sliceHeightMm = sliceHeightPx / pxPerMm;

      if (pageIndex > 0) {
        pdf.addPage();
      }
      pdf.addImage(
        imgData,
        'PNG',
        marginMm,
        marginMm,
        printableWidthMm,
        sliceHeightMm,
        undefined,
        'FAST'
      );

      offsetY += sliceHeightPx;
      pageIndex += 1;
    }

    return {
      pdf,
      fileName: sanitizePdfFileName(fileName),
      orientation,
      pageCount: pageImages.length,
      pageImages,
    };
  } finally {
    document.body.removeChild(sandbox);
  }
}

/**
 * Generates and downloads an A4 multi-page PDF directly from a DOM element.
 */
export async function downloadElementAsA4Pdf(
  sourceElement: HTMLElement,
  fileName: string,
  orientation: 'portrait' | 'landscape' = 'portrait'
): Promise<void> {
  const rendered = await renderElementToA4Pdf(sourceElement, fileName, orientation);
  rendered.pdf.save(rendered.fileName);
}

export function triggerPrintPreview(): void {
  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    window.print();
  }
}
