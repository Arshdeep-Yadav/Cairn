import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthManager } from '../src/core/auth.js';
import { getDiff } from '../src/core/git.js';
import { handle } from '../src/core/ids.js';
import { openStore } from '../src/core/store.js';
import { startUiServer, type UiServer } from '../src/cli/ui-server.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const PASSWORD = 'correct-horse-battery-staple';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-security-'));
const vaultDir = path.join(tempRoot, 'vault');

let ui: UiServer;
let auth: AuthManager;
let sessionCookie = '';
let csrfCookie = '';
let csrfToken = '';

// Second vault: first-run generated password, so the must-change flow is active.
const mustVaultDir = path.join(tempRoot, 'must-vault');
let mustUi: UiServer;
let mustAuth: AuthManager;
let mustGeneratedPassword = '';

// Third vault: dedicated to change-password integration tests.
const changeVaultDir = path.join(tempRoot, 'change-vault');
let changeUi: UiServer;
let changeAuth: AuthManager;
const CHANGE_INITIAL_PASSWORD = 'initial-change-password-123';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: {
    path: string;
    method?: string;
    host?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method || 'GET',
        headers: {
          ...(options.headers || {}),
          ...(options.host ? { Host: options.host } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function login(password: string): Promise<Response> {
  return fetch(`${ui.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function cookie(name: string, setCookies: string[]): string {
  const entry = setCookies.find((value) => value.startsWith(`${name}=`));
  return entry ? entry.slice(0, entry.indexOf(';')).slice(name.length + 1) : '';
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Cookie: `cairn_session=${sessionCookie}; cairn_csrf=${csrfCookie}`,
    'X-Cairn-CSRF': csrfToken,
    'Content-Type': 'application/json',
    ...extra,
  };
}

beforeAll(async () => {
  execFileSync(process.execPath, [CLI, 'init', '--vault', vaultDir, '--project', 'security'], {
    cwd: tempRoot,
    stdio: 'pipe',
  });
  const store = openStore({ vault: vaultDir, cwd: tempRoot, agent: 'human', autoInit: false });
  auth = AuthManager.ensure(vaultDir, { password: PASSWORD }).auth;
  ui = await startUiServer({
    store,
    auth,
    port: 0,
    host: '127.0.0.1',
    webRoot: path.join(ROOT, 'web'),
  });

  execFileSync(process.execPath, [CLI, 'init', '--vault', mustVaultDir, '--project', 'security'], {
    cwd: tempRoot,
    stdio: 'pipe',
  });
  const mustStore = openStore({ vault: mustVaultDir, cwd: tempRoot, agent: 'human', autoInit: false });
  const mustResult = AuthManager.ensure(mustVaultDir);
  mustAuth = mustResult.auth;
  mustGeneratedPassword = mustResult.password!;
  expect(mustAuth.mustChangePassword()).toBe(true);
  mustUi = await startUiServer({
    store: mustStore,
    auth: mustAuth,
    port: 0,
    host: '127.0.0.1',
    webRoot: path.join(ROOT, 'web'),
  });

  execFileSync(process.execPath, [CLI, 'init', '--vault', changeVaultDir, '--project', 'security'], {
    cwd: tempRoot,
    stdio: 'pipe',
  });
  const changeStore = openStore({ vault: changeVaultDir, cwd: tempRoot, agent: 'human', autoInit: false });
  changeAuth = AuthManager.ensure(changeVaultDir, { password: CHANGE_INITIAL_PASSWORD }).auth;
  changeUi = await startUiServer({
    store: changeStore,
    auth: changeAuth,
    port: 0,
    host: '127.0.0.1',
    webRoot: path.join(ROOT, 'web'),
  });
}, 30_000);

afterAll(async () => {
  await ui?.close();
  await mustUi?.close();
  await changeUi?.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('workspace authentication', () => {
  it('serves health and the login page without a session', async () => {
    const health = await fetch(`${ui.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const loginPage = await fetch(`${ui.url}/login`);
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain('Unlock Cairn');

    // A stale app.js after an upgrade breaks the UI; assets must revalidate.
    const script = await fetch(`${ui.url}/login.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('cache-control')).toBe('no-cache');

    const fallback = await fetch(`${ui.url}/login-fallback.js`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('content-type')).toContain('javascript');

    const status = await fetch(`${ui.url}/api/auth/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ authenticated: false });
  });

  it('blocks every workspace route without a session', async () => {
    for (const route of ['/api/bootstrap', '/api/overview', '/api/notes', '/api/events', '/api/connections']) {
      const response = await fetch(`${ui.url}${route}`);
      expect(response.status, route).toBe(401);
    }
    const app = await fetch(`${ui.url}/app.js`);
    expect(app.status).toBe(401);
    const home = await fetch(`${ui.url}/`, { redirect: 'manual' });
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/login');
  });

  it('rejects a bad password and accepts the real one', async () => {
    const wrong = await login('not-the-password');
    expect(wrong.status).toBe(401);

    const response = await login(PASSWORD);
    expect(response.status).toBe(200);
    const setCookies = response.headers.getSetCookie();
    sessionCookie = cookie('cairn_session', setCookies);
    csrfCookie = cookie('cairn_csrf', setCookies);
    const payload = (await response.json()) as { csrfToken: string };
    csrfToken = payload.csrfToken;
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();
    expect(csrfToken).toBe(csrfCookie);
    expect(setCookies.find((value) => value.startsWith('cairn_session='))).toContain('HttpOnly');
    expect(setCookies.find((value) => value.startsWith('cairn_session='))).toContain('SameSite=Strict');

    const bootstrap = await fetch(`${ui.url}/api/bootstrap`, {
      headers: { Cookie: `cairn_session=${sessionCookie}` },
    });
    expect(bootstrap.status).toBe(200);
    const data = (await bootstrap.json()) as { vault: { path: string } };
    expect(data.vault.path).toBe(vaultDir);
  });

  it('requires the session-bound CSRF token for mutations', async () => {
    const body = JSON.stringify({ kind: 'decision', title: 'CSRF test note', body: 'protected' });

    const missing = await fetch(`${ui.url}/api/notes`, {
      method: 'POST',
      headers: { Cookie: `cairn_session=${sessionCookie}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(missing.status).toBe(403);

    const mismatched = await fetch(`${ui.url}/api/notes`, {
      method: 'POST',
      headers: authHeaders({ 'X-Cairn-CSRF': 'forged' }),
      body,
    });
    expect(mismatched.status).toBe(403);

    const wrongType = await fetch(`${ui.url}/api/notes`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'text/plain' }),
      body,
    });
    expect(wrongType.status).toBe(415);

    const crossOrigin = await fetch(`${ui.url}/api/notes`, {
      method: 'POST',
      headers: authHeaders({ Origin: 'https://evil.example' }),
      body,
    });
    expect(crossOrigin.status).toBe(403);

    const created = await fetch(`${ui.url}/api/notes`, {
      method: 'POST',
      headers: authHeaders(),
      body,
    });
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { note: { title: string } };
    expect(payload.note.title).toBe('CSRF test note');
  });

  it('rejects forged or malformed host headers without crashing', async () => {
    const rebound = await rawRequest(ui.port, {
      path: '/api/bootstrap',
      host: 'evil.example',
      headers: { Cookie: `cairn_session=${sessionCookie}` },
    });
    expect(rebound.status).toBe(403);

    const malformed = await rawRequest(ui.port, { path: '/api/health', host: '[' });
    expect(malformed.status).toBe(400);

    const alive = await fetch(`${ui.url}/api/health`);
    expect(alive.status).toBe(200);

    const traversal = await fetch(`${ui.url}/../package.json`, {
      headers: { Cookie: `cairn_session=${sessionCookie}` },
    });
    expect(traversal.status).toBe(404);
  });

  it('revokes the session on logout', async () => {
    const logout = await fetch(`${ui.url}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    expect(logout.status).toBe(200);

    const replay = await fetch(`${ui.url}/api/bootstrap`, {
      headers: { Cookie: `cairn_session=${sessionCookie}` },
    });
    expect(replay.status).toBe(401);
  });

  it('locks out repeated failed logins', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await login('still-wrong');
      expect([401, 429]).toContain(response.status);
    }
    const locked = await login('still-wrong');
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBeTruthy();

    const correctWhileLocked = await login(PASSWORD);
    expect(correctWhileLocked.status).toBe(429);
  });
});

describe('first-login password challenge', () => {
  async function status(): Promise<{ authenticated: boolean; mustChangePassword: boolean }> {
    const response = await fetch(`${mustUi.url}/api/auth/status`, { cache: 'no-store' });
    expect(response.ok).toBe(true);
    return (await response.json()) as { authenticated: boolean; mustChangePassword: boolean };
  }

  async function change(current: string, next: string): Promise<Response> {
    return fetch(`${mustUi.url}/api/auth/must-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, next }),
    });
  }

  it('reports that a password change is required on first run', async () => {
    const state = await status();
    expect(state.authenticated).toBe(false);
    expect(state.mustChangePassword).toBe(true);
  });

  it('serves the login page with the reset challenge markup', async () => {
    const response = await fetch(`${mustUi.url}/login`);
    expect(response.ok).toBe(true);
    const html = await response.text();
    expect(html).toContain('id="must-change-view"');
    expect(html).toContain('id="must-change-form"');
  });

  it('refuses to grant a session with the generated password', async () => {
    const response = await fetch(`${mustUi.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: mustGeneratedPassword }),
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe('must_change');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects an incorrect generated password in the challenge', async () => {
    const response = await change('not-the-generated-password', 'a-new-strong-password-1');
    expect(response.status).toBe(401);
  });

  it('rejects a too-short replacement password', async () => {
    const response = await change(mustGeneratedPassword, 'short');
    expect(response.status).toBe(400);
  });

  it('sets a new password, opens a session, and clears the flag', async () => {
    const NEW = 'a-permanent-workspace-password-1';
    const response = await change(mustGeneratedPassword, NEW);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok?: boolean; csrfToken?: string };
    expect(payload.ok).toBe(true);
    expect(payload.csrfToken).toBeTruthy();

    // The challenge is public (no prior session) but must set a session cookie.
    const setCookies = response.headers.get('set-cookie') || '';
    expect(setCookies).toContain('cairn_session=');

    const state = await status();
    expect(state.mustChangePassword).toBe(false);

    // The generated password no longer works; the new one does.
    const oldLogin = await fetch(`${mustUi.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: mustGeneratedPassword }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await fetch(`${mustUi.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: NEW }),
    });
    expect(newLogin.status).toBe(200);
  });

  it('refuses a second challenge once the flag is cleared', async () => {
    const response = await change(mustGeneratedPassword, 'another-new-password-1');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe('not_required');
  });
});

