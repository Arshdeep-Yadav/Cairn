import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CAIRN_VERSION } from '../core/vault.js';
import type { Store } from '../core/store.js';
import type { Kind } from '../core/types.js';
import {
  AuthManager,
  CSRF_COOKIE,
  LoginLimiter,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  parseCookies,
  serializeCookie,
  type AuthSession,
} from '../core/auth.js';
import { CLIENT_SETUPS, detectClientWiring, mcpCommand } from './connections.js';

export interface UiServerOptions {
  store: Store;
  auth?: AuthManager;
  port?: number;
  host?: string;
  open?: boolean;
  webRoot?: string;
  maxPortAttempts?: number;
  /** Extra hostnames accepted in the Host header (cloud domains). */
  allowedHosts?: string[];
  /** Mark cookies Secure; required when TLS terminates in front of the server. */
  secureCookies?: boolean;
}

export interface UiServer {
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

const PUBLIC_ASSETS = new Map<string, string>([
  ['/login', 'login.html'],
  ['/login.html', 'login.html'],
  ['/login.js', 'login.js'],
  ['/login-fallback.js', 'login-fallback.js'],
  ['/login.css', 'login.css'],
  ['/favicon.svg', 'favicon.svg'],
  ['/manifest.webmanifest', 'manifest.webmanifest'],
]);

const PRIVATE_ASSETS = new Map<string, string>([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

interface RequestContext {
  authorizationHost: string;
  hostHeader: string;
  cookies: Record<string, string>;
  session: AuthSession | null;
  sessionToken?: string;
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function error(response: http.ServerResponse, status: number, message: string, code?: string): void {
  json(response, status, code ? { error: message, code } : { error: message });
}

/**
 * Reject a request that may still have an unread body. Returning early without
 * draining it leaves the keep-alive socket in a bad state: the next request on
 * the same connection can stall until the client times it out. `resume()` reads
 * and discards the rest so the response and connection stay clean.
 */
function reject(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  message: string,
  code?: string,
): void {
  if (!request.readableEnded && !request.destroyed) request.resume();
  error(response, status, message, code);
}

function redirect(response: http.ServerResponse, location: string): void {
  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  response.end();
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

function asKindList(value: string | null): Kind[] | undefined {
  if (!value) return undefined;
  const kinds = value.split(',').map((item) => item.trim()).filter(Boolean) as Kind[];
  return kinds.length ? kinds : undefined;
}

function summaryOnly(store: Store, note: Parameters<Store['index']['summary']>[0]) {
  return store.index.summary(note);
}

function contentKind(request: http.IncomingMessage): string {
  const raw = request.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').split(';')[0]!.trim().toLowerCase();
}

function clientAddress(request: http.IncomingMessage): string {
  const peer = request.socket.remoteAddress || 'unknown';
  // Only a local reverse proxy can set X-Forwarded-For; trusting it from a
  // remote peer would let attackers pick a fresh rate-limit bucket per request.
  const localPeer = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (localPeer) {
    const raw = request.headers['x-forwarded-for'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const first = String(value || '').split(',')[0]?.trim();
    if (first && first.length <= 64 && /^[\w.:-]+$/.test(first)) return first;
  }
  return peer;
}

function normalizeHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.replace(/\.$/, '');
}

/**
 * Parse a Host header without letting malformed input reach `new URL()`.
 * Returns the bare hostname (IPv6 without brackets) or null.
 */
function parseHostHeader(raw: string | undefined): string | null {
  if (!raw || raw.length > 255) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const ipv6 = value.match(/^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/);
  if (ipv6) {
    const port = ipv6[2] ? Number(ipv6[2]) : undefined;
    if (port !== undefined && (port < 1 || port > 65535)) return null;
    return normalizeHostname(`[${ipv6[1]}]`);
  }
  const match = value.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/);
  if (!match) return null;
  const hostname = match[1]!;
  if (hostname.includes('..') || hostname.length > 253) return null;
  const port = match[2] ? Number(match[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return hostname;
}

function buildAllowedHosts(boundHost: string, extra: string[] = []): Set<string> {
  const allowed = new Set<string>();
  const bind = normalizeHostname(boundHost);
  const isLoopback = (host: string) =>
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
  // An explicit allowlist replaces the loopback defaults. Keeping them would
  // let anyone who can reach a published port pass with `Host: localhost`.
  if (!extra.length) {
    for (const host of DEFAULT_ALLOWED_HOSTS) allowed.add(host);
    if (bind && bind !== '0.0.0.0' && bind !== '::') allowed.add(bind);
  } else if (bind && bind !== '0.0.0.0' && bind !== '::' && !isLoopback(bind)) {
    allowed.add(bind);
  }
  for (const entry of extra) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    // Accept "host", "host:port", and full origins for convenience.
    if (trimmed.includes('://')) {
      try {
        allowed.add(normalizeHostname(new URL(trimmed).hostname));
      } catch {
        // Ignore invalid entries; the remaining allowlist still applies.
      }
      continue;
    }
    const parsed = parseHostHeader(trimmed);
    if (parsed) allowed.add(parsed);
  }
  return allowed;
}

function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return allowed.has(normalizeHostname(parsed.hostname));
}

function checkUnsafeRequest(
  request: http.IncomingMessage,
  allowedHosts: Set<string>,
): { status: number; message: string; code?: string } | null {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return { status: 403, message: 'Cross-site request rejected.', code: 'cross_site' };
  }
  const origin = request.headers.origin;
  if (origin && !originAllowed(origin, allowedHosts)) {
    return { status: 403, message: 'Origin is not allowed.', code: 'bad_origin' };
  }
  return null;
}

function authCookies(
  response: http.ServerResponse,
  token: string,
  csrfToken: string,
  secure: boolean,
  maxAge: number,
): void {
  response.setHeader('Set-Cookie', [
    serializeCookie(SESSION_COOKIE, token, { httpOnly: true, secure, maxAge }),
    serializeCookie(CSRF_COOKIE, csrfToken, { httpOnly: false, secure, maxAge }),
  ]);
}

function clearAuthCookies(response: http.ServerResponse, secure: boolean): void {
  response.setHeader('Set-Cookie', [
    serializeCookie(SESSION_COOKIE, '', { httpOnly: true, secure, maxAge: 0 }),
    serializeCookie(CSRF_COOKIE, '', { httpOnly: false, secure, maxAge: 0 }),
  ]);
}

function overview(store: Store, project?: string) {
  const p = project ? store.resolveProject(project) : undefined;
  const stats = store.stats(p);
  const projects = store.projectsInfo();
  const agents = store.agentsInfo(p);
  const recentHits = store.search({ project: p, limit: 12, includeArchived: false });
  const decisions = store.search({
    project: p,
    kinds: ['decision'],
    status: ['accepted'],
    limit: 4,
    includeArchived: false,
  });
  const proposals = store.search({
    project: p,
    kinds: ['decision'],
    status: ['proposed'],
    limit: 4,
    includeArchived: false,
  });
  const questions = store.search({
    project: p,
    kinds: ['question'],
    status: ['open'],
    limit: 4,
    includeArchived: false,
  });
  const risks = store.search({
    project: p,
    kinds: ['risk'],
    status: ['open'],
    limit: 4,
    includeArchived: false,
  });
  const handoffs = store.search({
    project: p,
    kinds: ['handoff'],
    limit: 12,
    includeArchived: false,
  }).filter((hit) => hit.note.status !== 'done');
  const messages = store.search({
    project: p,
    kinds: ['message'],
    status: ['unread'],
    limit: 10,
    includeArchived: false,
  });
  const changes = store.search({
    project: p,
    kinds: ['change'],
    limit: 6,
    includeArchived: false,
  });
  const sessions = store.search({
    project: p,
    kinds: ['session'],
    limit: 5,
    includeArchived: false,
  });
  const timeline = store.timeline({ project: p, days: 14, limit: 18 });
  const count = (options: Parameters<Store['search']>[0]) =>
    store.search({ ...options, project: p, limit: 1000, offset: 0, includeArchived: false }).length;
  const attention = {
    proposals: count({ kinds: ['decision'], status: ['proposed'] }),
    questions: count({ kinds: ['question'], status: ['open'] }),
    risks: count({ kinds: ['risk'], status: ['open'] }),
    handoffs: count({ kinds: ['handoff'], status: ['unread'] }),
    messages: count({ kinds: ['message'], status: ['unread'] }),
  };
  return {
    project: p ?? null,
    generatedAt: new Date().toISOString(),
    stats,
    projects,
    agents,
    recent: recentHits.map((hit) => hit.note),
    decisions: decisions.map((hit) => hit.note),
    proposals: proposals.map((hit) => hit.note),
    questions: questions.map((hit) => hit.note),
    risks: risks.map((hit) => hit.note),
    handoffs: handoffs.map((hit) => hit.note),
    messages: messages.map((hit) => hit.note),
    changes: changes.map((hit) => hit.note),
    sessions: sessions.map((hit) => hit.note),
    timeline,
    attention,
  };
}

function filterGraphForUi(
  store: Store,
  options: {
    project?: string;
    kinds?: Kind[];
    includeFiles: boolean;
    includeHubs: boolean;
    limit: number;
  },
) {
  const includeVirtual = options.includeFiles || options.includeHubs;
  const data = store.graph({
    project: options.project,
    kinds: options.kinds,
    includeVirtual,
    limit: options.limit,
    depth: 4,
  });
  const allowed = new Map<string, boolean>();
  for (const node of data.nodes) {
    if (node.kind === 'file' && !options.includeFiles) continue;
    if ((node.kind === 'agent' || node.kind === 'project') && !options.includeHubs) continue;
    if (node.kind === 'missing' || node.kind === 'session') {
      if (!options.includeHubs) continue;
    }
    allowed.set(node.id, true);
  }
  const nodes = data.nodes.filter((node) => allowed.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = data.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.from, (degrees.get(edge.from) || 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) || 0) + 1);
  }
  for (const node of nodes) node.degree = degrees.get(node.id) || 0;
  return {
    nodes,
    edges,
    stats: {
      ...data.stats,
      nodes: nodes.length,
      edges: edges.length,
    },
    projects: store.projectsInfo(),
    agents: store.agentsInfo(options.project),
  };
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const { store } = options;
  const host = options.host || '127.0.0.1';
  const webRoot = options.webRoot || path.resolve(import.meta.dirname, '..', '..', 'web');
  const secureCookies = options.secureCookies === true;
  const allowedHosts = buildAllowedHosts(host, options.allowedHosts);
  const auth = options.auth || AuthManager.ensure(store.vault.dir).auth;
  const limiter = new LoginLimiter();
  const clients = new Set<http.ServerResponse>();
  let watcher: fs.FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;

  const broadcast = (payload: unknown) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(data);
      } catch {
        clients.delete(client);
      }
    }
  };

  const scheduleRefresh = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      try {
        store.index.refresh();
        broadcast({ type: 'refresh', at: new Date().toISOString() });
      } catch {
        // A transient read error should not kill live updates.
      }
    }, 220);
  };

  try {
    watcher = fs.watch(store.vault.dir, { recursive: true }, (_event, filename) => {
      if (filename && String(filename).includes('state')) return;
      scheduleRefresh();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );

    try {
      // The Host header is validated before URL parsing so malformed input
      // (for example `Host: [`) cannot crash the process or enable rebinding.
      const rawHostHeader = String(request.headers.host || '');
      const hostname = parseHostHeader(rawHostHeader);
      if (!hostname) {
        reject(request, response, 400, 'Invalid or missing Host header.');
        return;
      }
      if (!allowedHosts.has(normalizeHostname(hostname))) {
        reject(request, response, 403, 'This workspace is not configured for that host.', 'bad_host');
        return;
      }

      const url = new URL(request.url || '/', 'http://localhost');
      const method = request.method || 'GET';
      const pathname = url.pathname;

      // Reload auth state and unblock rate-limits if auth.json changed on disk (e.g. CLI reset)
      if (auth.reloadIfChanged()) {
        limiter.clear();
      }

      const cookies = parseCookies(request.headers.cookie);
      const sessionToken = cookies[SESSION_COOKIE];
      const session = auth.authenticate(sessionToken);
      const context: RequestContext = {
        authorizationHost: hostname,
        hostHeader: rawHostHeader,
        cookies,
        session,
        sessionToken,
      };

      const unsafe = checkUnsafeRequest(request, allowedHosts);
      if (unsafe && method !== 'GET' && method !== 'HEAD') {
        reject(request, response, unsafe.status, unsafe.message, unsafe.code);
        return;
      }

      const isLogin = pathname === '/api/auth/login';
      const isStatus = pathname === '/api/auth/status';
      const isMustChange = pathname === '/api/auth/must-change';
      const isPublicApi = pathname === '/api/health' || isLogin || isStatus || isMustChange;

      if (!isPublicApi && !session) {
        if (pathname.startsWith('/api/')) {
          reject(request, response, 401, 'Authentication required.', 'unauthenticated');
          return;
        }
        if (pathname === '/' || pathname === '/index.html') {
          redirect(response, '/login');
          return;
        }
        if (PRIVATE_ASSETS.has(pathname)) {
          reject(request, response, 401, 'Authentication required.', 'unauthenticated');
          return;
        }
      }

      if (pathname === '/api/health') {
        if (method !== 'GET' && method !== 'HEAD') {
          reject(request, response, 405, 'Method not allowed');
          return;
        }
        json(response, 200, { ok: true, version: CAIRN_VERSION });
        return;
      }

      if (isStatus) {
        if (method !== 'GET' && method !== 'HEAD') {
          reject(request, response, 405, 'Method not allowed');
          return;
        }
        json(response, 200, {
          authenticated: Boolean(session),
          version: CAIRN_VERSION,
          expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
          mustChangePassword: auth.mustChangePassword(),
        });
        return;
      }

      if (isLogin) {
        if (method !== 'POST') {
          reject(request, response, 405, 'Method not allowed');
          return;
        }
        if (contentKind(request) !== 'application/json') {
          reject(request, response, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
          return;
        }
        const key = clientAddress(request);
        const retryAfter = limiter.retryAfter(key);
        if (retryAfter > 0) {
          response.setHeader('Retry-After', String(retryAfter));
          reject(request, response, 429, `Too many failed attempts. Try again in ${retryAfter} seconds.`, 'rate_limited');
          return;
        }
        const body = (await readBody(request)) as Record<string, unknown>;
        const password = typeof body.password === 'string' ? body.password : '';
        if (!auth.verifyPassword(password)) {
          const failed = limiter.fail(key);
          if (failed.locked) {
            response.setHeader('Retry-After', String(failed.retryAfter));
            error(
              response,
              429,
              `Too many failed attempts. Try again in ${failed.retryAfter} seconds.`,
              'rate_limited',
            );
            return;
          }
          reject(request, response, 401, 'Incorrect password.', 'bad_password');
          return;
        }
        limiter.success(key);
        // The generated first-run password must not grant a usable session:
        // it is shown once and easy to lose, and the owner is meant to set a
        // real password. Refuse the session and tell the client to show the
        // reset challenge. Only `/api/auth/must-change` can authenticate here.
        if (auth.mustChangePassword()) {
          reject(request, response, 403, 'A new password is required before the workspace can be used.', 'must_change');
          return;
        }
        const created = auth.createSession();
        authCookies(response, created.token, created.csrfToken, secureCookies, SESSION_TTL_SECONDS);
        json(response, 200, {
          ok: true,
          csrfToken: created.csrfToken,
          expiresAt: new Date(created.session.expiresAt).toISOString(),
        });
        return;
      }

      // Public login surface. Everything after this point requires a session.
      const publicAsset = PUBLIC_ASSETS.get(pathname);
      if (publicAsset) {
        if (method !== 'GET' && method !== 'HEAD') {
          reject(request, response, 405, 'Method not allowed');
          return;
        }
        if (session && (pathname === '/login' || pathname === '/login.html')) {
          redirect(response, '/');
          return;
        }
        serveAsset(request, response, webRoot, publicAsset);
        return;
      }

      // Public recovery surface: the generated first-run password was shown
      // once and is easy to lose. Re-entering it here sets a new one and
      // clears the must-change flag. This is NOT a backdoor — it still
      // requires the generated password, which is printed on first run.
      if (pathname === '/api/auth/must-change' && method === 'POST') {
        if (contentKind(request) !== 'application/json') {
          reject(request, response, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
          return;
        }
        if (!auth.mustChangePassword()) {
          // A no-op must not touch the limiter at all: otherwise attackers
          // interleave it with wrong logins to avoid lockout.
          json(response, 400, { error: 'No password change is required.', code: 'not_required' });
          return;
        }
        const key = clientAddress(request);
        const retryAfter = limiter.retryAfter(key);
        if (retryAfter > 0) {
          response.setHeader('Retry-After', String(retryAfter));
          reject(request, response, 429, `Too many failed attempts. Try again in ${retryAfter} seconds.`, 'rate_limited');
          return;
        }
        const body = (await readBody(request)) as Record<string, unknown>;
        const current = typeof body.current === 'string' ? body.current : '';
        const next = typeof body.next === 'string' ? body.next : '';
        if (!auth.verifyPassword(current)) {
          const failed = limiter.fail(key);
          if (failed.locked) {
            response.setHeader('Retry-After', String(failed.retryAfter));
            error(
              response,
              429,
              `Too many failed attempts. Try again in ${failed.retryAfter} seconds.`,
              'rate_limited',
            );
            return;
          }
          reject(request, response, 401, 'Incorrect password.', 'bad_password');
          return;
        }
        try {
          auth.setPassword(next);
        } catch (err) {
          reject(request, response, 400, (err as Error).message || 'Invalid password.', 'bad_password');
          return;
        }
        limiter.success(key);
        const created = auth.createSession();
        authCookies(response, created.token, created.csrfToken, secureCookies, SESSION_TTL_SECONDS);
        json(response, 200, {
          ok: true,
          csrfToken: created.csrfToken,
          expiresAt: new Date(created.session.expiresAt).toISOString(),
        });
        return;
      }

      // From here on every route requires a valid session.
      if (!session) {
        reject(request, response, 401, 'Authentication required.', 'unauthenticated');
        return;
      }

      // Change password is authenticated but allows the current session's CSRF
      // to be verified inline (the new session is created after password change).
      if (pathname === '/api/auth/change-password') {
        if (method !== 'POST') {
          reject(request, response, 405, 'Method not allowed');
          return;
        }
        if (contentKind(request) !== 'application/json') {
          reject(request, response, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
          return;
        }
        const header = request.headers['x-cairn-csrf'];
        const csrfHeader = Array.isArray(header) ? header[0] : header;
        const csrfCookie = context.cookies[CSRF_COOKIE];
        if (
          !csrfHeader ||
          !csrfCookie ||
          csrfHeader !== csrfCookie ||
          !auth.verifyCsrf(session, csrfHeader)
        ) {
          reject(request, response, 403, 'Invalid or missing CSRF token.', 'bad_csrf');
          return;
        }
        const body = (await readBody(request)) as Record<string, unknown>;
        const current = typeof body.current === 'string' ? body.current : '';
        const next = typeof body.next === 'string' ? body.next : '';
        if (!current || !next) {
          reject(request, response, 400, 'Current and new password are required.', 'bad_request');
          return;
        }
        if (!auth.verifyPassword(current)) {
          // 400 (not 401): the session is valid — this is a bad request, and a
          // 401 would make the client's api() helper redirect to /login instead
          // of surfacing the inline "Incorrect current password" error.
          reject(request, response, 400, 'Incorrect current password.', 'bad_password');
          return;
        }
        try {
          auth.setPassword(next);
        } catch (err) {
          reject(request, response, 400, (err as Error).message || 'Invalid password.', 'bad_password');
          return;
        }
        const created = auth.createSession();
        authCookies(response, created.token, created.csrfToken, secureCookies, SESSION_TTL_SECONDS);
        json(response, 200, {
          ok: true,
          csrfToken: created.csrfToken,
          expiresAt: new Date(created.session.expiresAt).toISOString(),
        });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        if (contentKind(request) !== 'application/json') {
          reject(request, response, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
          return;
        }
        const header = request.headers['x-cairn-csrf'];
        const csrfHeader = Array.isArray(header) ? header[0] : header;
        const csrfCookie = context.cookies[CSRF_COOKIE];
        if (
          !csrfHeader ||
          !csrfCookie ||
          csrfHeader !== csrfCookie ||
          !auth.verifyCsrf(session, csrfHeader)
        ) {
          reject(request, response, 403, 'Invalid or missing CSRF token.', 'bad_csrf');
          return;
        }
      }

      if (pathname === '/api/auth/session') {
        if (method !== 'GET' && method !== 'HEAD') {
          reject(request, response, 405, 'Method not allowed');
          return;
        }
        const csrfToken = auth.csrfForSession(session);
        if (context.cookies[CSRF_COOKIE] !== csrfToken) {
          response.setHeader(
            'Set-Cookie',
            serializeCookie(CSRF_COOKIE, csrfToken, {
              httpOnly: false,
              secure: secureCookies,
              maxAge: Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000)),
            }),
          );
        }
        json(response, 200, {
          authenticated: true,
          csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
          vault: store.vault.config.name,
          version: CAIRN_VERSION,
        });
        return;
      }

      if (pathname === '/api/auth/logout') {
        if (method !== 'POST') {
          reject(request, response, 405, 'Method not allowed');
          return;
        }
        auth.revoke(context.sessionToken);
        clearAuthCookies(response, secureCookies);
        json(response, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/bootstrap') {
          const stats = store.stats();
          json(response, 200, {
            version: CAIRN_VERSION,
            vault: {
              path: store.vault.dir,
              name: store.vault.config.name,
              project: store.vault.config.project,
              settings: store.vault.config.settings,
            },
            defaultProject: store.defaultProject,
            defaultAgent: store.defaultAgent,
            stats,
            projects: store.projectsInfo(),
            agents: store.agentsInfo(),
            now: new Date().toISOString(),
          });
          return;
        }
        if (pathname === '/api/connections') {
          const wired = detectClientWiring(process.cwd());
          const wiredIds = new Set(wired.map((entry) => entry.id));
          json(response, 200, {
            vault: store.vault.dir,
            project: store.defaultProject,
            cwd: process.cwd(),
            notes: store.stats().notes,
            checkedAt: new Date().toISOString(),
            command: mcpCommand(store.vault.dir, store.defaultProject),
            wired,
            clients: CLIENT_SETUPS.map((client) => ({
              ...client,
              wired: wiredIds.has(client.id),
              command: `cairn connect ${client.id}`,
            })),
          });
          return;
        }
        if (pathname === '/api/overview') {
          json(response, 200, overview(store, asString(url.searchParams.get('project'))));
          return;
        }
        if (pathname === '/api/notes' && method === 'GET') {
          const hits = store.search({
            query: asString(url.searchParams.get('q')) || '',
            project: asString(url.searchParams.get('project')),
            agent: asString(url.searchParams.get('agent')),
            kinds: asKindList(url.searchParams.get('kinds') || url.searchParams.get('kind')),
            status: asString(url.searchParams.get('status')),
            tags: asStringArray(url.searchParams.get('tags')),
            to: asString(url.searchParams.get('to')),
            limit: Number(url.searchParams.get('limit') || 100),
            offset: Number(url.searchParams.get('offset') || 0),
            sort: (url.searchParams.get('sort') as 'relevance' | 'updated' | 'created') || undefined,
            includeArchived: url.searchParams.get('include_archived') === '1',
          });
          json(response, 200, { hits, count: hits.length });
          return;
        }
        if (pathname === '/api/notes' && method === 'POST') {
          const body = (await readBody(request)) as Record<string, unknown>;
          const kind = asString(body.kind) as Kind | undefined;
          if (!kind) throw new Error('kind is required');
          const title = asString(body.title);
          if (!title) throw new Error('title is required');
          const result = store.write({
            kind,
            title,
            body: asString(body.body),
            status: asString(body.status),
            project: asString(body.project) || store.defaultProject,
            agent: asString(body.agent) || 'human',
            tags: asStringArray(body.tags),
            files: asStringArray(body.files),
            to: asStringArray(body.to),
            related: asStringArray(body.related),
            metadata: { source: 'ui' },
          });
          broadcast({ type: 'refresh', at: new Date().toISOString() });
          json(response, 201, { note: result.note, created: result.created });
          return;
        }
        const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)(\/read)?$/);
        if (noteMatch && !noteMatch[2] && method === 'GET') {
          const result = store.get(decodeURIComponent(noteMatch[1]!));
          if (!result) {
            reject(request, response, 404, 'Note not found');
            return;
          }
          json(response, 200, {
            note: result.note,
            outgoing: result.outgoing,
            backlinks: result.backlinks,
            related: result.related.map((entry) => ({
              ...summaryOnly(store, entry.note),
              noteId: entry.note.id,
              label: entry.note.title,
              linkTypes: entry.types,
              direction: entry.direction,
            })),
            sessionNote: result.sessionNote,
            filePath: store.noteFilePath(result.note),
          });
          return;
        }
        if (noteMatch && noteMatch[2] && method === 'POST') {
          const id = decodeURIComponent(noteMatch[1]!);
          const note = store.update(id, { status: 'read' });
          broadcast({ type: 'refresh', at: new Date().toISOString() });
          json(response, 200, { note });
          return;
        }
        if (noteMatch && !noteMatch[2] && (method === 'PATCH' || method === 'POST')) {
          const rawBody = (await readBody(request)) as Record<string, unknown>;
          const id = decodeURIComponent(noteMatch[1]!);
          const note = store.update(id, {
            title: asString(rawBody.title),
            body: asString(rawBody.body),
            append: rawBody.append !== false,
            status: asString(rawBody.status),
            tags: asStringArray(rawBody.tags),
            files: asStringArray(rawBody.files),
          });
          broadcast({ type: 'refresh', at: new Date().toISOString() });
          json(response, 200, { note });
          return;
        }
        if (pathname === '/api/graph') {
          const project = asString(url.searchParams.get('project'));
          const data = filterGraphForUi(store, {
            project,
            kinds: asKindList(url.searchParams.get('kinds')),
            includeFiles: url.searchParams.get('include_files') === '1',
            includeHubs: url.searchParams.get('include_hubs') === '1',
            limit: Math.min(Number(url.searchParams.get('limit') || 600), 900),
          });
          json(response, 200, data);
          return;
        }
        if (pathname === '/api/timeline') {
          const hits = store.timeline({
            project: asString(url.searchParams.get('project')),
            agent: asString(url.searchParams.get('agent')),
            days: Number(url.searchParams.get('days') || 14),
            limit: Math.min(Number(url.searchParams.get('limit') || 80), 200),
          });
          json(response, 200, { hits });
          return;
        }
        if (pathname === '/api/agents') {
          const agents = store.agentsInfo(asString(url.searchParams.get('project'))).map((agent) => {
            const inbox = store.inbox({
              agent: agent.name,
              project: asString(url.searchParams.get('project')),
              unreadOnly: true,
              limit: 50,
            });
            return { ...agent, unread: inbox.length };
          });
          json(response, 200, { agents });
          return;
        }
        if (pathname === '/api/projects') {
          json(response, 200, { projects: store.projectsInfo() });
          return;
        }
        if (pathname === '/api/messages') {
          const project = asString(url.searchParams.get('project'));
          const status = asString(url.searchParams.get('status'));
          const to = asString(url.searchParams.get('to'));
          const kind = asString(url.searchParams.get('kind'));
          const kinds: Kind[] = kind === 'message' || kind === 'handoff' ? [kind] : ['message', 'handoff'];
          const hits = store.search({
            kinds,
            project,
            status,
            to,
            limit: Math.min(Number(url.searchParams.get('limit') || 200), 300),
            sort: 'updated',
          });
          json(response, 200, {
            hits,
            agents: store.agentsInfo(project),
          });
          return;
        }
        if (pathname === '/api/events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          response.write('retry: 2500\n\n');
          response.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);
          clients.add(response);
          request.on('close', () => clients.delete(response));
          return;
        }
        reject(request, response, 404, 'Unknown API route');
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        reject(request, response, 405, 'Method not allowed');
        return;
      }

      const privateAsset = PRIVATE_ASSETS.get(pathname);
      if (!privateAsset) {
        reject(request, response, 404, 'Not found');
        return;
      }
      serveAsset(request, response, webRoot, privateAsset);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unexpected error';
      if (message.includes('too large')) {
        reject(request, response, 413, message);
        return;
      }
      if (/not found/i.test(message)) {
        reject(request, response, 404, message);
        return;
      }
      reject(request, response, 400, message);
    }
  });

  const port = options.port ?? 4242;
  const attempts = options.maxPortAttempts ?? 12;
  const listen = (candidate: number, remaining: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (caught: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (caught.code === 'EADDRINUSE' && remaining > 0 && candidate > 0) {
          resolve(listen(candidate + 1, remaining - 1));
        } else {
          reject(caught);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(candidate);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    });

  const actualPort = await listen(port, attempts);
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : actualPort;
  const url = `http://${displayHost(host)}:${boundPort}`;

  if (options.open) {
    openBrowser(url);
  }

  return {
    server,
    url,
    port: boundPort,
    close: async () => {
      clearInterval(heartbeat);
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface CachedAsset {
  content: Buffer;
  contentType: string;
  etag: string;
  mtimeMs: number;
}
const assetCache = new Map<string, CachedAsset>();

function serveAsset(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  webRoot: string,
  relative: string,
): void {
  const file = path.resolve(webRoot, relative);
  if (!file.startsWith(path.resolve(webRoot) + path.sep)) {
    reject(request, response, 403, 'Forbidden');
    return;
  }
  let cached = assetCache.get(file);
  try {
    const stat = fs.statSync(file);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      const content = fs.readFileSync(file);
      const contentType = CONTENT_TYPES[path.extname(file)] || 'application/octet-stream';
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      cached = { content, contentType, etag, mtimeMs: stat.mtimeMs };
      assetCache.set(file, cached);
    }
  } catch {
    reject(request, response, 404, 'UI assets not found. Run from the Cairn package directory or reinstall.');
    return;
  }

  // Localhost assets must revalidate: after `npm i -g cairn@latest` an hour of
  // stale app.js against a new server API is a broken UI. The ETag keeps
  // revalidation cheap (304, no body).
  const cacheControl = 'no-cache';
  if (request.headers['if-none-match'] === cached.etag) {
    response.writeHead(304, {
      ETag: cached.etag,
      'Cache-Control': cacheControl,
    });
    response.end();
    return;
  }

  response.writeHead(200, {
    'Content-Type': cached.contentType,
    'Content-Length': cached.content.length,
    ETag: cached.etag,
    'Cache-Control': cacheControl,
  });
  if (request.method === 'HEAD') {
    response.end();
  } else {
    response.end(cached.content);
  }
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Opening a browser is best-effort.
  }
}
