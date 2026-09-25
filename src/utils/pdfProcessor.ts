import { decryptPDF, isEncrypted } from '@pdfsmaller/pdf-decrypt';
import { encryptPDF } from '@pdfsmaller/pdf-encrypt';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface PdfEncryptionDetails {
  encrypted: boolean;
  algorithm?: string;
  version?: number;
  revision?: number;
  keyLength?: number;
  pageCount?: number;
}

export interface UnlockResult {
  success: boolean;
  unlockedBytes?: Uint8Array;
  matchedPassword?: string;
  pageCount?: number;
  engineUsed?: 'WebCrypto' | 'QPDF-WASM' | 'Unencrypted';
  error?: string;
}

export interface NamingContext {
  pageCount?: number;
  index?: number;
}

/**
 * Formats the output PDF file name using a user-defined postfix (with support for {date}, {pages}p, {index} tokens).
 * Example: ("statement.pdf", "_unlocked") => "statement_unlocked.pdf"
 */
export function formatOutputFileName(
  originalName: string,
  postfix: string,
  prefix: string = '',
  ctx?: NamingContext
): string {
  const trimmedOriginal = originalName.trim() || 'document.pdf';
  const hasPdfExt = /\.pdf$/i.test(trimmedOriginal);
  const baseName = hasPdfExt ? trimmedOriginal.replace(/\.pdf$/i, '') : trimmedOriginal;

  const todayStr = new Date().toISOString().slice(0, 10);
  const resolvedPostfix = postfix
    .replace(/\{date\}/gi, todayStr)
    .replace(/\{pages\}/gi, ctx?.pageCount !== undefined ? String(ctx.pageCount) : '1')
    .replace(/\{index\}/gi, ctx?.index !== undefined ? String(ctx.index + 1) : '1');

  return `${prefix}${baseName}${resolvedPostfix}.pdf`;
}

/**
 * Formats byte counts into human-readable file size strings.
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Fallback decryption using QPDF compiled to WebAssembly (handles AES-128 V=4 R=4 and edge cases).
 */
async function decryptWithQpdfWasm(
  pdfBytes: Uint8Array,
  password: string
): Promise<Uint8Array> {
  const createQpdfModule = (await import('qpdf-wasm-esm-embedded')).default;
  let stderrOutput = '';

  const qpdf: any = await createQpdfModule({
    noInitialRun: true,
    print: () => {},
    printErr: (text: string) => {
      stderrOutput += text + '\n';
    },
  });

  const inputPath = '/input.pdf';
  const outputPath = '/output.pdf';

  qpdf.FS.writeFile(inputPath, pdfBytes);

  try {
    const exitCode = qpdf.callMain([
      `--password=${password}`,
      '--decrypt',
      inputPath,
      outputPath,
    ]);

    if (exitCode !== 0 && exitCode !== 3) {
      if (stderrOutput.toLowerCase().includes('invalid password')) {
        throw new Error('Incorrect password');
      }
      throw new Error(stderrOutput.trim() || `QPDF exited with code ${exitCode}`);
    }

    const outputBytes: Uint8Array = qpdf.FS.readFile(outputPath);
    return new Uint8Array(outputBytes);
  } finally {
    try {
      qpdf.FS.unlink(inputPath);
    } catch {}
    try {
      qpdf.FS.unlink(outputPath);
    } catch {}
  }
}

/**
 * Counts pages in an unlocked PDF byte array using pdf-lib.
 */
async function getPageCountSafe(pdfBytes: Uint8Array): Promise<number | undefined> {
  try {
    const doc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return doc.getPageCount();
  } catch {
    return undefined;
  }
}

/**
 * Inspects a PDF byte buffer to check whether it requires a password and what encryption it uses.
 */
export async function inspectPdfBytes(pdfBytes: Uint8Array): Promise<PdfEncryptionDetails> {
  try {
    const info = await isEncrypted(pdfBytes);
    if (info.encrypted) {
      return {
        encrypted: true,
        algorithm: info.algorithm
          ? `${info.algorithm}${info.keyLength ? ` (${info.keyLength}-bit)` : ''}`
          : 'Password Protected',
        version: info.version,
        revision: info.revision,
        keyLength: info.keyLength,
      };
    }

    const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    return {
      encrypted: false,
      pageCount: doc.getPageCount(),
    };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (msg.toLowerCase().includes('encrypt')) {
      return {
        encrypted: true,
        algorithm: 'AES-128 / Standard Security',
      };
    }
    return {
      encrypted: true,
      algorithm: 'Password Protected',
    };
  }
}

/**
 * Attempts to unlock a PDF using one or more candidate passwords.
 */
export async function unlockPdfWithPasswords(
  pdfBytes: Uint8Array,
  candidatePasswords: string[]
): Promise<UnlockResult> {
  const passwordsToTry = candidatePasswords.length > 0 ? candidatePasswords : [''];
  let lastError = 'Incorrect password';

  for (const pwd of passwordsToTry) {
    try {
      const decrypted = await decryptPDF(pdfBytes, pwd);
      const pageCount = await getPageCountSafe(decrypted);
      return {
        success: true,
        unlockedBytes: decrypted,
        matchedPassword: pwd,
        pageCount,
        engineUsed: 'WebCrypto',
      };
    } catch (err: any) {
      const message = String(err?.message || err || '');

      if (message.includes('not encrypted')) {
        const pageCount = await getPageCountSafe(pdfBytes);
        return {
          success: true,
          unlockedBytes: pdfBytes,
          matchedPassword: '',
          pageCount,
          engineUsed: 'Unencrypted',
        };
      }

      try {
        const wasmDecrypted = await decryptWithQpdfWasm(pdfBytes, pwd);
        const pageCount = await getPageCountSafe(wasmDecrypted);
        return {
          success: true,
          unlockedBytes: wasmDecrypted,
          matchedPassword: pwd,
          pageCount,
          engineUsed: 'QPDF-WASM',
        };
      } catch (wasmErr: any) {
        lastError = String(wasmErr?.message || 'Incorrect password');
      }
    }
  }

  return {
    success: false,
    error: lastError.includes('Incorrect password')
      ? 'Incorrect password for this PDF'
      : lastError,
  };
}

