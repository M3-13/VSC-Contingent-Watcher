/**
 * Which model answers a btw side question, by `contingentWatcher.btw.model`:
 * - "chat" (default): the model selected in the current Copilot chat (read from
 *   the chat session); else the model the user chose for btw before (globalState);
 *   else ask once with a QuickPick and remember the choice.
 * - "included": the first available family of `contingentWatcher.chat.preferredModels`
 *   (free, 0x); never falls back to another model.
 * Never picks a model silently.
 */
import * as vscode from 'vscode';
import { copilotModels, errMessage, pickIncludedModel } from '../chat/lm';
import { BtwMode, btwModeOf, matchModel } from './modelMatch';

export type BtwModelSource = 'chat' | 'chosen' | 'included';

export type BtwModelResult =
  | { kind: 'ok'; model: vscode.LanguageModelChat; source: BtwModelSource }
  /** Chat mode: the user dismissed the model QuickPick. */
  | { kind: 'notChosen' }
  /** Included mode: none of the preferred included families is available. */
  | { kind: 'noIncluded'; families: string[] }
  | { kind: 'error'; message: string };

export const BTW_MODEL_SETTING = 'contingentWatcher.btw.model';
const STATE_KEY = 'contingentWatcher.btw.chosenModel';
let picking: Promise<vscode.LanguageModelChat | undefined> | undefined;

interface RememberedModel {
  id: string;
  family: string;
  name?: string;
}

function remembered(ext: vscode.ExtensionContext): RememberedModel | undefined {
  const v = ext.globalState.get<RememberedModel>(STATE_KEY);
  return v && typeof v.id === 'string' && typeof v.family === 'string' ? v : undefined;
}

export function btwMode(): BtwMode {
  return btwModeOf(vscode.workspace.getConfiguration('contingentWatcher').get<string>('btw.model'));
}

/** Writes the mode (user settings; also the workspace value if one overrides it). */
export async function setBtwMode(mode: BtwMode): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('contingentWatcher');
  await cfg.update('btw.model', mode, vscode.ConfigurationTarget.Global);
  const info = cfg.inspect<string>('btw.model');
  if (info?.workspaceValue !== undefined) {
    await cfg.update('btw.model', mode, vscode.ConfigurationTarget.Workspace);
  }
  if (info?.workspaceFolderValue !== undefined) {
    await cfg.update('btw.model', mode, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

export async function resolveBtwModel(
  ext: vscode.ExtensionContext,
  chatModelId: string | undefined,
  log: (m: string) => void = () => undefined,
): Promise<BtwModelResult> {
  if (btwMode() === 'included') {
    const pick = await pickIncludedModel();
    if (pick.kind === 'ok') {
      return { kind: 'ok', model: pick.model, source: 'included' };
    }
    if (pick.kind === 'none') {
      log(`btw: no preferred included model available (have: ${pick.families.join(', ') || '–'})`);
      return { kind: 'noIncluded', families: pick.families };
    }
    return pick;
  }

  let models: vscode.LanguageModelChat[];
  try {
    models = await copilotModels();
  } catch (err) {
    return { kind: 'error', message: errMessage(err) };
  }
  if (models.length === 0) {
    return { kind: 'error', message: noModelsMessage() };
  }

  const m = matchModel(models, chatModelId);
  if (m) {
    return { kind: 'ok', model: m, source: 'chat' };
  }
  log(chatModelId ? `btw: chat model ${chatModelId} is not available here` : 'btw: chat model not detected');

  const rem = remembered(ext);
  if (rem) {
    const r = matchModel(models, rem.id) ?? matchModel(models, rem.family);
    if (r) {
      return { kind: 'ok', model: r, source: 'chosen' };
    }
    log(`btw: previously chosen model ${rem.family} is not available`);
  }

  // Several questions asked at once share one QuickPick.
  picking ??= chooseBtwModel(ext, models).finally(() => (picking = undefined));
  const picked = await picking;
  return picked ? { kind: 'ok', model: picked, source: 'chosen' } : { kind: 'notChosen' };
}

/** Footer wording for why this model answered. */
export function modelSourceLabel(source: BtwModelSource): string {
  switch (source) {
    case 'chat':
      return vscode.l10n.t('same model as your chat');
    case 'included':
      return vscode.l10n.t('included model · no premium requests');
    default:
      return vscode.l10n.t('chosen by you');
  }
}

function noModelsMessage(): string {
  return vscode.l10n.t('No Copilot chat models are available. Check that GitHub Copilot Chat is installed and you are signed in.');
}

/** QuickPick of the available Copilot models; remembers the choice. */
export async function chooseBtwModel(
  ext: vscode.ExtensionContext,
  models?: vscode.LanguageModelChat[],
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
  const current = remembered(ext);
  const items = [...models]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({
      label: m.name,
      description: current && current.id === m.id ? vscode.l10n.t('current choice') : undefined,
      detail: m.family === m.id ? m.family : `${m.family} · ${m.id}`,
      model: m,
    }));
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Model for btw side questions'),
    placeHolder: vscode.l10n.t(
      "Used when your chat's model can't be detected. Premium models use premium requests.",
    ),
    matchOnDetail: true,
  });
  if (!pick) {
    return undefined;
  }
  const value: RememberedModel = { id: pick.model.id, family: pick.model.family, name: pick.model.name };
  await ext.globalState.update(STATE_KEY, value);
  return pick.model;
}
