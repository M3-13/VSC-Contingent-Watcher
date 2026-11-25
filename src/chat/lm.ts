/**
 * Language model helpers for btw: included-model selection for the free mode
 * (never falls back to another model) and friendly error texts.
 */
import * as vscode from 'vscode';
import { availableFamilies, chooseModel, normalizePreferred } from './modelChoice';

export const PREFERRED_MODELS_SETTING = 'contingentWatcher.chat.preferredModels';

export function preferredModels(): string[] {
  return normalizePreferred(vscode.workspace.getConfiguration('contingentWatcher').get<unknown>('chat.preferredModels'));
}

export type ModelPick =
  | { kind: 'ok'; model: vscode.LanguageModelChat }
  /** None of the preferred families is available; `families` lists what is. */
  | { kind: 'none'; families: string[] }
  | { kind: 'error'; message: string };

/** Lists the Copilot chat models. Throws a friendly message on failure. */
export async function copilotModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch (err) {
    throw new Error(vscode.l10n.t('Could not list Copilot models: {0}', errMessage(err)));
  }
}

/** Picks the first available preferred (included) Copilot model. */
export async function pickIncludedModel(): Promise<ModelPick> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await copilotModels();
  } catch (err) {
    return { kind: 'error', message: errMessage(err) };
  }
  const model = chooseModel(models, preferredModels());
  return model ? { kind: 'ok', model } : { kind: 'none', families: availableFamilies(models) };
}

/** Explanation (Markdown) shown when no preferred included model is available. */
export function noModelMarkdown(families: readonly string[]): string {
  return [
    vscode.l10n.t(
      'None of your preferred free models is available, so I did not answer, to avoid using your allowance by accident.',
    ),
    vscode.l10n.t('Available model families: {0}', families.length ? families.map((f) => `\`${f}\``).join(', ') : '–'),
    vscode.l10n.t('Set your preferred families in the setting `contingentWatcher.chat.preferredModels`.'),
  ].join('\n\n');
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
