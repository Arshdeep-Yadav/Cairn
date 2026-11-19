import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = process.env.CAIRN_SHOT_URL || 'http://127.0.0.1:4242';
const outDir = path.resolve(process.env.CAIRN_SHOT_DIR || 'shots');
const password = process.env.CAIRN_SHOT_PASSWORD || '';
const noAuth = process.env.CAIRN_SHOT_NO_AUTH === '1';
if (!password && !noAuth) {
  throw new Error('Set CAIRN_SHOT_PASSWORD to the workspace password (or CAIRN_SHOT_NO_AUTH=1 for an unsecured vault).');
}
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-shot-'));
const port = 9333;

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForChrome() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error('Chrome did not expose the DevTools endpoint.');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

await waitForChrome();
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
const page = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((response) => response.json());
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

async function prepare({ width = 1440, height = Number(process.env.CAIRN_SHOT_HEIGHT) || 1000, mobile = false, theme = 'light' } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme }],
  });
}

async function save(name) {
  const state = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({ title: document.title, theme: document.documentElement.dataset.theme, ready: document.querySelector('#view')?.innerText.slice(0, 100) })`,
    returnByValue: true,
  });
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(screenshot.data, 'base64'));
  console.log(name, state.result.value, file);
}

async function loginShot(name, options = {}) {
  await prepare(options);
  await cdp.send('Page.navigate', { url: `${baseUrl}/login` });
  await sleep(700);
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('cairn.theme', ${JSON.stringify(options.theme || 'light')})`,
  });
  await cdp.send('Page.reload');
  await sleep(1200);
  await save(name);
}

async function authenticate() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(`Screenshot login failed (${response.status}). Check CAIRN_SHOT_PASSWORD.`);
  }
  const cookies = response.headers.getSetCookie();
  if (!cookies.length) throw new Error('Screenshot login returned no cookies.');
  for (const entry of cookies) {
    const [pair] = entry.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    await cdp.send('Network.setCookie', {
      name,
      value,
      url: baseUrl,
      path: '/',
      httpOnly: name === 'cairn_session',
      sameSite: 'Strict',
    });
  }
}

async function shot(name, route, options = {}) {
  await prepare(options);
  await cdp.send('Page.navigate', { url: `${baseUrl}/` });
  await sleep(700);
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('cairn.theme', ${JSON.stringify(options.theme || 'light')})`,
  });
  await cdp.send('Page.reload');
  await sleep(1800);
  await cdp.send('Page.navigate', { url: `${baseUrl}/${route}` });
  await sleep(2000);
  await save(name);
}

if (!noAuth) {
  await loginShot('login');
  await loginShot('login-dark', { theme: 'dark' });
  await loginShot('login-mobile', { width: 390, height: 844, mobile: true });
  await authenticate();
}

await shot('home', '#/home');
await shot('home-dark', '#/home', { theme: 'dark' });
await shot('graph', '#/graph');
await shot('decisions', '#/decisions');
await shot('timeline', '#/timeline');
await shot('messages', '#/messages');
await shot('agents', '#/agents');
await shot('setup', '#/setup');
await shot('projects', '#/projects');
await shot('mobile', '#/home', { width: 390, height: 844, mobile: true });
await shot('mobile-nav', '#/home', { width: 390, height: 844, mobile: true });

await cdp.ws.close();
chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  // Chrome may still hold the profile open briefly.
}
