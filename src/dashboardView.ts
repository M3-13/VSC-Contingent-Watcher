import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
  DashboardCommand,
  DashboardModel,
  DashboardSettingKey,
  ExtensionMessage,
  WebviewMessage,
} from './core/dashboardModel';

export interface DashboardHandlers {
  getModel(): DashboardModel;
  onCommand(command: DashboardCommand): void | Promise<unknown>;
  onSetting(key: DashboardSettingKey, value: unknown): void | Promise<unknown>;
}

// Records (not arrays) so the compiler flags a command or setting missing here.
const COMMANDS: Record<DashboardCommand, true> = {
  refresh: true,
  signIn: true,
  showLog: true,
  openSettings: true,
  openBilling: true,
  manageCopilot: true,
  openChat: true,
  snooze: true,
  unsnooze: true,
  openWalkthrough: true,
  configureBillingToken: true,
  clearBillingToken: true,
  clearActivity: true,
  btw: true,
  snoozeCompletions: true,
};

const SETTINGS: Record<DashboardSettingKey, true> = {
  display: true,
  countWeekends: true,
  reserve: true,
  thresholds: true,
  warningsEnabled: true,
  paceWarning: true,
  tipsEnabled: true,
  authProvider: true,
  copilotCompletions: true,
  copilotNextEdit: true,
  accent: true,
  statusBarIcon: true,
  statusBarColor: true,
  surplusHint: true,
  activityTracking: true,
  refreshIntervalMinutes: true,
  alignment: true,
  apiUrl: true,
  preferredModels: true,
  btwModel: true,
  btwOpenIn: true,
  btwIncludeChat: true,
  copilotEagerness: true,
  copilotLanguage: true,
  unit: true,
};

const has = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** Sidebar dashboard: renders a {@link DashboardModel} in a webview. */
export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'contingentWatcher.dashboard';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  /** media/ (dashboard assets and the status bar icon font). */
  private readonly mediaRoot: vscode.Uri;

  constructor(
    extensionUri: vscode.Uri,
    private readonly handlers: DashboardHandlers,
  ) {
    this.mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
  }

  /** True while the view is resolved and on screen. */
  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.mediaRoot] };
    view.webview.html = this.html(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
      // The webview is not retained while hidden; it re-sends 'ready' when shown.
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
        }
      }),
    );
  }

  /** Pushes a new model to the webview (no-op while the view does not exist). */
  update(model: DashboardModel): void {
    if (this.view) {
      const msg: ExtensionMessage = { type: 'model', model };
      void this.view.webview.postMessage(msg);
    }
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg?.type) {
        case 'ready':
          this.update(this.handlers.getModel());
          return;
        case 'command':
          if (has(COMMANDS, msg.command)) {
            await this.handlers.onCommand(msg.command);
          }
          return;
        case 'setSetting':
          if (has(SETTINGS, msg.key)) {
            await this.handlers.onSetting(msg.key, msg.value);
          }
          return;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'dashboard', 'dashboard.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'dashboard', 'dashboard.js'));
    // Loaded with the FontFace API by the script for the status bar icon previews.
    const font = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'contingent-icons.woff'));
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
<title>${vscode.l10n.t('Copilot Contingent')}</title>
</head>
<body data-icon-font="${font}">
<main id="app" aria-busy="true"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}
