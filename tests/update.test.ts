import { describe, expect, it } from 'vitest';
import { installerUrl, isInstallerScript } from '../src/cli/update.js';

describe('self-update installer lookup', () => {
  it('uses the platform installer for a git ref', () => {
    expect(installerUrl('main', 'linux')).toBe('https://raw.githubusercontent.com/Arshdeep-Yadav/Cairn/main/install.sh');
    expect(installerUrl('v0.1.0', 'win32')).toBe('https://raw.githubusercontent.com/Arshdeep-Yadav/Cairn/v0.1.0/install.ps1');
    expect(installerUrl('feature/self-update', 'darwin')).toContain('/feature/self-update/install.sh');
  });

  it('refuses refs that could change the download URL', () => {
    for (const ref of ['../../evil', 'main?x=1', 'main#frag', 'main sh']) {
      expect(() => installerUrl(ref, 'linux')).toThrow('Invalid CAIRN_REF');
    }
  });

  it('rejects content that is not the Cairn installer', () => {
    expect(isInstallerScript('cairn-memory\nnpm pack')).toBe(true);
    expect(isInstallerScript('curl something | sh')).toBe(false);
  });
});
