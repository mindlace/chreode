import type { Exec } from '../../src/run/exec.js';

export type Response = string | Error | Array<string | Error>;

/** A scripted Exec. Keys are `file arg1 arg2 …`. An array response is consumed in order and
 *  its last element repeats. An unscripted command throws (callers that tolerate failure,
 *  like "no upstream", see it as a failure). */
export function fakeExec(responses: Record<string, Response>): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const queues = new Map(
    Object.entries(responses).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value]
    ])
  );
  const exec: Exec = (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    const queue = queues.get(key);
    if (!queue || queue.length === 0) throw new Error(`unexpected exec: ${key}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { exec, calls };
}
