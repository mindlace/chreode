import { defaultExec, lines, type Exec } from '../run/exec.js';
import { FLAKE_LABEL, OCCURRENCE_MARKER, type FlakeIssue, type FlakeLedgerDeps } from './ledger.js';

const LABEL_DESCRIPTION = 'A test that failed, then passed on retry (chreode)';
const LABEL_COLOR = 'D93F0B';

interface RawIssue {
  number: number;
  title: string;
  url: string;
  labels: { name: string }[];
}

/** The ledger's GitHub side over `gh`. Every call is argv (no shell), so test titles and
 *  error text reach GitHub verbatim. */
export function ghLedgerDeps(exec: Exec = defaultExec): FlakeLedgerDeps {
  let labelReady = false;
  const ensureLabel = () => {
    if (labelReady) return;
    const labels = JSON.parse(
      exec('gh', ['label', 'list', '--limit', '1000', '--json', 'name'])
    ) as {
      name: string;
    }[];
    if (!labels.some((l) => l.name === FLAKE_LABEL)) {
      exec('gh', [
        'label',
        'create',
        FLAKE_LABEL,
        '--description',
        LABEL_DESCRIPTION,
        '--color',
        LABEL_COLOR
      ]);
    }
    labelReady = true;
  };
  return {
    listOpenFlakeIssues(): FlakeIssue[] {
      // A label filter, not a title search: it does not depend on search-index lag.
      const raw = JSON.parse(
        exec('gh', [
          'issue',
          'list',
          '--label',
          FLAKE_LABEL,
          '--state',
          'open',
          '--limit',
          '1000',
          '--json',
          'number,title,labels,url'
        ])
      ) as RawIssue[];
      return raw.map((i) => ({
        number: i.number,
        title: i.title,
        url: i.url,
        labels: i.labels.map((l) => l.name)
      }));
    },
    countOccurrenceComments(issue: number): number {
      const raw = JSON.parse(
        exec('gh', ['issue', 'view', String(issue), '--json', 'comments'])
      ) as {
        comments: { body: string }[];
      };
      return raw.comments.filter((c) => c.body.includes(OCCURRENCE_MARKER)).length;
    },
    createIssue(title: string, body: string): FlakeIssue {
      ensureLabel();
      const out = exec('gh', [
        'issue',
        'create',
        '--title',
        title,
        '--body',
        body,
        '--label',
        FLAKE_LABEL
      ]);
      const url = lines(out).at(-1) ?? '';
      const m = /\/issues\/(\d+)$/.exec(url);
      if (!m) throw new Error(`gh issue create printed no issue URL: ${out.trim()}`);
      return { number: Number(m[1]), title, url, labels: [FLAKE_LABEL] };
    },
    commentIssue(issue: number, body: string): void {
      exec('gh', ['issue', 'comment', String(issue), '--body', body]);
    }
  };
}
