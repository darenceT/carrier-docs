import { createInterface } from 'node:readline';

/**
 * Asks a question in the terminal and returns the answer. With `hidden` (the default) the typed
 * characters are not shown.
 *
 * The question is printed on its own line, ending in a newline, BEFORE readline starts: readline
 * clears the current line when it begins, which would erase a question printed on that line and
 * leave the script looking stalled.
 */
export function ask(question: string, hidden = true): Promise<string> {
  process.stdout.write(
    `\n>>> ${question}\n${hidden ? '    (typing is hidden: type or paste it, then press Enter)\n' : ''}`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const internals = rl as unknown as { _writeToOutput: (s: string) => void };
  let muted = false;
  internals._writeToOutput = (s: string) => {
    if (!muted) process.stdout.write(s);
  };
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      muted = false;
      rl.close();
      // No length either: this output may be pasted into a shared transcript.
      process.stdout.write(answer.trim() ? '    received\n' : '    (empty)\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}
