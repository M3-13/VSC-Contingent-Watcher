import * as vscode from 'vscode';
import { availableFamilies, chooseModel, truncate } from './modelChoice';

const PARTICIPANT_ID = 'contingentWatcher.sparsam';
const DEFAULT_PREFERRED = ['gpt-5-mini', 'gpt-4.1', 'gpt-4o'];
const MAX_REF_CHARS = 8000;

function preferredModels(): string[] {
  const v = vscode.workspace.getConfiguration('contingentWatcher').get<string[]>('chat.preferredModels');
  return Array.isArray(v) && v.length > 0 ? v.filter((s) => typeof s === 'string') : DEFAULT_PREFERRED;
}

function systemPrompt(btw: boolean): string {
  const base = vscode.l10n.t('You are a concise, helpful coding assistant. Answer in the same language as the user.');
  if (btw) {
    return `${base} Keep the answer to at most ~120 words unless code is needed.`;
  }
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

export function registerSparsam(context: vscode.ExtensionContext): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
    const btw = request.command === 'btw';

    let models: vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    } catch (err) {
      response.markdown(vscode.l10n.t('Could not list Copilot models: {0}', errMessage(err)));
      return {};
    }
    const model = chooseModel(models, preferredModels());
    if (!model) {
      const fams = availableFamilies(models);
      response.markdown(
        vscode.l10n.t(
          'None of your preferred included models is available, so I did not answer, to avoid using a premium request by accident.'
        ) +
          '\n\n' +
          vscode.l10n.t('Available model families: {0}', fams.length ? fams.map((f) => `\`${f}\``).join(', ') : '–') +
          '\n\n' +
          vscode.l10n.t('Set your preferred families in the setting `contingentWatcher.chat.preferredModels`.') +
          '\n\n'
      );
      response.button({
        title: vscode.l10n.t('Open settings'),
        command: 'workbench.action.openSettings',
        arguments: ['contingentWatcher.chat.preferredModels'],
      });
      return {};
    }

    const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(systemPrompt(btw))];
    if (!btw) {
      messages.push(...historyMessages(chatContext));
    }
    const refTexts: string[] = [];
    for (const ref of request.references) {
      const t = await readReference(ref);
      if (t) {
        refTexts.push(t);
      }
    }
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
    if (!btw && request.prompt.trim()) {
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function friendlyError(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return vscode.l10n.t('Permission to use the model was not granted. Ask again and allow access when prompted.');
      case vscode.LanguageModelError.Blocked.name:
        return vscode.l10n.t('The request was blocked (content filter or quota).');
      case vscode.LanguageModelError.NotFound.name:
        return vscode.l10n.t('The model was not found. It may have been retired; check your preferred models setting.');
      default:
        return vscode.l10n.t('The model request failed: {0}', err.message);
    }
  }
  return vscode.l10n.t('The model request failed: {0}', errMessage(err));
}
