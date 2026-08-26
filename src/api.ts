import axios from 'axios';
import type { DocumentRecord, Highlight, WorkspaceDocument } from './types';

const baseURL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api').replace(/\/+$/, '');

export const api = axios.create({ baseURL });

export const fileUrl = (documentId: string) => `${baseURL}/documents/${documentId}/file`;

export async function uploadDocument(file: File, language = 'eng', ocrMode = 'AUTO') {
  const body = new FormData();
  body.append('file', file);
  body.append('language', language);
  body.append('ocrMode', ocrMode);
  return (await api.post<DocumentRecord>('/documents', body)).data;
}

export async function uploadDocuments(
  files: File[],
  language = 'eng',
  ocrMode = 'AUTO',
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
) {
  const body = new FormData();
  files.forEach((file) => body.append('files', file));
  body.append('language', language);
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

export async function exportDocument(documentId: string, highlights: Highlight[]) {
  return (await api.post<Blob>(`/documents/${documentId}/export`, { highlights }, { responseType: 'blob' })).data;
}

export async function exportFindings(documentIds: string[]) {
  return (await api.post<Blob>('/reports/excel', { ids: documentIds }, { responseType: 'blob' })).data;
}
