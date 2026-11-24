import * as vscode from 'vscode';
import { SECTION } from './config';

/** Normalises user input like "acme.ghe.com" or "https://github.acme.corp/" to an origin. */
export function normaliseHost(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname ? `https://${url.host}` : undefined;
  } catch {
    return undefined;
  }
}

/** Web URL of the user's GitHub (github.com or the enterprise host). */
export function githubWebBase(): string {
  const mode = vscode.workspace.getConfiguration(SECTION).get<string>('auth.provider', 'auto');
  const uri = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
  if (mode !== 'github' && uri) {
    return normaliseHost(uri) ?? 'https://github.com';
  }
  return 'https://github.com';
}

/**
 * Guided sign-in: lets the user pick the kind of GitHub account, configures
 * the enterprise address if needed, then triggers the sign-in.
 * Returns false if the user cancelled.
 */
export async function guidedSignIn(): Promise<boolean> {
  type Item = vscode.QuickPickItem & { kind2: 'github' | 'ghe' | 'ghes' };
  const items: Item[] = [
    {
      kind2: 'github',
      label: '$(github) GitHub.com',
      detail: vscode.l10n.t('Personal account, Copilot Business/Enterprise on github.com, Enterprise Managed Users'),
    },
    {
      kind2: 'ghe',
      label: `$(organization) ${vscode.l10n.t('GitHub Enterprise Cloud with own domain')}`,
      detail: vscode.l10n.t('Your company signs in at an address like company.ghe.com'),
    },
    {
      kind2: 'ghes',
      label: `$(server) ${vscode.l10n.t('GitHub Enterprise Server')}`,
      detail: vscode.l10n.t('Your company runs its own GitHub server, e.g. github.company.com'),
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Which GitHub account do you use Copilot with?'),
    placeHolder: vscode.l10n.t('Not sure? Check the address you use to sign in to GitHub in the browser.'),
  });
  if (!pick) {
    return false;
  }
  const own = vscode.workspace.getConfiguration(SECTION);
  const target = vscode.ConfigurationTarget.Global;
  if (pick.kind2 === 'github') {
    await own.update('auth.provider', 'github', target);
    return true;
  }
  const current = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri') ?? '';
  const value = await vscode.window.showInputBox({
    title: pick.kind2 === 'ghe' ? vscode.l10n.t('Your GHE.com address') : vscode.l10n.t('Your GitHub Enterprise Server address'),
    prompt: vscode.l10n.t('The address you open in the browser to use GitHub'),
    placeHolder: pick.kind2 === 'ghe' ? 'https://company.ghe.com' : 'https://github.company.com',
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) => (normaliseHost(v) ? undefined : vscode.l10n.t('Please enter an address like company.ghe.com')),
  });
  const host = value ? normaliseHost(value) : undefined;
  if (!host) {
    return false;
  }
  // Same setting VS Code's GitHub Enterprise sign-in and Copilot use.
  await vscode.workspace.getConfiguration('github-enterprise').update('uri', host, target);
  await own.update('auth.provider', 'github-enterprise', target);
  return true;
}
