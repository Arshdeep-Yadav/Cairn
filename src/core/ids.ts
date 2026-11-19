import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789abcdefghjkmnpqrstvwxyz';

function encodeTime(time: number, length = 10): string {
  let out = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ENCODING[bytes[i]! % 32];
  return out;
}

/** Lexicographically sortable, collision-resistant id. */
export function ulid(now = Date.now()): string {
  return encodeTime(now) + encodeRandom(16);
}

export function newId(prefix?: string): string {
  const id = ulid();
  return prefix ? `${prefix}_${id}` : id;
}

export function shortId(id: string, length = 6): string {
  const bare = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  return bare.slice(-length);
}

export function slugify(input: string, max = 56): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug;
}

/** Agent / project handles: lowercase, no spaces, no path traversal. */
export function handle(input: string): string {
  const cleaned = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 160);
  return cleaned || 'unknown';
}

export function safeKey(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
}
