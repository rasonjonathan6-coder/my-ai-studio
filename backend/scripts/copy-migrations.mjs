import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc compiles .ts but leaves .sql behind, and a production start runs from dist
// with no source tree to fall back on. Copying the migrations next to the
// compiled code keeps `npm start` able to apply them.
const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');
const from = path.join(backendRoot, 'src', 'db', 'migrations');
const to = path.join(backendRoot, 'dist', 'db', 'migrations');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
process.stdout.write(`migrations copied to ${path.relative(backendRoot, to)}\n`);
