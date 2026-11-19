import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './vault.js';

export const SESSION_COOKIE = 'cairn_session';
export const CSRF_COOKIE = 'cairn_csrf';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

const AUTH_FILE = 'auth.json';
const SCRYPT = { n: 16384, r: 8, p: 1, keylen: 64 } as const;
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface PasswordRecord {
  algorithm: 'scrypt';
  salt: string;
  hash: string;
  n: number;
  r: number;
  p: number;
  keylen: number;
}

interface AuthState {
  version: 1;
  createdAt: string;
  updatedAt: string;
  password: PasswordRecord;
  sessionSecret: string;
  /** True while the generated first-run password is still the one printed on screen. */
  mustChangePassword?: boolean;
}

export interface AuthSession {
  sid: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthEnsureResult {
  auth: AuthManager;
  created: boolean;
  password?: string;
}

export interface AuthStatus {
  configured: boolean;
  path: string;
  updatedAt?: string;
  createdAt?: string;
  sessionTtlSeconds: number;
}

function authPath(vaultDir: string): string {
  return path.join(vaultDir, 'state', AUTH_FILE);
}

function isAuthState(value: unknown): value is AuthState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.version !== 1) return false;
  if (typeof state.sessionSecret !== 'string' || state.sessionSecret.length < 32) return false;
  const password = state.password;
  if (!password || typeof password !== 'object' || Array.isArray(password)) return false;
  const record = password as Record<string, unknown>;
  return (
    record.algorithm === 'scrypt' &&
    typeof record.salt === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.n === 'number' &&
    typeof record.r === 'number' &&
    typeof record.p === 'number' &&
    typeof record.keylen === 'number'
  );
}

function readState(vaultDir: string): AuthState | null {
  const file = authPath(vaultDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      `Cairn auth state at ${file} is not valid JSON. Restore it from a backup or delete it to generate a new password (this signs out every browser session).`,
    );
  }
  if (!isAuthState(parsed)) {
    throw new Error(
      `Cairn auth state at ${file} is not valid. Restore it from a backup or delete it to generate a new password.`,
    );
  }
  return parsed;
}

