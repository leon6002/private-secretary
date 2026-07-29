// Deterministic Gmail category filter. Keeps ONLY Primary-tab mail; filters
// anything Gmail classified into a non-primary tab (Promotions, Updates,
// Social, Forums) BEFORE it reaches the trigger filter / intent analysis.
// Uses Gmail's own label classification only — never content/subject guessing.
//
// "Keep Primary" is implemented as "filter the four non-primary CATEGORY_*
// labels", NOT "require CATEGORY_PERSONAL": Gmail does not reliably stamp
// CATEGORY_PERSONAL on Primary mail, so requiring it would mis-filter real
// person-to-person email — the worst failure mode. Absence of any non-primary
// category label therefore means Primary, and is kept.
//
// Pure: no I/O, no Gmail SDK types, no cursor coupling. The caller extracts
// labelIds off the message and hands them in.

export const NON_PRIMARY_CATEGORIES = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
] as const;

export interface PromoSignals {
  labelIds?: string[];
}

export interface PromoVerdict {
  // true = non-primary (promo/newsletter/social/forum) → exclude from ingestion.
  filtered: boolean;
  // Which signal matched, e.g. "gmail:promotions" — for the filtered-log so a
  // mis-filtered real message is traceable. Absent when kept.
  reason?: string;
}

export function classifyPromo(signals: PromoSignals): PromoVerdict {
  const labels = signals.labelIds ?? [];
  for (const cat of NON_PRIMARY_CATEGORIES) {
    if (labels.includes(cat)) {
      return { filtered: true, reason: `gmail:${cat.replace("CATEGORY_", "").toLowerCase()}` };
    }
  }
  return { filtered: false };
}
