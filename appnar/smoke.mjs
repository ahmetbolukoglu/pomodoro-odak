// AppNar smoke test — opens the generated app in a real (headless) Chrome,
// records load errors, then clicks every visible button on a fresh page and
// reports buttons that do nothing and errors thrown on click.
//
// Uses playwright-core with the Chrome that GitHub's Ubuntu runners ship, so
// no browser download is needed. If either is missing the test is skipped
// (the static checks in generate.mjs still run).
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve } from 'node:path';

// UTF-8 like GitHub Pages, so Turkish labels survive even without <meta charset>.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const CHROMES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
const MAX_TARGETS = 30;

/** Minimal static file server for the repo root; resolves with its base URL. */
export function serveStatic(root) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = resolve(base, path || 'index.html');
    if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}

/** Runs inside the page: lists visible, enabled clickables in a stable order. */
function listTargets() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[aria-hidden="true"]');
  };
  return [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
    .filter((el) => !el.disabled && visible(el))
    .map((el, i) => ({
      i,
      id: el.id || null,
      label: (
        (el.getAttribute('aria-label') || el.textContent || el.value || el.title || '').replace(/\s+/g, ' ').trim() ||
        (el.className ? `.${String(el.className).split(/\s+/)[0]} (no accessible name)` : '')
      ).slice(0, 60),
      submit: (el.type === 'submit' || el.tagName === 'BUTTON' && !el.getAttribute('type')) && Boolean(el.form),
    }));
}

/** Runs inside the page: fills the button's form with plausible values, clicks it and counts DOM changes. */
async function clickTarget(index) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[aria-hidden="true"]');
  };
  const els = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')].filter((el) => !el.disabled && visible(el));
  const el = els[index];
  if (!el) return { missing: true };
  if (el.form) {
    const today = new Date().toISOString().slice(0, 10);
    for (const f of el.form.elements) {
      if (!(f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement || f instanceof HTMLSelectElement) || f.disabled || f.readOnly) continue;
      if (f instanceof HTMLSelectElement) {
        const opt = [...f.options].find((o) => o.value);
        if (opt && !f.value) f.value = opt.value;
      } else if (['checkbox', 'radio', 'hidden', 'file', 'submit', 'button', 'color', 'range'].includes(f.type)) {
        continue;
      } else if (!f.value) {
        f.value = { number: '3', date: today, 'datetime-local': `${today}T09:00`, time: '09:00', month: today.slice(0, 7), email: 'test@example.com', url: 'https://example.com', tel: '5551234567' }[f.type] ?? 'Test 1';
      }
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  let mutations = 0;
  const obs = new MutationObserver((list) => (mutations += list.length));
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const before = location.href;
  el.click();
  await new Promise((r) => setTimeout(r, 350));
  obs.disconnect();
  return { mutations, navigated: location.href !== before };
}

/**
 * @returns {Promise<{skipped?: string, loadErrors: string[], clickErrors: {label: string, errors: string[]}[], deadButtons: {label: string, id: string|null}[], checked: number}>}
 */
export async function smokeTest(root = '.', { chromePath = process.env.CHROME_PATH } = {}) {
  const report = { loadErrors: [], clickErrors: [], deadButtons: [], checked: 0 };
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return { ...report, skipped: 'playwright-core is not installed' };
  }
  const exe = chromePath ?? CHROMES.find((p) => existsSync(p));
  if (!exe) return { ...report, skipped: 'no Chrome found' };

  const server = await serveStatic(root);
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  try {
    const open = async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      let extra = 0; // dialogs and downloads count as "something happened"
      page.on('pageerror', (e) => errors.push(`Uncaught ${e.name}: ${e.message}`));
      // Resource failures are reported once, by the response handler below.
      page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console.error: ${m.text().slice(0, 300)}`));
      page.on('response', (r) => {
        const path = new URL(r.url()).pathname;
        if (r.status() >= 400 && !path.endsWith('/favicon.ico')) errors.push(`HTTP ${r.status()} for ${path}`);
      });
      page.on('dialog', (d) => {
        extra++;
        d.accept().catch(() => {});
      });
      page.on('download', () => extra++);
      await page.goto(server.url, { waitUntil: 'load', timeout: 20_000 });
      await page.waitForTimeout(400);
      return { page, errors, extras: () => extra };
    };

    const first = await open();
    report.loadErrors = [...new Set(first.errors)];
    const targets = (await first.page.evaluate(listTargets)).slice(0, MAX_TARGETS);
    await first.page.close();

    for (const t of targets) {
      const { page, errors, extras } = await open(); // fresh page: one click cannot hide the next
      errors.length = 0;
      const extraBefore = extras();
      const r = await page.evaluate(clickTarget, t.i).catch((e) => ({ failed: String(e) }));
      await page.waitForTimeout(150);
      report.checked++;
      const label = t.label || t.id || `button #${t.i + 1}`;
      if (errors.length) report.clickErrors.push({ label, errors: [...new Set(errors)].slice(0, 3) });
      else if (!r.missing && !r.failed && !r.navigated && r.mutations === 0 && extras() === extraBefore) report.deadButtons.push({ label, id: t.id });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return report;
}

/** Human-readable problem lines for the model and for AppNar's UI. */
export function describeSmoke(report) {
  const lines = [];
  for (const e of report.loadErrors) lines.push(`On page load: ${e}`);
  for (const c of report.clickErrors) lines.push(`Clicking "${c.label}" throws: ${c.errors.join(' | ')}`);
  for (const d of report.deadButtons) lines.push(`Clicking "${d.label}"${d.id ? ` (#${d.id})` : ''} does nothing visible (no DOM change, dialog or download).`);
  return lines;
}
