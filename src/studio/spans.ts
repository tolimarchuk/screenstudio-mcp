// Time spans in milliseconds and the set operations the analyzer and planner share.

export interface Span {
  startMs: number;
  endMs: number;
}

export function overlaps(span: Span, list: Span[]) {
  return list.some((x) => x.startMs < span.endMs && x.endMs > span.startMs);
}

/** Joins spans that touch or sit within `gapMs` of each other. */
export function mergeSpans(spans: Span[], gapMs: number): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = out.at(-1);
    if (last && s.startMs - last.endMs <= gapMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
}

/** Removes every cut from every span, dropping leftover pieces shorter than `minMs`. */
export function subtractSpans(spans: Span[], cuts: Span[], minMs = 0): Span[] {
  return spans.flatMap((span) => {
    let pieces = [span];
    for (const cut of cuts)
      pieces = pieces.flatMap((p) =>
        cut.endMs <= p.startMs || cut.startMs >= p.endMs
          ? [p]
          : [
              { startMs: p.startMs, endMs: Math.max(p.startMs, cut.startMs) },
              { startMs: Math.min(p.endMs, cut.endMs), endMs: p.endMs },
            ].filter((x) => x.endMs > x.startMs && x.endMs - x.startMs >= minMs),
      );
    return pieces;
  });
}
