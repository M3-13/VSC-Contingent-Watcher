/** Pure helpers for git diff text. No vscode import (unit-testable). */

/** 1-based first line of the first hunk in the new file ("@@ -a,b +c,d @@"), if any. */
export function hunkStart(diff: string): number | undefined {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(diff);
  return m ? Math.max(1, Number(m[1])) : undefined;
}
