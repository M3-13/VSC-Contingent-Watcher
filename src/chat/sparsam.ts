import * as vscode from 'vscode';
import { truncate } from './modelChoice';
import { friendlyError, noModelMarkdown, pickIncludedModel, PREFERRED_MODELS_SETTING, streamBtwAnswer } from '../btw/answer';
import { describeBtwContext, gatherBtwContext, SPARSAM_PARTICIPANT_ID } from '../btw/context';

const PARTICIPANT_ID = SPARSAM_PARTICIPANT_ID;
const MAX_REF_CHARS = 8000;

function systemPrompt(): string {
  const base = vscode.l10n.t('You are a concise, helpful coding assistant. Answer in the same language as the user.');
  return (
    `${base} Be concise. If the question clearly needs deep reasoning or a large refactoring, ` +
    `say so in one line and suggest switching to a premium model.`
  );
}

async function readReference(ref: vscode.ChatPromptReference): Promise<string | undefined> {
  const value = ref.value;
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
    const label = vscode.workspace.asRelativePath(uri);
    return `File: ${label}\n\`\`\`\n${truncate(text, MAX_REF_CHARS)}\n\`\`\``;
  } catch {
    return undefined;
  }
}

function historyMessages(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (const turn of context.history) {
    if (turn.participant !== PARTICIPANT_ID) {
      continue;
    }
    if (turn instanceof vscode.ChatRequestTurn) {
      out.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      let text = '';
      for (const part of turn.response) {
        if (part instanceof vscode.ChatResponseMarkdownPart) {
          text += part.value.value;
        }
      }
      if (text.trim()) {
        out.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }
  return out;
}

export function registerSparsam(context: vscode.ExtensionContext, log?: vscode.LogOutputChannel): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
    const btw = request.command === 'btw';
    if (btw && !request.prompt.trim()) {
      response.markdown(vscode.l10n.t('Type your side question after `/btw`.'));
      return {};
    }

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
    const model = pick.model;

    const refTexts: string[] = [];
    for (const ref of request.references) {
      const t = await readReference(ref);
      if (t) {
        refTexts.push(t);
      }
    }

    if (btw) {
      // Same context and instruction as the btw panel, so both entry points behave identically.
      const ctx = await gatherBtwContext(context, { log: log ? (m) => log.info(m) : undefined });
      if (refTexts.length) {
        ctx.references = refTexts;
      }
      const res = await streamBtwAnswer(
        model,
        request.prompt,
        ctx,
        (fragment) => response.markdown(fragment),
        token,
        vscode.l10n.t("@sparsam uses an included model so simple questions don't use premium requests"),
      );
      if (res.kind === 'error') {
        response.markdown(res.message);
      }
      if (res.kind !== 'done') {
        return {};
      }
      response.markdown(
        '\n\n_' +
          vscode.l10n.t('Context: {0}', describeBtwContext(ctx)) +
          ' · ' +
          vscode.l10n.t('Answered with {0} (included model) · no premium requests', model.name) +
          '_',
      );
      return {};
    }

    const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(systemPrompt())];
    messages.push(...historyMessages(chatContext));
    const prompt = refTexts.length ? `${refTexts.join('\n\n')}\n\n${request.prompt}` : request.prompt;
    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    try {
      const res = await model.sendRequest(
        messages,
        {
          justification: vscode.l10n.t(
            '@sparsam uses an included model so simple questions don\'t use premium requests'
          ),
        },
        token
      );
      for await (const fragment of res.text) {
        response.markdown(fragment);
      }
    } catch (err) {
      if (token.isCancellationRequested) {
        return {};
      }
      response.markdown(friendlyError(err));
      return {};
    }
    if (token.isCancellationRequested) {
      return {};
    }

    response.markdown(
      '\n\n_' + vscode.l10n.t('Answered with {0} (included model) · no premium requests', model.name) + '_'
    );
    if (request.prompt.trim()) {
      response.button({
        title: vscode.l10n.t('Ask a premium model instead'),
        command: 'workbench.action.chat.open',
        arguments: [{ query: request.prompt }],
      });
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activitybar.svg');
  return participant;
}
