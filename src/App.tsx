import React, { useState, useRef, useMemo, useEffect } from 'react';
import JSZip from 'jszip';
import {
  ShieldCheck,
  Lock,
  Unlock,
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Download,
  FolderArchive,
  Eye,
  EyeOff,
  Trash2,
  Sparkles,
  KeyRound,
  Plus,
  RefreshCw,
  FileCheck2,
  X,
  Layers,
  Tag,
  Check,
  ArrowDownToLine,
  BookmarkCheck,
  Combine,
} from 'lucide-react';
import {
  formatOutputFileName,
  formatFileSize,
  inspectPdfBytes,
  unlockPdfWithPasswords,
  mergeUnlockedPdfs,
  createDemoEncryptedPdfs,
} from './utils/pdfProcessor';

export type PdfItemStatus = 'inspecting' | 'locked' | 'unlocking' | 'unlocked' | 'error';

export interface PdfFileItem {
  id: string;
  file: File;
  originalName: string;
  customBaseName?: string;
  sizeBytes: number;
  rawBytes?: Uint8Array;
  unlockedBytes?: Uint8Array;
  status: PdfItemStatus;
  encryptionInfo?: string;
  wasOriginallyEncrypted: boolean;
  pageCount?: number;
  matchedPassword?: string;
  engineUsed?: string;
  errorMessage?: string;
  individualPasswordInput: string;
  downloadedCount: number;
  isCurrentlyDownloading?: boolean;
}

const POSTFIX_PRESETS = [
  { label: '_unlocked (Default)', value: '_unlocked' },
  { label: '_nopass', value: '_nopass' },
  { label: '_decrypted', value: '_decrypted' },
  { label: '_{date}', value: '_{date}' },
  { label: '_{pages}p_unlocked', value: '_{pages}p_unlocked' },
  { label: ' (No Postfix)', value: '' },
];

const SAVED_PASSWORDS_STORAGE_KEY = 'pdf_unlocker_saved_passwords_v1';

