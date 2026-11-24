/** Accent presets; tuned to read well on light and dark themes. */
export const ACCENT_PRESETS: Record<string, string> = {
  teal: '#14b8a6',
  violet: '#8b5cf6',
  blue: '#3b82f6',
  green: '#22c55e',
  orange: '#f97316',
  pink: '#ec4899',
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Resolves a preset id or #hex to a colour; undefined = theme default. */
export function resolveColor(value: string | undefined): string | undefined {
  if (!value || value === 'auto') {
    return undefined;
  }
  const v = value.trim();
  if (ACCENT_PRESETS[v]) {
    return ACCENT_PRESETS[v];
  }
  return HEX.test(v) ? v : undefined;
}

export type IconStyle = 'gauge' | 'battery' | 'ring' | 'bars' | 'none';

/** Level 0..4 (4 = full) matching the remaining share. */
export function fillLevel(remaining: number, entitlement: number): number {
  if (entitlement <= 0) {
    return 4;
  }
  return Math.max(0, Math.min(4, Math.ceil((remaining / entitlement) * 4)));
}

/** Codicon reference for the status bar, or '' for no icon. */
export function iconFor(style: IconStyle, level: number): string {
  switch (style) {
    case 'none':
      return '';
    case 'gauge':
      return `$(contingent-level-${level})`;
    default:
      return `$(contingent-${style}-${level})`;
  }
}
