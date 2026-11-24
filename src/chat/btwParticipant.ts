/**
 * `@btw <question>` in Copilot Chat: a quick side question, like Claude Code's
 * /btw. It is answered with the context of the chat it was typed in (read from
 * the chat session, @btw turns excluded), the editor and #references, and the
 * answer streams into the separate "btw" window beside the chat, so it is not
 * mixed into the main task. The chat itself only gets one short line.
 *
 * Model (`contingentWatcher.btw.model`): "chat" = the model selected in the chat
 * picker (`request.model`); "included" = the first available free model from
 * `contingentWatcher.chat.preferredModels`, never a premium fallback.
 */
import * as vscode from 'vscode';
import { BtwAnswersPanel } from '../btw/answersPanel';
import { BTW_PARTICIPANT_ID } from '../btw/context';
import { chatNoteLine } from '../btw/prompt';
import { runBtwQuestion } from '../btw/run';
import { PREFERRED_MODELS_SETTING } from './lm';
import { truncate } from './modelChoice';

const MAX_REF_CHARS = 8000;
const MAX_REFS = 10;
/** Command that reveals the btw window (registered by the extension). */
export const SHOW_BTW_COMMAND = 'contingentWatcher.btw.show';

let answers: BtwAnswersPanel | undefined;

/** Reveals the btw window (creates it if needed) without taking focus from the chat. */
export async function showBtwPanel(): Promise<void> {
  await answers?.show();
}

/**
 * Shortcut: opens the btw window and focuses its input (works while an agent is
 * busy in the chat). With an editor selection, prefills "About the selection: ".
 */
export async function openBtwInput(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const prefill = ed && !ed.selection.isEmpty ? vscode.l10n.t('About the selection: ') : undefined;
  await answers?.show({ focusInput: true, prefill });
}

/** Puts `@btw ` into the current chat's input (no new session). */
export async function prefillBtwInChat(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@btw ', isPartialQuery: true });
}

export function registerBtwParticipant(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
  const panel = new BtwAnswersPanel(context, log);
  answers = panel;
  // Questions typed into the btw window itself: answered right away, independent of the chat.
  panel.onAsk = (question) => {
    void runBtwQuestion(context, log, panel.startCard(question), question);
  };

  const handler: vscode.ChatRequestHandler = async (request, _chatContext, response, token) => {
    const question = request.prompt.trim();
    if (!question) {
      response.markdown(vscode.l10n.t('Type your side question after `@btw`, e.g. `@btw what does this regex match?`'));
      return {};
    }

    const card = panel.startCard(question);
    const stop = token.onCancellationRequested(() => card.cancel());
    try {
      await panel.show();
      response.progress(vscode.l10n.t('Answering in the btw window…'));
      const out = await runBtwQuestion(context, log, card, question, {
        // `request.model` is the model selected in the chat picker (VS Code 1.95+).
        chatModel: (request as { model?: vscode.LanguageModelChat }).model,
        references: await readReferences(request.references),
      });
      // One short line in the chat; the answer itself is in the btw window.
      switch (out.kind) {
        case 'cancelled':
          return {};
        case 'done':
          response.markdown(chatNoteLine(vscode.l10n.t('btw: answer shown in the btw window')));
          break;
        case 'noModel':
          response.markdown(chatNoteLine(vscode.l10n.t('No free model is available, so btw did not answer.')));
          response.button({
            title: vscode.l10n.t('Open settings'),
            command: 'workbench.action.openSettings',
            arguments: [PREFERRED_MODELS_SETTING],
          });
          break;
        case 'error':
          response.markdown(chatNoteLine(out.message));
          break;
      }
      response.button({ title: vscode.l10n.t('Show btw window'), command: SHOW_BTW_COMMAND });
      return {};
    } finally {
      stop.dispose();
    }
  };

  const participant = vscode.chat.createChatParticipant(BTW_PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activitybar.svg');
  return vscode.Disposable.from(participant, panel, {
    dispose: () => {
      if (answers === panel) {
        answers = undefined;
      }
    },
  });
}

/** Text of #file / #selection / … references, formatted for the context block. */
async function readReferences(refs: readonly vscode.ChatPromptReference[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs.slice(0, MAX_REFS)) {
    const t = await readReference(ref);
    if (t) {
      out.push(t);
    }
  }
  return out;
}

async function readReference(ref: vscode.ChatPromptReference): Promise<string | undefined> {
  const value = ref.value;
  if (typeof value === 'string') {
    return value.trim() ? `${ref.modelDescription ?? ref.id}:\n${truncate(value, MAX_REF_CHARS)}` : undefined;
  }
  let uri: vscode.Uri | undefined;
  let range: vscode.Range | undefined;
  if (value instanceof vscode.Uri) {
    uri = value;
  } else if (value instanceof vscode.Location) {
    uri = value.uri;
    range = value.range;
  }
  if (!uri) {
    return undefined;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = range ? doc.getText(range) : doc.getText();
    const label = vscode.workspace.asRelativePath(uri, false) + (range ? `:${range.start.line + 1}-${range.end.line + 1}` : '');
    return `File: ${label}\n\`\`\`${doc.languageId}\n${truncate(text, MAX_REF_CHARS)}\n\`\`\``;
  } catch {
    return undefined;
  }
}
