export type OcrStatus = 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
export type HighlightSource = 'AUTO' | 'MANUAL';

export type OcrWord = {
  id: string;
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  blockId?: string;
  lineId?: string;
};

export type OcrPage = {
  id: string;
  pageNumber: number;
  width: number;
  height: number;
  source: string;
  text: string;
  words: OcrWord[];
};

export type Highlight = {
  id: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  source: HighlightSource;
  keyword?: string | null;
  note?: string | null;
};

export type DocumentRecord = {
  id: string;
  originalName: string;
  size: number;
  pageCount?: number | null;
  ocrStatus: OcrStatus;
  ocrLanguage: string;
  ocrMode: string;
  ocrError?: string | null;
  ocrProgress?: { currentPage: number; totalPages: number; queuePosition?: number } | null;
  createdAt: string;
  pages: OcrPage[];
  highlights: Highlight[];
};

export type DocumentSummary = Omit<DocumentRecord, 'pages' | 'highlights'>;

export type WorkspaceDocument = DocumentSummary & {
  highlights: Highlight[];
};

export type Finding = {
  fileName: string;
  pageNumber: number;
  title: string;
  keyword: string;
  matchedText: string;
  context: string;
  source: HighlightSource;
  note: string;
  confidence: number | null;
};

/** A keyword offered by the platform, with the projects it belongs to. */
export type ServerKeyword = {
  id: number;
  text: string;
  projectIds: number[];
};

export type PublishedRow = {
  keyword: string;
  pageNumber: number;
  projectIds: number[];
  url: string;
  resultIds: number[];
};

/** What publishing one document wrote, including what it deliberately skipped. */
export type PublishReport = {
  documentId: string;
  author: string;
  date: string;
  dateFromFileName: boolean;
  images: number;
  rows: number;
  published: PublishedRow[];
  skipped: Array<{ keyword: string; pageNumber: number; reason: string }>;
};

/** The whole batch: every document published in one action. */
export type BatchPublishReport = {
  documents: Array<PublishReport & { originalName: string }>;
  skippedDocuments: Array<{ documentId: string; originalName: string; reason: string }>;
  images: number;
  rows: number;
};
