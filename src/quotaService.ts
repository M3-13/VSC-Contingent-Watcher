import * as vscode from 'vscode';
import { parseCopilotUser } from './core/parse';
import { QuotaSnapshot } from './core/types';

const ENDPOINT = 'https://api.github.com/copilot_internal/user';
const SCOPES = ['user:email'];

export type FetchResult =
  | { kind: 'ok'; snapshot: QuotaSnapshot }
  | { kind: 'signedOut' }
  | { kind: 'noCopilot' }
  | { kind: 'error'; message: string };

/**
 * Reads the Copilot quota using the GitHub session VS Code already has
 * (the same one Copilot uses). No token is stored by this extension.
 */
export class QuotaService {
  async getSession(interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession('github', SCOPES, interactive ? { createIfNone: true } : { silent: true });
    } catch {
      return undefined;
    }
  }

  async fetch(interactive = false): Promise<FetchResult> {
    const session = await this.getSession(interactive);
    if (!session) {
      return { kind: 'signedOut' };
    }
    try {
      const res = await fetch(ENDPOINT, {
        headers: {
          Authorization: `token ${session.accessToken}`,
          Accept: 'application/json',
          'User-Agent': 'copilot-contingent-watcher',
          'Editor-Version': `vscode/${vscode.version}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) {
        return { kind: 'signedOut' };
      }
      if (res.status === 403 || res.status === 404) {
        return { kind: 'noCopilot' };
      }
      if (!res.ok) {
        return { kind: 'error', message: `HTTP ${res.status}` };
      }
      const snapshot = parseCopilotUser(await res.json());
      return snapshot ? { kind: 'ok', snapshot } : { kind: 'noCopilot' };
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
}
