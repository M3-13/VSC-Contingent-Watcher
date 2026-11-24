# Make your allowance last

Since mid-2026 many plans bill Copilot by usage (AI credits, based on tokens). **Context size is the main cost driver**, so most tips are about sending less, more precisely.

- **Fresh chat per task.** Long histories are re-sent with every request. Start a new chat when the topic changes, or compact long ones.
- **Precise context.** Attach `#file` or `#selection` instead of `#codebase` when you know where the change belongs. Paste only the relevant log lines.
- **Fewer tools.** Enable only the tools and MCP servers a task needs. Every tool definition adds to the input.
- **Right model for the job.** Use the cheapest model that does the job (see the model picker) or *Auto*; keep strong reasoning models for hard problems.
- **Right mode.** Ask for questions, inline chat for one-file changes, agent mode for multi-step work. Plan first, then implement.
- **Instructions and prompt files.** Put project rules in `.github/copilot-instructions.md` and repeated tasks in `.prompt.md` files.
- **Review early.** Check each diff, use checkpoints/undo instead of long repair chains. Ask for tests first.
- **Free features.** Inline completions and next edit suggestions don't use your allowance.
- **Side questions with `@btw`.** Keep quick questions out of your main task's context.
- **Budget.** Set a spending limit in your GitHub billing settings.

The **Tips** tab in the dashboard shows the tips that fit your current situation.
