/**
 * Opens a separate chat tab with `@btw ` typed in, so a side question never waits
 * for a busy agent in the main chat (and the main chat stays untouched).
 */
import * as vscode from 'vscode';
import { pickNewChatEditorCommand } from './chatCommands';
import { pinOriginSession } from '../btw/context';

const PREFILL = '@btw ';
const TYPE_DELAY_MS = 150;
const FALLBACK_INFO_KEY = 'contingentWatcher.btw.fallbackInfoShown';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where the btw chat opens: floating window, split beside the editor, or a normal tab. */
type OpenIn = 'window' | 'side' | 'tab';

/** Moves the just-opened (active) chat editor so it stays visible next to your work. */
async function placeEditor(openIn: OpenIn, log?: vscode.LogOutputChannel): Promise<void> {
  const command =
    openIn === 'window' ? 'workbench.action.moveEditorToNewWindow' : openIn === 'side' ? 'workbench.action.moveEditorToRightGroup' : undefined;
  if (!command) {
    return;
  }
  try {
    await vscode.commands.executeCommand(command);
    log?.info(`btw: placed chat tab with ${command}`);
    await delay(TYPE_DELAY_MS);
  } catch (err) {
    log?.warn(`btw: ${command} failed (${errText(err)}); keeping a normal tab`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 'newTab': a new chat editor was opened and `@btw ` typed into it.
 * 'fallback': no such command; `@btw ` was put into the main chat instead.
 */
export async function openBtwChat(ext: vscode.ExtensionContext, log?: vscode.LogOutputChannel): Promise<'newTab' | 'fallback'> {
  // Remember the chat this btw was started from, before a new chat exists.
  await pinOriginSession(ext, (m) => log?.info(m));
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
      const openIn = vscode.workspace.getConfiguration('contingentWatcher').get<OpenIn>('btw.openIn', 'window');
      await placeEditor(openIn, log);
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
  const result = await openBtwChat(context, log);
  if (result === 'fallback' && !context.globalState.get<boolean>(FALLBACK_INFO_KEY)) {
    await context.globalState.update(FALLBACK_INFO_KEY, true);
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Your VS Code version can't open a separate chat tab; @btw was put into the main chat."),
    );
  }
}
