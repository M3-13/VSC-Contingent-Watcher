/**
 * QA helper (not a test file): a small fake of the `vscode` API, enough to load
 * out/extension.js and call activate(). Records what the extension does
 * (status bar, notifications, configuration writes, webview messages, external
 * URLs, executed commands) so tests can assert on it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');

export const ROOT = path.resolve(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DE_BUNDLE: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.de.json'), 'utf8'));

type Listener<T> = (e: T) => any;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      l(e);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

class Disposable {
  constructor(private readonly fn: () => any = () => undefined) {}
  static from(...items: { dispose(): any }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i?.dispose?.()));
  }
  dispose(): void {
    this.fn();
  }
}

class Uri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = '',
  ) {}
  get fsPath(): string {
    return this.path;
  }
  static parse(s: string): Uri {
    const u = new URL(s);
    return new Uri(u.protocol.replace(':', ''), u.host, u.pathname, u.search.replace(/^\?/, ''));
  }
  static file(p: string): Uri {
    return new Uri('file', '', p);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...parts));
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`;
  }
  with(change: Partial<Uri>): Uri {
    return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query);
  }
}

class MarkdownString {
  isTrusted: any;
  supportThemeIcons: boolean;
  constructor(
    public value = '',
    supportThemeIcons = false,
  ) {
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
  appendText(s: string): this {
    this.value += s;
    return this;
  }
}

class ThemeColor {
  constructor(readonly id: string) {}
}

class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range,
  ) {}
}

class LanguageModelError extends Error {
  code = 'Unknown';
  static NoPermissions() {
    return undefined;
  }
  static Blocked() {
    return undefined;
  }
  static NotFound() {
    return undefined;
  }
}

export class Memento {
  readonly data = new Map<string, any>();
  get<T>(key: string, def?: T): T {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : (def as T);
  }
  async update(key: string, value: any): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, structuredClone(value));
    }
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
  setKeysForSync(): void {
    // not needed
  }
}

export interface Notification {
  level: 'info' | 'warning' | 'error';
  message: string;
  items: string[];
}

/** Manifest defaults for the extension's own settings. */
const MANIFEST_DEFAULTS: Record<string, any> = {};
for (const [k, v] of Object.entries<any>(PKG.contributes.configuration.properties)) {
  MANIFEST_DEFAULTS[k] = v.default;
}

export interface FakeEnv {
  vscode: any;
  /** Full-key (e.g. "contingentWatcher.budget.workDays") user values. */
  config: Map<string, any>;
  configWrites: { key: string; value: any; target: any }[];
  /** Keys read via get() that are neither in the manifest nor set by the test. */
  unknownConfigReads: Set<string>;
  notifications: Notification[];
  /** Answer for the next notification(s); a function gets the notification. */
  notificationAnswer: (n: Notification) => string | undefined;
  statusItems: any[];
  statusMessages: string[];
  commands: Map<string, (...a: any[]) => any>;
  executed: { id: string; args: any[] }[];
  externalUrls: string[];
  viewProviders: Map<string, any>;
  webviewPanels: any[];
  quickPickAnswer: (items: any[], opts: any) => any;
  inputBoxAnswer: (opts: any) => string | undefined;
  session: { accessToken: string; account: { label: string; id: string }; id: string; scopes: string[] } | undefined;
  sessionRequests: { provider: string; scopes: string[]; opts: any }[];
  l10nCalls: Set<string>;
  untranslated: Set<string>;
  logs: string[];
  locale: string;
  extensions: Map<string, any>;
  secrets: Map<string, string>;
  chatParticipants: Map<string, any>;
  fireConfigChange(keys: string[]): void;
  windowState: { focused: boolean };
}

