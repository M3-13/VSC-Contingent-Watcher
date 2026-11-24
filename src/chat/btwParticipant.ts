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
import { streamBtwAnswer } from '../btw/answer';
import { BtwAnswersPanel } from '../btw/answersPanel';
import { BTW_PARTICIPANT_ID, describeBtwContext, gatherBtwContext } from '../btw/context';
import { BtwModelSource, btwMode, modelSourceLabel, resolveBtwModel } from '../btw/model';
import { chatNoteLine } from '../btw/prompt';
import { noModelMarkdown, pickIncludedModel, PREFERRED_MODELS_SETTING } from './lm';
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

/** Puts `@btw ` into the current chat's input (no new session). */
export async function prefillBtwInChat(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@btw ', isPartialQuery: true });
}

export function registerBtwParticipant(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
  const panel = new BtwAnswersPanel(context, log);
  answers = panel;

  const handler: vscode.ChatRequestHandler = async (request, _chatContext, response, token) => {
    const question = request.prompt.trim();
    if (!question) {
      response.markdown(vscode.l10n.t('Type your side question after `@btw`, e.g. `@btw what does this regex match?`'));
      return {};
    }

    const card = panel.startCard(question);
    const stop = token.onCancellationRequested(() => card.cancel());
    const showButton = () =>
      response.button({ title: vscode.l10n.t('Show btw window'), command: SHOW_BTW_COMMAND });
    /** One short line in the chat; the answer itself is in the btw window. */
    const chatLine = (text: string) => response.markdown(chatNoteLine(text));

    try {
      await panel.show();
      response.progress(vscode.l10n.t('Answering in the btw window…'));

      const ctx = await gatherBtwContext(context, { log: (m) => log.info(m) });
      const refs = await readReferences(request.references);
      if (refs.length) {
        ctx.references = refs;
      }
      card.update({ context: describeBtwContext(ctx) });
      if (card.token.isCancellationRequested) {
        card.finish('cancelled');
        return {};
      }

      // Pick the model.
      let model: vscode.LanguageModelChat | undefined;
      let source: BtwModelSource = 'chat';
      if (btwMode() === 'included') {
        const pick = await pickIncludedModel();
        if (pick.kind === 'error') {
          card.finish('error', pick.message);
          chatLine(pick.message);
          showButton();
          return {};
        }
        if (pick.kind === 'none') {
          card.update({ fix: 'openSettings' });
          card.setAnswer(noModelMarkdown(pick.families));
          card.finish('noModel');
          chatLine(vscode.l10n.t('No free model is available, so btw did not answer.'));
          response.button({
            title: vscode.l10n.t('Open settings'),
            command: 'workbench.action.openSettings',
            arguments: [PREFERRED_MODELS_SETTING],
          });
          return {};
        }
        model = pick.model;
        source = 'included';
      } else {
        // `request.model` is the model selected in the chat picker (VS Code 1.95+).
        model = (request as { model?: vscode.LanguageModelChat }).model;
        if (!model) {
          const pick = await resolveBtwModel(context, ctx.chatModelId, (m) => log.info(m));
          if (pick.kind !== 'ok') {
            const msg =
              pick.kind === 'error' ? pick.message : vscode.l10n.t('No model chosen, so btw did not answer. Choose a model and try again.');
            card.finish('error', msg);
            chatLine(msg);
            return {};
          }
          model = pick.model;
          source = pick.source;
        }
      }

      card.update({ model: model.name, modelNote: modelSourceLabel(source), status: 'streaming' });
      log.info(`btw: asking ${model.name} (${model.family}, ${source}) · context: ${describeBtwContext(ctx)}`);
      const res = await streamBtwAnswer(model, question, ctx, (fragment) => card.append(fragment), card.token);
      if (res.kind === 'cancelled') {
        card.finish('cancelled');
        return {};
      }
      if (res.kind === 'error') {
        log.warn(`btw: ${res.message}`);
        card.finish('error', res.message);
        chatLine(res.message);
        showButton();
        return {};
      }
      card.finish('done');
      chatLine(vscode.l10n.t('btw: answer shown in the btw window'));
      showButton();
      return {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`btw: ${msg}`);
      card.finish('error', msg);
      chatLine(msg);
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
