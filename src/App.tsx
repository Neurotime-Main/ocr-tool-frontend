import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Check, ChevronDown, FileSearch, Files, Highlighter,
  ListChecks, LoaderCircle, Minus, MousePointer2, OctagonX, Plus, Redo2, RotateCcw, Search,
  SlidersHorizontal, Trash2, Undo2, Upload, UploadCloud, X,
} from 'lucide-react';
import {
  cancelDocuments, fetchKeywords, fileUrl, getDocument, getDocumentStatuses, isCancelledRequest,
  publishDocuments, retryOcr, saveHighlights, searchDocuments as searchDocumentSet, uploadDocuments,
} from './api';
import { normalizeSearchText } from './normalize';
import { PdfViewer } from './PdfViewer';
import type { BatchPublishReport, DocumentRecord, Highlight, ServerKeyword } from './types';
import { useHighlightHistory } from './useHighlightHistory';

/** Matches the server's MAX_BATCH_FILES. More can be added afterwards. */
const MAX_BATCH_FILES = 30;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

// Four of these share the Latin recognition model and one needs Cyrillic, but
// that is the server's concern: here they are simply the languages a document
// may be written in, and several can apply to the same file.
const OCR_LANGUAGES = [
  { value: 'aze', label: 'Azərbaycanca' },
  { value: 'eng', label: 'English' },
  { value: 'rus', label: 'Русский' },
  { value: 'uzb', label: 'Oʻzbekcha' },
  { value: 'tur', label: 'Türkçe' },
] as const;
type OcrLanguage = typeof OCR_LANGUAGES[number]['value'];
type OcrMode = 'AUTO' | 'FORCE_OCR';

/**
 * What may be uploaded. Office documents and images are converted to PDF on the
 * server, so everything downstream -- the viewer, OCR, highlights, publishing --
 * only ever deals with PDF pages.
 *
 * This list must stay in step with ACCEPTED_EXTENSIONS in the backend's
 * convert.ts; the file picker's filter is derived from it rather than written
 * out a second time.
 */
const ACCEPTED_UPLOAD_EXTENSIONS = [
  '.pdf',
  '.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
  '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.avif', '.heic', '.heif',
];
const UPLOAD_ACCEPT_ATTRIBUTE = ACCEPTED_UPLOAD_EXTENSIONS.join(',');

const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.round(bytes / 1024)} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const errorMessage = (error: unknown) => {
  const candidate = error as { response?: { data?: { error?: string } }; message?: string };
  return candidate.response?.data?.error ?? candidate.message ?? 'Something went wrong.';
};

const toggleOcrLanguage = (current: OcrLanguage[], language: OcrLanguage) => {
  if (current.includes(language)) {
    // An empty choice only turns into a server-side upload error.
    return current.length === 1 ? current : current.filter((item) => item !== language);
  }
  return [...current, language];
};

