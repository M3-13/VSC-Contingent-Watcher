/**
 * "BTW" panel: ask a quick side question while you keep working. Answered by the
 * current chat's model (or a free included model, see `contingentWatcher.btw.model`)
 * with a snapshot of the current chat and editor as context; nothing is added to
 * the main chat. Q&A lives only in memory for this session.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { streamBtwAnswer } from './answer';
import { noModelMarkdown, PREFERRED_MODELS_SETTING } from '../chat/lm';
import { btwMode, chooseBtwModel, modelSourceLabel, resolveBtwModel, setBtwMode } from './model';
import { BtwMode, btwModeOf } from './modelMatch';
import { describeBtwContext, gatherBtwContext, hasEditorSelection } from './context';

type CardStatus = 'thinking' | 'streaming' | 'done' | 'cancelled' | 'error' | 'noModel';

/** One question and its answer, as rendered by media/btw/btw.js. */
export interface BtwCard {
  id: string;
  question: string;
  answer: string;
  status: CardStatus;
  /** Human description of the context used, e.g. "chat (6 turns) · editor selection in src/app.ts". */
  context?: string;
  /** Display name of the model that answered. */
  model?: string;
  /** Why this model, e.g. "same model as your chat" (localised). */
  modelNote?: string;
  error?: string;
  /** For status 'noModel': how to fix it. */
  fix?: 'chooseModel' | 'openSettings';
}

type ToWebview =
  | { type: 'init'; strings: Record<string, string>; cards: BtwCard[]; mode: BtwMode; focus?: { prefill?: string } }
  | { type: 'mode'; mode: BtwMode }
  | { type: 'card'; card: BtwCard }
  /** `at`: offset in the answer where `text` starts (lets the webview ignore text it already has). */
  | { type: 'delta'; id: string; text: string; at: number }
  | { type: 'focus'; prefill?: string }
  | { type: 'clear' };

type FromWebview =
  | { type: 'ready' }
  | { type: 'ask'; question: string }
  | { type: 'cancel'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'copy'; text: string }
  | { type: 'continue'; id: string }
  | { type: 'chooseModel' }
  | { type: 'openSettings' }
  | { type: 'setMode'; mode: string };

const MAX_CARDS = 50;
const MAX_QUESTION = 4000;
const DELTA_FLUSH_MS = 40;

