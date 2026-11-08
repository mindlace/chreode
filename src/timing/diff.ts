export interface AddedLine {
  line: number;
  text: string;
}

export interface Hunk {
  removed: string[];
  added: AddedLine[];
}

export interface FileDiff {
  path: string;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const SIMPLE_ESCAPES: Record<string, number> = {
  '\\': 0x5c,
  '"': 0x22,
  t: 0x09,
  n: 0x0a
};

function unquote(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      const next = inner[i + 1];
      bytes.push(next in SIMPLE_ESCAPES ? SIMPLE_ESCAPES[next] : ch.charCodeAt(0));
      if (next in SIMPLE_ESCAPES) i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parsePath(rest: string): string | null {
  const raw = rest.endsWith('\t') ? rest.slice(0, -1) : rest;
  const path = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? unquote(raw) : raw;
  return path.startsWith('b/') ? path.slice(2) : null;
}

function stripCr(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

export function parseDiff(out: string): FileDiff[] {
  const files: FileDiff[] = [];
  let path: string | null = null;
  let hunks: Hunk[] = [];
  let removedLeft = 0;
  let addedLeft = 0;
  let nextLine = 0;

  const finishFile = (): void => {
    if (path !== null && hunks.length > 0) files.push({ path, hunks });
    path = null;
    hunks = [];
  };

  /** Opens a hunk if `raw` is a hunk header. */
  const startHunk = (raw: string): boolean => {
    const header = HUNK_HEADER.exec(raw);
    if (!header) return false;
    removedLeft = header[1] === undefined ? 1 : Number(header[1]);
    nextLine = Number(header[2]);
    addedLeft = header[3] === undefined ? 1 : Number(header[3]);
    hunks.push({ removed: [], added: [] });
    return true;
  };

  // The diff is pinned to -U0 with no merged hunks, so a hunk is exactly its declared removed
  // lines then its declared added lines. Anything else means a git setting changed the output
  // shape; dropping lines silently would pass a branch unchecked, so fail loudly instead.
  const where = (): string => `parseDiff: ${path ?? '(unknown file)'}:`;
  const pinned = 'git diff output is not in the shape chreode pinned';
  const unexpected = (raw: string): Error =>
    new Error(`${where()} unexpected line ${JSON.stringify(raw)} in a hunk (${pinned})`);
  const short = (): Error => {
    const missing = [
      removedLeft > 0 ? `${removedLeft} removed` : '',
      addedLeft > 0 ? `${addedLeft} added` : ''
    ].filter(Boolean);
    return new Error(
      `${where()} hunk ended with ${missing.join(' and ')} line(s) missing (${pinned})`
    );
  };

  const rows = out.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (raw.startsWith('\\')) continue;

    const hunk = hunks.at(-1);
    if (hunk && (removedLeft > 0 || addedLeft > 0)) {
      if (removedLeft > 0 && raw.startsWith('-')) {
        hunk.removed.push(stripCr(raw.slice(1)));
        removedLeft--;
        continue;
      }
      if (removedLeft === 0 && raw.startsWith('+')) {
        hunk.added.push({ line: nextLine++, text: stripCr(raw.slice(1)) });
        addedLeft--;
        continue;
      }
      if (/^[-+ ]/.test(raw)) throw unexpected(raw);
      throw short();
    }

    if (raw.startsWith('diff --git ')) {
      finishFile();
    } else if (hunk) {
      // After a file's first hunk only another hunk, the next file or the end may follow.
      if (!startHunk(raw) && !(raw === '' && i === rows.length - 1)) throw unexpected(raw);
    } else if (raw.startsWith('+++ ')) {
      path = parsePath(raw.slice(4));
    } else {
      startHunk(raw);
    }
  }
  if (removedLeft > 0 || addedLeft > 0) throw short();
  finishFile();
  return files;
}