function LanguageOptions({ languages, onChange, disabled }: {
  languages: OcrLanguage[];
  onChange: (languages: OcrLanguage[]) => void;
  disabled: boolean;
}) {
  return (
    <section className="upload-option-group" aria-labelledby="language-label">
      <div className="option-heading">
        <span id="language-label">Languages to read</span>
        <small>Choose one or more</small>
      </div>
      <div className="language-choices" role="group" aria-labelledby="language-label">
        {OCR_LANGUAGES.map((language) => {
          const selected = languages.includes(language.value);
          return (
            <button
              key={language.value}
              type="button"
              className={`language-choice ${selected ? 'selected' : ''}`}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(toggleOcrLanguage(languages, language.value))}
            >
              <span className="choice-check"><Check size={13} strokeWidth={3} /></span>
              {language.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function OcrModeOptions({ mode, onChange, disabled }: {
  mode: OcrMode;
  onChange: (mode: OcrMode) => void;
  disabled: boolean;
}) {
  return (
    <section className="upload-option-group" aria-labelledby="mode-label">
      <div className="option-heading">
        <span id="mode-label">Reading mode</span>
        <small>Pick for this batch</small>
      </div>
      <div className="ocr-mode-choices" role="radiogroup" aria-labelledby="mode-label">
        <button type="button" role="radio" aria-checked={mode === 'AUTO'} disabled={disabled} onClick={() => onChange('AUTO')} className={`ocr-mode-choice ${mode === 'AUTO' ? 'selected' : ''}`}>
          <span className="mode-choice-mark"><Check size={12} strokeWidth={3} /></span>
          <span><b>Automatic</b><small>Fast · uses PDF text when reliable</small></span>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'FORCE_OCR'} disabled={disabled} onClick={() => onChange('FORCE_OCR')} className={`ocr-mode-choice ${mode === 'FORCE_OCR' ? 'selected' : ''}`}>
          <span className="mode-choice-mark"><Check size={12} strokeWidth={3} /></span>
          <span><b>Complex layouts</b><small>Slower · OCR every page</small></span>
        </button>
      </div>
    </section>
  );
}

function UploadScreen({ onUploaded }: { onUploaded: (documents: DocumentRecord[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [uploadAlert, setUploadAlert] = useState<{ title: string; message: string } | null>(null);
  const uploadAlertTimer = useRef<number | undefined>(undefined);
  const [languages, setLanguages] = useState<OcrLanguage[]>(['aze', 'eng']);
  const [ocrMode, setOcrMode] = useState<OcrMode>('AUTO');

  const showUploadAlert = (title: string, message: string) => {
    setUploadAlert({ title, message });
    if (uploadAlertTimer.current) window.clearTimeout(uploadAlertTimer.current);
    uploadAlertTimer.current = window.setTimeout(() => setUploadAlert(null), 5000);
  };

  useEffect(() => () => {
    if (uploadAlertTimer.current) window.clearTimeout(uploadAlertTimer.current);
  }, []);

  const upload = async (selectedFiles?: FileList | File[]) => {
    const files = Array.from(selectedFiles ?? []);
    if (!files.length) return;
    if (files.length > MAX_BATCH_FILES) {
      showUploadAlert('Upload limit reached', `You can upload up to ${MAX_BATCH_FILES} files at a time.`);
      return;
    }
    const oversized = files.find((file) => file.size > MAX_FILE_SIZE_BYTES);
    if (oversized) {
      showUploadAlert('File is too large', `“${oversized.name}” is ${formatBytes(oversized.size)}. The limit is 50 MB per file.`);
      return;
    }
    const unsupported = files.filter((file) => !ACCEPTED_UPLOAD_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension)));
    if (unsupported.length) {
      showUploadAlert('Unsupported file type', `“${unsupported[0]!.name}” is not supported. Upload a PDF, an image, or a Word, Excel, PowerPoint or OpenDocument file.`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUploading(true);
    setUploadProgress({ loaded: 0, total: files.reduce((total, file) => total + file.size, 0) });
    setUploadAlert(null);
    setNotice('');
    try {
      const created = await uploadDocuments(
        files, languages, ocrMode,
        (loaded: number, total: number) => setUploadProgress({ loaded, total }),
        controller.signal,
      );
      onUploaded(created.map((item) => ({ ...item, pages: [], highlights: [] })));
    } catch (reason) {
      // A cancelled upload is a deliberate action, not a failure. The server
      // discards anything it had already stored for the aborted request.
      if (isCancelledRequest(reason)) setNotice('Upload cancelled. Nothing was saved.');
      else showUploadAlert('Upload failed', errorMessage(reason));
    } finally {
      abortRef.current = null;
      setUploading(false);
      setUploadProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <main className="welcome-shell">
      {uploadAlert && <div className="upload-alert" role="alert">
        <Files size={19} />
        <span><b>{uploadAlert.title}</b><small>{uploadAlert.message}</small></span>
        <button type="button" onClick={() => setUploadAlert(null)} aria-label="Dismiss upload alert"><X size={16} /></button>
      </div>}
      <header className="welcome-header">
        <div className="brand-mark"><Highlighter size={21} /></div>
        <span className="brand-name">Markwise</span>
      </header>
      <div className="welcome-body">
      <section className="welcome-copy">
        <span className="eyebrow"><span /> OCR document search</span>
        <h1>Search every Journal.<br /><em>Find every mention.</em></h1>
        <p>Upload one newspaper issue, pick the keywords to track, review the mentions, then publish the results.</p>
      </section>
      <section
        className={`upload-card ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}
      >
        <input ref={inputRef} type="file" accept={UPLOAD_ACCEPT_ATTRIBUTE} multiple hidden onChange={(event) => void upload(event.target.files ?? undefined)} />
        <div className="upload-icon"><UploadCloud size={31} /></div>
        <h2>{uploading ? 'Uploading files…' : 'Drop files here'}</h2>
        <p>{uploading && uploadProgress?.total
          ? `${Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))}% uploaded · preparing OCR jobs`
          : 'One file or up to 30 at once'}</p>
        <div className="upload-options">
          <LanguageOptions languages={languages} onChange={setLanguages} disabled={uploading} />
          <OcrModeOptions mode={ocrMode} onChange={setOcrMode} disabled={uploading} />
        </div>
        <div className="upload-actions">
          <button className="primary-button upload-button" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle className="spin" size={19} /> : <Files size={19} />}
            {uploading ? 'Uploading' : 'Choose files'}
          </button>
          {uploading && (
            <button className="cancel-button" onClick={() => abortRef.current?.abort()}>
              <X size={18} /> Cancel upload
            </button>
          )}
        </div>
        <div className="upload-meta"><span>1–30 files</span><i /> <span>50 MB each</span><i /> <span>AZ + EN + RU + UZ + TR</span></div>
        {notice && <div className="inline-notice">{notice}</div>}
      </section>
      </div>
      <footer className="welcome-footer">Files are processed with PaddleOCR on the server.</footer>
    </main>
  );
}

function AddDocumentsDialog({ onUploaded, onClose }: {
  onUploaded: (documents: DocumentRecord[]) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [languages, setLanguages] = useState<OcrLanguage[]>(['aze', 'eng']);
  const [ocrMode, setOcrMode] = useState<OcrMode>('AUTO');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);

  const upload = async (selectedFiles?: FileList | File[]) => {
    const files = Array.from(selectedFiles ?? []);
    if (!files.length) return;
    if (files.length > MAX_BATCH_FILES) {
      setError(`Choose no more than ${MAX_BATCH_FILES} files at once.`);
      return;
    }
    const unsupported = files.filter((file) => !ACCEPTED_UPLOAD_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension)));
    if (unsupported.length) {
      setError(`Unsupported file type: ${unsupported[0]!.name}. Accepted: PDF, images, Word, Excel, PowerPoint and OpenDocument.`);
      return;
    }
    if (files.length > MAX_BATCH_FILES) {
      setError(`Up to ${MAX_BATCH_FILES} files at once. You can add more once these are uploaded.`);
      return;
    }
    setUploading(true);
    setProgress({ loaded: 0, total: files.reduce((total, file) => total + file.size, 0) });
    setError('');
    try {
      const created = await uploadDocuments(files, languages, ocrMode, (loaded: number, total: number) => setProgress({ loaded, total }));
      onUploaded(created.map((item) => ({ ...item, pages: [], highlights: [] })));
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setUploading(false);
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="add-documents-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !uploading) onClose(); }}>
      <section className="add-documents-dialog" role="dialog" aria-modal="true" aria-labelledby="add-documents-title">
        <button className="dialog-close" type="button" onClick={onClose} disabled={uploading} aria-label="Close add documents dialog"><X size={18} /></button>
        <div className="dialog-icon"><Files size={21} /></div>
        <h2 id="add-documents-title">Add documents to the queue</h2>
        <p>Your current files will keep reading while these upload.</p>
        <div className="upload-options modal-upload-options">
          <LanguageOptions languages={languages} onChange={setLanguages} disabled={uploading} />
          <OcrModeOptions mode={ocrMode} onChange={setOcrMode} disabled={uploading} />
        </div>
        <input ref={inputRef} type="file" accept={UPLOAD_ACCEPT_ATTRIBUTE} multiple hidden onChange={(event) => void upload(event.target.files ?? undefined)} />
        <button className="primary-button add-files-button" type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? <LoaderCircle className="spin" size={18} /> : <UploadCloud size={18} />}
          {uploading && progress?.total ? `Uploading ${Math.min(100, Math.round((progress.loaded / progress.total) * 100))}%` : 'Choose files to add'}
        </button>
        {error && <p className="dialog-error">{error}</p>}
      </section>
    </div>
  );
}

function ProcessingScreen({ documents, stopping, onRetry, onDiscard, onUploaded }: {
  documents: DocumentRecord[];
  stopping: boolean;
  onRetry: (id: string) => void;
  onDiscard: (ids: string[]) => void;
  onUploaded: (documents: DocumentRecord[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const complete = documents.filter((document) => document.ocrStatus === 'COMPLETE').length;
  const failed = documents.filter((document) => document.ocrStatus === 'FAILED').length;
  const finished = complete + failed;
  const allFailed = finished === documents.length && failed === documents.length;
  // Each file contributes at most one unit, and a file being read contributes
  // the fraction of its pages that are done. Counting raw pages instead would
  // make the bar jump backwards every time a queued file reveals its length.
  const progress = documents.reduce((total, document) => {
    if (document.ocrStatus === 'COMPLETE' || document.ocrStatus === 'FAILED') return total + 1;
    const pages = document.ocrProgress;
    if (!pages?.totalPages) return total;
    return total + Math.min(1, pages.currentPage / pages.totalPages);
  }, 0);
  const percent = Math.min(100, (progress / Math.max(1, documents.length)) * 100);
  const readPages = documents.reduce((total, document) => total + (document.ocrStatus === 'COMPLETE'
    ? document.pageCount ?? 0
    : document.ocrProgress?.currentPage ?? 0), 0);

  return (
    <div className="processing-screen">
      <div className="brand-mark"><FileSearch size={22} /></div>
      {allFailed ? <X className="status-icon failed" size={38} /> : <LoaderCircle className="status-icon spin" size={38} />}
      <h1>{allFailed ? 'OCR could not finish' : `Reading ${documents.length} PDF${documents.length === 1 ? '' : 's'}`}</h1>
      <p>{finished} of {documents.length} finished{readPages ? ` · ${readPages} page${readPages === 1 ? '' : 's'} read` : ''}</p>
      <div className="batch-progress"><i style={{ width: `${percent}%` }} /></div>
      <div className="processing-files">
        {documents.map((document) => (
          <div className="processing-file" key={document.id}>
            <FileSearch size={17} />
            <span>
              <b title={document.originalName}>{document.originalName}</b>
              {document.ocrStatus === 'FAILED' && document.ocrError && (
                <em title={document.ocrError}>{document.ocrError}</em>
              )}
            </span>
            <small className={document.ocrStatus.toLowerCase()}>
              {document.ocrStatus === 'COMPLETE' ? `${document.pageCount ?? 0} pages`
                : document.ocrStatus === 'FAILED' ? 'Failed'
                  : document.ocrStatus === 'PROCESSING' ? document.ocrProgress?.totalPages
                    ? `${document.ocrProgress.currentPage} / ${document.ocrProgress.totalPages} pages`
                    : 'Preparing'
                    : document.ocrProgress?.queuePosition
                      ? `Queued · #${document.ocrProgress.queuePosition}`
                      : 'Queued'}
            </small>
            {document.ocrStatus === 'FAILED' && <button onClick={() => onRetry(document.id)} title="Retry OCR"><RotateCcw size={15} /></button>}
            {document.ocrStatus !== 'COMPLETE' && (
              <button
                className="discard-file"
                onClick={() => onDiscard([document.id])}
                disabled={stopping}
                title={`Stop reading and discard ${document.originalName}`}
                aria-label={`Stop reading and discard ${document.originalName}`}
              ><X size={15} /></button>
            )}
          </div>
        ))}
      </div>
      <div className="processing-actions">
        <button className="add-more-button" onClick={() => setAdding(true)} disabled={stopping}>
          <Plus size={17} /> Add more files
        </button>
        <button className="stop-button" onClick={() => onDiscard(documents.map((document) => document.id))} disabled={stopping}>
          {stopping ? <LoaderCircle className="spin" size={17} /> : <OctagonX size={17} />}
          {stopping ? 'Stopping…' : 'Stop and discard all'}
        </button>
        <small>New uploads join the queue. Stopping cancels and deletes all current files.</small>
      </div>
      {adding && <AddDocumentsDialog onUploaded={onUploaded} onClose={() => setAdding(false)} />}
    </div>
  );
}

export function App() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const [restoring, setRestoring] = useState(true);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Collapsed groups in the mentions list. A long batch produces hundreds of
  // rows, so a whole document or a single page can be folded away while the
  // rest stays visible.
  const [collapsedDocuments, setCollapsedDocuments] = useState<Set<string>>(new Set());
  const [collapsedPages, setCollapsedPages] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [bulkNote, setBulkNote] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [zoom, setZoom] = useState(0.9);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [searching, setSearching] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [exporting, setExporting] = useState<'publish' | null>(null);
  const [publishReport, setPublishReport] = useState<BatchPublishReport | null>(null);
  // Keywords come from the platform rather than being typed, so they are
  // fetched once when the workspace opens.
  const [availableKeywords, setAvailableKeywords] = useState<ServerKeyword[]>([]);
  const [keywordFilter, setKeywordFilter] = useState('');
  const [keywordError, setKeywordError] = useState('');
  const [loadingKeywords, setLoadingKeywords] = useState(false);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const history = useHighlightHistory();

  const document = documents.find((candidate) => candidate.id === activeDocumentId) ?? null;
  const readyDocuments = documents.filter((candidate) => candidate.ocrStatus === 'COMPLETE');
  const hasProcessing = documents.some((candidate) => ['PENDING', 'PROCESSING'].includes(candidate.ocrStatus));

  useEffect(() => {
    let storedIds: unknown = [];
    try { storedIds = JSON.parse(localStorage.getItem('markwise.documentIds') ?? '[]') as unknown; } catch { /* Ignore damaged local state. */ }
    const legacyId = localStorage.getItem('markwise.documentId');
    const ids = Array.isArray(storedIds) ? storedIds.filter((id): id is string => typeof id === 'string') : [];
    if (!ids.length && legacyId) ids.push(legacyId);
    if (!ids.length) { setRestoring(false); return; }
    getDocumentStatuses(ids.slice(0, MAX_BATCH_FILES))
      .then((summaries) => {
        const restored = summaries.map((summary) => ({ ...summary, pages: [] }));
        setDocuments(restored);
        const first = restored.find((candidate) => candidate.ocrStatus === 'COMPLETE') ?? restored[0];
        if (first) { setActiveDocumentId(first.id); history.reset(first.highlights); }
      })
      .catch(() => localStorage.removeItem('markwise.documentIds'))
      .finally(() => setRestoring(false));
  }, [history.reset]);

  useEffect(() => {
    if (restoring) return;
    localStorage.setItem('markwise.documentIds', JSON.stringify(documents.map((item) => item.id)));
    localStorage.removeItem('markwise.documentId');
  }, [documents.map((item) => item.id).join('|'), restoring]);

  useEffect(() => {
    if (!documents.length || !hasProcessing) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const statuses = await getDocumentStatuses(documents.map((item) => item.id));
        if (cancelled) return;
        const statusById = new Map(statuses.map((item) => [item.id, item]));
        setDocuments((current) => current.map((item) => {
          const status = statusById.get(item.id);
          return status ? { ...item, ...status } : item;
        }));
      } catch (error) {
        if (!cancelled) setNotice(errorMessage(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1800);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [documents.map((item) => `${item.id}:${item.ocrStatus}:${item.pages.length}`).join('|'), hasProcessing, activeDocumentId, history.reset]);

  useEffect(() => {
    if (!document || document.ocrStatus !== 'COMPLETE' || document.pages.length) return;
    let cancelled = false;
    getDocument(document.id).then((full) => {
      if (cancelled) return;
      setDocuments((current) => current.map((item) => item.id === full.id ? full : item));
      history.reset(full.highlights);
    }).catch((error) => !cancelled && setNotice(errorMessage(error)));
    return () => { cancelled = true; };
  }, [document?.id, document?.ocrStatus, document?.pages.length, history.reset]);

  useEffect(() => {
    if (hasProcessing || !readyDocuments.length) return;
    if (!document || document.ocrStatus !== 'COMPLETE') {
      setActiveDocumentId(readyDocuments[0]!.id);
      history.reset(readyDocuments[0]!.highlights);
    }
  }, [hasProcessing, readyDocuments.length, document?.ocrStatus, history.reset]);

  useEffect(() => {
    if (!activeDocumentId) return;
    setDocuments((current) => current.map((item) => item.id === activeDocumentId ? { ...item, highlights: history.highlights } : item));
  }, [activeDocumentId, history.highlights]);

  useEffect(() => {
    if (!document || revision === 0) return;
    setSaving('saving');
    const timer = window.setTimeout(() => {
      saveHighlights(document.id, history.highlights).then(() => setSaving('saved')).catch(() => setSaving('error'));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [document?.id, history.highlights, revision]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return;
      if (event.key.toLowerCase() === 'h') setManualMode((value) => !value);
      if (event.key === 'Escape') { setManualMode(false); setSelectedIds([]); setSelectionMode(false); setInspectorOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => setBulkNote(''), [selectedIds.join('|')]);

  const commit = (update: Highlight[] | ((current: Highlight[]) => Highlight[])) => {
    const next = typeof update === 'function' ? update(history.highlights) : update;
    history.commit(next);
    setRevision((value) => value + 1);
  };

  const switchDocument = (id: string) => {
    if (id === activeDocumentId) return;
    if (document) void saveHighlights(document.id, history.highlights).catch(() => setSaving('error'));
    const next = documents.find((candidate) => candidate.id === id && candidate.ocrStatus === 'COMPLETE');
    if (!next) return;
    setActiveDocumentId(id);
    history.reset(next.highlights);
    setSelectedIds([]);
    setSelectionMode(false);
    setManualMode(false);
  };

  const selectedHighlights = history.highlights.filter((highlight) => selectedIds.includes(highlight.id));
  const selected = selectedHighlights.at(-1) ?? null;
  const hasMultipleSelection = selectedHighlights.length > 1;
  const autoCount = history.highlights.filter((highlight) => highlight.source === 'AUTO').length;
  const manualCount = history.highlights.length - autoCount;
  const pagesWithHighlights = new Set(history.highlights.map((highlight) => highlight.pageNumber)).size;
  const allHighlightsCount = documents.reduce((total, item) => total + item.highlights.length, 0);
  const foundMentionsCount = documents.reduce((total, item) => total + item.highlights.filter((highlight) => highlight.source === 'AUTO').length, 0);
  const totalPages = readyDocuments.reduce((total, item) => total + (item.pageCount ?? 0), 0);

  const groupedHighlights = useMemo(() => documents.flatMap((item) => {
    const pages = new Map<number, Highlight[]>();
    for (const highlight of item.highlights) {
      const group = pages.get(highlight.pageNumber) ?? [];
      group.push(highlight);
      pages.set(highlight.pageNumber, group);
    }
    return [...pages.entries()].sort(([a], [b]) => a - b).map(([page, highlights]) => ({ document: item, page, highlights }));
  }), [documents]);

  // The platform's keyword list for newspapers. Fetched once per workspace:
  // it changes rarely, and re-fetching on every search would add a round trip
  // to the Neurotime database for no benefit.
  useEffect(() => {
    let cancelled = false;
    setLoadingKeywords(true);
    setKeywordError('');
    fetchKeywords()
      .then((result) => {
        if (cancelled) return;
        setAvailableKeywords(result.keywords);
        if (!result.keywords.length) setKeywordError('No keywords are registered for newspapers (source type 10).');
      })
      .catch((error) => { if (!cancelled) setKeywordError(errorMessage(error)); })
      .finally(() => { if (!cancelled) setLoadingKeywords(false); });
    return () => { cancelled = true; };
  }, []);

  const filteredKeywords = useMemo(() => {
    // Accent-tolerant, same as the highlight matcher: typing a plain
    // "azerbaycan" has to find "Azərbaycan", and typing the OCR-degraded
    // "azrbaycan" (the recognizer's own lowercase-ə gap) has to find it too.
    const needle = normalizeSearchText(keywordFilter);
    const chosen = new Set(keywords.map((keyword) => normalizeSearchText(keyword)));
    return availableKeywords
      .filter((keyword) => !chosen.has(normalizeSearchText(keyword.text)))
      .filter((keyword) => !needle || normalizeSearchText(keyword.text).includes(needle))
      .slice(0, 80);
  }, [availableKeywords, keywordFilter, keywords]);

  const toggleKeyword = (text: string) => {
    setKeywords((current) => current.includes(text)
      ? current.filter((item) => item !== text)
      : [...current, text]);
  };

  const runSearch = async () => {
    const searchKeywords = keywords;
    if (!searchKeywords.length || !readyDocuments.length) return;
    setSaving('saving');
    setSearching(true);
    try {
      if (document) await saveHighlights(document.id, history.highlights);
      const results = await searchDocumentSet(readyDocuments.map((item) => item.id), searchKeywords);
      const byId = new Map(results.map((result) => [result.documentId, result.highlights]));
      const nextDocuments = documents.map((item) => byId.has(item.id) ? { ...item, highlights: byId.get(item.id)! } : item);
      setDocuments(nextDocuments);
      const activeNext = nextDocuments.find((item) => item.id === activeDocumentId);
      if (activeNext) history.reset(activeNext.highlights);
      setSelectedIds([]);
      const total = results.reduce((sum, result) => sum + result.highlights.filter((highlight) => highlight.source === 'AUTO').length, 0);
      setSaving('saved');
      setNotice(total ? `Found ${total} mentions across ${readyDocuments.length} documents.` : 'No matching words were found.');
    } catch {
      setSaving('error');
      setNotice('The document search could not finish.');
    } finally {
      setSearching(false);
    }
  };

  const removeHighlight = (documentId: string, id: string) => {
    if (documentId === activeDocumentId) {
      commit((current) => current.filter((item) => item.id !== id));
      setSelectedIds((current) => current.filter((selectedId) => selectedId !== id));
      return;
    }
    const target = documents.find((item) => item.id === documentId);
    if (!target) return;
    const highlights = target.highlights.filter((item) => item.id !== id);
    setDocuments((current) => current.map((item) => item.id === documentId ? { ...item, highlights } : item));
    void saveHighlights(documentId, highlights).catch(() => setSaving('error'));
  };

  const scrollToHighlight = (id: string, attempt = 0) => {
    const target = window.document.querySelector<HTMLElement>(`[data-highlight-id="${id}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    else if (attempt < 30) window.setTimeout(() => scrollToHighlight(id, attempt + 1), 120);
  };

  const focusHighlight = (documentId: string, id: string, additive = false) => {
    // Ticking a box in another document must not drag the viewer over to it:
    // building a selection across the batch means passing through documents
    // that are not open, and switching on every tick would make that unusable.
    if (additive) {
      setSelectedIds((current) => current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id]);
      setInspectorOpen(true);
      return;
    }
    if (documentId !== activeDocumentId) {
      switchDocument(documentId);
      setSelectedIds([id]);
    } else if (additive) {
      setSelectedIds((current) => current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id]);
    } else setSelectedIds([id]);
    setInspectorOpen(true);
    window.setTimeout(() => scrollToHighlight(id), documentId === activeDocumentId ? 0 : 180);
  };

  const updateHighlight = (id: string, patch: Partial<Highlight>) => commit((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));

  /**
   * Applies a change to every selected mention, in whichever document it lives.
   *
   * Selection spans the whole batch now, so an edit cannot simply go through
   * `commit`: that only ever touches the open document, and the rest of the
   * selection would silently be left alone. The active document still goes
   * through the history so undo keeps working; the others are written straight
   * to state and persisted, which is the same path a single cross-document
   * delete already took.
   */
  const mutateSelected = (transform: (highlights: Highlight[], selected: Set<string>) => Highlight[]) => {
    if (!selectedIds.length) return;
    const selected = new Set(selectedIds);

    if (document) commit((current) => transform(current, selected));

    const touched = documents.filter((item) => item.id !== activeDocumentId
      && item.highlights.some((highlight) => selected.has(highlight.id)));
    if (!touched.length) return;

    const updates = new Map(touched.map((item) => [item.id, transform(item.highlights, selected)]));
    setDocuments((current) => current.map((item) => updates.has(item.id)
      ? { ...item, highlights: updates.get(item.id)! }
      : item));
    for (const [id, highlights] of updates) {
      void saveHighlights(id, highlights).catch(() => setSaving('error'));
    }
  };

  const updateSelectedHighlights = (patch: Partial<Highlight>) => {
    mutateSelected((highlights, selected) => highlights.map((item) => selected.has(item.id) ? { ...item, ...patch } : item));
  };

  const removeSelectedHighlights = () => {
    mutateSelected((highlights, selected) => highlights.filter((item) => !selected.has(item.id)));
    setSelectedIds([]);
    setSelectionMode(false);
  };

  /**
   * One control for both directions: it selects everything in the batch, and
   * once everything is selected it clears the selection instead. Two buttons
   * where one is always a no-op is just something else to aim at.
   */
  const allHighlightIds = useMemo(
    () => documents.flatMap((item) => item.highlights.map((highlight) => highlight.id)),
    [documents],
  );
  const allSelected = allHighlightIds.length > 0 && selectedIds.length >= allHighlightIds.length;
  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : allHighlightIds);

  const toggleDocumentCollapsed = (documentId: string) => setCollapsedDocuments((current) => {
    const next = new Set(current);
    if (next.has(documentId)) next.delete(documentId); else next.add(documentId);
    return next;
  });

  const togglePageCollapsed = (key: string) => setCollapsedPages((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /**
   * Publishes the reviewed mentions.
   *
   * Highlights are saved first: the operator has usually just removed a bad
   * match or drawn a manual one, and publishing works from what is stored, not
   * from what is on screen.
   */
  const publish = async () => {
    if (!document) return;
    if (!foundMentionsCount) { setNotice('Search for keywords before publishing.'); return; }
    setExporting('publish');
    setNotice('');
    try {
      // Save the open document first: the operator has usually just adjusted it,
      // and publishing reads what is stored rather than what is on screen. The
      // others were already saved when they were last edited.
      await saveHighlights(document.id, history.highlights);
      setPublishReport(await publishDocuments(readyDocuments.map((item) => item.id)));
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const closeWorkspace = () => {
    if (document) void saveHighlights(document.id, history.highlights).catch(() => undefined);
    localStorage.removeItem('markwise.documentIds');
    setDocuments([]);
    setActiveDocumentId('');
    history.reset([]);
    setRevision(0);
    setSelectedIds([]);
    setKeywords([]);
    setInspectorOpen(false);
  };

  const retry = (id: string) => void retryOcr(id)
    .then(() => setDocuments((current) => current.map((item) => item.id === id ? { ...item, ocrStatus: 'PENDING', ocrError: null } : item)))
    .catch((error) => setNotice(errorMessage(error)));

  const discardDocuments = async (ids: string[]) => {
    if (!ids.length || stopping) return;
    setStopping(true);
    try {
      const removed = new Set(await cancelDocuments(ids));
      if (!removed.size) return;
      const remaining = documents.filter((item) => !removed.has(item.id));
      setDocuments(remaining);
      if (removed.has(activeDocumentId)) {
        const next = remaining.find((item) => item.ocrStatus === 'COMPLETE') ?? remaining[0];
        setActiveDocumentId(next?.id ?? '');
        history.reset(next?.highlights ?? []);
        setRevision(0);
      }
      setSelectedIds([]);
      // Dropping the last document also empties local storage through the
      // effect that mirrors `documents`, so the upload screen comes back clean.
      if (!remaining.length) {
        setKeywords([]);
            setInspectorOpen(false);
      }
      setNotice(`Stopped and discarded ${removed.size} file${removed.size === 1 ? '' : 's'}.`);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setStopping(false);
    }
  };

  const reprocessActiveDocument = async () => {
    if (!document) return;
    setReprocessing(true);
    try {
      await retryOcr(document.id, 'FORCE_OCR');
      const manualHighlights = history.highlights.filter((highlight) => highlight.source === 'MANUAL');
      setDocuments((current) => current.map((item) => item.id === document.id
        ? { ...item, ocrStatus: 'PENDING', ocrMode: 'FORCE_OCR', ocrError: null, pages: [], highlights: manualHighlights }
        : item));
      history.reset(manualHighlights);
      setNotice('Re-running OCR with the high-accuracy layout mode. Search again when it finishes.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setReprocessing(false);
    }
  };

  if (restoring) return <div className="processing-screen"><LoaderCircle className="status-icon spin" size={38} /><p>Opening your workspace…</p></div>;
  if (!documents.length) return <UploadScreen onUploaded={(created) => { setDocuments(created); setActiveDocumentId(created[0]?.id ?? ''); history.reset([]); }} />;
  if (hasProcessing || !readyDocuments.length) {
    return <ProcessingScreen
      documents={documents}
      stopping={stopping}
      onRetry={retry}
      onDiscard={(ids) => void discardDocuments(ids)}
      onUploaded={(created) => {
        setDocuments((current) => [...current, ...created]);
        setActiveDocumentId((current) => current || created[0]?.id || '');
      }}
    />;
  }
  if (!document) return null;

  return (
    <div className={`app-shell batch-workspace ${inspectorOpen ? 'inspector-open' : ''}`}>
      <header className="topbar">
        <div className="brand-block"><div className="brand-mark small"><Highlighter size={17} /></div><span className="brand-name">Markwise</span></div>
        <div className="document-title"><button className="icon-button" onClick={closeWorkspace} title="Close workspace"><ArrowLeft size={19} /></button><span>{document.originalName}</span><small>{readyDocuments.length} documents · {totalPages} pages</small></div>
        <div className="top-actions">
          <span className={`save-state ${saving}`}><Check size={14} /> {saving === 'saving' ? 'Saving…' : saving === 'error' ? 'Not saved' : 'Saved'}</span>
          <button className="icon-button" disabled={!history.canUndo} onClick={() => { history.undo(); setRevision((value) => value + 1); }} title="Undo"><Undo2 size={19} /></button>
          <button className="icon-button" disabled={!history.canRedo} onClick={() => { history.redo(); setRevision((value) => value + 1); }} title="Redo"><Redo2 size={19} /></button>
          <button className={`icon-button inspector-toggle ${inspectorOpen ? 'active' : ''}`} onClick={() => setInspectorOpen((value) => !value)} title="Inspector"><SlidersHorizontal size={18} /></button>
          <button className="export-button" onClick={() => void publish()} disabled={exporting !== null || !foundMentionsCount} title="Create a highlighted image per keyword and record the results">
            <Upload size={17} /> {exporting === 'publish' ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </header>

      {publishReport && <div className="publish-overlay" role="dialog" aria-label="Publish result">
        <div className="publish-card">
          <header>
            <h2>Published</h2>
            <button className="icon-button" onClick={() => setPublishReport(null)} title="Close"><X size={18} /></button>
          </header>
          <p className="publish-summary">
            <b>{publishReport.images}</b> image{publishReport.images === 1 ? '' : 's'} created,
            {' '}<b>{publishReport.rows}</b> media result{publishReport.rows === 1 ? '' : 's'} recorded
            {' '}across <b>{publishReport.documents.length}</b> PDF{publishReport.documents.length === 1 ? '' : 's'}.
          </p>

          {publishReport.documents.map((item) => <section className="publish-document" key={item.documentId}>
            <h3>
              <span>{item.originalName}</span>
              <small>{item.author} · {item.date}{!item.dateFromFileName && <em> — date not in the file name</em>}</small>
            </h3>
            <ul className="publish-list">
              {item.published.map((row) => <li key={row.url}>
                <span className="publish-keyword">{row.keyword}</span>
                <span className="publish-page">page {row.pageNumber}</span>
                <span className="publish-projects">{row.projectIds.length} project{row.projectIds.length === 1 ? '' : 's'}</span>
                <a href={row.url} target="_blank" rel="noreferrer">image</a>
              </li>)}
            </ul>
            {item.skipped.length > 0 && <p className="publish-note">
              {item.skipped.length} mention{item.skipped.length === 1 ? '' : 's'} not published — {item.skipped[0]!.reason}
            </p>}
          </section>)}

          {publishReport.skippedDocuments.length > 0 && <div className="publish-skipped">
            <b>Nothing published from {publishReport.skippedDocuments.length} PDF{publishReport.skippedDocuments.length === 1 ? '' : 's'}</b>
            <ul>{publishReport.skippedDocuments.map((item) => <li key={item.documentId}>
              {item.originalName} — {item.reason}
            </li>)}</ul>
          </div>}
        </div>
      </div>}

      <aside className="left-panel">
        <div className="panel-section search-section">
          <label htmlFor="keyword-filter">
            <span>Keywords</span>
            {availableKeywords.length > 0 && <span className="label-count">{keywords.length} of {availableKeywords.length}</span>}
          </label>

          <div className="keyword-search">
            <Search size={15} aria-hidden />
            <input
              id="keyword-filter"
              type="text"
              value={keywordFilter}
              onChange={(event) => setKeywordFilter(event.target.value)}
              placeholder={loadingKeywords ? 'Loading keywords…' : 'Filter keywords'}
              disabled={loadingKeywords || (!availableKeywords.length && !keywordError)}
              autoComplete="off"
              spellCheck={false}
            />
            {keywordFilter && <button type="button" className="keyword-search-clear" onClick={() => setKeywordFilter('')} aria-label="Clear filter" title="Clear filter"><X size={14} /></button>}
          </div>

          {loadingKeywords && <div className="keyword-status"><LoaderCircle className="spin" size={14} /> Loading keywords…</div>}
          {keywordError && <div className="keyword-status error"><OctagonX size={14} /> {keywordError}</div>}

          {!loadingKeywords && !keywordError && availableKeywords.length > 0 && <div className="keyword-available" aria-label="Available keywords">
            {filteredKeywords.map((keyword) => <button
              type="button"
              key={keyword.id}
              className={`keyword-chip ${keyword.projectIds.length ? '' : 'orphan'}`}
              onClick={() => toggleKeyword(keyword.text)}
              title={keyword.projectIds.length
                ? `Add “${keyword.text}” · ${keyword.projectIds.length} project${keyword.projectIds.length === 1 ? '' : 's'}`
                : `Add “${keyword.text}” · no project, so nothing will be published for it`}
            >
              <Plus size={12} aria-hidden /><span>{keyword.text}</span>
            </button>)}
            {!filteredKeywords.length && <p className="keyword-empty">{keywordFilter.trim() ? `Nothing matches “${keywordFilter.trim()}”.` : 'Every keyword is already selected.'}</p>}
          </div>}

          {keywords.length > 0 && <div className="keyword-list" aria-label="Selected keywords">
            <div className="keyword-list-header"><span>Selected ({keywords.length})</span><button type="button" onClick={() => setKeywords([])}>Clear all</button></div>
            <ul>{keywords.map((keyword) => <li key={keyword}><span>{keyword}</span><button type="button" onClick={() => setKeywords((current) => current.filter((item) => item !== keyword))} aria-label={`Remove ${keyword}`} title={`Remove ${keyword}`}><X size={16} /></button></li>)}</ul>
          </div>}
          <div className="keyword-actions"><button className="find-button" onClick={() => void runSearch()} disabled={searching || !keywords.length}>{searching ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}{searching ? ' Searching…' : ` Search ${keywords.length} keyword${keywords.length === 1 ? '' : 's'}`}</button></div>
        </div>
        <div className="panel-section tool-section"><button className={`tool-button ${manualMode ? 'active' : ''}`} onClick={() => setManualMode((value) => !value)}><MousePointer2 size={20} /><span><b>Draw highlight</b><small>Current PDF</small></span><kbd>H</kbd></button></div>
        <div className="results-heading"><span>Mentions</span><b>{allHighlightsCount}</b><button className={`selection-mode-button ${selectionMode ? 'active' : ''}`} onClick={() => { setSelectionMode((value) => !value); setSelectedIds([]); setManualMode(false); }}><ListChecks size={15} /> {selectionMode ? 'Done' : 'Select'}</button></div>
        {selectionMode && <div className="bulk-toolbar">
          <span>{selectedIds.length ? `${selectedIds.length} selected` : `${allHighlightIds.length} across ${documents.length} PDF${documents.length === 1 ? '' : 's'}`}</span>
          <button onClick={toggleSelectAll} disabled={!allHighlightIds.length}>{allSelected ? 'Deselect all' : 'Select all'}</button>
          <button className="bulk-delete" onClick={removeSelectedHighlights} disabled={!selectedIds.length}><Trash2 size={13} /> Delete</button>
        </div>}
        <div className="results-list batch-results-list">
          {!allHighlightsCount && <div className="empty-results"><Search size={28} /><p>No mentions yet</p><small>Pick keywords and search the documents.</small></div>}
          {groupedHighlights.map((group, index) => {
            const firstForDocument = index === 0 || groupedHighlights[index - 1]!.document.id !== group.document.id;
            const documentCollapsed = collapsedDocuments.has(group.document.id);
            const pageKey = `${group.document.id}:${group.page}`;
            const pageCollapsed = collapsedPages.has(pageKey);
            const selectedHere = group.highlights.filter((highlight) => selectedIds.includes(highlight.id)).length;
            return <div className="result-group" key={pageKey}>
              {firstForDocument && <div className={`document-group-title ${documentCollapsed ? 'collapsed' : ''}`}>
                <button
                  className="group-collapse"
                  onClick={() => toggleDocumentCollapsed(group.document.id)}
                  aria-expanded={!documentCollapsed}
                  aria-label={documentCollapsed ? `Expand ${group.document.originalName}` : `Collapse ${group.document.originalName}`}
                  title={documentCollapsed ? 'Expand this PDF' : 'Collapse this PDF'}
                ><ChevronDown size={15} /></button>
                <button className="group-label" onClick={() => switchDocument(group.document.id)} title={group.document.originalName}>
                  <FileSearch size={15} /><span>{group.document.originalName}</span>
                </button>
                <b>{group.document.highlights.length}</b>
              </div>}

              {!documentCollapsed && <div className={`page-group-title ${pageCollapsed ? 'collapsed' : ''}`}>
                <button
                  className="group-collapse"
                  onClick={() => togglePageCollapsed(pageKey)}
                  aria-expanded={!pageCollapsed}
                  aria-label={pageCollapsed ? `Expand page ${group.page}` : `Collapse page ${group.page}`}
                  title={pageCollapsed ? 'Expand this page' : 'Collapse this page'}
                ><ChevronDown size={15} /></button>
                <button className="group-label" onClick={() => { switchDocument(group.document.id); window.setTimeout(() => window.document.getElementById(`page-${group.page}`)?.scrollIntoView({ behavior: 'smooth' }), 180); }}>
                  <span>Page {group.page}</span>
                </button>
                <b>{selectionMode && selectedHere ? `${selectedHere}/${group.highlights.length}` : group.highlights.length}</b>
              </div>}

              {!documentCollapsed && !pageCollapsed && group.highlights.map((highlight) => <button key={highlight.id} className={`result-row ${selectedIds.includes(highlight.id) ? 'selected' : ''}`} onClick={(event) => focusHighlight(group.document.id, highlight.id, selectionMode || event.metaKey || event.ctrlKey)}>
                {selectionMode && <span className={`selection-check ${selectedIds.includes(highlight.id) ? 'checked' : ''}`}><Check size={12} /></span>}<i style={{ backgroundColor: highlight.color }} /><span><b>{highlight.keyword ?? highlight.note ?? 'Manual highlight'}</b><small>{group.document.originalName} · page {highlight.pageNumber}</small></span>{!selectionMode && <Trash2 size={15} onClick={(event) => { event.stopPropagation(); removeHighlight(group.document.id, highlight.id); }} />}
              </button>)}
            </div>;
          })}
        </div>
      </aside>

      <main className={`viewer-area ${searching ? 'is-searching' : ''}`} onClick={() => setSelectedIds([])} aria-busy={searching}>
        <div className="viewer-toolbar"><button className={`mode-pill ${!manualMode ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); setManualMode(false); }}><MousePointer2 size={16} /> Select</button><button className={`mode-pill ${manualMode ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); setManualMode(true); }}><Highlighter size={16} /> Highlight</button><span className="toolbar-rule" /><button className="zoom-button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}><Minus size={17} /></button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button className="zoom-button" onClick={() => setZoom((value) => Math.min(1.7, value + 0.1))}><Plus size={17} /></button></div>
        <PdfViewer url={fileUrl(document.id)} highlights={history.highlights} selectedIds={selectedIds} selectionMode={selectionMode} manualMode={manualMode} zoom={zoom} onSelect={(id) => id && focusHighlight(document.id, id, selectionMode)} onAdd={(highlight) => { commit((current) => [...current, highlight]); setSelectedIds([highlight.id]); setManualMode(false); setInspectorOpen(true); }} onUpdate={updateHighlight} />
        {searching && <div className="search-overlay" role="status"><LoaderCircle className="spin" size={28} /><b>Searching {readyDocuments.length} documents</b><span>Finding every matching mention…</span></div>}
      </main>

      <aside className="right-panel" aria-label="Highlight inspector">
        <div className="inspector-header"><span>{hasMultipleSelection ? `${selectedHighlights.length} selected` : 'Highlight'}</span>{selected && <button className="icon-button" onClick={() => { setSelectedIds([]); setInspectorOpen(false); }}><X size={17} /></button>}</div>
        {selected ? hasMultipleSelection ? <div className="inspector-content">
          <div className="selection-preview multi-selection-preview"><i style={{ background: 'linear-gradient(135deg, #FACC15 0 33%, #60A5FA 33% 66%, #4ADE80 66%)' }} /><span><b>{selectedHighlights.length} highlights</b><small>Changes apply to all selected marks.</small></span></div>
          <label>Color</label><div className="color-row">{['#FACC15', '#FB7185', '#60A5FA', '#4ADE80', '#C084FC'].map((color) => <button key={color} className={selectedHighlights.every((highlight) => highlight.color === color) ? 'active' : ''} style={{ backgroundColor: color }} onClick={() => updateSelectedHighlights({ color })} aria-label={`Use ${color}`} />)}<input type="color" value={selected.color} onChange={(event) => updateSelectedHighlights({ color: event.target.value.toUpperCase() })} /></div>
          <label htmlFor="bulk-opacity">Opacity <span>{Math.round(selected.opacity * 100)}%</span></label><input id="bulk-opacity" className="range" type="range" min="0.1" max="0.8" step="0.05" value={selected.opacity} onChange={(event) => updateSelectedHighlights({ opacity: Number(event.target.value) })} />
          <label htmlFor="bulk-note">Note</label><textarea id="bulk-note" className="note-input" placeholder="Optional note" value={bulkNote} onChange={(event) => setBulkNote(event.target.value)} /><button className="apply-note-button" onClick={() => updateSelectedHighlights({ note: bulkNote })}>Apply note</button><button className="delete-button" onClick={removeSelectedHighlights}><Trash2 size={16} /> Remove {selectedHighlights.length}</button>
        </div> : <div className="inspector-content">
          <div className="selection-preview"><i style={{ backgroundColor: selected.color, opacity: selected.opacity }} /><span><b>{selected.source === 'AUTO' ? selected.keyword : 'Manual highlight'}</b><small>Page {selected.pageNumber}</small></span></div>
          <label>Color</label><div className="color-row">{['#FACC15', '#FB7185', '#60A5FA', '#4ADE80', '#C084FC'].map((color) => <button key={color} className={selected.color === color ? 'active' : ''} style={{ backgroundColor: color }} onClick={() => updateHighlight(selected.id, { color })} aria-label={`Use ${color}`} />)}<input type="color" value={selected.color} onChange={(event) => updateHighlight(selected.id, { color: event.target.value.toUpperCase() })} /></div>
          <label htmlFor="opacity">Opacity <span>{Math.round(selected.opacity * 100)}%</span></label><input id="opacity" className="range" type="range" min="0.1" max="0.8" step="0.05" value={selected.opacity} onChange={(event) => updateHighlight(selected.id, { opacity: Number(event.target.value) })} />
          <label htmlFor="note">Note</label><textarea id="note" className="note-input" placeholder="Optional note" value={selected.note ?? ''} onChange={(event) => updateHighlight(selected.id, { note: event.target.value })} /><button className="delete-button" onClick={() => removeHighlight(document.id, selected.id)}><Trash2 size={16} /> Remove highlight</button>
        </div> : <div className="empty-inspector"><MousePointer2 size={28} /><p>Select a highlight</p></div>}
        <div className="document-stats"><h3>Current PDF</h3><div><span>Automatic</span><b>{autoCount}</b></div><div><span>Manual</span><b>{manualCount}</b></div><div><span>Pages marked</span><b>{pagesWithHighlights} / {document.pageCount}</b></div><div><span>File size</span><b>{formatBytes(document.size)}</b></div><button className="rerun-ocr-button" onClick={() => void reprocessActiveDocument()} disabled={reprocessing}><RotateCcw size={15} /> {reprocessing ? 'Starting…' : 'Re-run OCR'}</button></div>
      </aside>
      {notice && <button className="toast" onClick={() => setNotice('')}>{notice}<X size={15} /></button>}
    </div>
  );
}
