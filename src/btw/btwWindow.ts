/**
 * The btw window: a narrow panel beside the editor for ONE quick side question
 * about the current Copilot session. It reads the session (chat storage), git
 * changes and the editor, answers right away (independent of a busy agent) and
 * never creates or switches chat sessions. A new question replaces the answer;
 * Esc or ✕ closes the window and returns to the chat input.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { streamBtwAnswer } from './answer';
import { gatherBtwContext, readSessionHeader } from './context';
import { BtwModelSource, chooseBtwModel, findBtwModel, resolveBtwModel } from './model';
import { SummaryLabels, buildBtwPrompt, describeSummary } from './prompt';

type CardStatus = 'thinking' | 'streaming' | 'done' | 'cancelled' | 'error';

/** The single question and its answer, as rendered by media/btw/btw.js. */
export interface BtwCard {
  id: string;
  question: string;
  /** Markdown. */
  answer: string;
  status: CardStatus;
  /** e.g. "session (6 turns) · diff (4 files) · 3 files · editor". */
  context?: string;
  model?: string;
  error?: string;
}

interface Header {
  /** Session title (first prompt), if a working session was found. */
  title?: string;
  model?: string;
  /** Why this model (localised), shown as tooltip. */
  modelNote?: string;
}

type ToWebview =
  | { type: 'init'; strings: Record<string, string>; header: Header; card?: BtwCard; focus?: { prefill?: string } }
  | { type: 'header'; header: Header }
  | { type: 'card'; card: BtwCard }
  /** `at`: offset in the answer where `text` starts. */
  | { type: 'delta'; id: string; text: string; at: number }
  | { type: 'focus'; prefill?: string };

type FromWebview =
  | { type: 'ready' }
  | { type: 'ask'; question: string }
  | { type: 'stop' }
  | { type: 'copy'; text: string }
  | { type: 'close' }
  | { type: 'chooseModel' };

const MAX_QUESTION = 4000;
const DELTA_FLUSH_MS = 40;

export class BtwWindow implements vscode.Disposable {
  static readonly viewType = 'contingentWatcher.btw';

  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pendingFocus?: { prefill?: string };
  private header: Header = {};
  private card?: BtwCard;
  private running?: vscode.CancellationTokenSource;
  /** Model picked in the window; used until the window is closed. */
  private overrideModelId?: string;
  private sessionModelId?: string;
  private seq = 0;
  private readonly mediaRoot: vscode.Uri;

  constructor(
    private readonly ext: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.mediaRoot = vscode.Uri.joinPath(ext.extensionUri, 'media');
  }

