import PdfPrinter = require('pdfmake');
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

/** Caratteri Roboto inclusi in pdfmake (nessun file esterno da installare). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vfs: Record<string, string> = require('pdfmake/build/vfs_fonts');

let printer: PdfPrinter | null = null;
const getPrinter = () => {
  if (!printer) {
    const font = (name: string) => Buffer.from(vfs[name], 'base64');
    printer = new PdfPrinter({
      Roboto: {
        normal: font('Roboto-Regular.ttf'),
        bold: font('Roboto-Medium.ttf'),
        italics: font('Roboto-Italic.ttf'),
        bolditalics: font('Roboto-MediumItalic.ttf'),
      },
    });
  }
  return printer;
};

/** Genera il PDF in memoria. */
export function renderPdf(def: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = getPrinter().createPdfKitDocument(def);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Millimetri → punti PDF. */
export const mm = (v: number) => v * 2.8346;
