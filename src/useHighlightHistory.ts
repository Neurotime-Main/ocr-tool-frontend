import { useCallback, useState } from 'react';
import type { Highlight } from './types';

type History = { past: Highlight[][]; present: Highlight[]; future: Highlight[][] };

export function useHighlightHistory(initial: Highlight[] = []) {
  const [history, setHistory] = useState<History>({ past: [], present: initial, future: [] });

  const reset = useCallback((highlights: Highlight[]) => {
    setHistory({ past: [], present: highlights, future: [] });
  }, []);

  const commit = useCallback((update: Highlight[] | ((current: Highlight[]) => Highlight[])) => {
    setHistory((current) => {
      const next = typeof update === 'function' ? update(current.present) : update;
      if (next === current.present) return current;
      return { past: [...current.past, current.present].slice(-50), present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => setHistory((current) => {
    const previous = current.past.at(-1);
    if (!previous) return current;
    return { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] };
  }), []);

  const redo = useCallback(() => setHistory((current) => {
    const next = current.future[0];
    if (!next) return current;
    return { past: [...current.past, current.present], present: next, future: current.future.slice(1) };
  }), []);

  return {
    highlights: history.present,
    reset,
    commit,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
