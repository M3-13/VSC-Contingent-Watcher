/** Streams a btw answer from a language model. */
import * as vscode from 'vscode';
import { errMessage } from './model';
import { BtwPrompt } from './prompt';

export type StreamResult = { kind: 'done' } | { kind: 'cancelled' } | { kind: 'error'; message: string };

/** Streams the answer to `onText`. Never throws. */
export async function streamBtwAnswer(
  model: vscode.LanguageModelChat,
  prompt: BtwPrompt,
  onText: (fragment: string) => void,
  token: vscode.CancellationToken,
): Promise<StreamResult> {
  try {
    const res = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt.context), vscode.LanguageModelChatMessage.User(prompt.question)],
      { justification: vscode.l10n.t('btw answers a side question about your Copilot session') },
      token,
    );
    for await (const fragment of res.text) {
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }
      onText(fragment);
    }
  } catch (err) {
    if (token.isCancellationRequested || err instanceof vscode.CancellationError || (err instanceof Error && err.name === 'Canceled')) {
      return { kind: 'cancelled' };
    }
    return { kind: 'error', message: friendlyError(err) };
  }
  return token.isCancellationRequested ? { kind: 'cancelled' } : { kind: 'done' };
}

export function friendlyError(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return vscode.l10n.t('Permission to use the model was not granted. Ask again and allow access when prompted.');
      case vscode.LanguageModelError.Blocked.name:
        return vscode.l10n.t('The request was blocked (content filter or quota).');
      case vscode.LanguageModelError.NotFound.name:
        return vscode.l10n.t('The model was not found. It may have been retired; choose another model.');
      default:
        return vscode.l10n.t('The model request failed: {0}', err.message);
    }
  }
  return vscode.l10n.t('The model request failed: {0}', errMessage(err));
}