export class BtwViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'contingentWatcher.btw';

  private view?: vscode.WebviewView;
  private ready = false;
  private pendingFocus?: { prefill?: string };
  private cards: BtwCard[] = [];
  private readonly running = new Map<string, vscode.CancellationTokenSource>();
  private readonly mediaRoot: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private seq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('contingentWatcher.btw.model')) {
          this.post({ type: 'mode', mode: btwMode() });
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.mediaRoot] };
    view.webview.html = this.html(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage((msg: FromWebview) => void this.onMessage(msg)),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.ready = false;
        }
      }),
    );
  }

  /**
   * Reveals the view and focuses the input. With `send`, `question` is asked right
   * away; otherwise it is prefilled into the input (cursor at the end).
   */
  async ask(question?: string, send = false): Promise<void> {
    await vscode.commands.executeCommand(`${BtwViewProvider.viewId}.focus`);
    if (send && question?.trim()) {
      void this.submit(question);
      this.focusInput();
      return;
    }
    this.focusInput(question);
  }

  /** QuickPick for the fallback model (used when the chat's model can't be detected). */
  async changeModel(): Promise<void> {
    const m = await chooseBtwModel(this.context);
    if (m) {
      vscode.window.setStatusBarMessage(
        vscode.l10n.t("btw will use {0} when your chat's model can't be detected", m.name),
        5000,
      );
    }
  }

  /** Cancels running answers and removes all cards. */
  clear(): void {
    for (const cts of this.running.values()) {
      cts.cancel();
    }
    this.running.clear();
    this.cards = [];
    this.post({ type: 'clear' });
  }

  private focusInput(prefill?: string): void {
    if (this.view && this.ready) {
      this.post({ type: 'focus', prefill });
    } else {
      this.pendingFocus = { prefill };
    }
  }

  private post(msg: ToWebview): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(msg);
    }
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    try {
      switch (msg?.type) {
        case 'ready':
          this.ready = true;
          this.post({ type: 'init', strings: webviewStrings(), cards: this.cards, mode: btwMode(), focus: this.pendingFocus });
          this.pendingFocus = undefined;
          return;
        case 'ask':
          if (typeof msg.question === 'string' && msg.question.trim()) {
            await this.submit(msg.question);
          }
          return;
        case 'cancel':
          this.running.get(String(msg.id))?.cancel();
          return;
        case 'retry': {
          const card = this.cards.find((c) => c.id === msg.id);
          if (card && !this.running.has(card.id)) {
            await this.run(card);
          }
          return;
        }
        case 'copy':
          if (typeof msg.text === 'string') {
            await vscode.env.clipboard.writeText(msg.text);
          }
          return;
        case 'continue': {
          const card = this.cards.find((c) => c.id === msg.id);
          if (card) {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
              query: card.question,
              isPartialQuery: true,
            });
          }
          return;
        }
        case 'chooseModel':
          await this.changeModel();
          return;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', PREFERRED_MODELS_SETTING);
          return;
        case 'setMode':
          await setBtwMode(btwModeOf(msg.mode));
          return;
      }
    } catch (err) {
      this.log.error(`btw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async submit(question: string): Promise<void> {
    const card: BtwCard = {
      id: `${Date.now().toString(36)}-${++this.seq}`,
      question: question.trim().slice(0, MAX_QUESTION),
      answer: '',
      status: 'thinking',
    };
    this.cards.push(card);
    if (this.cards.length > MAX_CARDS) {
      this.cards.splice(0, this.cards.length - MAX_CARDS);
    }
    await this.run(card);
  }

  private async run(card: BtwCard): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    this.running.set(card.id, cts);
    Object.assign(card, { answer: '', status: 'thinking', error: undefined, model: undefined, modelNote: undefined, fix: undefined, context: undefined });
    this.post({ type: 'card', card });

    let pending = '';
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (pending) {
        this.post({ type: 'delta', id: card.id, text: pending, at: card.answer.length - pending.length });
        pending = '';
      }
    };

    try {
      const ctx = await gatherBtwContext(this.context, { log: (m) => this.log.info(m) });
      card.context = describeBtwContext(ctx);
      if (cts.token.isCancellationRequested) {
        card.status = 'cancelled';
        return;
      }
      const pick = await resolveBtwModel(this.context, ctx.chatModelId, (m) => this.log.info(m));
      if (pick.kind !== 'ok') {
        if (pick.kind === 'notChosen') {
          card.status = 'noModel';
          card.fix = 'chooseModel';
          card.answer = vscode.l10n.t('No model chosen, so btw did not answer. Choose a model and try again.');
        } else if (pick.kind === 'noIncluded') {
          card.status = 'noModel';
          card.fix = 'openSettings';
          card.answer = noModelMarkdown(pick.families);
        } else {
          card.status = 'error';
          card.error = pick.message;
        }
        return;
      }
      card.model = pick.model.name;
      card.modelNote = modelSourceLabel(pick.source);
      card.status = 'streaming';
      this.post({ type: 'card', card });
      this.log.info(`btw: asking ${pick.model.name} (${pick.model.family}, ${pick.source}) · context: ${card.context}`);

      const res = await streamBtwAnswer(
        pick.model,
        card.question,
        ctx,
        (fragment) => {
          card.answer += fragment;
          pending += fragment;
          timer ??= setTimeout(flush, DELTA_FLUSH_MS);
        },
        cts.token,
      );
      if (timer) {
        clearTimeout(timer);
      }
      flush();
      if (res.kind === 'error') {
        card.status = 'error';
        card.error = res.message;
        this.log.warn(`btw: ${res.message}`);
      } else {
        card.status = res.kind === 'cancelled' ? 'cancelled' : 'done';
      }
    } catch (err) {
      card.status = 'error';
      card.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      cts.dispose();
      if (this.running.get(card.id) === cts) {
        this.running.delete(card.id);
      }
      // Only publish if the card was not cleared meanwhile.
      if (this.cards.includes(card)) {
        this.post({ type: 'card', card });
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'btw', 'btw.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'btw', 'btw.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>${vscode.l10n.t('btw')}</title>
</head>
<body>
<div id="app" aria-busy="true"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const cts of this.running.values()) {
      cts.cancel();
      cts.dispose();
    }
    this.running.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}

/** Opens Copilot Chat with `@btw ` prefilled (the main way to ask a side question). */
export async function openBtwInChat(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@btw ', isPartialQuery: true });
}

/** Command `contingentWatcher.btw`: ask a side question in Copilot Chat via @btw. */
export async function btwCommand(_provider?: BtwViewProvider): Promise<void> {
  await openBtwInChat();
}

/**
 * Reveals the btw panel (works in parallel while a chat request is busy); with a
 * selection, prefills "About the selection: ".
 */
export async function revealBtwPanel(provider: BtwViewProvider): Promise<void> {
  await provider.ask(hasEditorSelection() ? vscode.l10n.t('About the selection: ') : undefined);
}

/** UI strings for the webview (keys are referenced by media/btw/btw.js). */
function webviewStrings(): Record<string, string> {
  return {
    placeholder: vscode.l10n.t('Ask a quick side question…'),
    inputLabel: vscode.l10n.t('Side question'),
    hint: vscode.l10n.t('Enter to send · Shift+Enter for a new line'),
    send: vscode.l10n.t('Send'),
    stop: vscode.l10n.t('Stop'),
    copy: vscode.l10n.t('Copy'),
    copyAnswer: vscode.l10n.t('Copy answer'),
    copyCode: vscode.l10n.t('Copy code'),
    copied: vscode.l10n.t('Copied'),
    continueInChat: vscode.l10n.t('Continue in chat'),
    continueTitle: vscode.l10n.t('Open the question in Copilot Chat to continue there'),
    retry: vscode.l10n.t('Retry'),
    changeModel: vscode.l10n.t('Change model'),
    changeModelTitle: vscode.l10n.t("Choose the model btw uses when your chat's model can't be detected"),
    openSettings: vscode.l10n.t('Open settings'),
    modeLabel: vscode.l10n.t('Model for btw'),
    modeChat: vscode.l10n.t('Chat model'),
    modeChatTitle: vscode.l10n.t('Same model as your current Copilot chat. Premium models use premium requests.'),
    modeIncluded: vscode.l10n.t('Free model'),
    modeIncludedTitle: vscode.l10n.t('An included model (no premium requests), from contingentWatcher.chat.preferredModels'),
    context: vscode.l10n.t('Context: {0}'),
    notAdded: vscode.l10n.t('not added to your chat'),
    thinking: vscode.l10n.t('Thinking'),
    stopped: vscode.l10n.t('Stopped.'),
    answerReady: vscode.l10n.t('Answer ready'),
    question: vscode.l10n.t('Question'),
    emptyTitle: vscode.l10n.t('Ask a quick side question while you keep working.'),
    emptyBody: vscode.l10n.t(
      'It sees a snapshot of your current chat and editor and is not added to your chat.',
    ),
    emptyCost: vscode.l10n.t('Chat model: costs what your chat model costs. Free model: no premium requests.'),
  };
}
