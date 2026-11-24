import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const RAW_BASE = 'https://raw.githubusercontent.com/Arshdeep-Yadav/Cairn';

/** The ref comes from the environment, so reject anything that is not a plain git ref. */
export function installerUrl(ref: string, platform: NodeJS.Platform): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) {
    throw new Error(`Invalid CAIRN_REF: ${ref}`);
  }
  const script = platform === 'win32' ? 'install.ps1' : 'install.sh';
  return `${RAW_BASE}/${encodeURI(ref)}/${script}`;
}

/** Never execute a remote file without checking it is the installer we expect. */
export function isInstallerScript(text: string): boolean {
  return text.includes('cairn-memory') && text.includes('npm pack');
}

export async function downloadInstaller(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the Cairn installer (${response.status}).`);
  const script = await response.text();
  if (!isInstallerScript(script)) throw new Error('Downloaded installer failed its integrity check.');
  fs.writeFileSync(destination, script, { encoding: 'utf8', mode: 0o700 });
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