function format(s: string, args: any[]): string {
  return s.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

export function createFakeVscode(locale = 'en'): FakeEnv {
  const configChange = new EventEmitter<any>();
  const windowStateChange = new EventEmitter<any>();
  const sessionsChange = new EventEmitter<any>();
  const extensionsChange = new EventEmitter<void>();
  const env: FakeEnv = {
    vscode: undefined,
    config: new Map(),
    configWrites: [],
    unknownConfigReads: new Set(),
    notifications: [],
    notificationAnswer: () => undefined,
    statusItems: [],
    statusMessages: [],
    commands: new Map(),
    executed: [],
    externalUrls: [],
    viewProviders: new Map(),
    webviewPanels: [],
    quickPickAnswer: () => undefined,
    inputBoxAnswer: () => undefined,
    session: { accessToken: 'gho_test', account: { label: 'octocat', id: '1' }, id: 's1', scopes: ['user:email'] },
    sessionRequests: [],
    l10nCalls: new Set(),
    untranslated: new Set(),
    logs: [],
    locale,
    extensions: new Map(),
    secrets: new Map(),
    chatParticipants: new Map(),
    windowState: { focused: true },
    fireConfigChange(keys: string[]) {
      configChange.fire({ affectsConfiguration: (s: string) => keys.some((k) => k === s || k.startsWith(`${s}.`) || s.startsWith(`${k}.`)) });
    },
  };

  const notify = (level: Notification['level']) => async (message: string, ...rest: any[]) => {
    const items = rest.filter((x) => typeof x === 'string');
    const n = { level, message, items };
    env.notifications.push(n);
    return env.notificationAnswer(n);
  };

  const logChannel = (name: string) => {
    const rec = (lvl: string) => (m: string) => env.logs.push(`[${lvl}] ${m}`);
    return {
      name,
      trace: rec('trace'),
      debug: rec('debug'),
      info: rec('info'),
      warn: rec('warn'),
      error: rec('error'),
      append: rec('append'),
      appendLine: rec('line'),
      show: () => env.logs.push('[show]'),
      hide: () => undefined,
      clear: () => undefined,
      dispose: () => undefined,
      onDidChangeLogLevel: new EventEmitter<any>().event,
      logLevel: 2,
    };
  };

  const getConfiguration = (section?: string) => {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    return {
      get(key: string, def?: any) {
        const k = full(key);
        if (env.config.has(k)) {
          return structuredClone(env.config.get(k));
        }
        if (k in MANIFEST_DEFAULTS) {
          return structuredClone(MANIFEST_DEFAULTS[k]);
        }
        if (k.startsWith('contingentWatcher.')) {
          env.unknownConfigReads.add(k);
        }
        return def;
      },
      has(key: string) {
        return env.config.has(full(key)) || full(key) in MANIFEST_DEFAULTS;
      },
      inspect(key: string) {
        const k = full(key);
        return { key: k, defaultValue: MANIFEST_DEFAULTS[k], globalValue: env.config.get(k) };
      },
      async update(key: string, value: any, target: any) {
        const k = full(key);
        env.configWrites.push({ key: k, value: structuredClone(value), target });
        if (value === undefined) {
          env.config.delete(k);
        } else {
          env.config.set(k, structuredClone(value));
        }
        env.fireConfigChange([k]);
      },
    };
  };

  const vscode: any = {
    version: '1.99.0',
    EventEmitter,
    Disposable,
    Uri,
    MarkdownString,
    ThemeColor,
    CancellationTokenSource,
    CancellationError: class extends Error {},
    Position,
    Range,
    Location,
    LanguageModelError,
    LanguageModelChatMessage: { User: (c: string) => ({ role: 1, content: c }), Assistant: (c: string) => ({ role: 2, content: c }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    l10n: {
      t(message: any, ...args: any[]) {
        const msg = typeof message === 'string' ? message : message.message;
        const a = typeof message === 'string' ? (args.length === 1 && Array.isArray(args[0]) ? args[0] : args) : (message.args ?? []);
        env.l10nCalls.add(msg);
        let s = msg;
        if (env.locale.startsWith('de')) {
          if (DE_BUNDLE[msg] === undefined) {
            env.untranslated.add(msg);
          } else {
            s = DE_BUNDLE[msg];
          }
        }
        return format(s, a);
      },
    },
    env: {
      get language() {
        return env.locale;
      },
      appName: 'Visual Studio Code',
      openExternal: async (u: any) => {
        env.externalUrls.push(String(u));
        return true;
      },
      clipboard: { writeText: async () => undefined, readText: async () => '' },
    },
    window: {
      state: env.windowState,
      activeTextEditor: undefined,
      visibleTextEditors: [],
      createStatusBarItem(id: string, alignment: number, priority: number) {
        const item: any = { id, alignment, priority, text: '', tooltip: undefined, color: undefined, backgroundColor: undefined, command: undefined, visible: false, disposed: false };
        item.show = () => (item.visible = true);
        item.hide = () => (item.visible = false);
        item.dispose = () => (item.disposed = true);
        env.statusItems.push(item);
        return item;
      },
      createOutputChannel: (name: string) => logChannel(name),
      showInformationMessage: notify('info'),
      showWarningMessage: notify('warning'),
      showErrorMessage: notify('error'),
      setStatusBarMessage: (m: string) => {
        env.statusMessages.push(m);
        return new Disposable();
      },
      showQuickPick: async (items: any, opts: any) => env.quickPickAnswer(await items, opts),
      showInputBox: async (opts: any) => {
        const v = env.inputBoxAnswer(opts);
        if (v !== undefined && opts?.validateInput) {
          const err = await opts.validateInput(v);
          if (err) {
            return undefined;
          }
        }
        return v;
      },
      registerWebviewViewProvider(id: string, provider: any) {
        env.viewProviders.set(id, provider);
        return new Disposable(() => env.viewProviders.delete(id));
      },
      createWebviewPanel(viewType: string, title: string, showOptions: any, options: any) {
        const p = fakeWebviewPanel(viewType, title, showOptions, options);
        env.webviewPanels.push(p);
        return p;
      },
      onDidChangeWindowState: windowStateChange.event,
      onDidChangeActiveTextEditor: new EventEmitter<any>().event,
      onDidChangeTextEditorSelection: new EventEmitter<any>().event,
      tabGroups: { all: [] },
    },
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: configChange.event,
      onDidChangeTextDocument: new EventEmitter<any>().event,
      workspaceFolders: undefined,
      textDocuments: [],
      openTextDocument: async () => {
        throw new Error('no documents in fake');
      },
      asRelativePath: (u: any) => String(u?.path ?? u),
      fs: {
        readFile: async () => {
          throw new Error('ENOENT');
        },
        stat: async () => {
          throw new Error('ENOENT');
        },
        readDirectory: async () => {
          throw new Error('ENOENT');
        },
      },
    },
    languages: { getDiagnostics: () => [] },
    commands: {
      registerCommand(id: string, fn: (...a: any[]) => any) {
        if (env.commands.has(id)) {
          throw new Error(`command '${id}' already exists`);
        }
        env.commands.set(id, fn);
        return new Disposable(() => env.commands.delete(id));
      },
      async executeCommand(id: string, ...args: any[]) {
        env.executed.push({ id, args });
        const fn = env.commands.get(id);
        return fn ? fn(...args) : undefined;
      },
      getCommands: async () => [...env.commands.keys(), 'workbench.action.chat.open', 'github.copilot.completions.snooze'],
    },
    authentication: {
      async getSession(provider: string, scopes: string[], opts: any) {
        env.sessionRequests.push({ provider, scopes, opts });
        if (!env.session) {
          return undefined;
        }
        if (opts?.silent && !env.session.scopes.every((s) => scopes.includes(s))) {
          return undefined;
        }
        return env.session;
      },
      onDidChangeSessions: sessionsChange.event,
    },
    extensions: {
      getExtension: (id: string) => env.extensions.get(id),
      get all() {
        return [...env.extensions.values()];
      },
      onDidChange: extensionsChange.event,
    },
    chat: {
      createChatParticipant(id: string, handler: any) {
        const p = { id, handler, iconPath: undefined, dispose: () => env.chatParticipants.delete(id) };
        env.chatParticipants.set(id, p);
        return p;
      },
    },
    lm: { selectChatModels: async () => [] },
  };
  env.vscode = vscode;
  return env;
}

export function fakeWebview() {
  const recv = new EventEmitter<any>();
  const wv: any = {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    posted: [] as any[],
    asWebviewUri: (u: any) => u,
    onDidReceiveMessage: recv.event,
    postMessage: async (m: any) => {
      wv.posted.push(structuredClone(m));
      return true;
    },
    /** Simulates a message from the webview script. */
    send: (m: any) => recv.fire(m),
  };
  return wv;
}

export function fakeWebviewView() {
  const dispose = new EventEmitter<void>();
  const view: any = {
    webview: fakeWebview(),
    visible: true,
    onDidDispose: dispose.event,
    onDidChangeVisibility: new EventEmitter<void>().event,
    show: () => undefined,
    dispose: () => dispose.fire(),
  };
  return view;
}

function fakeWebviewPanel(viewType: string, title: string, showOptions: any, options: any) {
  const dispose = new EventEmitter<void>();
  const panel: any = {
    viewType,
    title,
    showOptions,
    options,
    webview: fakeWebview(),
    visible: true,
    reveals: 0,
    iconPath: undefined,
    reveal: () => panel.reveals++,
    onDidDispose: dispose.event,
    onDidChangeViewState: new EventEmitter<any>().event,
    dispose: () => dispose.fire(),
  };
  return panel;
}

export function fakeContext(env: FakeEnv) {
  const secretChange = new EventEmitter<any>();
  return {
    subscriptions: [] as { dispose(): any }[],
    globalState: new Memento(),
    workspaceState: new Memento(),
    secrets: {
      get: async (k: string) => env.secrets.get(k),
      store: async (k: string, v: string) => {
        env.secrets.set(k, v);
        secretChange.fire({ key: k });
      },
      delete: async (k: string) => {
        env.secrets.delete(k);
        secretChange.fire({ key: k });
      },
      onDidChange: secretChange.event,
    },
    extensionUri: Uri.file(ROOT),
    extensionPath: ROOT,
    extension: { id: 'm3-13.copilot-contingent-watcher', packageJSON: PKG, extensionUri: Uri.file(ROOT) },
    globalStorageUri: Uri.file('/tmp/qa-global-storage'),
    storageUri: undefined,
    logUri: Uri.file('/tmp/qa-log'),
    extensionMode: 3,
    asAbsolutePath: (p: string) => path.join(ROOT, p),
  };
}

const FAKE_ID = path.join(ROOT, 'out', 'test', '__fake_vscode__.js');
let hooked = false;
let current: FakeEnv | undefined;

function hook(): void {
  if (hooked) {
    return;
  }
  hooked = true;
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: any[]) {
    if (request === 'vscode') {
      return FAKE_ID;
    }
    return orig.call(this, request, ...rest);
  };
}

/**
 * Installs a fresh fake `vscode` and (re)loads the compiled extension so
 * module-level state starts clean.
 */
export function loadExtension(env: FakeEnv): any {
  hook();
  current = env;
  const m = new Module(FAKE_ID);
  m.filename = FAKE_ID;
  m.loaded = true;
  m.exports = env.vscode;
  Module._cache[FAKE_ID] = m;
  const outDir = path.join(ROOT, 'out') + path.sep;
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(outDir) && !k.includes(`${path.sep}test${path.sep}`)) {
      delete require.cache[k];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(ROOT, 'out', 'extension.js'));
}

