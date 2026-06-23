export interface DominantFields {
  dominantCity: string | null;
  dominantState: string | null;
  dominantIndustry: string | null;
  dominantCategory: string | null;
}

interface DominantInput {
  rawData?: Record<string, any> | null;
  transformedData?: Record<string, any> | null;
}

function mode(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of values) {
    if (raw === null || raw === undefined) continue;
    const v = String(raw).trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function pick(rec: DominantInput, key: string): string | null {
  const t = (rec.transformedData ?? {})[key];
  if (t !== undefined && t !== null && String(t).trim() !== '') {
    return String(t);
  }
  const r = (rec.rawData ?? {})[key];
  if (r !== undefined && r !== null && String(r).trim() !== '') {
    return String(r);
  }
  return null;
}

function pickCategory(rec: DominantInput): string | null {
  const t = (rec.transformedData ?? {}) as Record<string, any>;
  const r = (rec.rawData ?? {}) as Record<string, any>;
  const first = (v: any): string | null => {
    if (Array.isArray(v) && v.length > 0) {
      const s = String(v[0] ?? '').trim();
      return s || null;
    }
    if (typeof v === 'string' && v.trim()) return v;
    return null;
  };
  return (
    first(t.categories) ??
    first(t.rawCategories) ??
    first(r.categories) ??
    first(r.rawCategories)
  );
}

function pickIndustry(rec: DominantInput): string | null {
  const t = (rec.transformedData ?? {}) as Record<string, any>;
  const r = (rec.rawData ?? {}) as Record<string, any>;
  const tryVal = (v: any): string | null => {
    if (typeof v === 'string' && v.trim()) return v;
    return null;
  };
  return (
    tryVal(t.industry) ??
    tryVal(t.rawIndustry) ??
    tryVal(r.industry) ??
    tryVal(r.rawIndustry)
  );
}

export function computeDominant(records: DominantInput[]): DominantFields {
  return {
    dominantCity: mode(records.map((r) => pick(r, 'city'))),
    dominantState: mode(records.map((r) => pick(r, 'state'))),
    dominantIndustry: mode(records.map((r) => pickIndustry(r))),
    dominantCategory: mode(records.map((r) => pickCategory(r))),
  };
}
