import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Check, ChevronDown, Download, FileSearch, FileSpreadsheet, Files, Highlighter,
  ListChecks, LoaderCircle, Minus, MousePointer2, OctagonX, Plus, Redo2, RotateCcw, Search,
  SlidersHorizontal, Trash2, Undo2, UploadCloud, X,
} from 'lucide-react';
import {
  cancelDocuments, exportDocument, exportFindings, fileUrl, getDocument, getDocumentStatuses,
  isCancelledRequest, retryOcr, saveHighlights, searchDocuments as searchDocumentSet, uploadDocuments,
} from './api';
import { parseKeywords } from './match';
import { PdfViewer } from './PdfViewer';
import type { DocumentRecord, Highlight } from './types';
import { useHighlightHistory } from './useHighlightHistory';

const MAX_BATCH_FILES = 30;

const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.round(bytes / 1024)} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const errorMessage = (error: unknown) => {
  const candidate = error as { response?: { data?: { error?: string } }; message?: string };
  return candidate.response?.data?.error ?? candidate.message ?? 'Something went wrong.';
};

const mergeKeywords = (current: string[], additions: string[]) => {
  const known = new Set(current.map((keyword) => keyword.toLocaleLowerCase()));
  const merged = [...current];
  for (const keyword of additions) {
    const key = keyword.toLocaleLowerCase();
    if (!known.has(key)) {
      known.add(key);
      merged.push(keyword);
    }
  }
  return merged;
};

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function UploadScreen({ onUploaded }: { onUploaded: (documents: DocumentRecord[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [language, setLanguage] = useState('aze+eng');
  const [ocrMode, setOcrMode] = useState('AUTO');

  const upload = async (selectedFiles?: FileList | File[]) => {
    const files = Array.from(selectedFiles ?? []);
    if (!files.length) return;
    if (files.length > MAX_BATCH_FILES) {
      setError(`Choose no more than ${MAX_BATCH_FILES} PDFs.`);
      return;
    }
    if (files.some((file) => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) {
      setError('Every selected file must be a PDF.');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUploading(true);
    setUploadProgress({ loaded: 0, total: files.reduce((total, file) => total + file.size, 0) });
    setError('');
    setNotice('');
    try {
      const created = await uploadDocuments(
        files, language, ocrMode,
        (loaded, total) => setUploadProgress({ loaded, total }),
        controller.signal,
      );
      onUploaded(created.map((document) => ({ ...document, pages: [], highlights: [] })));
    } catch (reason) {
      // A cancelled upload is a deliberate action, not a failure. The server
      // discards anything it had already stored for the aborted request.
      if (isCancelledRequest(reason)) setNotice('Upload cancelled. Nothing was saved.');
      else setError(errorMessage(reason));
    } finally {
      abortRef.current = null;
      setUploading(false);
      setUploadProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <main className="welcome-shell">
      <header className="welcome-header">
        <div className="brand-mark"><Highlighter size={21} /></div>
        <span className="brand-name">Markwise</span>
      </header>
      <section className="welcome-copy">
        <span className="eyebrow"><span /> OCR document search</span>
        <h1>Search every PDF.<br /><em>Find every mention.</em></h1>
        <p>Upload one document or a complete set, search them together, review the highlights, and export the results.</p>
      </section>
      <section
        className={`upload-card ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}
      >
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => void upload(event.target.files ?? undefined)} />
        <div className="upload-icon"><UploadCloud size={31} /></div>
        <h2>{uploading ? 'Uploading PDFs…' : 'Drop PDFs here'}</h2>
        <p>{uploading && uploadProgress?.total
          ? `${Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))}% uploaded · preparing OCR jobs`
          : 'One file or up to 30 at once'}</p>
        <div className="upload-options">
          <label><span>Language</span>
            <select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={uploading}>
              <option value="aze+eng">Azərbaycanca + English</option>
              <option value="aze">Azərbaycanca</option>
              <option value="eng">English</option>
            </select>
          </label>
          <label><span>OCR mode</span>
            <select value={ocrMode} onChange={(event) => setOcrMode(event.target.value)} disabled={uploading}>
              <option value="AUTO">Automatic</option>
              <option value="FORCE_OCR">Complex layouts</option>
            </select>
          </label>
        </div>
        <div className="upload-actions">
          <button className="primary-button upload-button" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle className="spin" size={19} /> : <Files size={19} />}
            {uploading ? 'Uploading' : 'Choose PDFs'}
          </button>
          {uploading && (
            <button className="cancel-button" onClick={() => abortRef.current?.abort()}>
              <X size={18} /> Cancel upload
            </button>
          )}
        </div>
        <div className="upload-meta"><span>1–30 PDFs</span><i /> <span>50 MB each</span><i /> <span>AZ + EN</span></div>
        {error && <div className="inline-error">{error}</div>}
        {notice && !error && <div className="inline-notice">{notice}</div>}
      </section>
      <footer className="welcome-footer">Files are processed with Tesseract on your server.</footer>
    </main>
  );
}

function ProcessingScreen({ documents, stopping, onRetry, onDiscard }: {
  documents: DocumentRecord[];
  stopping: boolean;
  onRetry: (id: string) => void;
  onDiscard: (ids: string[]) => void;
}) {
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
            <span title={document.originalName}>{document.originalName}</span>
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
        <button className="stop-button" onClick={() => onDiscard(documents.map((document) => document.id))} disabled={stopping}>
          {stopping ? <LoaderCircle className="spin" size={17} /> : <OctagonX size={17} />}
          {stopping ? 'Stopping…' : 'Stop and discard all'}
        </button>
        <small>Stopping cancels the remaining pages and deletes the uploaded files from the server.</small>
      </div>
    </div>
  );
}

export function App() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const [restoring, setRestoring] = useState(true);
  const [keywordInput, setKeywordInput] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [bulkNote, setBulkNote] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [zoom, setZoom] = useState(0.9);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [searching, setSearching] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [exporting, setExporting] = useState<'pdf' | 'excel' | null>(null);
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

  const addKeywords = () => {
    const additions = parseKeywords(keywordInput);
    if (!additions.length) return;
    setKeywords((current) => mergeKeywords(current, additions));
    setKeywordInput('');
  };

  const runSearch = async () => {
    const searchKeywords = mergeKeywords(keywords, parseKeywords(keywordInput));
    if (!searchKeywords.length || !readyDocuments.length) return;
    setKeywords(searchKeywords);
    setKeywordInput('');
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
      setNotice(total ? `Found ${total} mentions across ${readyDocuments.length} PDFs.` : 'No matching words were found.');
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

  const updateSelectedHighlights = (patch: Partial<Highlight>) => {
    if (!selectedIds.length) return;
    const selectedSet = new Set(selectedIds);
    commit((current) => current.map((item) => selectedSet.has(item.id) ? { ...item, ...patch } : item));
  };

  const removeSelectedHighlights = () => {
    if (!selectedIds.length) return;
    const selectedSet = new Set(selectedIds);
    commit((current) => current.filter((item) => !selectedSet.has(item.id)));
    setSelectedIds([]);
    setSelectionMode(false);
  };

  const downloadPdf = async () => {
    if (!document) return;
    setExporting('pdf');
    try {
      downloadBlob(await exportDocument(document.id, history.highlights), `${document.originalName.replace(/\.pdf$/i, '')}-highlighted.pdf`);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const downloadExcel = async () => {
    if (!foundMentionsCount) { setNotice('Search for keywords before exporting the report.'); return; }
    setExporting('excel');
    try {
      if (document) await saveHighlights(document.id, history.highlights);
      downloadBlob(await exportFindings(readyDocuments.map((item) => item.id)), 'markwise-findings.xlsx');
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
    setKeywordInput('');
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
        setKeywordInput('');
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
    return <ProcessingScreen documents={documents} stopping={stopping} onRetry={retry} onDiscard={(ids) => void discardDocuments(ids)} />;
  }
  if (!document) return null;

  return (
    <div className={`app-shell batch-workspace ${inspectorOpen ? 'inspector-open' : ''}`}>
      <header className="topbar">
        <div className="brand-block"><div className="brand-mark small"><Highlighter size={17} /></div><span className="brand-name">Markwise</span></div>
        <div className="document-title"><button className="icon-button" onClick={closeWorkspace} title="Close workspace"><ArrowLeft size={19} /></button><span>{document.originalName}</span><small>{readyDocuments.length} PDFs · {totalPages} pages</small></div>
        <div className="top-actions">
          <span className={`save-state ${saving}`}><Check size={14} /> {saving === 'saving' ? 'Saving…' : saving === 'error' ? 'Not saved' : 'Saved'}</span>
          <button className="icon-button" disabled={!history.canUndo} onClick={() => { history.undo(); setRevision((value) => value + 1); }} title="Undo"><Undo2 size={19} /></button>
          <button className="icon-button" disabled={!history.canRedo} onClick={() => { history.redo(); setRevision((value) => value + 1); }} title="Redo"><Redo2 size={19} /></button>
          <button className={`icon-button inspector-toggle ${inspectorOpen ? 'active' : ''}`} onClick={() => setInspectorOpen((value) => !value)} title="Inspector"><SlidersHorizontal size={18} /></button>
          <button className="excel-button" onClick={() => void downloadExcel()} disabled={exporting !== null || !foundMentionsCount}><FileSpreadsheet size={17} /> {exporting === 'excel' ? 'Exporting…' : 'Excel'}</button>
          <button className="export-button" onClick={() => void downloadPdf()} disabled={exporting !== null}><Download size={17} /> {exporting === 'pdf' ? 'Exporting…' : 'PDF'}</button>
        </div>
      </header>

      <aside className="left-panel">
        <div className="panel-section search-section">
          <label htmlFor="keywords">Search all PDFs</label>
          <div className="keyword-box">
            <textarea id="keywords" value={keywordInput} onChange={(event) => setKeywordInput(event.target.value)} placeholder="Keyword or phrase" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); addKeywords(); } }} />
            <button className="keyword-add" onClick={addKeywords} disabled={!keywordInput.trim()} title="Add keywords"><Plus size={17} /><span>Add</span></button>
          </div>
          {keywords.length > 0 && <div className="keyword-list" aria-label="Keyword list">
            <div className="keyword-list-header"><span>Keywords ({keywords.length})</span><button type="button" onClick={() => setKeywords([])}>Clear all</button></div>
            <ul>{keywords.map((keyword) => <li key={keyword}><span>{keyword}</span><button type="button" onClick={() => setKeywords((current) => current.filter((item) => item !== keyword))} aria-label={`Remove ${keyword}`} title={`Remove ${keyword}`}><X size={16} /></button></li>)}</ul>
          </div>}
          <div className="keyword-actions"><button className="find-button" onClick={() => void runSearch()} disabled={searching || (!keywords.length && !keywordInput.trim())}>{searching ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}{searching ? ` Searching ${readyDocuments.length} PDFs…` : ` Search ${readyDocuments.length} PDFs`}</button></div>
        </div>
        <div className="panel-section tool-section"><button className={`tool-button ${manualMode ? 'active' : ''}`} onClick={() => setManualMode((value) => !value)}><MousePointer2 size={20} /><span><b>Draw highlight</b><small>Current PDF</small></span><kbd>H</kbd></button></div>
        <div className="results-heading"><span>Mentions</span><b>{allHighlightsCount}</b><button className={`selection-mode-button ${selectionMode ? 'active' : ''}`} onClick={() => { setSelectionMode((value) => !value); setSelectedIds([]); setManualMode(false); }}><ListChecks size={15} /> {selectionMode ? 'Done' : 'Select'}</button></div>
        {selectionMode && <div className="bulk-toolbar"><span>{selectedIds.length ? `${selectedIds.length} selected` : 'Current PDF'}</span><button onClick={() => setSelectedIds(history.highlights.map((highlight) => highlight.id))}>All</button><button onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>None</button><button className="bulk-delete" onClick={removeSelectedHighlights} disabled={!selectedIds.length}><Trash2 size={13} /> Delete</button></div>}
        <div className="results-list batch-results-list">
          {!allHighlightsCount && <div className="empty-results"><Search size={28} /><p>No mentions yet</p><small>Add keywords and search the document set.</small></div>}
          {groupedHighlights.map((group, index) => {
            const firstForDocument = index === 0 || groupedHighlights[index - 1]!.document.id !== group.document.id;
            return <div className="result-group" key={`${group.document.id}-${group.page}`}>
              {firstForDocument && <button className="document-group-title" onClick={() => switchDocument(group.document.id)}><FileSearch size={15} /><span>{group.document.originalName}</span><b>{group.document.highlights.length}</b></button>}
              <button className="page-group-title" onClick={() => { switchDocument(group.document.id); window.setTimeout(() => window.document.getElementById(`page-${group.page}`)?.scrollIntoView({ behavior: 'smooth' }), 180); }}><span>Page {group.page}</span><ChevronDown size={15} /></button>
              {group.highlights.map((highlight) => <button key={highlight.id} className={`result-row ${group.document.id === activeDocumentId && selectedIds.includes(highlight.id) ? 'selected' : ''}`} onClick={(event) => focusHighlight(group.document.id, highlight.id, selectionMode || event.metaKey || event.ctrlKey)}>
                {selectionMode && group.document.id === activeDocumentId && <span className={`selection-check ${selectedIds.includes(highlight.id) ? 'checked' : ''}`}><Check size={12} /></span>}<i style={{ backgroundColor: highlight.color }} /><span><b>{highlight.keyword ?? highlight.note ?? 'Manual highlight'}</b><small>{group.document.originalName} · page {highlight.pageNumber}</small></span>{!selectionMode && <Trash2 size={15} onClick={(event) => { event.stopPropagation(); removeHighlight(group.document.id, highlight.id); }} />}
              </button>)}
            </div>;
          })}
        </div>
      </aside>

      <main className={`viewer-area ${searching ? 'is-searching' : ''}`} onClick={() => setSelectedIds([])} aria-busy={searching}>
        <div className="viewer-toolbar"><button className={`mode-pill ${!manualMode ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); setManualMode(false); }}><MousePointer2 size={16} /> Select</button><button className={`mode-pill ${manualMode ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); setManualMode(true); }}><Highlighter size={16} /> Highlight</button><span className="toolbar-rule" /><button className="zoom-button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}><Minus size={17} /></button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button className="zoom-button" onClick={() => setZoom((value) => Math.min(1.7, value + 0.1))}><Plus size={17} /></button></div>
        <PdfViewer url={fileUrl(document.id)} highlights={history.highlights} selectedIds={selectedIds} selectionMode={selectionMode} manualMode={manualMode} zoom={zoom} onSelect={(id) => id && focusHighlight(document.id, id, selectionMode)} onAdd={(highlight) => { commit((current) => [...current, highlight]); setSelectedIds([highlight.id]); setManualMode(false); setInspectorOpen(true); }} onUpdate={updateHighlight} />
        {searching && <div className="search-overlay" role="status"><LoaderCircle className="spin" size={28} /><b>Searching {readyDocuments.length} PDFs</b><span>Finding every matching mention…</span></div>}
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
