/**
 * `@btw <question>` in Copilot Chat: a quick side question answered with the
 * context of the current conversation (read from the chat session) and editor,
 * like Claude Code's /btw. Side questions are independent: @btw's own earlier
 * turns are not used as context.
 *
 * Model (`contingentWatcher.btw.model`): "chat" = the model selected in the chat
 * picker (`request.model`); "included" = the first available free model from
 * `contingentWatcher.chat.preferredModels`, never a premium fallback.
 */
import * as vscode from 'vscode';
import { streamBtwAnswer } from '../btw/answer';
import { BTW_PARTICIPANT_ID, describeBtwContext, gatherBtwContext } from '../btw/context';
import { BtwModelSource, btwMode, modelSourceLabel, resolveBtwModel } from '../btw/model';
import { chatFooter } from '../btw/prompt';
import { noModelMarkdown, pickIncludedModel, PREFERRED_MODELS_SETTING } from './lm';
import { truncate } from './modelChoice';

const MAX_REF_CHARS = 8000;
const MAX_REFS = 10;

export function registerBtwParticipant(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, response, token) => {
    const question = request.prompt.trim();
    if (!question) {
      response.markdown(vscode.l10n.t('Type your side question after `@btw`, e.g. `@btw what does this regex match?`'));
      return {};
    }

    response.progress(vscode.l10n.t('Reading your chat and editor…'));
    const ctx = await gatherBtwContext(context, { log: (m) => log.info(m) });
    const refs = await readReferences(request.references);
    if (refs.length) {
      ctx.references = refs;
    }
    if (token.isCancellationRequested) {
      return {};
    }

    // Pick the model.
    let model: vscode.LanguageModelChat | undefined;
    let source: BtwModelSource = 'chat';
    if (btwMode() === 'included') {
      const pick = await pickIncludedModel();
      if (pick.kind === 'error') {
        response.markdown(pick.message);
        return {};
      }
      if (pick.kind === 'none') {
        response.markdown(noModelMarkdown(pick.families) + '\n\n');
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
        if (pick.kind === 'error') {
          response.markdown(pick.message);
          return {};
        }
        if (pick.kind !== 'ok') {
          response.markdown(vscode.l10n.t('No model chosen, so btw did not answer. Choose a model and try again.'));
          return {};
        }
        model = pick.model;
        source = pick.source;
      }
    }

    const contextLabel = describeBtwContext(ctx);
    log.info(`btw (chat): asking ${model.name} (${model.family}, ${source}) · context: ${contextLabel}`);
    const res = await streamBtwAnswer(model, question, ctx, (fragment) => response.markdown(fragment), token);
    if (res.kind === 'cancelled') {
      return {};
    }
    if (res.kind === 'error') {
      log.warn(`btw (chat): ${res.message}`);
      response.markdown(res.message);
      return {};
    }
    response.markdown(
      '\n\n' +
        chatFooter([
          'btw',
          model.name,
          modelSourceLabel(source),
          vscode.l10n.t('side question'),
          vscode.l10n.t('Context: {0}', contextLabel),
        ]),
    );
    return {};
  };

  const participant = vscode.chat.createChatParticipant(BTW_PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activitybar.svg');
  return participant;
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
