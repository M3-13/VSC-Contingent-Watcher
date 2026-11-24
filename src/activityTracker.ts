import * as path from 'path';
import * as vscode from 'vscode';
import { ActivityItem, ActivityKey, addActiveTime, addUsage, IDLE_MS, isActive } from './core/activity';

const K_ITEMS = 'activity';
const TICK_MS = 30_000;

/** Minimal subset of the built-in git extension API (vscode.git, API v1). */
interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string; commit?: string }; onDidChange: vscode.Event<void> };
  getCommit(ref: string): Promise<{ message: string }>;
}
interface GitApi {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

/**
 * Records active editor time and quota usage per git branch. "Active" means
 * the window is focused and there was editor activity in the last 5 minutes.
 * Everything stays local (globalState).
 */
export class ActivityTracker implements vscode.Disposable {
  private items: ActivityItem[];
  private lastSignal = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private git: GitApi | undefined;
  private detailCache = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly mem: vscode.Memento,
    private enabled: boolean,
  ) {
    this.items = mem.get<ActivityItem[]>(K_ITEMS, []);
    const signal = () => (this.lastSignal = Date.now());
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => e.document.uri.scheme === 'file' && signal()),
      vscode.window.onDidChangeActiveTextEditor(signal),
      vscode.window.onDidChangeTextEditorSelection(signal),
      vscode.window.onDidChangeWindowState((s) => s.focused && signal()),
      this.changed,
    );
    void this.initGit();
    this.setEnabled(enabled);
  }

  private async initGit(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
      const exports = ext ? (ext.isActive ? ext.exports : await ext.activate()) : undefined;
      this.git = exports?.getAPI(1);
    } catch {
      this.git = undefined;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (enabled) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
    }
  }

  private repository(): GitRepository | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.git?.getRepository(uri)) || this.git?.repositories[0];
  }

  /** The branch/repo currently worked on. */
  currentKey(): ActivityKey | undefined {
    const repo = this.repository();
    if (repo) {
      return { repo: path.basename(repo.rootUri.fsPath), branch: repo.state.HEAD?.name ?? 'HEAD' };
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? { repo: folder.name } : undefined;
  }

  private async detail(): Promise<string | undefined> {
    const repo = this.repository();
    const commit = repo?.state.HEAD?.commit;
    if (!repo || !commit) {
      return undefined;
    }
    if (!this.detailCache.has(commit)) {
      try {
        const c = await repo.getCommit(commit);
        this.detailCache.set(commit, c.message.split('\n')[0].slice(0, 120));
      } catch {
        return undefined;
      }
    }
    return this.detailCache.get(commit);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (!this.enabled || !vscode.window.state.focused || now - this.lastSignal > IDLE_MS) {
      return;
    }
    const key = this.currentKey();
    if (!key) {
      return;
    }
    this.items = addActiveTime(this.items, key, now, TICK_MS, await this.detail());
    await this.save();
  }

  /** Attributes newly used quota to the current item. */
  async recordUsage(delta: number): Promise<void> {
    const key = this.currentKey();
    // Only attribute if the user was actually working recently.
    if (!this.enabled || !key || delta <= 0 || Date.now() - this.lastSignal > 4 * IDLE_MS) {
      return;
    }
    this.items = addUsage(this.items, key, Date.now(), delta);
    await this.save();
  }

  async clear(): Promise<void> {
    this.items = [];
    await this.save();
  }

  private async save(): Promise<void> {
    await this.mem.update(K_ITEMS, this.items);
    this.changed.fire();
  }

  snapshot(): { items: ActivityItem[]; isActive(i: ActivityItem): boolean } {
    const key = this.currentKey();
    const now = Date.now();
    return { items: this.items, isActive: (i) => isActive(i, key, now) };
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
