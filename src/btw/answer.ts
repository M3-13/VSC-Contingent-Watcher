/** Message building and streaming for btw side questions. */
import * as vscode from 'vscode';
import { friendlyError } from '../chat/lm';
import { BtwContext, buildInstructionMessage, buildQuestionMessage } from './prompt';

export function buildBtwMessages(question: string, ctx: BtwContext): vscode.LanguageModelChatMessage[] {
  return [
    vscode.LanguageModelChatMessage.User(buildInstructionMessage(ctx)),
    vscode.LanguageModelChatMessage.User(buildQuestionMessage(question)),
  ];
}

export type StreamResult = { kind: 'done' } | { kind: 'cancelled' } | { kind: 'error'; message: string };

/** Streams the answer to `onText`. Never throws. */
export async function streamBtwAnswer(
  model: vscode.LanguageModelChat,
  question: string,
  ctx: BtwContext,
  onText: (fragment: string) => void,
  token: vscode.CancellationToken,
): Promise<StreamResult> {
  try {
    const res = await model.sendRequest(
      buildBtwMessages(question, ctx),
      { justification: vscode.l10n.t('btw answers quick side questions with the model you use in Copilot Chat') },
      token,
    );
    for await (const fragment of res.text) {
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }
      onText(fragment);
    }
  } catch (err) {
    if (token.isCancellationRequested || isCancellation(err)) {
      return { kind: 'cancelled' };
    }
    return { kind: 'error', message: friendlyError(err) };
  }
  return token.isCancellationRequested ? { kind: 'cancelled' } : { kind: 'done' };
}

function isCancellation(err: unknown): boolean {
  return err instanceof vscode.CancellationError || (err instanceof Error && err.name === 'Canceled');
}
