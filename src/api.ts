import axios from 'axios';
import type { BatchPublishReport, DocumentRecord, Highlight, ServerKeyword, WorkspaceDocument } from './types';

const baseURL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api').replace(/\/+$/, '');

export const api = axios.create({ baseURL });

export const fileUrl = (documentId: string) => `${baseURL}/documents/${documentId}/file`;

/**
 * Uploads a batch of documents in one request.
 *
 * The server persists them in parallel and answers once every file is stored,
 * so the browser sees a single progress bar for the whole set rather than one
 * per file. Reading and recognising them happens afterwards, in the background.
 */
export async function uploadDocuments(
  files: File[],
  languages: string[] = ['aze'],
  ocrMode = 'AUTO',
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
) {
  const body = new FormData();
  files.forEach((file) => body.append('files', file));
  body.append('language', languages.join('+'));
  body.append('ocrMode', ocrMode);
  return (await api.post<{ documents: DocumentRecord[] }>('/documents/batch', body, {
    signal,
    onUploadProgress: (event) => {
      if (event.total) onProgress?.(event.loaded, event.total);
    },
  })).data.documents;
}

/** Stops OCR for these documents and deletes them together with their files. */
export async function cancelDocuments(ids: string[]) {
  return (await api.post<{ cancelled: string[] }>('/documents/cancel', { ids })).data.cancelled;
}

export const isCancelledRequest = (error: unknown) => axios.isCancel(error);

export async function getDocument(documentId: string) {
  return (await api.get<DocumentRecord>(`/documents/${documentId}`)).data;
}

export async function getDocumentStatuses(ids: string[]) {
  return (await api.post<{ documents: WorkspaceDocument[] }>('/documents/statuses', { ids })).data.documents;
}

export async function searchDocuments(ids: string[], keywords: string[]) {
  return (await api.post<{ documents: Array<{ documentId: string; highlights: Highlight[] }> }>('/documents/search', { ids, keywords })).data.documents;
}

export async function retryOcr(documentId: string, ocrMode?: 'AUTO' | 'FORCE_OCR') {
  await api.post(`/documents/${documentId}/ocr`, ocrMode ? { ocrMode } : undefined);
}

export async function saveHighlights(documentId: string, highlights: Highlight[]) {
  return (await api.put<{ highlights: Highlight[] }>(`/documents/${documentId}/highlights`, { highlights })).data.highlights;
}

/**
 * The keywords this platform tracks for newspapers, with their projects.
 *
 * Operators pick from these rather than typing free text, so what is searched
 * for matches what the rest of the platform reports on.
 */
export async function fetchKeywords() {
  return (await api.get<{ sourceTypeId: number; keywords: ServerKeyword[] }>('/keywords')).data;
}

/**
 * Publishes the reviewed mentions for the whole batch in one request: one
 * highlighted image per keyword per page, and one media_results row per project
 * behind each image.
 */
export async function publishDocuments(documentIds: string[]) {
  return (await api.post<BatchPublishReport>('/documents/publish', { ids: documentIds })).data;
}
