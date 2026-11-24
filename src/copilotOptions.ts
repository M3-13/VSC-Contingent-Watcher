import * as vscode from 'vscode';

/* eslint-disable @typescript-eslint/no-explicit-any */

const COPILOT_IDS = ['GitHub.copilot', 'GitHub.copilot-chat'];

interface DiscoveredSetting {
  key: string;
  options: string[];
}

/**
 * Copilot's own options (as in Copilot's status bar menu), discovered at
 * runtime from the installed Copilot extension's manifest, so we follow
 * whatever setting names the installed version actually uses.
 */
export class CopilotOptions {
  private eagernessSetting: DiscoveredSetting | undefined;
  private snoozeCommand: string | undefined;

  constructor() {
    this.discover();
  }

  get installed(): boolean {
    return COPILOT_IDS.some((id) => !!vscode.extensions.getExtension(id));
  }

  /** Re-reads manifests and commands (e.g. after Copilot was installed or updated). */
  discover(): void {
    this.eagernessSetting = undefined;
    for (const id of COPILOT_IDS) {
      const pkg: any = vscode.extensions.getExtension(id)?.packageJSON;
      const sections: any[] = Array.isArray(pkg?.contributes?.configuration)
        ? pkg.contributes.configuration
        : pkg?.contributes?.configuration
          ? [pkg.contributes.configuration]
          : [];
      for (const section of sections) {
        for (const [key, def] of Object.entries<any>(section?.properties ?? {})) {
          if (/eagerness/i.test(key) && Array.isArray(def?.enum) && def.enum.every((v: unknown) => typeof v === 'string')) {
            // Prefer the inline/next-edit suggestion setting if several exist.
            if (!this.eagernessSetting || /nextEdit|inline|completion/i.test(key)) {
              this.eagernessSetting = { key, options: def.enum };
            }
          }
        }
      }
    }
    void vscode.commands.getCommands(true).then((cmds) => {
      this.snoozeCommand =
        cmds.find((c) => /^github\.copilot\..*snooze/i.test(c) && !/unsnooze|cancel/i.test(c)) ??
        cmds.find((c) => /^editor\.action\.inlineSuggest\.snooze/i.test(c));
    });
  }

  private split(key: string): [string, string] {
    const i = key.lastIndexOf('.');
    return [key.slice(0, i), key.slice(i + 1)];
  }

  get eagerness(): { value: string; options: string[] } | undefined {
    const s = this.eagernessSetting;
    if (!s) {
      return undefined;
    }
    const [section, name] = this.split(s.key);
    const value = vscode.workspace.getConfiguration(section).get<string>(name) ?? s.options[0];
    return { value, options: s.options };
  }

  async setEagerness(value: unknown): Promise<void> {
    const s = this.eagernessSetting;
    if (!s || typeof value !== 'string' || !s.options.includes(value)) {
      return;
    }
    const [section, name] = this.split(s.key);
    await vscode.workspace.getConfiguration(section).update(name, value, vscode.ConfigurationTarget.Global);
  }

  get snoozeAvailable(): boolean {
    return !!this.snoozeCommand;
  }

  async snooze(): Promise<void> {
    if (this.snoozeCommand) {
      await vscode.commands.executeCommand(this.snoozeCommand);
    }
  }

  private get enableMap(): Record<string, boolean> {
    return vscode.workspace.getConfiguration('github.copilot').get<Record<string, boolean>>('enable') ?? {};
  }

  get completionsEnabled(): boolean {
    return this.enableMap['*'] !== false;
  }

  /** Language-specific completions toggle for the active editor. */
  get language(): { id: string; label: string; enabled: boolean } | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file') {
      return undefined;
    }
    const map = this.enableMap;
    const id = doc.languageId;
    return { id, label: id, enabled: map[id] ?? map['*'] !== false };
  }

  async setCompletions(enabled: boolean): Promise<void> {
    await this.updateEnable({ '*': enabled });
  }

  async setLanguage(enabled: boolean): Promise<void> {
    const lang = this.language;
    if (lang) {
      await this.updateEnable({ [lang.id]: enabled });
    }
  }

  private async updateEnable(patch: Record<string, boolean>): Promise<void> {
    await vscode.workspace
      .getConfiguration('github.copilot')
      .update('enable', { ...this.enableMap, ...patch }, vscode.ConfigurationTarget.Global);
  }

  get nextEditEnabled(): boolean {
    return vscode.workspace.getConfiguration('github.copilot').get<boolean>('nextEditSuggestions.enabled', true);
  }

  async setNextEdit(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('github.copilot').update('nextEditSuggestions.enabled', enabled, vscode.ConfigurationTarget.Global);
  }
}
