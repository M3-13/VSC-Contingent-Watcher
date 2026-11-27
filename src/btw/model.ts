/**
 * Which model answers a btw side question: a model picked in the btw window
 * (for as long as it is open), else the model of the working chat session,
 * else the model chosen for btw before (remembered), else ask once with a
 * QuickPick and remember. Never picks a model silently.
 */
import * as vscode from 'vscode';
import { matchModel } from './modelMatch';

export type BtwModelSource = 'session' | 'chosen';

export type BtwModelResult =
  | { kind: 'ok'; model: vscode.LanguageModelChat; source: BtwModelSource }
  | { kind: 'notChosen' }
  | { kind: 'error'; message: string };

const STATE_KEY = 'contingentWatcher.btw.chosenModel';

interface RememberedModel {
  id: string;
  family: string;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noModelsMessage(): string {
  return vscode.l10n.t('No Copilot chat models are available. Check that GitHub Copilot Chat is installed and you are signed in.');
}

export async function copilotModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch (err) {
    throw new Error(vscode.l10n.t('Could not list Copilot models: {0}', errMessage(err)));
  }
}

function remembered(ext: vscode.ExtensionContext): RememberedModel | undefined {
  const v = ext.globalState.get<RememberedModel>(STATE_KEY);
  return v && typeof v.id === 'string' && typeof v.family === 'string' ? v : undefined;
}

/** Without asking: the override, the session's model or the remembered one. */
export async function findBtwModel(
  ext: vscode.ExtensionContext,
  sessionModelId: string | undefined,
  overrideId?: string,
): Promise<{ model: vscode.LanguageModelChat; source: BtwModelSource } | undefined> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await copilotModels();
  } catch {
    return undefined;
  }
  const over = overrideId ? models.find((m) => m.id === overrideId) : undefined;
  if (over) {
    return { model: over, source: 'chosen' };
  }
  const fromSession = matchModel(models, sessionModelId);
  if (fromSession) {
    return { model: fromSession, source: 'session' };
  }
  const rem = remembered(ext);
  const r = rem ? matchModel(models, rem.id) ?? matchModel(models, rem.family) : undefined;
  return r ? { model: r, source: 'chosen' } : undefined;
}

/** Like {@link findBtwModel}, but asks once (QuickPick) if nothing fits. */
export async function resolveBtwModel(
  ext: vscode.ExtensionContext,
  sessionModelId: string | undefined,
  overrideId: string | undefined,
  log: (m: string) => void = () => undefined,
): Promise<BtwModelResult> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await copilotModels();
  } catch (err) {
    return { kind: 'error', message: errMessage(err) };
  }
  if (models.length === 0) {
    return { kind: 'error', message: noModelsMessage() };
  }
  const found = await findBtwModel(ext, sessionModelId, overrideId);
  if (found) {
    return { kind: 'ok', ...found };
  }
  log(sessionModelId ? `btw: session model ${sessionModelId} is not available here` : 'btw: session model not detected');
  const picked = await chooseBtwModel(ext, models);
  return picked ? { kind: 'ok', model: picked, source: 'chosen' } : { kind: 'notChosen' };
}

/** QuickPick of the available Copilot models; remembers the choice. */
export async function chooseBtwModel(
  ext: vscode.ExtensionContext,
  models?: vscode.LanguageModelChat[],
  currentId?: string,
): Promise<vscode.LanguageModelChat | undefined> {
  if (!models) {
    try {
      models = await copilotModels();
    } catch (err) {
      void vscode.window.showErrorMessage(errMessage(err));
      return undefined;
    }
  }
  if (models.length === 0) {
    void vscode.window.showWarningMessage(noModelsMessage());
    return undefined;
  }
  const items = [...models]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({
      label: m.name,
      description: m.id === currentId ? vscode.l10n.t('current') : undefined,
      detail: m.family === m.id ? m.family : `${m.family} · ${m.id}`,
      model: m,
    }));
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Model for btw'),
    placeHolder: vscode.l10n.t('Used for side questions; premium models use your allowance.'),
    matchOnDetail: true,
  });
  if (!pick) {
    return undefined;
  }
  await ext.globalState.update(STATE_KEY, { id: pick.model.id, family: pick.model.family } satisfies RememberedModel);
  return pick.model;
}
