import { describe, expect, it } from 'vitest';
import { runTail, type TailEffects, type TailWork } from './tail.js';

function effects(events: string[], over: Partial<TailEffects> = {}): TailEffects {
  return {
    push: () => void events.push('push'),
    postStatus: (sha, d) => void events.push(`status ${sha} ${d}`),
    writeNote: (sha, labels) => void events.push(`note ${sha} ${JSON.stringify(labels)}`),
    prUrl: () => null,
    ...over
  };
}
const work: TailWork = {
  sha: 'h',
  signer: 'me@example.com',
  noPush: false,
  ranLabels: ['lint'],
  skippedByFlag: [],
  allowedStderr: [],
  baseFlag: null,
  context: 'chreode/signoff'
};
const quiet = () => {};

describe('runTail', () => {
  it('pushes, then posts the status, then writes the note', () => {
    const events: string[] = [];
    runTail(work, effects(events), quiet);
    expect(events).toEqual(['push', 'status h signed off by me@example.com', 'note h ["lint"]']);
  });

  it('--no-push still posts and notes', () => {
    const events: string[] = [];
    runTail({ ...work, noPush: true }, effects(events), quiet);
    expect(events).toEqual(['status h signed off by me@example.com', 'note h ["lint"]']);
  });

  it('a failed status post writes no note, so the next run is not "already signed off"', () => {
    const events: string[] = [];
    const failing = effects(events, {
      postStatus: () => {
        throw new Error('422');
      }
    });
    expect(() => runTail(work, failing, quiet)).toThrow('422');
    expect(events).toEqual(['push']);
  });

  it('names --skip’d steps in the description', () => {
    const events: string[] = [];
    runTail({ ...work, skippedByFlag: ['test:e2e'] }, effects(events), quiet);
    expect(events[1]).toBe('status h signed off by me@example.com (skipped: test:e2e)');
  });

  describe('a partial run posts and pushes but writes no note, so it never becomes a base', () => {
    it('--skip', () => {
      const events: string[] = [];
      runTail({ ...work, skippedByFlag: ['test:e2e'] }, effects(events), quiet);
      expect(events).toEqual(['push', 'status h signed off by me@example.com (skipped: test:e2e)']);
    });

    it('--base', () => {
      const events: string[] = [];
      runTail({ ...work, baseFlag: 'HEAD~1' }, effects(events), quiet);
      expect(events).toEqual(['push', 'status h signed off by me@example.com (base=HEAD~1)']);
    });

    it('--allow-stderr that actually let a step pass', () => {
      const events: string[] = [];
      runTail({ ...work, allowedStderr: ['lint'] }, effects(events), quiet);
      expect(events).toEqual([
        'push',
        'status h signed off by me@example.com (allowed stderr: lint)'
      ]);
    });

    it('says why the note was withheld', () => {
      const logs: string[] = [];
      runTail({ ...work, skippedByFlag: ['e2e'], baseFlag: 'x' }, effects([]), (m) => logs.push(m));
      expect(logs.join('\n')).toContain('not writing the signoff note');
      expect(logs.join('\n')).toContain('--skip');
      expect(logs.join('\n')).toContain('--base');
    });
  });
});
