/**
 * The "btw" window: answers to `@btw` side questions stream here, next to the
 * chat (beside the editor, or in its own floating window), so they are visible
 * without being mixed into the main task. Session only: nothing is persisted.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { PREFERRED_MODELS_SETTING } from '../chat/lm';

export type BtwCardStatus = 'thinking' | 'streaming' | 'done' | 'cancelled' | 'error' | 'noModel';

/** One side question and its answer, as rendered by media/btw/btw.js. */
export interface BtwCard {
  id: string;
  question: string;
  /** Markdown. */
  answer: string;
  status: BtwCardStatus;
  /** Human description of the context used, e.g. "chat (6 turns) · editor selection in src/app.ts". */
  context?: string;
  /** Display name of the model that answered. */
  model?: string;
  /** Short note on the model, e.g. "same model as your chat" (localised). */
  modelNote?: string;
  error?: string;
  /** For status 'noModel': how to fix it. */
  fix?: 'openSettings';
}

/** Handle for one card while it is being answered. */
export interface BtwCardHandle {
  readonly id: string;
  /** Cancelled by the card's Stop button, by Clear, or via {@link cancel}. */
  readonly token: vscode.CancellationToken;
  update(patch: Partial<Omit<BtwCard, 'id' | 'question' | 'answer'>>): void;
  append(text: string): void;
  /** Sets the whole answer (e.g. an explanation instead of a model answer). */
  setAnswer(markdown: string): void;
  finish(status: Exclude<BtwCardStatus, 'thinking' | 'streaming'>, error?: string): void;
  cancel(): void;
}

type ToWebview =
  | { type: 'init'; strings: Record<string, string>; cards: BtwCard[]; focus?: { prefill?: string } }
  | { type: 'focus'; prefill?: string }
  | { type: 'card'; card: BtwCard }
  /** `at`: offset in the answer where `text` starts (lets the webview ignore text it already has). */
  | { type: 'delta'; id: string; text: string; at: number }
  | { type: 'clear' };

type FromWebview =
  | { type: 'ready' }
  | { type: 'ask'; question: string }
  | { type: 'copy'; text: string }
  | { type: 'cancel'; id: string }
  | { type: 'clear' }
  | { type: 'openSettings' };

const MAX_CARDS = 50;
const DELTA_FLUSH_MS = 40;

export class BtwAnswersPanel implements vscode.Disposable {
  static readonly viewType = 'contingentWatcher.btwAnswers';

