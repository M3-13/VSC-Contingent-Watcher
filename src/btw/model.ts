/**
 * Which model answers a btw side question. In order:
 * 1. `contingentWatcher.btw.model` = "chat" (default): the model selected in the
 *    current Copilot chat (read from the chat session); otherwise the family
 *    named in the setting.
 * 2. The model the user chose for btw before (globalState).
 * 3. Ask once with a QuickPick and remember the choice.
 * Never picks a model silently.
 */
import * as vscode from 'vscode';
import { copilotModels, errMessage } from '../chat/lm';
import { isChatSetting, matchModel } from './modelMatch';

export type BtwModelSource = 'chat' | 'setting' | 'chosen';

export type BtwModelResult =
  | { kind: 'ok'; model: vscode.LanguageModelChat; source: BtwModelSource }
  /** The user dismissed the model QuickPick. */
  | { kind: 'notChosen' }
  | { kind: 'error'; message: string };

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

function settingValue(): string {
  return vscode.workspace.getConfiguration('contingentWatcher').get<string>('btw.model', 'chat') ?? 'chat';
}

export async function resolveBtwModel(
  ext: vscode.ExtensionContext,
  chatModelId: string | undefined,
  log: (m: string) => void = () => undefined,
): Promise<BtwModelResult> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await copilotModels();
  } catch (err) {
    return { kind: 'error', message: errMessage(err) };
  }
  if (models.length === 0) {
    return {
      kind: 'error',
      message: vscode.l10n.t('No Copilot chat models are available. Check that GitHub Copilot Chat is installed and you are signed in.'),
    };
  }

  const setting = settingValue();
  if (isChatSetting(setting)) {
    const m = matchModel(models, chatModelId);
    if (m) {
      return { kind: 'ok', model: m, source: 'chat' };
    }
    log(chatModelId ? `btw: chat model ${chatModelId} is not available here` : 'btw: chat model not detected');
  } else {
    const m = matchModel(models, setting, { allowPrefix: true });
    if (m) {
      return { kind: 'ok', model: m, source: 'setting' };
    }
    log(`btw: model "${setting}" from contingentWatcher.btw.model is not available`);
  }

  const rem = remembered(ext);
  if (rem) {
    const m = matchModel(models, rem.id) ?? matchModel(models, rem.family);
    if (m) {
      return { kind: 'ok', model: m, source: 'chosen' };
    }
    log(`btw: previously chosen model ${rem.family} is not available`);
  }

  // Several questions asked at once share one QuickPick.
  picking ??= chooseBtwModel(ext, models).finally(() => (picking = undefined));
  const picked = await picking;
  return picked ? { kind: 'ok', model: picked, source: 'chosen' } : { kind: 'notChosen' };
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
    void vscode.window.showWarningMessage(
      vscode.l10n.t('No Copilot chat models are available. Check that GitHub Copilot Chat is installed and you are signed in.'),
    );
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
