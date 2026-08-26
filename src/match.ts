import type { Highlight, OcrPage, OcrWord } from './types';

// Search is deliberately accent-tolerant because OCR commonly confuses
// Azerbaijani dotted/dotless i and drops diacritics from ş, ç, ğ, ö, and ü.
const normalize = (value: string) => value
  .toLocaleLowerCase()
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .replace(/ı/g, 'i')
  .replace(/ə/g, 'e')
  // Keep every Unicode dash as part of the token. `azal-` and
  // `azal-airlines` are therefore distinct from the standalone word `azal`.
  .replace(/(^[^\p{L}\p{N}\p{Pd}]+|[^\p{L}\p{N}\p{Pd}]+$)/gu, '');

export function groupWordsIntoLines(words: OcrWord[]) {
  const identified = new Map<string, OcrWord[]>();
  const unassigned: OcrWord[] = [];
  for (const word of words) {
    if (!word.lineId) {
      unassigned.push(word);
      continue;
    }
    const line = identified.get(word.lineId) ?? [];
    line.push(word);
    identified.set(word.lineId, line);
  }

  const lines = [...identified.values()];
  for (const word of unassigned.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const center = word.y + word.height / 2;
    const line = lines.find((candidate) => {
      const candidateCenter = candidate.reduce((sum, item) => sum + item.y + item.height / 2, 0) / candidate.length;
      return Math.abs(center - candidateCenter) <= Math.max(word.height, ...candidate.map((item) => item.height)) * 0.65;
    });
    if (line) line.push(word);
    else lines.push([word]);
  }

  return lines
    .map((line) => line.sort((a, b) => a.x - b.x))
    .sort((a, b) => {
      const aTop = Math.min(...a.map((word) => word.y));
      const bTop = Math.min(...b.map((word) => word.y));
      return aTop - bTop || a[0]!.x - b[0]!.x;
    });
}

function boundingBox(words: OcrWord[]) {
  const x = Math.min(...words.map((word) => word.x));
  const y = Math.min(...words.map((word) => word.y));
  const right = Math.max(...words.map((word) => word.x + word.width));
  const bottom = Math.max(...words.map((word) => word.y + word.height));
  return { x, y, width: right - x, height: bottom - y };
}

const isDash = (value: string) => /\p{Pd}/u.test(value);

function isHyphenatedFragment(lines: OcrWord[][], lineIndex: number, wordIndex: number) {
  const line = lines[lineIndex]!;
  const word = line[wordIndex]!;
  if (isDash(word.text.slice(0, 1)) || isDash(word.text.slice(-1))) return true;

  // OCR can drop the trailing dash from the first line while retaining it on
  // the next, e.g. `azal` followed by `-dilir`. Treat both edges as one word.
  const previous = lineIndex > 0 ? lines[lineIndex - 1]!.at(-1) : undefined;
  const next = lineIndex < lines.length - 1 ? lines[lineIndex + 1]![0] : undefined;
  if (wordIndex === 0 && previous && isDash(previous.text.slice(-1))) return true;
  if (wordIndex === line.length - 1 && next && isDash(next.text.slice(0, 1))) return true;
  return false;
}

export function parseKeywords(input: string) {
  return [...new Set(input.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
}

export function findMatches(pages: OcrPage[], keywords: string[]): Highlight[] {
  const matches: Highlight[] = [];

  for (const page of pages) {
    const lines = groupWordsIntoLines(page.words);
    for (const keyword of keywords) {
      const query = keyword.split(/\s+/).map(normalize).filter(Boolean);
      if (!query.length) continue;

      for (const [lineIndex, line] of lines.entries()) {
        const normalizedWords = line.map((word) => normalize(word.text));
        for (let index = 0; index <= normalizedWords.length - query.length; index += 1) {
          if (!query.every((token, offset) => normalizedWords[index + offset] === token)) continue;
          const occurrence = line.slice(index, index + query.length);
          if (occurrence.some((_word, offset) => isHyphenatedFragment(lines, lineIndex, index + offset))) continue;
          matches.push({
            id: crypto.randomUUID(),
            pageNumber: page.pageNumber,
            ...boundingBox(occurrence),
            color: '#FACC15',
            opacity: 0.42,
            source: 'AUTO',
            keyword,
          });
          index += query.length - 1;
        }
      }
    }
  }

  return matches;
}
