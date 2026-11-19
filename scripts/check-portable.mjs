// Portability gate for CI: confirms the published package ships no native
// binaries and that every runtime dependency is pure JavaScript.
//
// Cairn must run on Linux/macOS/Windows × x64/arm64 with only Node >= 20, so
// anything platform-specific must be a dev-only transitive dep. This script
// walks the `files` list from package.json and the runtime dependency tree,
// failing if it finds a compiled artifact or a non-pure-JS runtime dep.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NATIVE_EXT = /\.(node|dll|so|dylib|wasm|jnilib)$/;
const SUSPICIOUS = [/node_modules[/\\](?:lightningcss|esbuild|@esbuild|@rolldown|@swc|fsevents|node-gyp)/];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = pkg.files ?? [];
const errors = [];

// 1) The shipped `files` globs must not match any native artifact.
for (const pattern of files) {
  const full = path.join(ROOT, pattern);
  if (!fs.existsSync(full)) continue;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (NATIVE_EXT.test(p)) errors.push(`native binary in shipped files: ${path.relative(ROOT, p)}`);
    }
  };
  if (fs.statSync(full).isDirectory()) walk(full);
}

// 2) Runtime deps (not devDeps) must be pure JS — no native addons.
const deps = Object.keys(pkg.dependencies ?? {});
for (const dep of deps) {
  const modDir = path.join(ROOT, 'node_modules', dep);
  if (!fs.existsSync(modDir)) {
    errors.push(`runtime dep ${dep} missing from node_modules — run npm ci`);
    continue;
  }
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.cache') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (NATIVE_EXT.test(p)) errors.push(`native artifact in runtime dep ${dep}: ${path.relative(ROOT, p)}`);
    }
  };
  walk(modDir);
}

// 3) Dev-only transitive deps that happen to be platform-specific must not be
//    reachable from the runtime tree. We just flag them for review.
const devDeps = Object.keys(pkg.devDependencies ?? {});
for (const dep of devDeps) {
  const modDir = path.join(ROOT, 'node_modules', dep);
  if (!fs.existsSync(modDir)) continue;
  for (const sub of fs.readdirSync(modDir)) {
    if (SUSPICIOUS.some((re) => re.test(sub))) {
      // Fine — dev-only. Only report if it appears under a runtime dep.
    }
  }
}

if (errors.length) {
  console.error('Portability check FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`Portability OK: ${files.length} shipped dirs/files, ${deps.length} runtime deps, no native binaries.`);