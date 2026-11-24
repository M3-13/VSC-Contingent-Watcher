import * as vscode from 'vscode';
import { apiBaseFor, resolveTargets } from './auth';
import { ModelUsage, parseModelUsage } from './core/billing';
import { githubWebBase } from './signIn';

const SECRET_KEY = 'contingentWatcher.billingToken';
const CACHE_MS = 30 * 60 * 1000;

export type ModelUsageState =
  | { state: 'notConfigured' }
  | { state: 'loading' }
  | { state: 'ok'; items: ModelUsage[]; period: Date }
  | { state: 'error'; message: string };

/**
 * Optional per-model usage from GitHub's official billing API. Needs a
 * fine-grained token with "Plan" (read) permission, kept in SecretStorage.
 */
export class BillingService {
  private current: ModelUsageState = { state: 'notConfigured' };
  private fetchedAt = 0;
  private hasToken = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.LogOutputChannel,
  ) {
    void this.secrets.get(SECRET_KEY).then((t) => {
      this.hasToken = !!t;
      if (t) {
        void this.refresh(true);
      }
    });
  }

  get state(): ModelUsageState {
    return this.current;
  }

  get tokenSet(): boolean {
    return this.hasToken;
  }

  private set(s: ModelUsageState): void {
    this.current = s;
    this.changed.fire();
  }

  async configure(): Promise<void> {
    const create = vscode.l10n.t('Create token on GitHub');
    const enter = vscode.l10n.t('Enter token');
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('Per-model usage needs a fine-grained GitHub token with the account permission "Plan" (read). It is stored securely in VS Code.'),
      enter,
      create,
    );
    if (choice === create) {
      await vscode.env.openExternal(vscode.Uri.parse(`${githubWebBase()}/settings/personal-access-tokens/new`));
    } else if (choice !== enter) {
      return;
    }
    const token = await vscode.window.showInputBox({
      title: vscode.l10n.t('GitHub token for per-model usage'),
      prompt: vscode.l10n.t('Fine-grained token with "Plan" (read) permission'),
      placeHolder: 'github_pat_…',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token?.trim()) {
      return;
    }
    await this.secrets.store(SECRET_KEY, token.trim());
    this.hasToken = true;
    await this.refresh(true);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this.hasToken = false;
    this.set({ state: 'notConfigured' });
  }

  /** Refreshes at most every 30 minutes unless forced. */
  async refresh(force = false): Promise<void> {
    const token = await this.secrets.get(SECRET_KEY);
    this.hasToken = !!token;
    if (!token) {
      this.set({ state: 'notConfigured' });
      return;
    }
    if (!force && Date.now() - this.fetchedAt < CACHE_MS && this.current.state === 'ok') {
      return;
    }
    this.set({ state: 'loading' });
    const base = apiBaseFor(resolveTargets()[0]);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'copilot-contingent-watcher',
    };
    try {
      const me = await fetch(`${base}/user`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!me.ok) {
        throw new Error(me.status === 401 ? vscode.l10n.t('Token invalid or expired') : `HTTP ${me.status}`);
      }
      const login = ((await me.json()) as { login?: string }).login;
      const now = new Date();
      const url = `${base}/users/${encodeURIComponent(login ?? '')}/settings/billing/premium_request/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      this.log.info(`[billing] GET premium_request/usage → ${res.status}`);
      if (!res.ok) {
        this.log.warn(`[billing] response: ${(await res.text()).slice(0, 300)}`);
        throw new Error(res.status === 403 ? vscode.l10n.t('Token lacks the "Plan" (read) permission') : `HTTP ${res.status}`);
      }
      this.fetchedAt = Date.now();
      this.set({ state: 'ok', items: parseModelUsage(await res.json()), period: now });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`[billing] ${message}`);
      this.set({ state: 'error', message });
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