  private panel?: vscode.WebviewPanel;
  private ready = false;
  private cards: BtwCard[] = [];
  private readonly running = new Map<string, vscode.CancellationTokenSource>();
  private readonly mediaRoot: vscode.Uri;
  private seq = 0;
  private pendingFocus?: { prefill?: string };
  /** Called for questions typed into the window's own input. */
  onAsk?: (question: string) => void;

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  }

  /**
   * Shows the window. Created beside the editor, or (setting
   * `contingentWatcher.btw.openIn` = "window") moved into its own floating window
   * the first time. By default focus stays in the chat; with `focusInput` the
   * window's input gets the focus (optionally prefilled).
   */
  async show(opts: { focusInput?: boolean; prefill?: string } = {}): Promise<void> {
    const focus = opts.focusInput ? { prefill: opts.prefill } : undefined;
    if (this.panel) {
      this.panel.reveal(undefined, !focus);
      if (focus) {
        this.focusInput(focus);
      }
      return;
    }
    const openIn = vscode.workspace.getConfiguration('contingentWatcher').get<string>('btw.openIn', 'side');
    const ownWindow = openIn === 'window';
    this.pendingFocus = focus;
    const panel = vscode.window.createWebviewPanel(
      BtwAnswersPanel.viewType,
      vscode.l10n.t('btw'),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !ownWindow && !focus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.mediaRoot] },
    );
    this.panel = panel;
    this.ready = false;
    panel.iconPath = vscode.Uri.joinPath(this.mediaRoot, 'activitybar.svg');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((msg: FromWebview) => void this.onMessage(msg));
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
      }
    });
    if (ownWindow) {
      await this.moveToOwnWindow(!focus);
    }
  }

  private focusInput(focus: { prefill?: string }): void {
    if (this.panel && this.ready) {
      this.post({ type: 'focus', prefill: focus.prefill });
    } else {
      this.pendingFocus = focus;
    }
  }

  private async moveToOwnWindow(refocusChat: boolean): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      this.log.info('btw: answers window moved to its own window');
    } catch (err) {
      this.log.warn(`btw: could not move the answers window (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!refocusChat) {
      return;
    }
    try {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('workbench.action.chat.focusInput')) {
        await vscode.commands.executeCommand('workbench.action.chat.focusInput');
      }
    } catch {
      // best effort
    }
  }

  /** Adds a card for a new question and returns a handle to fill it. */
  startCard(question: string): BtwCardHandle {
    const card: BtwCard = {
      id: `${Date.now().toString(36)}-${++this.seq}`,
      question: question.trim(),
      answer: '',
      status: 'thinking',
    };
    this.cards.push(card);
    if (this.cards.length > MAX_CARDS) {
      this.cards.splice(0, this.cards.length - MAX_CARDS);
    }
    const cts = new vscode.CancellationTokenSource();
    this.running.set(card.id, cts);
    this.post({ type: 'card', card });

    let pending = '';
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (pending) {
        this.post({ type: 'delta', id: card.id, text: pending, at: card.answer.length - pending.length });
        pending = '';
      }
    };
    const publish = () => {
      flush();
      if (this.cards.includes(card)) {
        this.post({ type: 'card', card });
      }
    };

    return {
      id: card.id,
      token: cts.token,
      update: (patch) => {
        Object.assign(card, patch);
        publish();
      },
      append: (text) => {
        if (!text) {
          return;
        }
        card.answer += text;
        if (card.status === 'thinking') {
          card.status = 'streaming';
        }
        pending += text;
        timer ??= setTimeout(flush, DELTA_FLUSH_MS);
      },
      setAnswer: (markdown) => {
        pending = '';
        card.answer = markdown;
        publish();
      },
      finish: (status, error) => {
        card.status = status;
        card.error = error;
        publish();
        cts.dispose();
        if (this.running.get(card.id) === cts) {
          this.running.delete(card.id);
        }
      },
      cancel: () => cts.cancel(),
    };
  }

  /** Cancels running answers and removes all cards. */
  clear(): void {
    for (const cts of this.running.values()) {
      cts.cancel();
    }
    this.cards = [];
    this.post({ type: 'clear' });
  }

  private post(msg: ToWebview): void {
    if (this.panel && this.ready) {
      void this.panel.webview.postMessage(msg);
    }
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    try {
      switch (msg?.type) {
        case 'ready':
          this.ready = true;
          this.post({ type: 'init', strings: webviewStrings(), cards: this.cards, focus: this.pendingFocus });
          this.pendingFocus = undefined;
          return;
        case 'ask':
          if (typeof msg.question === 'string' && msg.question.trim()) {
            this.onAsk?.(msg.question.trim().slice(0, 4000));
          }
          return;
        case 'copy':
          if (typeof msg.text === 'string') {
            await vscode.env.clipboard.writeText(msg.text);
          }
          return;
        case 'cancel':
          this.running.get(String(msg.id))?.cancel();
          return;
        case 'clear':
          this.clear();
          return;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', PREFERRED_MODELS_SETTING);
          return;
      }
    } catch (err) {
      this.log.error(`btw: ${err instanceof Error ? err.message : String(err)}`);
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
    this.panel?.dispose();
    this.panel = undefined;
  }
}

/** UI strings for the webview (keys are referenced by media/btw/btw.js). */
function webviewStrings(): Record<string, string> {
  return {
    headerHint: vscode.l10n.t('Side questions'),
    placeholder: vscode.l10n.t('Ask a side question… (works while the agent is busy)'),
    inputLabel: vscode.l10n.t('Side question'),
    hint: vscode.l10n.t('Enter to send · Shift+Enter for a new line'),
    send: vscode.l10n.t('Send'),
    clear: vscode.l10n.t('Clear'),
    clearTitle: vscode.l10n.t('Remove all side questions'),
    stop: vscode.l10n.t('Stop'),
    copy: vscode.l10n.t('Copy'),
    copyAnswer: vscode.l10n.t('Copy answer'),
    copyCode: vscode.l10n.t('Copy code'),
    copied: vscode.l10n.t('Copied'),
    openSettings: vscode.l10n.t('Open settings'),
    context: vscode.l10n.t('Context: {0}'),
    notMixed: vscode.l10n.t('not mixed into your main task'),
    thinking: vscode.l10n.t('Thinking'),
    stopped: vscode.l10n.t('Stopped.'),
    answerReady: vscode.l10n.t('Answer ready'),
    question: vscode.l10n.t('Question'),
    emptyTitle: vscode.l10n.t('Type here (works while the agent is busy) or use @btw in the chat.'),
    emptyBody: vscode.l10n.t(
      'Answered with the context of your chat and editor, without being mixed into your main task.',
    ),
  };
}