/**
 * Merges multiple unlocked PDF byte arrays into a single combined PDF document.
 */
export async function mergeUnlockedPdfs(pdfByteArrays: Uint8Array[]): Promise<Uint8Array> {
  const mergedPdf = await PDFDocument.create();

  for (const bytes of pdfByteArrays) {
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }

  const saved = await mergedPdf.save();
  return new Uint8Array(saved);
}

/**
 * Generates 3 realistic password-protected sample PDFs right in the browser for instant testing.
 */
export async function createDemoEncryptedPdfs(password: string = 'secret123'): Promise<File[]> {
  const demos = [
    {
      fileName: 'Bank_Statement_Sept_2026.pdf',
      title: 'MONTHLY ACCOUNT STATEMENT — SEPT 2026',
      subtitle: 'Account Holder: Rushi Patel | Account #: XXXX-XXXX-8492',
      accentColor: rgb(0.06, 0.46, 0.43),
      pages: [
        [
          'Statement Period: 01 Sep 2026 - 30 Sep 2026',
          'Opening Balance: $14,250.00',
          'Total Credits: +$6,400.00',
          'Total Debits: -$1,820.50',
          'Closing Balance: $18,829.50',
          '',
          'Recent Transactions:',
          '05 Sep 2026  Direct Deposit - Payroll          +$3,200.00',
          '12 Sep 2026  Cloud Infrastructure AWS          -$142.50',
          '19 Sep 2026  Direct Deposit - Consulting       +$3,200.00',
          '24 Sep 2026  Office Equipment & Fibre          -$1,678.00',
        ],
        [
          'Page 2 — Important Security Notice',
          'This PDF was originally encrypted with 256-bit AES protection.',
          'Unlocked cleanly in your browser using PDF Unlocker.',
          'All vector text, fonts, and layout remain 100% intact and lossless.',
        ],
      ],
    },
    {
      fileName: 'Salary_Slip_Q3_2026.pdf',
      title: 'CONFIDENTIAL PAYSLIP — SEPTEMBER 2026',
      subtitle: 'Department: Engineering | Employee ID: ENG-2049',
      accentColor: rgb(0.15, 0.38, 0.72),
      pages: [
        [
          'Basic Salary:                  $4,800.00',
          'Housing & Allowances:          $1,200.00',
          'Performance Bonus:             $850.00',
          'Gross Earnings:                $6,850.00',
          '',
          'Deductions (Tax & PF):         -$650.00',
          'Net Pay Disbursed:             $6,200.00',
          '',
          'Status: Paid via Electronic Wire Transfer on 25 Sep 2026.',
        ],
      ],
    },
    {
      fileName: 'Tax_Invoice_2026_Q3.pdf',
      title: 'TAX INVOICE & COMPLIANCE CERTIFICATE',
      subtitle: 'Invoice #INV-2026-0981 | Issue Date: 25 Sep 2026',
      accentColor: rgb(0.45, 0.22, 0.68),
      pages: [
        [
          'Billed To: Enterprise Solutions Ltd.',
          'Service Description: Full-Stack Architecture & Security Audit',
          'Total Hours Logged: 120 hrs @ $85/hr',
          'Subtotal: $10,200.00',
          'Applicable Tax (0% Export): $0.00',
          'Total Amount Due: $10,200.00',
        ],
      ],
    },
  ];

  const files: File[] = [];

  for (const demo of demos) {
    const pdfDoc = await PDFDocument.create();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (let pIndex = 0; pIndex < demo.pages.length; pIndex++) {
      const page = pdfDoc.addPage([595.28, 841.89]);
      const { width, height } = page.getSize();

      page.drawRectangle({
        x: 0,
        y: height - 95,
        width,
        height: 95,
        color: demo.accentColor,
      });

      page.drawText(demo.title, {
        x: 45,
        y: height - 48,
        size: 16,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      page.drawText(demo.subtitle, {
        x: 45,
        y: height - 72,
        size: 10.5,
        font: fontRegular,
        color: rgb(0.9, 0.95, 1),
      });

      let yCursor = height - 145;
      for (const line of demo.pages[pIndex]) {
        if (line === '') {
          yCursor -= 14;
          continue;
        }
        page.drawText(line, {
          x: 45,
          y: yCursor,
          size: 11.5,
          font: line.startsWith('Page ') || line.endsWith(':') ? fontBold : fontRegular,
          color: rgb(0.15, 0.18, 0.22),
        });
        yCursor -= 24;
      }

      page.drawText(
        `Demo PDF generated locally for password removal testing • Original Password: "${password}" • Page ${pIndex + 1} of ${demo.pages.length}`,
        {
          x: 45,
          y: 35,
          size: 8.5,
          font: fontRegular,
          color: rgb(0.5, 0.55, 0.6),
        }
      );
    }

    const plainBytes = await pdfDoc.save();
    const encryptedBytes = await encryptPDF(new Uint8Array(plainBytes), password);
    const blob = new Blob([new Uint8Array(encryptedBytes)], { type: 'application/pdf' });
    files.push(new File([blob], demo.fileName, { type: 'application/pdf' }));
  }

  return files;
}
