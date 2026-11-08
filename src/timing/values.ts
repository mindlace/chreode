import type { Hunk } from './diff.js';
import { isComment, netNew, type Finding } from './rules.js';

const INT = /^\d[\d_]*$/;

function intLiteral(text: string): number | null {
  return INT.test(text) ? Number(text.replace(/_/g, '')) : null;
}

/** Integer literals (with `_` separators) and products of them; `0` means no limit. */
export function parseValue(expr: string): number | null {
  const factors = expr.split('*').map((f) => intLiteral(f.trim()));
  if (factors.some((f) => f === null)) return null;
  const product = (factors as number[]).reduce((a, b) => a * b, 1);
  return product === 0 ? Infinity : product;
}

interface Setting {
  key: string;
  value: string;
}

function cleanValue(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim();
}

function collect(text: string, patterns: [RegExp, (m: RegExpExecArray) => Setting][]): Setting[] {
  const found: { index: number; setting: Setting }[] = [];
  for (const [re, make] of patterns) {
    for (const m of text.matchAll(re)) found.push({ index: m.index, setting: make(m) });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.setting);
}

const TYPE_ONLY = /^(?:number|string|boolean|bigint|object|unknown|any|never|undefined|null)$/;
const TYPE_KEYWORD = /^(?:number|string|boolean|bigint|object|unknown|any|never)$/;

/** A TS type such as `number` or `number | undefined` (a type annotation sets nothing). Bare
 *  `undefined`/`null` are values, and `number = 5` is a defaulted parameter, so neither is. */
function isTypeExpression(value: string): boolean {
  const parts = value.split('|').map((p) => p.trim().replace(/(?:\[\])+$/, ''));
  return parts.every((p) => TYPE_ONLY.test(p)) && parts.some((p) => TYPE_KEYWORD.test(p));
}

function timeoutSettings(text: string): Setting[] {
  return collect(text, [
    [
      /\b(timeout|testTimeout|hookTimeout|actionTimeout|navigationTimeout)\s*:\s*([^,;})]*)/g,
      (m) => ({ key: m[1], value: cleanValue(m[2]) })
    ],
    [
      /\b(?:test|testInfo)\.setTimeout\(\s*([^)]*)\)/g,
      (m) => ({ key: 'setTimeout', value: cleanValue(m[1]) })
    ]
  ]);
}

function retriesSettings(text: string): Setting[] {
  return collect(text, [
    [/\b(retries|retry)\s*:\s*([^,;})]*)/g, (m) => ({ key: m[1], value: cleanValue(m[2]) })],
    [/--(retries|retry)=([^\s'"`]+)/g, (m) => ({ key: m[1], value: m[2] })]
  ]);
}

/** Pairs the i-th added setting with the i-th removed one of the same key; `shouldFlag` decides. */
function valueRule(
  hunk: Hunk,
  rule: Finding['rule'],
  extract: (text: string) => Setting[],
  shouldFlag: (added: string, removed: string | undefined) => boolean
): Finding[] {
  const removed = new Map<string, string[]>();
  for (const text of hunk.removed) {
    if (isComment(text)) continue;
    for (const s of extract(text)) {
      if (!isTypeExpression(s.value)) removed.set(s.key, [...(removed.get(s.key) ?? []), s.value]);
    }
  }
  const seen = new Map<string, number>();
  const findings: Finding[] = [];
  for (const line of hunk.added) {
    if (isComment(line.text)) continue;
    for (const s of extract(line.text)) {
      if (isTypeExpression(s.value)) continue;
      const i = seen.get(s.key) ?? 0;
      seen.set(s.key, i + 1);
      const old = removed.get(s.key)?.[i];
      if (old !== undefined && old === s.value) continue;
      if (!shouldFlag(s.value, old)) continue;
      const finding: Finding = { rule, line: line.line, text: line.text.trim() };
      if (old !== undefined) finding.was = old;
      findings.push(finding);
    }
  }
  return findings;
}

export function timeoutRaise(hunk: Hunk): Finding[] {
  const settings = valueRule(hunk, 'timeout-raise', timeoutSettings, (added, removed) => {
    if (removed === undefined) return true;
    const a = parseValue(added);
    const r = parseValue(removed);
    return a === null || r === null || a > r;
  });
  const slow = netNew(hunk, 'timeout-raise', (t) => /\btest\.slow\(/.test(t));
  return [...settings, ...slow].sort((a, b) => a.line - b.line);
}

/** Integer literals, and `false` (no retries) as 0. `true` is unlimited retries (TanStack Query),
 *  so it is not a count and gets flagged like any non-literal. */
function retryCount(text: string): number | null {
  return text === 'false' ? 0 : intLiteral(text);
}

export function retriesRaise(hunk: Hunk): Finding[] {
  return valueRule(hunk, 'retries-raise', retriesSettings, (added, removed) => {
    const a = retryCount(added);
    if (a === null) return true;
    const old = removed === undefined ? 0 : (retryCount(removed) ?? 0);
    return a > Math.max(old, 1);
  });
}