export function App() {
  const [items, setItems] = useState<PdfFileItem[]>([]);
  const [postfix, setPostfix] = useState<string>('_unlocked');
  const [prefix, setPrefix] = useState<string>('');
  const [masterPassword, setMasterPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [savedPasswords, setSavedPasswords] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(SAVED_PASSWORDS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [rememberPassword, setRememberPassword] = useState<boolean>(true);
  const [multiPasswordMode, setMultiPasswordMode] = useState<boolean>(false);
  const [extraPasswordsText, setExtraPasswordsText] = useState<string>('');
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isBatchUnlocking, setIsBatchUnlocking] = useState<boolean>(false);
  const [isSequentialDownloading, setIsSequentialDownloading] = useState<boolean>(false);
  const [sequentialProgress, setSequentialProgress] = useState<{ current: number; total: number } | null>(null);
  const [isZipping, setIsZipping] = useState<boolean>(false);
  const [isMerging, setIsMerging] = useState<boolean>(false);
  const [isGeneratingDemo, setIsGeneratingDemo] = useState<boolean>(false);
  const [previewItem, setPreviewItem] = useState<{ name: string; url: string } | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SAVED_PASSWORDS_STORAGE_KEY, JSON.stringify(savedPasswords));
    } catch {}
  }, [savedPasswords]);

  const savePasswordToVault = (pwd: string) => {
    const clean = pwd.trim();
    if (!clean) return;
    setSavedPasswords((prev) => (prev.includes(clean) ? prev : [clean, ...prev].slice(0, 15)));
  };

  const removeSavedPassword = (pwd: string) => {
    setSavedPasswords((prev) => prev.filter((p) => p !== pwd));
  };

  // Build candidate password list from masterPassword + saved vault + optional multi-password list
  const getCandidatePasswords = (overridePassword?: string): string[] => {
    const list: string[] = [];
    if (overridePassword !== undefined && overridePassword !== '') {
      list.push(overridePassword);
      if (overridePassword.trim() !== overridePassword) {
        list.push(overridePassword.trim());
      }
    }
    if (masterPassword !== '') {
      list.push(masterPassword);
      if (masterPassword.trim() !== masterPassword) {
        list.push(masterPassword.trim());
      }
    }
    if (multiPasswordMode && extraPasswordsText.trim()) {
      const lines = extraPasswordsText
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (!list.includes(line)) {
          list.push(line);
        }
      }
    }
    for (const saved of savedPasswords) {
      if (!list.includes(saved)) {
        list.push(saved);
      }
    }
    return list;
  };

  // Add 1 or multiple PDF files and inspect each one automatically
  const handleAddFiles = async (fileList: FileList | File[], explicitPassword?: string) => {
    const incomingFiles = Array.from(fileList).filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );

    if (incomingFiles.length === 0) return;

    const newEntries: PdfFileItem[] = incomingFiles.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      originalName: file.name,
      sizeBytes: file.size,
      status: 'inspecting',
      wasOriginallyEncrypted: true,
      individualPasswordInput: '',
      downloadedCount: 0,
    }));

    setItems((prev) => [...prev, ...newEntries]);

    const currentCandidates = getCandidatePasswords(explicitPassword);

    for (const entry of newEntries) {
      try {
        const buffer = await entry.file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const info = await inspectPdfBytes(bytes);

        if (!info.encrypted) {
          setItems((prev) =>
            prev.map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    rawBytes: bytes,
                    unlockedBytes: bytes,
                    status: 'unlocked',
                    wasOriginallyEncrypted: false,
                    encryptionInfo: 'No Password Required',
                    pageCount: info.pageCount,
                    engineUsed: 'Unencrypted',
                  }
                : item
            )
          );
        } else if (currentCandidates.length > 0) {
          const unlockRes = await unlockPdfWithPasswords(bytes, currentCandidates);
          if (unlockRes.success && unlockRes.unlockedBytes) {
            setItems((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? {
                      ...item,
                      rawBytes: bytes,
                      unlockedBytes: unlockRes.unlockedBytes,
                      status: 'unlocked',
                      wasOriginallyEncrypted: true,
                      encryptionInfo: info.algorithm || 'Encrypted PDF',
                      pageCount: unlockRes.pageCount,
                      matchedPassword: unlockRes.matchedPassword,
                      engineUsed: unlockRes.engineUsed,
                      errorMessage: undefined,
                    }
                  : item
              )
            );
          } else {
            setItems((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? {
                      ...item,
                      rawBytes: bytes,
                      status: 'locked',
                      wasOriginallyEncrypted: true,
                      encryptionInfo: info.algorithm || 'Password Protected',
                    }
                  : item
              )
            );
          }
        } else {
          setItems((prev) =>
            prev.map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    rawBytes: bytes,
                    status: 'locked',
                    wasOriginallyEncrypted: true,
                    encryptionInfo: info.algorithm || 'Password Protected',
                  }
                : item
            )
          );
        }
      } catch {
        setItems((prev) =>
          prev.map((item) =>
            item.id === entry.id
              ? {
                  ...item,
                  status: 'error',
                  errorMessage: 'Could not read PDF file',
                }
              : item
          )
        );
      }
    }

    setTimeout(() => {
      passwordInputRef.current?.focus();
    }, 100);
  };

  // Try the entered password(s) across all selected PDFs that are still locked or errored
  const handleUnlockAll = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const candidates = getCandidatePasswords();
    if (candidates.length === 0) {
      passwordInputRef.current?.focus();
      setStatusAnnouncement('Please enter a PDF password to unlock your selected files.');
      return;
    }

    if (rememberPassword && masterPassword.trim()) {
      savePasswordToVault(masterPassword);
    }

    const targets = items.filter((item) => item.status !== 'unlocked' && item.rawBytes);
    if (targets.length === 0) return;

    setIsBatchUnlocking(true);
    setStatusAnnouncement(`Attempting password on ${targets.length} PDF file(s)...`);

    const targetIds = new Set(targets.map((t) => t.id));
    setItems((prev) =>
      prev.map((item) =>
        targetIds.has(item.id) ? { ...item, status: 'unlocking', errorMessage: undefined } : item
      )
    );

    let newlyUnlockedCount = 0;

    for (const target of targets) {
      if (!target.rawBytes) continue;
      const perFileCandidates = target.individualPasswordInput
        ? [target.individualPasswordInput, ...candidates]
        : candidates;

      const result = await unlockPdfWithPasswords(target.rawBytes, perFileCandidates);

      if (result.success && result.unlockedBytes) {
        newlyUnlockedCount++;
        if (rememberPassword && result.matchedPassword) {
          savePasswordToVault(result.matchedPassword);
        }
        setItems((prev) =>
          prev.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: 'unlocked',
                  unlockedBytes: result.unlockedBytes,
                  matchedPassword: result.matchedPassword,
                  pageCount: result.pageCount,
                  engineUsed: result.engineUsed,
                  errorMessage: undefined,
                }
              : item
          )
        );
      } else {
        setItems((prev) =>
          prev.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: 'error',
                  errorMessage: result.error || 'Incorrect password for this PDF',
                }
              : item
          )
        );
      }
    }

    setIsBatchUnlocking(false);
    setStatusAnnouncement(`Unlocked ${newlyUnlockedCount} of ${targets.length} PDF file(s).`);
  };

  // Unlock a single specific PDF row
  const handleUnlockSingle = async (id: string) => {
    const target = items.find((i) => i.id === id);
    if (!target || !target.rawBytes) return;

    const candidates = getCandidatePasswords(target.individualPasswordInput);
    if (candidates.length === 0) {
      passwordInputRef.current?.focus();
      return;
    }

    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, status: 'unlocking', errorMessage: undefined } : item
      )
    );

    const result = await unlockPdfWithPasswords(target.rawBytes, candidates);
    if (result.success && result.unlockedBytes) {
      if (rememberPassword && result.matchedPassword) {
        savePasswordToVault(result.matchedPassword);
      }
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'unlocked',
                unlockedBytes: result.unlockedBytes,
                matchedPassword: result.matchedPassword,
                pageCount: result.pageCount,
                engineUsed: result.engineUsed,
                errorMessage: undefined,
              }
            : item
        )
      );
    } else {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'error',
                errorMessage: result.error || 'Incorrect password',
              }
            : item
        )
      );
    }
  };

  // Compute final output filename for an item
  const getOutputName = (item: PdfFileItem, index: number = 0): string => {
    const sourceName = item.customBaseName
      ? `${item.customBaseName}.pdf`
      : item.originalName;
    return formatOutputFileName(sourceName, postfix, prefix, {
      pageCount: item.pageCount,
      index,
    });
  };

  // Trigger a single browser file download
  const triggerBrowserDownload = (bytes: Uint8Array, fileName: string) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // Download a single unlocked PDF
  const handleDownloadOne = (item: PdfFileItem, index: number) => {
    if (!item.unlockedBytes) return;
    const outName = getOutputName(item, index);
    triggerBrowserDownload(item.unlockedBytes, outName);
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id ? { ...i, downloadedCount: i.downloadedCount + 1 } : i
      )
    );
  };

  // Download ALL unlocked PDFs sequentially one after another!
  const handleDownloadAllSequential = async () => {
    const unlockedList = items.filter((i) => i.status === 'unlocked' && i.unlockedBytes);
    if (unlockedList.length === 0 || isSequentialDownloading) return;

    setIsSequentialDownloading(true);
    setSequentialProgress({ current: 0, total: unlockedList.length });

    for (let idx = 0; idx < unlockedList.length; idx++) {
      const currentItem = unlockedList[idx];
      setSequentialProgress({ current: idx + 1, total: unlockedList.length });

      setItems((prev) =>
        prev.map((i) => ({
          ...i,
          isCurrentlyDownloading: i.id === currentItem.id,
        }))
      );

      if (currentItem.unlockedBytes) {
        const outName = getOutputName(currentItem, idx);
        triggerBrowserDownload(currentItem.unlockedBytes, outName);
        setItems((prev) =>
          prev.map((i) =>
            i.id === currentItem.id
              ? { ...i, downloadedCount: i.downloadedCount + 1 }
              : i
          )
        );
      }

      if (idx < unlockedList.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    setItems((prev) => prev.map((i) => ({ ...i, isCurrentlyDownloading: false })));
    setIsSequentialDownloading(false);
    setTimeout(() => setSequentialProgress(null), 2000);
  };

  // Merge all unlocked PDFs into 1 combined PDF and download it
  const handleMergeAndDownloadAll = async () => {
    const unlockedList = items.filter((i) => i.status === 'unlocked' && i.unlockedBytes);
    if (unlockedList.length < 2 || isMerging) return;

    setIsMerging(true);
    try {
      const byteArrays = unlockedList.map((i) => i.unlockedBytes!);
      const mergedBytes = await mergeUnlockedPdfs(byteArrays);
      const mergedFileName = formatOutputFileName('Merged_Documents.pdf', postfix, prefix, {
        pageCount: unlockedList.reduce((acc, item) => acc + (item.pageCount || 1), 0),
        index: 0,
      });
      triggerBrowserDownload(mergedBytes, mergedFileName);
    } finally {
      setIsMerging(false);
    }
  };

  // Download all unlocked PDFs bundled in a single ZIP archive
  const handleDownloadAllZip = async () => {
    const unlockedList = items.filter((i) => i.status === 'unlocked' && i.unlockedBytes);
    if (unlockedList.length === 0 || isZipping) return;

    setIsZipping(true);
    try {
      const zip = new JSZip();
      const usedNames = new Set<string>();

      for (let idx = 0; idx < unlockedList.length; idx++) {
        const item = unlockedList[idx];
        if (!item.unlockedBytes) continue;
        let outName = getOutputName(item, idx);
        if (usedNames.has(outName)) {
          const base = outName.replace(/\.pdf$/i, '');
          let counter = 2;
          while (usedNames.has(`${base}_${counter}.pdf`)) counter++;
          outName = `${base}_${counter}.pdf`;
        }
        usedNames.add(outName);
        zip.file(outName, item.unlockedBytes);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `unlocked_pdfs${postfix.replace(/\{[^}]+\}/g, '') || ''}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally {
      setIsZipping(false);
    }
  };

  // Preview unlocked PDF inside a modal
  const handlePreviewPdf = (item: PdfFileItem, idx: number) => {
    if (!item.unlockedBytes) return;
    const blob = new Blob([new Uint8Array(item.unlockedBytes)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    setPreviewItem({
      name: getOutputName(item, idx),
      url,
    });
  };

  const closePreview = () => {
    if (previewItem?.url) {
      URL.revokeObjectURL(previewItem.url);
    }
    setPreviewItem(null);
  };

  // Generate 3 real password-protected demo PDFs ("secret123")
  const handleLoadDemoPdfs = async () => {
    setIsGeneratingDemo(true);
    try {
      const demoFiles = await createDemoEncryptedPdfs('secret123');
      setMasterPassword('secret123');
      await handleAddFiles(demoFiles, 'secret123');
    } finally {
      setIsGeneratingDemo(false);
    }
  };

  const stats = useMemo(() => {
    const total = items.length;
    const unlocked = items.filter((i) => i.status === 'unlocked').length;
    const locked = items.filter((i) => i.status === 'locked' || i.status === 'error').length;
    const errored = items.filter((i) => i.status === 'error').length;
    return { total, unlocked, locked, errored };
  }, [items]);

  const samplePreviewName = useMemo(() => {
    const firstOriginal = items[0]?.originalName || 'invoice_2026.pdf';
    return formatOutputFileName(firstOriginal, postfix, prefix, {
      pageCount: items[0]?.pageCount ?? 2,
      index: 0,
    });
  }, [items, postfix, prefix]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Screen-reader live region */}
      <div className="sr-only" aria-live="polite">
        {statusAnnouncement}
      </div>

      {/* Top Navigation / Trust Header */}
      <header className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Unlock className="w-5 h-5 text-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">
                  PDF Unlocker Pro
                </h1>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  <ShieldCheck className="w-3 h-3" /> 100% Local & Private
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Batch remove PDF passwords in your browser — zero server uploads, lossless quality
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleLoadDemoPdfs}
              disabled={isGeneratingDemo}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-emerald-300 border border-emerald-500/30 transition cursor-pointer disabled:opacity-50"
              title="Generates 3 real AES-256 encrypted PDFs with password 'secret123' and unlocks them so you can test immediately"
            >
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              {isGeneratingDemo ? 'Creating Demo PDFs...' : 'Load 3 Demo Locked PDFs (pwd: secret123)'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Step 1: Upload 1 or Multiple PDFs */}
        <section
          aria-label="Upload PDF files"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files?.length) {
              handleAddFiles(e.dataTransfer.files);
            }
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`relative rounded-2xl border-2 border-dashed transition-all duration-200 p-7 sm:p-9 text-center cursor-pointer group ${
            isDragging
              ? 'border-emerald-400 bg-emerald-500/10 scale-[1.005]'
              : 'border-slate-800 hover:border-emerald-500/50 bg-slate-900/50 hover:bg-slate-900/80'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                handleAddFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />

          <div className="mx-auto w-14 h-14 rounded-2xl bg-slate-800/90 group-hover:bg-emerald-500/15 border border-slate-700 group-hover:border-emerald-500/40 flex items-center justify-center transition mb-4">
            <Upload className="w-6 h-6 text-emerald-400 group-hover:scale-110 transition-transform" />
          </div>

          <h2 className="text-base sm:text-lg font-semibold text-white">
            Select 1 or Multiple Password-Protected PDFs
          </h2>
          <p className="text-sm text-slate-400 mt-1 max-w-xl mx-auto">
            Drag & drop your PDF files here, or{' '}
            <span className="text-emerald-400 font-medium underline underline-offset-4">
              browse from your device
            </span>
            . Supports AES-256, AES-128, and RC4 encrypted PDFs.
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800">
              <Layers className="w-3.5 h-3.5 text-emerald-400" /> Single or Batch PDF Upload
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800">
              <Tag className="w-3.5 h-3.5 text-emerald-400" /> Custom Filename Postfix + Tokens
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800">
              <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-400" /> Sequential 1-by-1 Download
            </span>
          </div>
        </section>

        {/* Step 2 & Step 3: Postfix Settings + Password Configuration */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Step 2: Filename Postfix Settings */}
          <div className="lg:col-span-5 rounded-2xl bg-slate-900/70 border border-slate-800 p-5 sm:p-6 flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold flex items-center justify-center">
                    2
                  </span>
                  <h3 className="text-sm font-semibold text-white uppercase tracking-wider">
                    Output Filename Postfix
                  </h3>
                </div>
                <span className="text-[11px] text-slate-400">Default: _unlocked</span>
              </div>

              <div>
                <label
                  htmlFor="postfix-input"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Filename Postfix (supports <code className="text-emerald-300">{'{date}'}</code>,{' '}
                  <code className="text-emerald-300">{'{pages}'}</code>,{' '}
                  <code className="text-emerald-300">{'{index}'}</code>)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="postfix-input"
                    name="postfix"
                    type="text"
                    value={postfix}
                    onChange={(e) => setPostfix(e.target.value)}
                    placeholder="_unlocked"
                    className="w-full rounded-xl bg-slate-950 border border-slate-700/80 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 px-3.5 py-2.5 text-sm font-mono text-white placeholder-slate-500 outline-none transition"
                  />
                  {postfix !== '_unlocked' && (
                    <button
                      type="button"
                      onClick={() => setPostfix('_unlocked')}
                      className="px-3 py-2.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 shrink-0 transition cursor-pointer"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              {/* Quick Preset Chips */}
              <div>
                <span className="block text-[11px] text-slate-400 mb-1.5">
                  Quick Postfix Presets:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {POSTFIX_PRESETS.map((preset) => {
                    const active = postfix === preset.value;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setPostfix(preset.value)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-mono transition cursor-pointer border ${
                          active
                            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-semibold'
                            : 'bg-slate-950/70 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Live Output Filename Preview Box */}
            <div className="rounded-xl bg-slate-950/90 border border-slate-800/90 p-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">
                  Live Download Name Preview
                </div>
                <div className="text-xs sm:text-sm font-mono text-emerald-300 truncate mt-0.5">
                  {samplePreviewName}
                </div>
              </div>
              <span className="px-2 py-1 rounded text-[11px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                .pdf
              </span>
            </div>
          </div>

          {/* Step 3: Password Input & Batch Try Form */}
          <form
            onSubmit={handleUnlockAll}
            className="lg:col-span-7 rounded-2xl bg-slate-900/70 border border-slate-800 p-5 sm:p-6 flex flex-col justify-between space-y-4"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold flex items-center justify-center">
                    3
                  </span>
                  <h3 className="text-sm font-semibold text-white uppercase tracking-wider">
                    PDF Password (Tried Across All Selected PDFs)
                  </h3>
                </div>

                <button
                  type="button"
                  onClick={() => setMultiPasswordMode((v) => !v)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition cursor-pointer ${
                    multiPasswordMode
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {multiPasswordMode ? '✓ Multi-Password Book Active' : '+ Have Multiple Passwords?'}
                </button>
              </div>

              <div>
                <label
                  htmlFor="master-password-input"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Enter PDF Password to Unlock Selected Files
                </label>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                  <div className="relative flex-1">
                    <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      ref={passwordInputRef}
                      id="master-password-input"
                      name="pdfPassword"
                      type={showPassword ? 'text' : 'password'}
                      value={masterPassword}
                      onChange={(e) => setMasterPassword(e.target.value)}
                      placeholder="Enter password (e.g. secret123)..."
                      className="w-full rounded-xl bg-slate-950 border border-slate-700/80 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 pl-10 pr-10 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  <button
                    type="submit"
                    disabled={items.length === 0 || isBatchUnlocking}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    {isBatchUnlocking ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Unlocking PDFs...
                      </>
                    ) : (
                      <>
                        <Unlock className="w-4 h-4 stroke-[2.5]" />
                        Unlock All PDFs ({stats.locked > 0 ? stats.locked : items.length})
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Saved Password Vault Chips & Remember Toggle */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberPassword}
                    onChange={(e) => setRememberPassword(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500/30"
                  />
                  <span>Remember successful passwords in local browser vault</span>
                </label>

                {savedPasswords.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400 inline-flex items-center gap-1">
                      <BookmarkCheck className="w-3.5 h-3.5 text-emerald-400" /> Saved Vault:
                    </span>
                    {savedPasswords.map((pwd) => (
                      <span
                        key={pwd}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono bg-slate-950 border border-slate-800 text-slate-300"
                      >
                        <button
                          type="button"
                          onClick={() => setMasterPassword(pwd)}
                          className="hover:text-emerald-300 cursor-pointer"
                          title="Click to use this saved password"
                        >
                          {showPassword ? pwd : '••••••'}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeSavedPassword(pwd)}
                          className="text-slate-500 hover:text-rose-400 cursor-pointer"
                          title="Remove from saved vault"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Optional Multi-Password Vault */}
              {multiPasswordMode && (
                <div className="pt-1">
                  <label
                    htmlFor="extra-passwords"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Additional Candidate Passwords (one per line or comma-separated — we try all of them on each PDF):
                  </label>
                  <textarea
                    id="extra-passwords"
                    rows={2}
                    value={extraPasswordsText}
                    onChange={(e) => setExtraPasswordsText(e.target.value)}
                    placeholder="e.g.&#10;PAN123456&#10;01011995"
                    className="w-full rounded-xl bg-slate-950 border border-slate-700/80 focus:border-emerald-500 p-2.5 text-xs font-mono text-slate-200 placeholder-slate-500 outline-none"
                  />
                </div>
              )}
            </div>
          </form>
        </div>

        {/* Step 4: Selected PDFs List, Check Marks, Individual Download & Sequential Download All */}
        {items.length > 0 && (
          <section className="rounded-2xl bg-slate-900/70 border border-slate-800 overflow-hidden shadow-xl">
            {/* Action Header Bar */}
            <div className="p-4 sm:px-6 border-b border-slate-800 bg-slate-900/90 flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  <FileCheck2 className="w-5 h-5 text-emerald-400" />
                  Selected PDF Files ({stats.total})
                </h3>

                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-medium inline-flex items-center gap-1">
                    <Check className="w-3.5 h-3.5 stroke-[2.5]" /> {stats.unlocked} Unlocked
                  </span>
                  {stats.locked > 0 && (
                    <span className="px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium inline-flex items-center gap-1">
                      <Lock className="w-3 h-3" /> {stats.locked} Locked
                    </span>
                  )}
                </div>
              </div>

              {/* Download All (Sequential One-by-One) + Merge + ZIP */}
              <div className="flex flex-wrap items-center gap-2.5">
                {stats.unlocked > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={handleDownloadAllSequential}
                      disabled={isSequentialDownloading}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50"
                    >
                      <Download className="w-4 h-4 stroke-[2.5]" />
                      {isSequentialDownloading && sequentialProgress
                        ? `Downloading ${sequentialProgress.current} of ${sequentialProgress.total}...`
                        : `Download All (${stats.unlocked}) One by One`}
                    </button>

                    {stats.unlocked > 1 && (
                      <>
                        <button
                          type="button"
                          onClick={handleMergeAndDownloadAll}
                          disabled={isMerging}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 transition cursor-pointer disabled:opacity-50"
                          title="Combine all unlocked PDFs into a single merged PDF document"
                        >
                          <Combine className="w-4 h-4 text-emerald-400" />
                          {isMerging ? 'Merging PDFs...' : 'Merge into 1 PDF'}
                        </button>

                        <button
                          type="button"
                          onClick={handleDownloadAllZip}
                          disabled={isZipping}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition cursor-pointer disabled:opacity-50"
                          title="Download all unlocked PDFs inside a single .zip archive"
                        >
                          <FolderArchive className="w-4 h-4 text-emerald-400" />
                          {isZipping ? 'Creating ZIP...' : 'Download as ZIP'}
                        </button>
                      </>
                    )}
                  </>
                )}

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-slate-800/80 hover:bg-slate-800 text-slate-300 border border-slate-700/80 transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" /> Add More
                </button>

                <button
                  type="button"
                  onClick={() => setItems([])}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/20 transition cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Clear All
                </button>
              </div>
            </div>

            {/* File Rows */}
            <div className="divide-y divide-slate-800/80">
              {items.map((item, index) => {
                const outputName = getOutputName(item, index);
                const isUnlocked = item.status === 'unlocked';
                const isErrored = item.status === 'error';

                return (
                  <div
                    key={item.id}
                    className={`p-4 sm:px-6 transition-colors ${
                      item.isCurrentlyDownloading
                        ? 'bg-emerald-500/15'
                        : isUnlocked
                        ? 'bg-emerald-950/10 hover:bg-slate-900/80'
                        : 'hover:bg-slate-900/60'
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      {/* Left: Check Mark / Status Icon + File Details */}
                      <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
                        {/* Prominent Check Mark when Unlocked */}
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border transition-all ${
                            isUnlocked
                              ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-md shadow-emerald-500/10'
                              : isErrored
                              ? 'bg-rose-500/15 border-rose-500/40 text-rose-400'
                              : item.status === 'unlocking' || item.status === 'inspecting'
                              ? 'bg-sky-500/15 border-sky-500/40 text-sky-400'
                              : 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                          }`}
                          title={
                            isUnlocked
                              ? 'PDF Opened & Password Removed!'
                              : isErrored
                              ? item.errorMessage
                              : 'Locked PDF'
                          }
                        >
                          {isUnlocked ? (
                            <CheckCircle2 className="w-6 h-6 text-emerald-400 stroke-[2.25]" />
                          ) : item.status === 'unlocking' || item.status === 'inspecting' ? (
                            <RefreshCw className="w-5 h-5 animate-spin" />
                          ) : isErrored ? (
                            <AlertCircle className="w-5 h-5" />
                          ) : (
                            <Lock className="w-5 h-5" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-mono text-slate-500">
                              #{index + 1}
                            </span>
                            <span className="text-sm font-medium text-slate-200 truncate">
                              {item.originalName}
                            </span>
                            <span className="text-xs text-slate-500">
                              ({formatFileSize(item.sizeBytes)})
                            </span>

                            {/* Status Badge */}
                            {isUnlocked && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                {item.wasOriginallyEncrypted ? 'Unlocked & Ready' : 'Already Unlocked'}
                              </span>
                            )}

                            {item.pageCount !== undefined && (
                              <span className="px-2 py-0.5 rounded-md text-[11px] bg-slate-800 text-slate-300">
                                {item.pageCount} {item.pageCount === 1 ? 'page' : 'pages'}
                              </span>
                            )}

                            {item.downloadedCount > 0 && (
                              <span className="px-2 py-0.5 rounded-md text-[11px] bg-teal-500/15 text-teal-300 border border-teal-500/30">
                                ✓ Downloaded {item.downloadedCount > 1 ? `(${item.downloadedCount}x)` : ''}
                              </span>
                            )}
                          </div>

                          {/* Output Filename with Postfix Preview */}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <span>Downloading as:</span>
                              <code className="text-emerald-300 font-mono bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                                {outputName}
                              </code>
                            </span>

                            {item.encryptionInfo && (
                              <span className="text-slate-500">
                                • {item.encryptionInfo}
                              </span>
                            )}
                          </div>

                          {/* Error feedback if password didn't match this specific file */}
                          {isErrored && (
                            <p className="text-xs text-rose-400 font-medium flex items-center gap-1.5 pt-0.5">
                              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                              {item.errorMessage} — try another password above or enter this file&apos;s specific password on the right.
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Right: Actions (Individual Password Override OR Preview + Download Button) */}
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {!isUnlocked && (
                          <div className="flex items-center gap-1.5">
                            <input
                              type={showPassword ? 'text' : 'password'}
                              value={item.individualPasswordInput}
                              onChange={(e) => {
                                const val = e.target.value;
                                setItems((prev) =>
                                  prev.map((i) =>
                                    i.id === item.id ? { ...i, individualPasswordInput: val } : i
                                  )
                                );
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleUnlockSingle(item.id);
                                }
                              }}
                              placeholder="File-specific password..."
                              className="w-44 rounded-lg bg-slate-950 border border-slate-700/80 focus:border-emerald-500 px-2.5 py-1.5 text-xs text-white placeholder-slate-500 outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => handleUnlockSingle(item.id)}
                              disabled={item.status === 'unlocking'}
                              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 transition cursor-pointer"
                            >
                              Unlock
                            </button>
                          </div>
                        )}

                        {isUnlocked && (
                          <>
                            <button
                              type="button"
                              onClick={() => handlePreviewPdf(item, index)}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition cursor-pointer"
                              title="Preview unlocked PDF in browser"
                            >
                              <FileText className="w-3.5 h-3.5 text-emerald-400" />
                              Preview
                            </button>

                            <button
                              type="button"
                              onClick={() => handleDownloadOne(item, index)}
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md shadow-emerald-500/15 transition cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5 stroke-[2.5]" />
                              Download
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          onClick={() =>
                            setItems((prev) => prev.filter((i) => i.id !== item.id))
                          }
                          className="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                          aria-label={`Remove ${item.originalName}`}
                          title="Remove file"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>

      {/* Unlocked PDF Modal Viewer */}
      {previewItem && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closePreview}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-2xl max-w-4xl w-full h-[85vh] flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <span className="text-sm font-mono font-semibold text-white truncate">
                  {previewItem.name}
                </span>
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Password Removed
                </span>
              </div>
              <button
                type="button"
                onClick={closePreview}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 bg-slate-950">
              <iframe
                src={previewItem.url}
                title={previewItem.name}
                className="w-full h-full border-0"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
