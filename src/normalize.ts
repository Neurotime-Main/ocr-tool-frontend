/**
 * The comparison form of a word, shared by the keyword picker's filter.
 *
 * Mirrors the server's normaliser so that what the operator can find in the
 * list is what the search will actually match on the page.
 */
// Accent-tolerant on purpose: without it, typing a plain "azerbaycan" on an
// ordinary keyboard never matches the stored "Azərbaycan", because once case is
// folded the two share no character in that position at all.
export const normalizeSearchText = (value: string) => value
  .toLocaleLowerCase()
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .replace(/ı/g, 'i')
  .replace(/ə/g, 'e')
  // Uzbek writes `oʻ` and `gʻ` with a modifier letter, U+02BB, which Unicode
  // classes as a letter and so survives every other rule here -- while the
  // recogniser has no such glyph and emits a plain apostrophe or nothing.
  .replace(/\p{Lm}/gu, '')
  // Keep every Unicode dash as part of the token. `azal-` and
  // `azal-airlines` are therefore distinct from the standalone word `azal`.
  .replace(/(^[^\p{L}\p{N}\p{Pd}]+|[^\p{L}\p{N}\p{Pd}]+$)/gu, '');
