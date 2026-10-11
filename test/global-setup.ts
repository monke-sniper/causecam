import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** The e2e test runs the compiled CLI and runtime bootstrap, so build once before the suite. */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, '..');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
}
