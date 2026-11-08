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
  let hunk: Hunk | null = null;
  let removedLeft = 0;
  let addedLeft = 0;
  let nextLine = 0;

  const finishFile = (): void => {
    if (path !== null && hunks.length > 0) files.push({ path, hunks });
    path = null;
    hunks = [];
    hunk = null;
  };

  for (const raw of out.split('\n')) {
    if (raw.startsWith('\\')) continue;

    if (hunk && (removedLeft > 0 || addedLeft > 0)) {
      if (removedLeft > 0 && raw.startsWith('-')) {
        hunk.removed.push(stripCr(raw.slice(1)));
        removedLeft--;
        continue;
      }
      if (removedLeft === 0 && addedLeft > 0 && raw.startsWith('+')) {
        hunk.added.push({ line: nextLine++, text: stripCr(raw.slice(1)) });
        addedLeft--;
        continue;
      }
    }

    if (raw.startsWith('diff --git ')) {
      finishFile();
    } else if (raw.startsWith('+++ ')) {
      path = parsePath(raw.slice(4));
    } else {
      const header = HUNK_HEADER.exec(raw);
      if (header) {
        removedLeft = header[1] === undefined ? 1 : Number(header[1]);
        nextLine = Number(header[2]);
        addedLeft = header[3] === undefined ? 1 : Number(header[3]);
        hunk = { removed: [], added: [] };
        hunks.push(hunk);
      }
    }
  }
  finishFile();
  return files;
}
