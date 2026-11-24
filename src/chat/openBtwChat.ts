/**
 * Opens a separate chat tab with `@btw ` typed in, so a side question never waits
 * for a busy agent in the main chat (and the main chat stays untouched).
 */
import * as vscode from 'vscode';
import { pickNewChatEditorCommand } from './chatCommands';

const PREFILL = '@btw ';
const TYPE_DELAY_MS = 150;
const FALLBACK_INFO_KEY = 'contingentWatcher.btw.fallbackInfoShown';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 'newTab': a new chat editor was opened and `@btw ` typed into it.
 * 'fallback': no such command; `@btw ` was put into the main chat instead.
 */
export async function openBtwChat(log?: vscode.LogOutputChannel): Promise<'newTab' | 'fallback'> {
  let commands: string[] = [];
  try {
    commands = await vscode.commands.getCommands(true);
  } catch {
    // ignore: fall back below
  }
  const id = pickNewChatEditorCommand(commands);
  if (id) {
    try {
      await vscode.commands.executeCommand(id);
      log?.info(`btw: opened a new chat tab with ${id}`);
      await delay(TYPE_DELAY_MS);
      try {
        // Types into the focused chat input of the new tab.
        await vscode.commands.executeCommand('type', { text: PREFILL });
      } catch (err) {
        log?.warn(`btw: could not prefill @btw (${errText(err)})`);
      }
      return 'newTab';
    } catch (err) {
      log?.warn(`btw: ${id} failed (${errText(err)}); using the main chat`);
    }
  } else {
    log?.info('btw: no command to open a new chat tab found; using the main chat');
  }
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: PREFILL, isPartialQuery: true });
  return 'fallback';
}

/** Command handler: {@link openBtwChat}, with a one-time hint when only the main chat could be used. */
export async function openBtwChatCommand(context: vscode.ExtensionContext, log?: vscode.LogOutputChannel): Promise<void> {
  const result = await openBtwChat(log);
  if (result === 'fallback' && !context.globalState.get<boolean>(FALLBACK_INFO_KEY)) {
    await context.globalState.update(FALLBACK_INFO_KEY, true);
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Your VS Code version can't open a separate chat tab; @btw was put into the main chat."),
    );
  }
}
