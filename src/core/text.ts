export function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label || target)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, '') + '…';
}

const SPECIAL_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'openai-codex': 'OpenAI Codex',
  codex: 'Codex',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  'google-antigravity': 'Google Antigravity',
  omnirush: 'Omnirush',
  hermes: 'Hermes Agent',
  't3-code': 'T3 Code',
  pi: 'Pi',
  'command-code': 'Command Code',
  aider: 'Aider',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  copilot: 'Copilot',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini CLI',
  human: 'You',
  git: 'Git',
};

export function humanizeHandle(input: string): string {
  if (!input) return '';
  const key = input.toLowerCase();
  if (SPECIAL_LABELS[key]) return SPECIAL_LABELS[key];
  return input
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function relativeTime(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const diff = now - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [1000, 's'],
    [60 * 1000, 'm'],
    [60 * 60 * 1000, 'h'],
    [24 * 60 * 60 * 1000, 'd'],
    [7 * 24 * 60 * 60 * 1000, 'w'],
    [30 * 24 * 60 * 60 * 1000, 'mo'],
    [365 * 24 * 60 * 60 * 1000, 'y'],
  ];
  if (abs < 45 * 1000) return future ? 'in a moment' : 'just now';
  let unit = units[0]!;
  for (const candidate of units) {
    if (abs >= candidate[0]) unit = candidate;
  }
  const value = Math.max(1, Math.round(abs / unit[0]));
  return future ? `in ${value}${unit[1]}` : `${value}${unit[1]} ago`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
