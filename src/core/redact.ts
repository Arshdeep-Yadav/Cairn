const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[redacted key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted aws key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted api key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted token]'],
  [/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted jwt]'],
  [/(?<=password[=:]\s*)\S{6,}/gi, '[redacted]'],
  [/(?<=api[_-]?key[=:]\s*)\S{8,}/gi, '[redacted]'],
  [/(?<=token[=:]\s*)\S{12,}/gi, '[redacted]'],
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const base = normalized.split('/').pop() || normalized;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc' || base === '.git-credentials') return true;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  if (/(secret|credential|token)s?\.(json|ya?ml|toml|ini|txt)$/.test(base)) return true;
  return false;
}

const IGNORED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
  '.cairn',
  '.idea',
  '.vscode-test',
];

export function isIgnoredPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => IGNORED_DIRS.includes(segment))) return true;
  if (normalized.endsWith('.lock') && normalized.includes('lock')) return true;
  if (/\.(png|jpe?g|gif|webp|ico|bmp|tiff|woff2?|ttf|otf|eot|mp4|mov|avi|zip|gz|tar|7z|pdf)$/i.test(normalized)) {
    return true;
  }
  return false;
}
