/**
 * Matching a spoken employee name (as transcribed/transliterated by Gemini) against workspace members.
 * Spellings of Indian names vary between transcriptions ("Shreyas" / "Sreyas"), so after exact checks
 * a similarity score is used. When the result is not a single confident match, callers ask the owner.
 */

export interface MemberName {
  id: string;
  firstName: string;
  lastName: string;
}

export type NameMatch<T extends MemberName> =
  | { kind: 'match'; member: T }
  | { kind: 'ambiguous'; candidates: T[] }
  | { kind: 'none'; suggestions: T[] };

// Honorifics and Malayalam/Hindi kinship suffixes that are often spoken with a name
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'madam', 'maam', 'mam',
  'chettan', 'chetta', 'chechi', 'etta', 'ettan', 'ikka', 'itha', 'bhai', 'ji', 'anna', 'akka', 'bro',
]);

export const normalizeName = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !HONORIFICS.has(token))
    .join(' ');

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
};

/** Folds common transliteration variants so "Aakash"/"Akash" and "Shreyas"/"Sreyas" compare equal. */
const phoneticKey = (value: string): string =>
  value
    .replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u')
    .replace(/([sktdbpgc])h/g, '$1')
    .replace(/w/g, 'v').replace(/z/g, 's').replace(/y$/g, 'i')
    .replace(/(.)\1+/g, '$1');

const similarity = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const raw = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  const folded = ka === kb ? 0.95 : 1 - levenshtein(ka, kb) / Math.max(ka.length, kb.length);
  return Math.max(raw, folded);
};

const CONFIDENT = 0.85; // single fuzzy match at or above this is accepted
const CANDIDATE = 0.7; // shown as "did you mean"
const MAX_CHOICES = 5;

export function matchMemberName<T extends MemberName>(spoken: string, members: T[]): NameMatch<T> {
  const query = normalizeName(spoken);
  if (!query) return { kind: 'none', suggestions: [] };
  const [queryFirst, querySecond] = query.split(' ');

  const people = members.map((member) => {
    const first = normalizeName(member.firstName);
    const last = normalizeName(member.lastName);
    return { member, first, last, full: [first, last].filter(Boolean).join(' ') };
  });

  // 1. Exact full name
  const fullMatches = people.filter((p) => p.full === query);
  if (fullMatches.length === 1) return { kind: 'match', member: fullMatches[0].member };
  if (fullMatches.length > 1) return { kind: 'ambiguous', candidates: fullMatches.map((p) => p.member) };

  // 2. Exact first name, optionally narrowed by a spoken last name or initial ("Shreyas K")
  const firstMatches = people.filter(
    (p) => p.first === queryFirst && (!querySecond || p.last.startsWith(querySecond)),
  );
  if (firstMatches.length === 1) return { kind: 'match', member: firstMatches[0].member };
  if (firstMatches.length > 1) {
    return { kind: 'ambiguous', candidates: firstMatches.slice(0, MAX_CHOICES).map((p) => p.member) };
  }

  // 3. Fuzzy: best of full-name and first-name similarity
  const scored = people
    .map((p) => ({
      member: p.member,
      score: Math.max(similarity(query, p.full), similarity(queryFirst, p.first), similarity(query, p.first)),
    }))
    .sort((a, b) => b.score - a.score);

  const candidates = scored.filter((s) => s.score >= CANDIDATE);
  const [best, second] = candidates;
  if (best && best.score >= CONFIDENT && (!second || best.score - second.score >= 0.1)) {
    return { kind: 'match', member: best.member };
  }
  if (candidates.length > 0) {
    return { kind: 'ambiguous', candidates: candidates.slice(0, MAX_CHOICES).map((c) => c.member) };
  }
  return {
    kind: 'none',
    suggestions: scored.filter((s) => s.score >= 0.5).slice(0, 3).map((s) => s.member),
  };
}
