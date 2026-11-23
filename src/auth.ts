import * as vscode from 'vscode';
import { SECTION } from './config';
import { apiBaseForHost } from './core/endpoints';

export type ProviderId = 'github' | 'github-enterprise';

export interface AuthTarget {
  provider: ProviderId;
  /** Host for GitHub Enterprise (GHE.com tenant or GHES), undefined for github.com. */
  enterpriseHost?: string;
  /** Explicit API base URL override. */
  apiUrl?: string;
}

function enterpriseHost(): string | undefined {
  // Same setting VS Code's GitHub Enterprise auth provider and Copilot use.
  const uri = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
  if (!uri) {
    return undefined;
  }
  try {
    return new URL(uri.includes('://') ? uri : `https://${uri}`).host;
  } catch {
    return undefined;
  }
}

function copilotUsesEnterprise(): boolean {
  return vscode.workspace.getConfiguration('github.copilot').get<string>('advanced.authProvider') === 'github-enterprise';
}

/**
 * Ordered list of targets to try. In "auto" mode we follow Copilot's own
 * configuration and fall back to the other provider if no session exists.
 */
export function resolveTargets(): AuthTarget[] {
  const c = vscode.workspace.getConfiguration(SECTION);
  const mode = c.get<'auto' | ProviderId>('auth.provider', 'auto');
  const apiUrl = c.get<string>('auth.apiUrl')?.trim() || undefined;
  const host = enterpriseHost();
  const gh: AuthTarget = { provider: 'github', apiUrl };
  const ghe: AuthTarget = { provider: 'github-enterprise', enterpriseHost: host, apiUrl };

  if (mode === 'github') {
    return [gh];
  }
  if (mode === 'github-enterprise') {
    return [ghe];
  }
  const preferEnterprise = copilotUsesEnterprise() || !!host;
  if (preferEnterprise) {
    return host ? [ghe, gh] : [ghe];
  }
  return host ? [gh, ghe] : [gh];
}

export function apiBaseFor(t: AuthTarget): string {
  if (t.apiUrl) {
    return t.apiUrl.replace(/\/+$/, '');
  }
  return t.provider === 'github-enterprise' && t.enterpriseHost ? apiBaseForHost(t.enterpriseHost) : 'https://api.github.com';
}
