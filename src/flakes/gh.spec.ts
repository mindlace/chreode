import { describe, expect, it } from 'vitest';
import type { Exec } from '../run/exec.js';
import { ghLedgerDeps } from './gh.js';
import { OCCURRENCE_MARKER } from './ledger.js';

/** Records every call as argv; `respond` maps the gh subcommand to stdout. */
function recorder(respond: (args: readonly string[]) => string) {
  const calls: string[][] = [];
  const exec: Exec = (file, args) => {
    calls.push([file, ...args]);
    return respond(args);
  };
  return { exec, calls };
}

const CREATED = 'https://github.com/acme/widget/issues/12\n';

describe('ghLedgerDeps', () => {
  it('lists open issues by the flake label, with their urls and label names', () => {
    const { exec, calls } = recorder(() =>
      JSON.stringify([
        { number: 3, title: 't', url: 'https://gh/i/3', labels: [{ name: 'flake' }, { name: 'x' }] }
      ])
    );
    expect(ghLedgerDeps(exec).listOpenFlakeIssues()).toEqual([
      { number: 3, title: 't', url: 'https://gh/i/3', labels: ['flake', 'x'] }
    ]);
    expect(calls).toEqual([
      [
        'gh',
        'issue',
        'list',
        '--label',
        'flake',
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'number,title,labels,url'
      ]
    ]);
  });

  it('counts only the occurrence-marker comments', () => {
    const { exec, calls } = recorder(() =>
      JSON.stringify({
        comments: [
          { body: `${OCCURRENCE_MARKER}\nagain` },
          { body: 'a human' },
          { body: OCCURRENCE_MARKER }
        ]
      })
    );
    expect(ghLedgerDeps(exec).countOccurrenceComments(7)).toBe(2);
    expect(calls).toEqual([['gh', 'issue', 'view', '7', '--json', 'comments']]);
  });

  it('creates the flake label once when it is missing, then files labelled issues', () => {
    const { exec, calls } = recorder((args) =>
      args[0] === 'label' && args[1] === 'list'
        ? '[{"name":"bug"}]'
        : args[0] === 'label'
          ? ''
          : CREATED
    );
    const deps = ghLedgerDeps(exec);
    expect(deps.createIssue('t1', 'b1')).toEqual({
      number: 12,
      title: 't1',
      url: 'https://github.com/acme/widget/issues/12',
      labels: ['flake']
    });
    deps.createIssue('t2', 'b2');
    expect(calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'gh label list',
      'gh label create',
      'gh issue create',
      'gh issue create'
    ]);
    expect(calls[1]).toEqual([
      'gh',
      'label',
      'create',
      'flake',
      '--description',
      'A test that failed, then passed on retry (chreode)',
      '--color',
      'D93F0B'
    ]);
  });

  it('does not create the label when it exists', () => {
    const { exec, calls } = recorder((args) =>
      args[0] === 'label' ? '[{"name":"flake"}]' : CREATED
    );
    ghLedgerDeps(exec).createIssue('t', 'b');
    expect(calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['gh label list', 'gh issue create']);
  });

  it('passes titles and bodies as single argv elements, never through a shell', () => {
    const title = 'flake(unit): a.spec.ts › handles "quotes", `ticks` and $(rm -rf ~)';
    const body = "line one\n'single' $HOME `whoami`";
    const { exec, calls } = recorder((args) =>
      args[0] === 'label' ? '[{"name":"flake"}]' : CREATED
    );
    ghLedgerDeps(exec).createIssue(title, body);
    expect(calls[1]).toEqual([
      'gh',
      'issue',
      'create',
      '--title',
      title,
      '--body',
      body,
      '--label',
      'flake'
    ]);
  });

  it('fails loudly when gh prints no issue URL', () => {
    const { exec } = recorder((args) => (args[0] === 'label' ? '[{"name":"flake"}]' : 'oops\n'));
    expect(() => ghLedgerDeps(exec).createIssue('t', 'b')).toThrow('no issue URL');
  });

  it('comments with the body as one argument', () => {
    const { exec, calls } = recorder(() => '');
    ghLedgerDeps(exec).commentIssue(9, 'b');
    expect(calls).toEqual([['gh', 'issue', 'comment', '9', '--body', 'b']]);
  });
});
