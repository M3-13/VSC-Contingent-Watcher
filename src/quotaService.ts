import * as vscode from 'vscode';
import { parseCopilotUser, UnitPreference } from './core/parse';
import { QuotaSnapshot } from './core/types';
import { apiBaseFor, AuthTarget, resolveTargets } from './auth';

/**
 * Scope sets other extensions commonly request. VS Code's GitHub provider only
 * returns a silent session for an exact scope match, so we try each to reuse
 * the login Copilot (or GitHub PRs) already has, without showing a dialog.
 */
const SILENT_SCOPE_SETS = [['user:email'], ['read:user', 'user:email', 'repo', 'workflow'], ['repo', 'workflow', 'user:email'], ['read:user']];
const INTERACTIVE_SCOPES = ['user:email'];

export type FetchResult =
  | { kind: 'ok'; snapshot: QuotaSnapshot; target: AuthTarget }
  | { kind: 'signedOut'; target: AuthTarget }
  | { kind: 'noCopilot'; target: AuthTarget; status?: number }
  | { kind: 'error'; target: AuthTarget; message: string };

/**
 * Reads the Copilot quota using a GitHub session VS Code already has
 * (github.com or GitHub Enterprise). No token is stored by this extension.
 */
export class QuotaService {
  constructor(private readonly log: vscode.LogOutputChannel) {}

  private async session(target: AuthTarget, interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
    for (const scopes of SILENT_SCOPE_SETS) {
      try {
        const s = await vscode.authentication.getSession(target.provider, scopes, { silent: true });
        if (s) {
          this.log.debug(`[${target.provider}] reusing session (${scopes.join(' ')}) for ${s.account.label}`);
          return s;
        }
      } catch (e) {
        this.log.debug(`[${target.provider}] silent getSession(${scopes.join(' ')}) failed: ${String(e)}`);
      }
    }
    if (!interactive) {
      return undefined;
    }
    try {
      return await vscode.authentication.getSession(target.provider, INTERACTIVE_SCOPES, { createIfNone: true });
    } catch (e) {
      this.log.warn(`[${target.provider}] sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  async fetch(interactive = false): Promise<FetchResult> {
    const targets = resolveTargets();
    let first: FetchResult | undefined;
    for (const [i, target] of targets.entries()) {
      // Only the primary target may show a sign-in dialog.
      const res = await this.fetchFrom(target, interactive && i === 0);
      if (res.kind === 'ok') {
        return res;
      }
      first ??= res;
      // A real answer from the server (not just "no session") ends the search.
      if (res.kind !== 'signedOut') {
        return res;
      }
    }
    return first!;
  }

  private async fetchFrom(target: AuthTarget, interactive: boolean): Promise<FetchResult> {
    const session = await this.session(target, interactive);
    if (!session) {
      this.log.info(`[${target.provider}] no session available`);
      return { kind: 'signedOut', target };
    }
    const url = `${apiBaseFor(target)}/copilot_internal/user`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `token ${session.accessToken}`,
          Accept: 'application/json',
          'User-Agent': 'copilot-contingent-watcher',
          'Editor-Version': `vscode/${vscode.version}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      this.log.info(`[${target.provider}] GET ${url} → ${res.status}`);
      if (!res.ok) {
        // Body may explain SSO/policy issues; never contains the token.
        const body = (await res.text()).slice(0, 300);
        this.log.warn(`[${target.provider}] response: ${body}`);
        if (res.status === 401) {
          return { kind: 'signedOut', target };
        }
        if (res.status === 403 || res.status === 404) {
          return { kind: 'noCopilot', target, status: res.status };
        }
        return { kind: 'error', target, message: `HTTP ${res.status}` };
      }
      const json = await res.json();
      const snaps = (json as any)?.quota_snapshots ?? {};
      // Shapes only (no personal data): helps to see whether credits or requests are reported.
      this.log.info(
        `[${target.provider}] quotas: ${Object.entries<any>(snaps).map(([k, v]) => `${k}(entitlement=${v?.entitlement ?? '?'}, unlimited=${v?.unlimited ?? '?'})`).join(', ') || '(none)'}`,
      );
      const snapshot = parseCopilotUser(json, Date.now(), vscode.workspace.getConfiguration('contingentWatcher').get<UnitPreference>('unit', 'auto'));
      return snapshot ? { kind: 'ok', snapshot, target } : { kind: 'noCopilot', target };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`[${target.provider}] GET ${url} failed: ${message}`);
      return { kind: 'error', target, message };
    }
  }
}
