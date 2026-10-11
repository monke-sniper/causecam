import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request, type Route } from 'playwright';
import { log } from '../config.js';
import { newSessionId, newSpanId, newTraceId, traceparent } from '../core/ids.js';
import { redactUrl, sanitizeText } from '../core/redact.js';
import type { TraceStore } from '../core/store.js';
import type { ActionType, BrowserEvent, ElementMeta, InteractionRecord, NetworkRecord, TargetSpec, TraceRecord } from '../core/types.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ACTION_TIMEOUT_MS = 10_000;
const SETTLE_QUIET_MS = 350;
const SETTLE_MAX_MS = 8_000;

/** True for loopback hosts only: localhost, *.localhost, 127.0.0.0/8 and ::1. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h) || h === '[::1]' || h === '::1';
}

/** Validate that a capture target is an http(s) URL on a loopback host, without embedded credentials. */
export function validateLocalUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) URLs are supported, got ${u.protocol}`);
  if (!isLocalHost(u.hostname)) {
    throw new Error(`Refusing to capture ${u.origin}: the MVP only allows local origins (localhost, *.localhost, 127.0.0.1, [::1]).`);
  }
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed.');
  return u;
}

export interface SessionOptions {
  url: string;
  allowMutations: boolean;
  extraOrigins?: string[];
  headed?: boolean;
}

export interface ActionInput {
  action: ActionType;
  target?: TargetSpec;
  url?: string;
  value?: string;
  key?: string;
}

export interface ActionResult {
  sessionId: string;
  interactionId: string;
  traceId: string;
  action: ActionType;
  error?: string;
  pageUrl: string;
  requests: { method: string; path: string; outcome: string }[];
  blocked: number;
  consoleErrors: number;
  backendSpans: number;
}

interface Window {
  traceId: string;
  interaction: InteractionRecord;
  network: NetworkRecord[];
  events: BrowserEvent[];
  pending: Set<Request>;
}

interface Tracked {
  rec: NetworkRecord;
  traceId: string;
  window?: Window;
}

/**
 * A capture session: one dedicated Chromium browser, one page, an allowlist of local origins and a
 * mutation policy. Every request the page makes goes through `context.route`, where CAUSECAM:
 *  - blocks non-allowlisted origins,
 *  - blocks non-GET/HEAD/OPTIONS requests unless the session allows mutations,
 *  - injects a W3C `traceparent` header carrying the action's trace id and a per-request span id,
 *    which is what lets backend spans be linked to the request explicitly.
 */
export class BrowserSession {
  readonly id = newSessionId();
  readonly origin: string;
  readonly allowedOrigins: Set<string>;
  readonly allowMutations: boolean;
  readonly startedAt = Date.now();
  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private seq = 0;
  private active?: Window;
  private busy = false;
  private closed = false;
  private backendSeen = false;
  private readonly tracked = new WeakMap<Request, Tracked>();

  private constructor(
    private readonly store: TraceStore,
    private readonly opts: SessionOptions,
  ) {
    const start = validateLocalUrl(opts.url);
    this.origin = start.origin;
    this.allowedOrigins = new Set([start.origin, ...(opts.extraOrigins ?? []).map((o) => validateLocalUrl(o).origin)]);
    this.allowMutations = opts.allowMutations;
  }

  static async start(store: TraceStore, opts: SessionOptions): Promise<{ session: BrowserSession; initial: ActionResult }> {
    const s = new BrowserSession(store, opts);
    s.browser = await chromium.launch({ headless: !opts.headed });
    try {
      s.context = await s.browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      await s.context.route('**/*', (route, request) => s.onRoute(route, request));
      s.page = await s.context.newPage();
      s.attachListeners();
      store.createSession({
        sessionId: s.id,
        origin: s.origin,
        allowedOrigins: [...s.allowedOrigins],
        allowMutations: s.allowMutations,
        startedAt: s.startedAt,
      });
      const initial = await s.perform({ action: 'navigate', url: opts.url });
      return { session: s, initial };
    } catch (e) {
      await s.browser.close().catch(() => undefined);
      throw e;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pageUrl(): string {
    return this.page && !this.page.isClosed() ? redactUrl(this.page.url()) : '(closed)';
  }

  get interactionCount(): number {
    return this.seq;
  }

  // -- request interception -------------------------------------------------

  private track(request: Request): Tracked {
    let t = this.tracked.get(request);
    if (t) return t;
    const w = this.active;
    const rec: NetworkRecord = {
      requestSpanId: newSpanId(),
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: request.resourceType(),
      startedAt: Date.now(),
      traceparentInjected: false,
    };
    const prev = request.redirectedFrom();
    if (prev) rec.redirectedFrom = redactUrl(prev.url());
    t = { rec, traceId: w ? w.traceId : newTraceId(), ...(w ? { window: w } : {}) };
    if (w) {
      w.network.push(rec);
      w.pending.add(request);
    }
    this.tracked.set(request, t);
    return t;
  }

  private async onRoute(route: Route, request: Request): Promise<void> {
    const t = this.track(request);
    let origin: string;
    try {
      origin = new URL(request.url()).origin;
    } catch {
      return route.continue();
    }
    if (!this.allowedOrigins.has(origin)) {
      t.rec.blocked = 'external-origin';
      return route.abort('blockedbyclient');
    }
    if (!SAFE_METHODS.has(request.method()) && !this.allowMutations) {
      t.rec.blocked = 'mutation-not-permitted';
      return route.abort('blockedbyclient');
    }
    try {
      const headers = { ...(await request.allHeaders()), traceparent: traceparent(t.traceId, t.rec.requestSpanId) };
      t.rec.traceparentInjected = true;
      await route.continue({ headers });
    } catch (e) {
      log('route.continue failed:', (e as Error).message);
    }
  }

  private finish(request: Request, failure?: string): void {
    const t = this.track(request);
    t.rec.endedAt ??= Date.now();
    if (failure && !t.rec.blocked) t.rec.failure = sanitizeText(failure, 200);
    if (t.window) t.window.pending.delete(request);
    else this.saveBackground({ network: [t.rec], events: [], traceId: t.traceId, startedAt: t.rec.startedAt });
  }

  private attachListeners(): void {
    this.context.on('request', (r) => void this.track(r));
    this.context.on('response', (res) => {
      const t = this.track(res.request());
      t.rec.status = res.status();
    });
    this.context.on('requestfinished', (r) => this.finish(r));
    this.context.on('requestfailed', (r) => this.finish(r, r.failure()?.errorText ?? 'failed'));

    const event = (type: BrowserEvent['type'], text: string, stack?: string) => {
      const e: BrowserEvent = { ts: Date.now(), type, text: sanitizeText(text, 500) };
      if (stack) e.stack = sanitizeText(stack, 2000, true);
      if (this.active) this.active.events.push(e);
      else if (type !== 'navigation') this.saveBackground({ network: [], events: [e], traceId: newTraceId(), startedAt: e.ts });
    };
    this.page.on('console', (m) => {
      if (m.type() === 'error') event('console-error', m.text());
      else if (m.type() === 'warning') event('console-warning', m.text());
    });
    this.page.on('pageerror', (err) => event('page-error', `${err.name}: ${err.message}`, err.stack));
    this.page.on('framenavigated', (f) => {
      if (f === this.page.mainFrame()) event('navigation', redactUrl(f.url()));
    });
    this.page.on('dialog', (d) => {
      event('dialog', `${d.type()}: ${d.message()}`);
      void d.dismiss().catch(() => undefined);
    });
    this.page.on('close', () => {
      this.closed = true;
    });
  }

  private saveBackground(p: { network: NetworkRecord[]; events: BrowserEvent[]; traceId: string; startedAt: number }): void {
    try {
      this.store.saveTrace({
        traceId: p.traceId,
        sessionId: this.id,
        kind: 'background',
        startedAt: p.startedAt,
        endedAt: Date.now(),
        network: p.network,
        events: p.events,
        pageUrlBefore: this.pageUrl,
      });
    } catch (e) {
      log('failed to save background trace:', (e as Error).message);
    }
  }

  // -- actions --------------------------------------------------------------

  async perform(input: ActionInput): Promise<ActionResult> {
    if (this.closed) throw new Error(`Session ${this.id} is closed.`);
    if (this.busy) throw new Error(`Session ${this.id} is already performing an action.`);
    this.busy = true;
    try {
      const interaction: InteractionRecord = { id: `int_${++this.seq}`, type: input.action, startedAt: Date.now(), endedAt: 0 };
      if (input.target) interaction.target = input.target;
      const w: Window = { traceId: newTraceId(), interaction, network: [], events: [], pending: new Set() };
      const pageUrlBefore = this.pageUrl;
      this.active = w;
      try {
        await this.execute(input, interaction);
      } catch (e) {
        interaction.error = sanitizeText((e as Error).message.split('\n')[0] ?? 'action failed', 300);
      }
      interaction.endedAt = Date.now();
      await this.settle(w);
      this.active = undefined;
      const backendSpans = await this.waitForSpans(w);

      const record: TraceRecord = {
        traceId: w.traceId,
        sessionId: this.id,
        kind: 'interaction',
        interaction,
        pageUrlBefore,
        pageUrlAfter: this.pageUrl,
        startedAt: interaction.startedAt,
        // End of observed activity, excluding CAUSECAM's own settle/span-wait time.
        endedAt: Math.max(interaction.endedAt, ...w.network.map((n) => n.endedAt ?? n.startedAt), ...w.events.map((e) => e.ts)),
        network: w.network,
        events: w.events,
      };
      this.store.saveTrace(record);

      const result: ActionResult = {
        sessionId: this.id,
        interactionId: interaction.id,
        traceId: w.traceId,
        action: input.action,
        pageUrl: this.pageUrl,
        requests: w.network.map((n) => ({ method: n.method, path: pathOf(n.url), outcome: n.blocked ? `blocked (${n.blocked})` : n.failure ? 'failed' : String(n.status ?? 'pending') })),
        blocked: w.network.filter((n) => n.blocked).length,
        consoleErrors: w.events.filter((e) => e.type === 'console-error' || e.type === 'page-error').length,
        backendSpans,
      };
      if (interaction.error) result.error = interaction.error;
      return result;
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  private async execute(input: ActionInput, ia: InteractionRecord): Promise<void> {
    switch (input.action) {
      case 'navigate': {
        if (!input.url) throw new Error('navigate requires url');
        const u = validateLocalUrl(new URL(input.url, this.page.url() === 'about:blank' ? this.origin : this.page.url()).toString());
        if (!this.allowedOrigins.has(u.origin)) throw new Error(`Origin ${u.origin} is not allowed in this session.`);
        ia.url = redactUrl(u.toString());
        await this.page.goto(u.toString(), { waitUntil: 'load', timeout: ACTION_TIMEOUT_MS });
        return;
      }
      case 'click':
      case 'fill':
      case 'select':
      case 'press': {
        if (input.action === 'press' && !input.target) {
          if (!input.key) throw new Error('press requires key');
          ia.key = input.key;
          await this.page.keyboard.press(input.key);
          return;
        }
        const loc = this.locate(input.target);
        ia.element = await describeElement(loc);
        if (input.action === 'click') await loc.click({ timeout: ACTION_TIMEOUT_MS });
        else if (input.action === 'fill') {
          if (input.value === undefined) throw new Error('fill requires value');
          ia.valueLength = input.value.length;
          await loc.fill(input.value, { timeout: ACTION_TIMEOUT_MS });
        } else if (input.action === 'select') {
          if (input.value === undefined) throw new Error('select requires value');
          ia.valueLength = input.value.length;
          await loc.selectOption(input.value, { timeout: ACTION_TIMEOUT_MS });
        } else {
          if (!input.key) throw new Error('press requires key');
          ia.key = input.key;
          await loc.press(input.key, { timeout: ACTION_TIMEOUT_MS });
        }
        return;
      }
    }
  }

  private locate(t: TargetSpec | undefined): Locator {
    if (!t) throw new Error('This action requires a target (testId, role+name, label, text or css).');
    if (t.testId) return this.page.getByTestId(t.testId);
    if (t.role) return this.page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name } : {});
    if (t.label) return this.page.getByLabel(t.label);
    if (t.text) return this.page.getByText(t.text);
    if (t.css) return this.page.locator(t.css);
    throw new Error('Target must specify one of testId, role, label, text or css.');
  }

  /** Wait until the action's requests have finished and the network has been quiet for a short period. */
  private async settle(w: Window): Promise<void> {
    const deadline = Date.now() + SETTLE_MAX_MS;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (w.pending.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= SETTLE_QUIET_MS) return;
      await sleep(40);
    }
  }

  /** Backend spans are exported when they end, slightly after the response; wait briefly for them. */
  private async waitForSpans(w: Window): Promise<number> {
    const expected = w.network.filter((n) => n.traceparentInjected && n.endedAt && !STATIC.has(n.resourceType)).map((n) => n.requestSpanId);
    if (!expected.length) return this.store.spanStats(w.traceId).count;
    const deadline = Date.now() + (this.backendSeen ? 3000 : 1500);
    while (Date.now() < deadline) {
      const parents = this.store.serverSpanParents(w.traceId);
      if (expected.every((id) => parents.has(id))) break;
      await sleep(50);
    }
    // children are exported before their server span ends, but allow stragglers
    let last = this.store.spanStats(w.traceId);
    for (let i = 0; i < 6; i++) {
      await sleep(50);
      const now = this.store.spanStats(w.traceId);
      if (now.count === last.count) break;
      last = now;
    }
    if (last.count > 0) this.backendSeen = true;
    return last.count;
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.store.endSession(this.id, Date.now());
  }
}

const STATIC = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack']);

async function describeElement(loc: Locator): Promise<ElementMeta> {
  const meta: ElementMeta = {};
  try {
    const info = await loc.evaluate(
      (el) => ({ tag: el.tagName.toLowerCase(), testId: el.getAttribute('data-testid'), role: el.getAttribute('role') }),
      undefined,
      { timeout: ACTION_TIMEOUT_MS },
    );
    meta.tag = info.tag;
    if (info.testId) meta.testId = sanitizeText(info.testId, 80);
    if (info.role) meta.role = sanitizeText(info.role, 40);
    const snap = (await loc.ariaSnapshot({ timeout: 2000 })).split('\n')[0] ?? '';
    const m = /^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(snap);
    if (m) {
      meta.role = m[1];
      if (m[2]) meta.name = sanitizeText(m[2].replace(/\\"/g, '"'), 80);
    }
  } catch {
    /* element metadata is best-effort; the action itself reports failures */
  }
  return meta;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
