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
