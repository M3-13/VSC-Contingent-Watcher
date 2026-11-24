import type { Tip } from './tips';

/**
 * Best practices for spending the Copilot allowance wisely. Deliberately no
 * hard-coded multipliers or prices: they change, the model picker shows them.
 */
export const TIPS: Tip[] = [
  {
    id: 'baseModel',
    when: ['ahead', 'critical'],
    text: 'Use an included model (multiplier 0x, shown in the model picker) for explanations, small edits and boilerplate.',
  },
  {
    id: 'premiumForHard',
    when: ['ahead', 'critical'],
    text: 'Save premium models for genuinely hard problems: architecture, tricky bugs, large refactorings.',
  },
  {
    id: 'completionsFree',
    when: ['critical', 'exhausted'],
    text: 'Inline completions and next edit suggestions do not use your allowance; lean on them when you are short.',
  },
  {
    id: 'agentMode',
    when: ['ahead', 'critical'],
    text: 'Agent mode can use many requests per task. For a small, well-defined change use Ask or Edit instead.',
  },
  {
    id: 'context',
    when: ['general'],
    text: 'Give context up front (#file, #selection, error output) so you get it right the first time instead of asking follow-ups.',
  },
  {
    id: 'batch',
    when: ['general'],
    text: 'Batch related questions into one prompt instead of sending several small ones.',
  },
  {
    id: 'newChat',
    when: ['general'],
    text: 'Start a new chat when the topic changes; long histories cost more and lower answer quality.',
  },
  {
    id: 'instructions',
    when: ['general'],
    text: 'Put recurring conventions in .github/copilot-instructions.md so you do not repeat them in every prompt.',
  },
  {
    id: 'budget',
    when: ['exhausted'],
    text: 'Set a spending limit for overages in your GitHub billing settings so nothing gets expensive by surprise.',
  },
  {
    id: 'dailyBudget',
    when: ['onTrack', 'ahead'],
    text: 'Check the daily budget in the status bar: it tells you what you can spend today and still reach the end of the month.',
  },
];
