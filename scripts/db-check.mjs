// Gate: the committed migrations must match the schema.
//
// This used to be `drizzle-kit generate && git diff --exit-code drizzle/`, which
// is green in both of the cases it is supposed to catch:
//
//   - `drizzle-kit generate` exits 0 even when it throws. Renaming a table needs
//     an interactive prompt, there is no TTY in CI, so it prints a stack trace
//     and returns success. `&&` then trusts a failure.
//   - a missing migration arrives as a NEW file, and `git diff` does not report
//     untracked files. Adding a column — the ordinary way to drift — sailed
//     straight through.
//
// Both are proven by breaking them on purpose; see the plan's Task 8 Step 3.
import { spawnSync } from 'node:child_process';

function fail(message) {
  process.stderr.write(`db:check FAILED — ${message}\n`);
  process.exit(1);
}

const generate = spawnSync('pnpm', ['exec', 'drizzle-kit', 'generate'], { encoding: 'utf8' });
const output = `${generate.stdout ?? ''}${generate.stderr ?? ''}`;
process.stdout.write(output);

if (generate.status !== 0) fail(`drizzle-kit exited ${generate.status}`);
if (/^Error:/m.test(output)) fail('drizzle-kit reported an error but still exited 0');

const dirty = spawnSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', 'drizzle'],
  { encoding: 'utf8' },
).stdout.trim();

if (dirty) {
  fail(`the schema has drifted from drizzle/ — run \`pnpm db:generate\` and commit:\n${dirty}`);
}

process.stdout.write('db:check OK — migrations match the schema\n');