export function currentEnv(): FakeEnv | undefined {
  return current;
}

// ------------------------------------------------------------------ fetch

export type FetchHandler = (url: string, init: any) => Promise<Response> | Response;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function stubFetch(handler: FetchHandler): { calls: { url: string; init: any }[]; restore(): void } {
  const prev = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as any;
  return { calls, restore: () => (globalThis.fetch = prev) };
}

/** Realistic copilot_internal/user bodies. */
export const BODIES = {
  requests: (remaining: number, entitlement = 300, reset = '2026-12-01') => ({
    login: 'octocat',
    copilot_plan: 'individual',
    access_type_sku: 'monthly_subscriber',
    chat_enabled: true,
    quota_reset_date: reset,
    quota_snapshots: {
      chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true, overage_count: 0, overage_permitted: false, quota_id: 'chat' },
      completions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true, overage_count: 0, overage_permitted: false, quota_id: 'completions' },
      premium_interactions: {
        entitlement,
        remaining,
        percent_remaining: (remaining / entitlement) * 100,
        unlimited: false,
        overage_count: 0,
        overage_permitted: false,
        quota_id: 'premium_interactions',
      },
    },
  }),
  credits: (creditsRemaining: number, creditsEntitlement = 3900, reqRemaining = 120) => ({
    login: 'octocat',
    copilot_plan: 'individual_pro',
    quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
    quota_snapshots: {
      chat: { unlimited: true, entitlement: 0, remaining: 0 },
      completions: { unlimited: true, entitlement: 0, remaining: 0 },
      premium_interactions: { entitlement: 300, remaining: reqRemaining, unlimited: false, overage_count: 0, overage_permitted: false },
      ai_credits: { entitlement: creditsEntitlement, remaining: creditsRemaining, unlimited: false, overage_count: 0, overage_permitted: true },
    },
  }),
  unlimited: () => ({
    login: 'octocat',
    copilot_plan: 'enterprise',
    quota_reset_date: '2026-12-01',
    quota_snapshots: {
      chat: { unlimited: true },
      completions: { unlimited: true },
      premium_interactions: { entitlement: 0, remaining: 0, unlimited: true, overage_count: 0, overage_permitted: false },
    },
  }),
};
