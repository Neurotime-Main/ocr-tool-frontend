import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Plus } from 'lucide-react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Highlight } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Props = {
  url: string;
  highlights: Highlight[];
  selectedIds: string[];
  selectionMode: boolean;
  manualMode: boolean;
  zoom: number;
  onSelect: (id: string | null) => void;
  onAdd: (highlight: Highlight) => void;
  onUpdate: (id: string, patch: Partial<Highlight>) => void;
};

type DragPoint = { x: number; y: number };
type TransformDraft = {
  id: string;
  start: DragPoint;
  original: Highlight;
  current: Highlight;
  resize: boolean;
};

function PageCanvas({
  page,
  pageNumber,
  zoom,
  highlights,
  selectedIds,
  selectionMode,
  manualMode,
  onSelect,
  onAdd,
  onUpdate,
}: {
  page: PDFPageProxy;
  pageNumber: number;
  zoom: number;
  highlights: Highlight[];
  selectedIds: string[];
  selectionMode: boolean;
  manualMode: boolean;
  onSelect: (id: string | null) => void;
  onAdd: (highlight: Highlight) => void;
  onUpdate: (id: string, patch: Partial<Highlight>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<DragPoint | null>(null);
  const [draft, setDraft] = useState<DragPoint | null>(null);
  const [transform, setTransform] = useState<TransformDraft | null>(null);
  const viewport = page.getViewport({ scale: 1.25 * zoom });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const render = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    return () => render.cancel();
  }, [page, viewport.width, viewport.height]);

  const pointFromEvent = (event: ReactPointerEvent) => {
    const bounds = overlayRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent) => {
    if (!manualMode || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    setStart(point);
    setDraft(point);
    onSelect(null);
  };

  const finishDrawing = (event: ReactPointerEvent) => {
    if (!start || !draft) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const x = Math.min(start.x, draft.x);
    const y = Math.min(start.y, draft.y);
    const width = Math.abs(draft.x - start.x);
    const height = Math.abs(draft.y - start.y);
    if (width > 0.005 && height > 0.005) {
      onAdd({
        id: crypto.randomUUID(), pageNumber, x, y, width, height,
        color: '#60A5FA', opacity: 0.35, source: 'MANUAL', note: '',
      });
    }
    setStart(null);
    setDraft(null);
  };

  const draftBox = start && draft ? {
    x: Math.min(start.x, draft.x),
    y: Math.min(start.y, draft.y),
    width: Math.abs(draft.x - start.x),
    height: Math.abs(draft.y - start.y),
  } : null;

  const startTransform = (event: ReactPointerEvent<HTMLButtonElement>, highlight: Highlight) => {
    event.stopPropagation();
    if (highlight.source !== 'MANUAL' || !selectedIds.includes(highlight.id) || manualMode || selectionMode) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setTransform({
      id: highlight.id,
      start: pointFromEvent(event),
      original: highlight,
      current: highlight,
      resize: (event.target as HTMLElement).dataset.resize === 'true',
    });
  };

  const moveTransform = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!transform) return;
    const point = pointFromEvent(event);
    const dx = point.x - transform.start.x;
    const dy = point.y - transform.start.y;
    setTransform((current) => {
      if (!current) return null;
      const original = current.original;
      const changed = current.resize ? {
        width: Math.max(0.005, Math.min(1 - original.x, original.width + dx)),
        height: Math.max(0.005, Math.min(1 - original.y, original.height + dy)),
      } : {
        x: Math.max(0, Math.min(1 - original.width, original.x + dx)),
        y: Math.max(0, Math.min(1 - original.height, original.y + dy)),
      };
      return { ...current, current: { ...original, ...changed } };
    });
  };

  const finishTransform = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!transform) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onUpdate(transform.id, transform.current);
    setTransform(null);
  };

  return (
    <article className="pdf-page" id={`page-${pageNumber}`} style={{ width: viewport.width, height: viewport.height }}>
      <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
      <div
        ref={overlayRef}
        className={`highlight-layer ${manualMode ? 'is-drawing' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={(event) => start && setDraft(pointFromEvent(event))}
        onPointerUp={finishDrawing}
        onPointerCancel={() => { setStart(null); setDraft(null); }}
      >
        {highlights.map((highlight) => {
          const displayed = transform?.id === highlight.id ? transform.current : highlight;
          const isSelected = selectedIds.includes(highlight.id);
          return (
          <button
            type="button"
            key={highlight.id}
            className={`highlight-box ${highlight.source.toLowerCase()} ${isSelected ? 'selected' : ''}`}
            data-highlight-id={highlight.id}
            style={{
              left: `${displayed.x * 100}%`, top: `${displayed.y * 100}%`,
              width: `${displayed.width * 100}%`, height: `${displayed.height * 100}%`,
              backgroundColor: displayed.color, opacity: isSelected ? Math.min(1, displayed.opacity + 0.22) : displayed.opacity,
            }}
            onPointerDown={(event) => startTransform(event, highlight)}
            onPointerMove={moveTransform}
            onPointerUp={finishTransform}
            onClick={(event) => { event.stopPropagation(); onSelect(highlight.id); }}
            aria-label={`${highlight.source === 'AUTO' ? highlight.keyword : 'Manual'} highlight`}
          >
            {highlight.source === 'MANUAL' && isSelected && !manualMode && !selectionMode && <span className="resize-handle" data-resize="true" />}
          </button>
        )})}
        {draftBox && <div className="highlight-box draft" style={{
          left: `${draftBox.x * 100}%`, top: `${draftBox.y * 100}%`,
          width: `${draftBox.width * 100}%`, height: `${draftBox.height * 100}%`,
        }} />}
      </div>
      <span className="page-number">{pageNumber}</span>
    </article>
  );
}

export function PdfViewer(props: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const task = pdfjs.getDocument({ url: props.url });
    task.promise.then(async (document) => {
      if (!active) return;
      setPdf(document);
      setPages(await Promise.all(Array.from({ length: document.numPages }, (_, index) => document.getPage(index + 1))));
    }).catch((reason: Error) => active && setError(reason.message));
    return () => { active = false; void task.destroy(); };
  }, [props.url]);

  if (error) return <div className="viewer-message error-box">Could not render this PDF: {error}</div>;
  if (!pdf || !pages.length) return <div className="viewer-message"><span className="spinner" /> Loading document…</div>;

  return (
    <section className="pdf-stack" aria-label="PDF document">
      {props.manualMode && <div className="drawing-tip"><Plus size={14} /> Drag anywhere on a page to add a highlight</div>}
      {pages.map((page, index) => (
        <PageCanvas
          key={index + 1}
          page={page}
          pageNumber={index + 1}
          zoom={props.zoom}
          highlights={props.highlights.filter((highlight) => highlight.pageNumber === index + 1)}
          selectedIds={props.selectedIds}
          selectionMode={props.selectionMode}
          manualMode={props.manualMode}
          onSelect={props.onSelect}
          onAdd={props.onAdd}
          onUpdate={props.onUpdate}
        />
      ))}
    </section>
  );
}