describe('change-password authenticated workflow', () => {
  let changeSessionCookie = '';
  let changeCsrfCookie = '';
  let changeCsrfToken = '';

  async function changeLogin(password: string): Promise<Response> {
    return fetch(`${changeUi.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  }

  function changeAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Cookie: `cairn_session=${changeSessionCookie}; cairn_csrf=${changeCsrfCookie}`,
      'X-Cairn-CSRF': changeCsrfToken,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  beforeAll(async () => {
    const response = await changeLogin(CHANGE_INITIAL_PASSWORD);
    expect(response.status).toBe(200);
    const setCookies = response.headers.getSetCookie();
    changeSessionCookie = cookie('cairn_session', setCookies);
    changeCsrfCookie = cookie('cairn_csrf', setCookies);
    const payload = (await response.json()) as { csrfToken: string };
    changeCsrfToken = payload.csrfToken;
    expect(changeSessionCookie).toBeTruthy();
    expect(changeCsrfCookie).toBeTruthy();
    expect(changeCsrfToken).toBe(changeCsrfCookie);
  });

  it('rejects requests with missing or invalid CSRF tokens', async () => {
    const missing = await fetch(`${changeUi.url}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        Cookie: `cairn_session=${changeSessionCookie}; cairn_csrf=${changeCsrfCookie}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ current: CHANGE_INITIAL_PASSWORD, next: 'a-valid-new-password-123' }),
    });
    expect(missing.status).toBe(403);
    const missingPayload = (await missing.json()) as { code?: string };
    expect(missingPayload.code).toBe('bad_csrf');

    const forged = await fetch(`${changeUi.url}/api/auth/change-password`, {
      method: 'POST',
      headers: changeAuthHeaders({ 'X-Cairn-CSRF': 'forged-token' }),
      body: JSON.stringify({ current: CHANGE_INITIAL_PASSWORD, next: 'a-valid-new-password-123' }),
    });
    expect(forged.status).toBe(403);
    const forgedPayload = (await forged.json()) as { code?: string };
    expect(forgedPayload.code).toBe('bad_csrf');
  });

  it('rejects passwords shorter than 12 characters with a validation error', async () => {
    const response = await fetch(`${changeUi.url}/api/auth/change-password`, {
      method: 'POST',
      headers: changeAuthHeaders(),
      body: JSON.stringify({ current: CHANGE_INITIAL_PASSWORD, next: 'too-short' }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string; code?: string };
    expect(payload.code).toBe('bad_password');
    expect(payload.error).toContain('at least 12 characters');
  });

  it('returns a 400 bad password error when current password is incorrect', async () => {
    const response = await fetch(`${changeUi.url}/api/auth/change-password`, {
      method: 'POST',
      headers: changeAuthHeaders(),
      body: JSON.stringify({ current: 'wrong-current-password', next: 'a-valid-new-password-123' }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string; code?: string };
    expect(payload.code).toBe('bad_password');
    expect(payload.error).toBe('Incorrect current password.');
  });

  it('successfully changes password and rotates secret, invalidating old sessions', async () => {
    const NEW_PASSWORD = 'a-brand-new-strong-password-456';
    const oldSessionCookie = changeSessionCookie;

    const response = await fetch(`${changeUi.url}/api/auth/change-password`, {
      method: 'POST',
      headers: changeAuthHeaders(),
      body: JSON.stringify({ current: CHANGE_INITIAL_PASSWORD, next: NEW_PASSWORD }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok?: boolean; csrfToken?: string; expiresAt?: string };
    expect(payload.ok).toBe(true);
    expect(payload.csrfToken).toBeTruthy();

    const setCookies = response.headers.getSetCookie();
    const newSessionCookie = cookie('cairn_session', setCookies);
    const newCsrfCookie = cookie('cairn_csrf', setCookies);
    expect(newSessionCookie).toBeTruthy();
    expect(newCsrfCookie).toBeTruthy();
    expect(newSessionCookie).not.toBe(oldSessionCookie);
    expect(payload.csrfToken).toBe(newCsrfCookie);

    // Secret rotation: Old session cookie must now be rejected (401) on authenticated routes
    const oldSessionCheck = await fetch(`${changeUi.url}/api/bootstrap`, {
      headers: { Cookie: `cairn_session=${oldSessionCookie}` },
    });
    expect(oldSessionCheck.status).toBe(401);

    // New session cookie grants access to authenticated routes
    const newSessionCheck = await fetch(`${changeUi.url}/api/bootstrap`, {
      headers: { Cookie: `cairn_session=${newSessionCookie}` },
    });
    expect(newSessionCheck.status).toBe(200);

    // Old password no longer works for login
    const oldLogin = await changeLogin(CHANGE_INITIAL_PASSWORD);
    expect(oldLogin.status).toBe(401);

    // New password authenticates successfully
    const newLogin = await changeLogin(NEW_PASSWORD);
    expect(newLogin.status).toBe(200);
  });
});

describe('hardening helpers', () => {
  it('strips traversal out of agent and project handles', () => {
    expect(handle('../../etc/passwd')).toBe('etc-passwd');
    expect(handle('..\\..\\Windows')).not.toContain('..');
    expect(handle('a/b')).not.toContain('/');
    expect(handle('normal-agent')).toBe('normal-agent');
  });

  it('reloads auth state and clears rate limits when password is reset on disk', () => {
    expect(auth.reloadIfChanged()).toBe(false);

    // Modify password on disk via an external AuthManager (simulating CLI set-password)
    const external = AuthManager.load(vaultDir);
    const newPass = 'brand-new-rotated-password-123';
    external.setPassword(newPass);

    // Now reloadIfChanged detects the file change
    expect(auth.reloadIfChanged()).toBe(true);
    expect(auth.verifyPassword(newPass)).toBe(true);
    expect(auth.verifyPassword(PASSWORD)).toBe(false);

    // Revert back so subsequent tests in the suite continue working
    external.setPassword(PASSWORD);
    expect(auth.reloadIfChanged()).toBe(true);
    expect(auth.verifyPassword(PASSWORD)).toBe(true);
  });

  it('limits diffs to filtered paths and redacts tokens', () => {
    const repo = path.join(tempRoot, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=old\n');
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@cairn.test'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=SUPER_SECRET_VALUE\n');
    fs.writeFileSync(
      path.join(repo, 'src', 'app.ts'),
      'export const token = "ghp_abcdefghijklmnopqrstuvwxyz1234";\n',
    );

    const diff = getDiff(repo, 'workspace', undefined, 20_000, ['src/app.ts']);
    expect(diff).toContain('src/app.ts');
    expect(diff).not.toContain('SUPER_SECRET_VALUE');
    expect(diff).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234');
    expect(getDiff(repo, 'workspace', undefined, 20_000, [])).toBe('');
  });

  it('guards state names and note file paths', () => {
    const vault = openStore({ vault: vaultDir, cwd: tempRoot, agent: 'human', autoInit: false }).vault;
    expect(() => vault.readState('../config', {})).toThrow(/Invalid vault state name/);
    expect(vault.readNoteFile('../config.json')).toBeNull();
  });

  it('serializes writers and releases the lock', () => {
    const vault = openStore({ vault: vaultDir, cwd: tempRoot, agent: 'human', autoInit: false }).vault;
    let ran = 0;
    vault.withWriteLock(() => {
      vault.withWriteLock(() => {
        ran += 1;
      });
    });
    expect(ran).toBe(1);
    expect(fs.existsSync(vault.lockPath)).toBe(false);

    fs.writeFileSync(vault.lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(() => vault.withWriteLock(() => undefined, 80)).toThrow(/Timed out/);
    fs.rmSync(vault.lockPath, { force: true });
  });
});
