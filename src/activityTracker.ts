import * as path from 'path';
import * as vscode from 'vscode';
import {
  ActivityKey,
  ActivityState,
  addActiveTime,
  addUsage,
  attributesUsage,
  closeWithCommit,
  CommitInfo,
  countsAsActive,
  emptyState,
  finishManual,
  ManualTask,
  migrate,
  newOwnCommits,
  setHead,
  startManual,
} from './core/activity';

const K_ITEMS = 'activity';
const TICK_MS = 30_000;

/** Minimal subset of the built-in git extension API (vscode.git, API v1). */
interface GitCommit {
  hash: string;
  message: string;
  parents: string[];
  authorEmail?: string;
  authorDate?: Date;
  commitDate?: Date;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string; commit?: string }; onDidChange: vscode.Event<void> };
  getCommit(ref: string): Promise<GitCommit>;
  getConfig?(key: string): Promise<string>;
  getGlobalConfig?(key: string): Promise<string>;
}
interface GitApi {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  onDidOpenRepository?: vscode.Event<GitRepository>;
}

/**
 * Records active editor time and allowance usage. Per repo+branch an open
 * unit collects the time until the user's next own commit closes it; a
 * manually started task takes all time while it runs. "Active" means the
 * window is focused and there was editor activity in the last 5 minutes.
 * Everything stays local (globalState).
 */
export class ActivityTracker implements vscode.Disposable {
  private state: ActivityState;
  private lastSignal = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private git: GitApi | undefined;
  /** Serialises HEAD checks per repository root. */
  private readonly checking = new Map<string, Promise<void>>();
  private readonly watched = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly mem: vscode.Memento,
    private enabled: boolean,
  ) {
    this.state = migrate(mem.get<unknown>(K_ITEMS));
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
    if (!this.git) {
      return;
    }
    this.git.repositories.forEach((r) => this.watch(r));
    if (this.git.onDidOpenRepository) {
      this.disposables.push(this.git.onDidOpenRepository((r) => this.watch(r)));
    }
  }

  private watch(repo: GitRepository): void {
    const root = repo.rootUri.fsPath;
    if (this.watched.has(root)) {
      return;
    }
    this.watched.add(root);
    this.disposables.push(repo.state.onDidChange(() => void this.checkHead(repo)));
    void this.checkHead(repo);
  }

  /** Closes the open unit when HEAD moved because of the user's own commit(s). */
  private checkHead(repo: GitRepository): Promise<void> {
    const root = repo.rootUri.fsPath;
    const next = (this.checking.get(root) ?? Promise.resolve()).then(() => this.doCheckHead(repo)).catch(() => undefined);
    this.checking.set(root, next);
    return next;
  }

  private async doCheckHead(repo: GitRepository): Promise<void> {
    const root = repo.rootUri.fsPath;
    const head = repo.state.HEAD?.commit;
    const prev = this.state.heads[root];
    if (!head || head === prev) {
      return;
    }
    if (this.enabled && prev) {
      const email = (await repo.getConfig?.('user.email').catch(() => '')) || (await repo.getGlobalConfig?.('user.email').catch(() => ''));
      const commits = await newOwnCommits(prev, head, (h) => this.commit(repo, h), email || undefined, Date.now());
      const key = this.keyFor(repo);
      for (const c of commits) {
        this.state = closeWithCommit(this.state, key, c, Date.now());
      }
    }
    this.state = setHead(this.state, root, head);
    await this.save();
  }

  private async commit(repo: GitRepository, hash: string): Promise<CommitInfo | undefined> {
    const c = await repo.getCommit(hash);
    if (!c) {
      return undefined;
    }
    const date = c.commitDate ?? c.authorDate;
    return { hash: c.hash, message: c.message ?? '', parents: c.parents ?? [], authorEmail: c.authorEmail, time: date ? new Date(date).getTime() : undefined };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (enabled) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    }
  }

  private repository(): GitRepository | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.git?.getRepository(uri)) || this.git?.repositories[0];
  }

  private keyFor(repo: GitRepository): ActivityKey {
    return { repo: path.basename(repo.rootUri.fsPath), branch: repo.state.HEAD?.name ?? 'HEAD' };
  }

  /** The branch/repo currently worked on. */
  currentKey(): ActivityKey | undefined {
    const repo = this.repository();
    if (repo) {
      return this.keyFor(repo);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? { repo: folder.name } : undefined;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (!this.enabled || !countsAsActive(now, this.lastSignal, vscode.window.state.focused)) {
      return;
    }
    const next = addActiveTime(this.state, this.currentKey(), now, TICK_MS);
    if (next !== this.state) {
      this.state = next;
      await this.save();
    }
  }

  /** Attributes newly used allowance to the manual task or the open unit. */
  async recordUsage(delta: number): Promise<void> {
    // Only attribute if the user was actually working recently.
    if (!this.enabled || delta <= 0 || !attributesUsage(Date.now(), this.lastSignal)) {
      return;
    }
    const next = addUsage(this.state, this.currentKey(), Date.now(), delta);
    if (next !== this.state) {
      this.state = next;
      await this.save();
    }
  }

  get manualTask(): ManualTask | undefined {
    return this.state.manual;
  }

  /** Starts a manual task; a running one is finished first. */
  async startTask(name: string): Promise<void> {
    this.state = startManual(this.state, name, this.currentKey(), Date.now());
    await this.save();
  }

  /** Finishes the running manual task. Returns it, or undefined if none was running. */
  async finishTask(): Promise<ManualTask | undefined> {
    const m = this.state.manual;
    if (m) {
      this.state = finishManual(this.state, Date.now());
      await this.save();
    }
    return m;
  }

  async clear(): Promise<void> {
    // Keep the known HEADs, so the next commit is still detected.
    this.state = { ...emptyState(), heads: this.state.heads };
    await this.save();
  }

  private async save(): Promise<void> {
    await this.mem.update(K_ITEMS, this.state);
    this.changed.fire();
  }

  snapshot(): { state: ActivityState; key: ActivityKey | undefined } {
    return { state: this.state, key: this.currentKey() };
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
