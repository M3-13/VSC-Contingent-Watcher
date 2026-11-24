/**
 * Opens a separate chat for btw (own window, beside the editor or as a tab) with
 * `@btw ` typed in, so a side question never waits for a busy agent and the main
 * chat stays untouched. The chat you were working in is remembered as context.
 */
import * as vscode from 'vscode';
import { pinOriginSession } from '../btw/context';
import { OpenIn, planOpen } from './chatCommands';

const PREFILL = '@btw ';
const SETTLE_MS = 250;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function run(command: string, log?: vscode.LogOutputChannel): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command);
    log?.info(`btw: ran ${command}`);
    return true;
  } catch (err) {
    log?.warn(`btw: ${command} failed (${errText(err)})`);
    return false;
  }
}

/** Returns false if no separate chat could be opened (the main chat is never used instead). */
export async function openBtwChat(ext: vscode.ExtensionContext, log?: vscode.LogOutputChannel): Promise<boolean> {
  // Remember the chat this btw was started from, before a new chat exists.
  await pinOriginSession(ext, (m) => log?.info(m));

  const openIn = vscode.workspace.getConfiguration('contingentWatcher').get<OpenIn>('btw.openIn', 'window');
  let commands: string[] = [];
  try {
    commands = await vscode.commands.getCommands(true);
  } catch {
    // handled below
  }
  const plan = planOpen(commands, openIn);
  if (!plan) {
    log?.warn('btw: this VS Code version offers no command to open a separate chat');
    return false;
  }

  if (!(await run(plan.command, log))) {
    return false;
  }
  await delay(SETTLE_MS);

  if (plan.kind === 'editor') {
    if (openIn === 'window') {
      await run('workbench.action.moveEditorToNewWindow', log);
      await delay(SETTLE_MS);
    } else if (openIn === 'side') {
      await run('workbench.action.moveEditorToRightGroup', log);
      await delay(SETTLE_MS);
    }
  }

  // Type "@btw " into the focused input of the new chat.
  try {
    await vscode.commands.executeCommand('type', { text: PREFILL });
  } catch (err) {
    log?.warn(`btw: could not prefill @btw (${errText(err)})`);
  }
  return true;
}

/** Command handler with a clear hint when no separate chat can be opened. */
export async function openBtwChatCommand(context: vscode.ExtensionContext, log?: vscode.LogOutputChannel): Promise<void> {
  if (!(await openBtwChat(context, log))) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Couldn't open a separate chat for btw in this VS Code version. Open a new chat (Chat: New Chat Window) and type @btw there.",
      ),
    );
  }
}
