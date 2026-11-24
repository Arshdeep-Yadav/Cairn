import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Self-update runs the installer shipped with this package, never a remote script. */
export function installerPath(platform: NodeJS.Platform): string {
  const script = platform === 'win32' ? 'install.ps1' : 'install.sh';
  const file = path.join(PACKAGE_ROOT, script);
  if (!fs.existsSync(file)) throw new Error(`Cairn is missing ${script}. Reinstall cairn-memory.`);
  return file;
}

export function runInstaller(file: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      stdio: 'inherit',
      windowsHide: true,
    });
  } else {
    execFileSync('sh', [file], { stdio: 'inherit' });
  }
}