function writeState(vaultDir: string, state: AuthState): void {
  const file = authPath(vaultDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function passwordRecord(password: string): PasswordRecord {
  validatePassword(password);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.n,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return {
    algorithm: 'scrypt',
    salt: base64url(salt),
    hash: base64url(hash),
    n: SCRYPT.n,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
  };
}

function verifyRecord(password: string, record: PasswordRecord): boolean {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(record.hash, 'base64url');
    const actual = scryptSync(password, Buffer.from(record.salt, 'base64url'), record.keylen, {
      N: record.n,
      r: record.r,
      p: record.p,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The workspace password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`The workspace password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

export function generatePassword(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  return out.match(/.{1,5}/g)!.join('-');
}

function sign(secret: string, value: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AuthManager {
  readonly vaultDir: string;
  private state: AuthState;
  private lastMtimeMs: number;
  private readonly sessions = new Map<string, AuthSession>();

  private constructor(vaultDir: string, state: AuthState, mtimeMs = 0) {
    this.vaultDir = path.resolve(vaultDir);
    this.state = state;
    this.lastMtimeMs = mtimeMs;
  }

  static exists(vaultDir: string): boolean {
    return fs.existsSync(authPath(vaultDir));
  }

  /** Load an existing auth file. Never creates or overwrites state. */
  static load(vaultDir: string): AuthManager {
    const state = readState(vaultDir);
    if (!state) {
      throw new Error(`Cairn auth is not configured at ${authPath(vaultDir)}. Run \`cairn start\` first.`);
    }
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(authPath(vaultDir)).mtimeMs;
    } catch {
      // ignore
    }
    return new AuthManager(vaultDir, state, mtimeMs);
  }

  /**
   * Load the auth file, creating it on first run. When `password` is omitted a
   * strong password is generated and returned exactly once; the caller prints
   * it. An existing auth file is never overwritten here.
   */
  static ensure(vaultDir: string, options: { password?: string } = {}): AuthEnsureResult {
    const existing = readState(vaultDir);
    if (existing) {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(authPath(vaultDir)).mtimeMs;
      } catch {
        // ignore
      }
      if (options.password) {
        const auth = new AuthManager(vaultDir, existing, mtimeMs);
        if (!auth.verifyPassword(options.password)) {
          throw new Error(
            'CAIRN_PASSWORD does not match the existing workspace password. Use `cairn auth set-password` to change it.',
          );
        }
      }
      return { auth: new AuthManager(vaultDir, existing, mtimeMs), created: false };
    }
    const password = options.password || generatePassword();
    validatePassword(password);
    const now = new Date().toISOString();
    const state: AuthState = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      password: passwordRecord(password),
      sessionSecret: base64url(randomBytes(32)),
      // A generated first-run password is shown once on screen; it must be
      // replaced before the workspace is usable. A user-supplied password
      // (CAIRN_PASSWORD) is already the owner's choice and is not flagged.
      mustChangePassword: !options.password,
    };
    writeState(vaultDir, state);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(authPath(vaultDir)).mtimeMs;
    } catch {
      // ignore
    }
    return {
      auth: new AuthManager(vaultDir, state, mtimeMs),
      created: true,
      password: options.password ? undefined : password,
    };
  }

  verifyPassword(password: string): boolean {
    return verifyRecord(password, this.state.password);
  }

  createSession(): { token: string; session: AuthSession; csrfToken: string } {
    this.pruneSessions();
    const sid = base64url(randomBytes(18));
    const issuedAt = Date.now();
    const session: AuthSession = {
      sid,
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_SECONDS * 1000,
    };
    // Keep a bounded number of live sessions so a stolen cookie cannot be
    // replayed forever and abandoned sessions do not accumulate.
    if (this.sessions.size >= 20) {
      const oldest = Array.from(this.sessions.values()).sort((a, b) => a.issuedAt - b.issuedAt)[0];
      if (oldest) this.sessions.delete(oldest.sid);
    }
    this.sessions.set(sid, session);
    const payload = base64url(Buffer.from(JSON.stringify({ v: 1, sid, iat: issuedAt, exp: session.expiresAt })));
    const token = `${payload}.${sign(this.state.sessionSecret, payload)}`;
    return { token, session, csrfToken: this.csrfForSession(session) };
  }

  authenticate(token: string | undefined): AuthSession | null {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    const [payload, signature, ...rest] = token.split('.');
    if (!payload || !signature || rest.length) return null;
    if (!safeEqual(signature, sign(this.state.sessionSecret, payload))) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    } catch {
      return null;
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const record = decoded as Record<string, unknown>;
    if (record.v !== 1 || typeof record.sid !== 'string' || typeof record.exp !== 'number') return null;
    if (record.exp <= Date.now()) {
      this.sessions.delete(record.sid);
      return null;
    }
    const session = this.sessions.get(record.sid);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(record.sid);
      return null;
    }
    return session;
  }

  revoke(token: string | undefined): void {
    const session = this.authenticate(token);
    if (session) this.sessions.delete(session.sid);
  }

  csrfForSession(session: AuthSession): string {
    return sign(this.state.sessionSecret, `csrf:${session.sid}`);
  }

  verifyCsrf(session: AuthSession, token: string | undefined): boolean {
    if (!token || token.length > 512) return false;
    return safeEqual(token, this.csrfForSession(session));
  }

  setPassword(password: string): void {
    validatePassword(password);
    const now = new Date().toISOString();
    this.state = {
      version: 1,
      createdAt: this.state.createdAt,
      updatedAt: now,
      password: passwordRecord(password),
      // Rotating the secret invalidates every previously issued cookie.
      sessionSecret: base64url(randomBytes(32)),
    };
    writeState(this.vaultDir, this.state);
    try {
      this.lastMtimeMs = fs.statSync(authPath(this.vaultDir)).mtimeMs;
    } catch {
      this.lastMtimeMs = Date.now();
    }
    this.sessions.clear();
  }

  resetPassword(password = generatePassword()): string {
    this.setPassword(password);
    return password;
  }

  /**
   * Reload auth state from disk if auth.json has been modified since it was loaded.
   * Returns true if credentials or state changed, false otherwise.
   */
  reloadIfChanged(): boolean {
    const file = authPath(this.vaultDir);
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs > this.lastMtimeMs) {
        const next = readState(this.vaultDir);
        if (next) {
          const changed =
            this.state.updatedAt !== next.updatedAt ||
            this.state.password.hash !== next.password.hash ||
            this.state.sessionSecret !== next.sessionSecret ||
            Boolean(this.state.mustChangePassword) !== Boolean(next.mustChangePassword);
          this.state = next;
          this.lastMtimeMs = stat.mtimeMs;
          if (changed) {
            this.sessions.clear();
            return true;
          }
        }
      }
    } catch {
      // Keep existing state if file is temporarily unreadable
    }
    return false;
  }

  status(): AuthStatus {
    return {
      configured: true,
      path: authPath(this.vaultDir),
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
    };
  }

  /** True while the generated first-run password is still the one printed on screen. */
  mustChangePassword(): boolean {
    return Boolean(this.state.mustChangePassword);
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [sid, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sid);
    }
  }
}

/** In-memory login throttle. Separate per server process, keyed by client address. */
export class LoginLimiter {
  private readonly attempts = new Map<string, { failures: number[]; lockedUntil: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;

  constructor(options: { maxFailures?: number; windowMs?: number; lockMs?: number } = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.lockMs = options.lockMs ?? 15 * 60_000;
  }

  retryAfter(key: string): number {
    const entry = this.attempts.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.lockedUntil > now) return Math.ceil((entry.lockedUntil - now) / 1000);
    if (entry.lockedUntil > 0) this.attempts.delete(key);
    return 0;
  }

  fail(key: string): { locked: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.attempts.get(key) || { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((at) => now - at < this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.lockedUntil = now + this.lockMs;
      entry.failures = [];
    }
    this.attempts.set(key, entry);
    if (this.attempts.size > 512) {
      const oldest = this.attempts.keys().next().value;
      if (oldest) this.attempts.delete(oldest);
    }
    return {
      locked: entry.lockedUntil > now,
      retryAfter: entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0,
    };
  }

  success(key: string): void {
    this.attempts.delete(key);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  clear(): void {
    this.attempts.clear();
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' } = {},
): string {
  const parts = [`${name}=${value}`, 'Path=/', `SameSite=${options.sameSite || 'Strict'}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join('; ');
}
