import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installerPath } from '../src/cli/update.js';

describe('self-update installer lookup', () => {
  it('uses the installer bundled with the package', () => {
    for (const [platform, name] of [
      ['linux', 'install.sh'],
      ['win32', 'install.ps1'],
      ['darwin', 'install.sh'],
    ] as const) {
      const file = installerPath(platform);
      expect(path.basename(file)).toBe(name);
      expect(fs.existsSync(file)).toBe(true);
    }
  });
});
