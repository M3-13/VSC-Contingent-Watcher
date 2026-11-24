/**
 * Shared answering logic for btw side questions (btw panel and `@sparsam /btw`):
 * included-model selection (never falls back to another model), message
 * building, streaming and error handling.
 */
import * as vscode from 'vscode';
import { availableFamilies, chooseModel, normalizePreferred } from '../chat/modelChoice';
import { BtwContext, buildInstructionMessage, buildQuestionMessage } from './prompt';

export const PREFERRED_MODELS_SETTING = 'contingentWatcher.chat.preferredModels';

export function preferredModels(): string[] {
  return normalizePreferred(vscode.workspace.getConfiguration('contingentWatcher').get<unknown>('chat.preferredModels'));
}

export type ModelPick =
  | { kind: 'ok'; model: vscode.LanguageModelChat }
  /** None of the preferred families is available; `families` lists what is. */
  | { kind: 'none'; families: string[] }
  | { kind: 'error'; message: string };

/** Picks the first available preferred (included) Copilot model. */
export async function pickIncludedModel(): Promise<ModelPick> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch (err) {
    return { kind: 'error', message: vscode.l10n.t('Could not list Copilot models: {0}', errMessage(err)) };
  }
  const model = chooseModel(models, preferredModels());
  return model ? { kind: 'ok', model } : { kind: 'none', families: availableFamilies(models) };
}

/** Explanation (Markdown) shown when no preferred included model is available. */
export function noModelMarkdown(families: readonly string[]): string {
  return [
    vscode.l10n.t(
      'None of your preferred included models is available, so I did not answer, to avoid using a premium request by accident.',
    ),
    vscode.l10n.t('Available model families: {0}', families.length ? families.map((f) => `\`${f}\``).join(', ') : '–'),
    vscode.l10n.t('Set your preferred families in the setting `contingentWatcher.chat.preferredModels`.'),
  ].join('\n\n');
}

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
  justification: string = vscode.l10n.t("btw uses an included model so side questions don't use premium requests"),
): Promise<StreamResult> {
  try {
    const res = await model.sendRequest(buildBtwMessages(question, ctx), { justification }, token);
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

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function friendlyError(err: unknown): string {
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
