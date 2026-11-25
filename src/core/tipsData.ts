import type { Tip } from './tips';

/**
 * Best practices for using GitHub Copilot sparingly (researched November 2026).
 * Deliberately no prices or multipliers: they change; the model picker shows them.
 * `when` decides in which situations a tip is shown (see core/tips.ts).
 */
export const TIPS: Tip[] = [
  {
    id: "newChatPerTask",
    when: ["general", "ahead", "critical", "onTrack"],
    text: "Start a new chat whenever the topic changes. A clean context is cheaper per request and gives better answers.",
  },
  {
    id: "compactLongChats",
    when: ["ahead", "critical"],
    text: "In long chats run /compact to summarise older turns instead of dragging the whole history into every request.",
  },
  {
    id: "lighterModelSimple",
    when: ["general", "ahead", "critical"],
    text: "Use a lighter model for quick edits, boilerplate and direct questions; keep reasoning models for hard problems.",
  },
  {
    id: "lowerThinkingEffort",
    when: ["ahead", "critical"],
    text: "If your model offers a lower thinking/reasoning level in the model picker, use it for routine tasks; deep reasoning burns many output tokens.",
  },
  {
    id: "trimToolList",
    when: ["general", "ahead", "critical"],
    text: "Enable only the tools a task needs via Configure Tools. Every tool definition and result adds to the context you pay for.",
  },
  {
    id: "limitMcpServers",
    when: ["ahead", "critical", "lateMonth"],
    text: "Disable MCP servers you are not using in this session; large tool catalogs inflate input on every request.",
  },
  {
    id: "keepCacheWarm",
    when: ["onTrack", "ahead"],
    text: "Stay in one focused session for one task. Switching models or settings mid-session can make the next requests more expensive.",
  },
  {
    id: "autoModel",
    when: ["general", "earlyMonth", "ahead"],
    text: "Try the Auto model option; it routes by task so simple requests go to cheaper models. Check the model picker for details.",
  },
  {
    id: "includedModels",
    when: ["critical", "exhausted", "earlyMonth"],
    text: "Prefer models marked as included or lowest cost in the model picker for everyday work, and go premium only when needed.",
  },
  {
    id: "freeCompletions",
    when: ["exhausted", "critical", "general"],
    text: "Inline completions and next edit suggestions do not use your allowance. Lean on them for small edits instead of chat.",
  },
  {
    id: "exhaustedPlan",
    when: ["exhausted"],
    text: "With the allowance used up, keep working with completions and next edit suggestions, and plan chat tasks for the next reset.",
  },
  {
    id: "exhaustedPrepare",
    when: ["exhausted"],
    text: "While blocked, write prompts, specs and instruction files by hand so the next session starts with precise, cheap requests.",
  },
  {
    id: "exhaustedDebugLocal",
    when: ["exhausted"],
    text: "Use the debugger, tests and search yourself before asking chat; reproduce the bug so a later prompt can be one short request.",
  },
  {
    id: "exhaustedBudget",
    when: ["exhausted", "critical"],
    text: "If you truly need more, an additional spending budget can be set in your GitHub billing settings. Set a hard cap you can live with.",
  },
  {
    id: "spendingLimit",
    when: ["general", "earlyMonth"],
    text: "Set a spending limit or budget in GitHub billing so overages cannot surprise you, and check your usage page regularly.",
  },
  {
    id: "planFirst",
    when: ["general", "earlyMonth", "onTrack"],
    text: "Use Plan mode or a planning custom agent first, review the plan, then implement it in a fresh chat with the plan attached.",
  },
  {
    id: "askForQuestions",
    when: ["ahead", "critical", "general"],
    text: "Use Ask mode for explanations and questions; it avoids agent loops with many tool calls and costs less than agent mode.",
  },
  {
    id: "agentForMultiStep",
    when: ["ahead", "critical"],
    text: "Reserve agent mode for multi-file, multi-step work. For a one-file change, a precise prompt in inline chat is enough.",
  },
  {
    id: "specificContext",
    when: ["general", "ahead", "critical"],
    text: "Attach exact files with #file or #selection instead of #codebase when you already know where the change belongs.",
  },
  {
    id: "avoidBigAttachments",
    when: ["ahead", "critical"],
    text: "Do not attach whole logs, huge files or many images. Paste only the relevant lines, since long input costs more on every turn.",
  },
  {
    id: "oneGoalPerPrompt",
    when: ["general", "onTrack"],
    text: "Give one clear goal per prompt with acceptance criteria and a named example. Vague prompts cause costly retry rounds.",
  },
  {
    id: "copilotInstructions",
    when: ["earlyMonth", "general"],
    text: "Put project rules, build and test commands in .github/copilot-instructions.md so you stop repeating them in every prompt.",
  },
  {
    id: "scopedInstructions",
    when: ["earlyMonth", "general"],
    text: "Use *.instructions.md files with an applyTo glob so language- or folder-specific rules load only when relevant.",
  },
  {
    id: "promptFiles",
    when: ["earlyMonth", "onTrack"],
    text: "Turn repeated tasks into .prompt.md files and run them with a slash command for consistent, short requests.",
  },
  {
    id: "customAgentModel",
    when: ["earlyMonth", "general"],
    text: "Define custom agents with a restricted tools list and a fixed model, e.g. a cheap one for docs and a strong one for design.",
  },
  {
    id: "reviewDiffs",
    when: ["general", "onTrack"],
    text: "Review each diff before accepting. Catching a wrong turn early is cheaper than a long chain of correction prompts.",
  },
  {
    id: "checkpointsUndo",
    when: ["ahead", "critical", "general"],
    text: "Use checkpoints and undo to roll back a bad agent run instead of asking the model to repair its own mess.",
  },
  {
    id: "testsFirst",
    when: ["onTrack", "general"],
    text: "Ask for tests first, then the implementation, and let the agent run them. A failing test is a precise, short feedback loop.",
  },
  {
    id: "codeReviewCost",
    when: ["ahead", "critical"],
    text: "Copilot code review on private repos also uses Actions minutes. Trigger it on PRs that matter, not on every small push.",
  },
  {
    id: "localReviewSurplus",
    when: ["surplus"],
    text: "Use leftover allowance for a deep review of your riskiest module with a strong model, or a Copilot review before merging a big PR.",
  },
  {
    id: "surplusRefactor",
    when: ["surplus", "lateMonth"],
    text: "Before the month ends, spend spare allowance on a planned refactor or migration with a premium model, in small reviewed steps.",
  },
  {
    id: "surplusTestsDocs",
    when: ["surplus", "lateMonth"],
    text: "Let a premium model write missing tests, docs and README sections now; leftover allowance expires at the reset.",
  },
  {
    id: "surplusInstructions",
    when: ["surplus", "lateMonth"],
    text: "Spend spare allowance letting an agent draft your copilot-instructions.md and prompt files, then trim them by hand.",
  },
  {
    id: "cloudAgentBatch",
    when: ["surplus", "general"],
    text: "The cloud coding agent works asynchronously on issues and its usage is billed too. Hand it well-scoped issues, not vague ones.",
  },
  {
    id: "sideQuestions",
    when: ["general", "ahead"],
    text: "Ask quick side questions with @btw (or in a separate chat) so they don't bloat the context of your main task.",
  },
  {
    id: "planMonthStart",
    when: ["earlyMonth"],
    text: "At the start of the month, split the allowance into weekly shares and note which big tasks deserve premium models.",
  },
  {
    id: "earlyMonthSetup",
    when: ["earlyMonth"],
    text: "Early in the month invest in setup: instructions, prompt files and tool selection pay back across every later request.",
  },
  {
    id: "lateMonthBatch",
    when: ["lateMonth", "critical"],
    text: "Late in the month, batch small questions into one precise prompt and defer large explorations to after the reset.",
  },
  {
    id: "keepHabits",
    when: ["onTrack", "lateMonth"],
    text: "You are on track: keep fresh chats, scoped context and cheaper models for routine work, and check usage weekly.",
  },
  {
    id: "dailyBudget",
    when: ["onTrack", "ahead", "earlyMonth"],
    text: "Check the daily budget in the status bar: it tells you what you can spend today and still get through to the reset.",
  },
];