  /** Opens (or reveals) the window beside the editor and focuses its input. */
  async open(prefill?: string): Promise<void> {
    const focus = { prefill };
    if (this.panel) {
      this.panel.reveal(undefined, false);
      this.focusInput(focus);
      void this.refreshHeader();
      return;
    }
    const singleGroup = vscode.window.tabGroups.all.length === 1;
    const panel = vscode.window.createWebviewPanel(
      BtwWindow.viewType,
      vscode.l10n.t('btw'),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.mediaRoot] },
    );
    this.panel = panel;
    this.ready = false;
    this.pendingFocus = focus;
    this.card = undefined;
    panel.iconPath = vscode.Uri.joinPath(this.mediaRoot, 'activitybar.svg');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((msg: FromWebview) => void this.onMessage(msg));
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.running?.cancel();
        this.panel = undefined;
        this.ready = false;
        this.card = undefined;
        this.overrideModelId = undefined;
      }
    });
    if (singleGroup) {
      // Keep the window narrow next to the editor (best effort).
      try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.68 }, { size: 0.32 }] });
      } catch {
        // ignore
      }
    }
    void this.refreshHeader();
  }

  /** Closes the window and returns focus to the chat input. */
  async close(): Promise<void> {
    this.running?.cancel();
    this.panel?.dispose();
    try {
      const commands = await vscode.commands.getCommands(true);
      const target = ['workbench.action.chat.focusInput', 'workbench.panel.chat.view.copilot.focus'].find((c) => commands.includes(c));
      if (target) {
        await vscode.commands.executeCommand(target);
      }
    } catch {
      // best effort
    }
  }

  private async refreshHeader(): Promise<void> {
    const head = await readSessionHeader(this.ext, (m) => this.log.info(m));
    this.sessionModelId = head.modelId;
    const found = await findBtwModel(this.ext, head.modelId, this.overrideModelId);
    this.header = {
      title: head.title,
      model: found?.model.name,
      modelNote: found ? sourceLabel(found.source) : undefined,
    };
    this.post({ type: 'header', header: this.header });
  }

  private focusInput(focus: { prefill?: string }): void {
    if (this.panel && this.ready) {
      this.post({ type: 'focus', prefill: focus.prefill });
    } else {
      this.pendingFocus = focus;
    }
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
          this.post({ type: 'init', strings: webviewStrings(), header: this.header, card: this.card, focus: this.pendingFocus });
          this.pendingFocus = undefined;
          return;
        case 'ask':
          if (typeof msg.question === 'string' && msg.question.trim()) {
            await this.ask(msg.question.trim().slice(0, MAX_QUESTION));
          }
          return;
        case 'stop':
          this.running?.cancel();
          return;
        case 'copy':
          if (typeof msg.text === 'string') {
            await vscode.env.clipboard.writeText(msg.text);
          }
          return;
        case 'close':
          await this.close();
          return;
        case 'chooseModel': {
          const m = await chooseBtwModel(this.ext, undefined, this.overrideModelId);
          if (m) {
            this.overrideModelId = m.id;
            this.header = { ...this.header, model: m.name, modelNote: sourceLabel('chosen') };
            this.post({ type: 'header', header: this.header });
          }
          return;
        }
      }
    } catch (err) {
      this.log.error(`btw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Answers one question; replaces the previous card. */
  private async ask(question: string): Promise<void> {
    this.running?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.running = cts;
    const card: BtwCard = { id: `${Date.now().toString(36)}-${++this.seq}`, question, answer: '', status: 'thinking' };
    this.card = card;
    const publish = () => {
      if (this.card === card) {
        this.post({ type: 'card', card });
      }
    };
    publish();

    let pending = '';
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (pending && this.card === card) {
        this.post({ type: 'delta', id: card.id, text: pending, at: card.answer.length - pending.length });
      }
      pending = '';
    };

    try {
      const { ctx, modelId } = await gatherBtwContext(this.ext, { log: (m) => this.log.info(m) });
      this.sessionModelId = modelId ?? this.sessionModelId;
      if (cts.token.isCancellationRequested) {
        card.status = 'cancelled';
        return;
      }
      const pick = await resolveBtwModel(this.ext, this.sessionModelId, this.overrideModelId, (m) => this.log.info(m));
      if (pick.kind !== 'ok') {
        card.status = 'error';
        card.error =
          pick.kind === 'error' ? pick.message : vscode.l10n.t('No model chosen, so btw did not answer. Choose a model and try again.');
        return;
      }
      const prompt = buildBtwPrompt(question, ctx);
      card.context = describeSummary(prompt.summary, summaryLabels());
      card.model = pick.model.name;
      card.status = 'streaming';
      this.header = { ...this.header, title: ctx.session?.title ?? this.header.title, model: pick.model.name, modelNote: sourceLabel(pick.source) };
      this.post({ type: 'header', header: this.header });
      publish();
      this.log.info(`btw: asking ${pick.model.name} (${pick.source}) · context: ${card.context}`);

      const res = await streamBtwAnswer(
        pick.model,
        prompt,
        (fragment) => {
          card.answer += fragment;
          pending += fragment;
          timer ??= setTimeout(flush, DELTA_FLUSH_MS);
        },
        cts.token,
      );
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
      flush();
      cts.dispose();
      if (this.running === cts) {
        this.running = undefined;
      }
      publish();
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
    this.running?.cancel();
    this.panel?.dispose();
    this.panel = undefined;
  }
}

function sourceLabel(source: BtwModelSource): string {
  return source === 'session' ? vscode.l10n.t('Same model as your session') : vscode.l10n.t('Chosen by you');
}

function summaryLabels(): SummaryLabels {
  return {
    sessionOne: vscode.l10n.t('session (1 turn)'),
    sessionMany: vscode.l10n.t('session ({0} turns)', '{0}'),
    diffOne: vscode.l10n.t('diff (1 file)'),
    diffMany: vscode.l10n.t('diff ({0} files)', '{0}'),
    fileOne: vscode.l10n.t('1 file'),
    fileMany: vscode.l10n.t('{0} files', '{0}'),
    editor: vscode.l10n.t('editor'),
    none: vscode.l10n.t('none'),
  };
}

/** Command `contingentWatcher.btw`: opens the window; with a selection, prefills "About the selection: ". */
export async function openBtwWindow(win: BtwWindow): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  await win.open(ed && !ed.selection.isEmpty ? vscode.l10n.t('About the selection: ') : undefined);
}

/** UI strings for the webview (keys are referenced by media/btw/btw.js). */
function webviewStrings(): Record<string, string> {
  return {
    close: vscode.l10n.t('Close (Esc)'),
    noSession: vscode.l10n.t('No active chat session found'),
    chooseModel: vscode.l10n.t('Choose model'),
    modelTitle: vscode.l10n.t('Model for this side question. Click to change.'),
    placeholder: vscode.l10n.t('Ask a side question about this session…'),
    inputLabel: vscode.l10n.t('Side question'),
    hint: vscode.l10n.t('Enter to send · Shift+Enter for a new line · Esc to close'),
    send: vscode.l10n.t('Send'),
    stop: vscode.l10n.t('Stop'),
    copy: vscode.l10n.t('Copy'),
    copyAnswer: vscode.l10n.t('Copy answer'),
    copyCode: vscode.l10n.t('Copy code'),
    copied: vscode.l10n.t('Copied'),
    thinking: vscode.l10n.t('Reading the session…'),
    stopped: vscode.l10n.t('Stopped.'),
    context: vscode.l10n.t('Context: {0}'),
    answerReady: vscode.l10n.t('Answer ready'),
    emptyTitle: vscode.l10n.t('Ask anything about the current session.'),
    emptyBody: vscode.l10n.t(
      "Answered right away from the chat, the agent's changes and your editor. The agent keeps working, and nothing is added to the chat.",
    ),
  };
}
