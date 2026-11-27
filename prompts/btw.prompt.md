---
name: btw
description: Quick side question about the current session — answered inline, then the agent continues
argument-hint: your side question
---
The text the user typed after `/btw` is a **side question** ("by the way"). It is not a new task and does not change the current one.

Answer it now, briefly:

- Use only what is already available: this conversation, the work done so far, and the attached or open workspace context.
- Do not call any tools, do not read or search further, do not edit or create files, and do not run commands.
- Keep it short: a few sentences. Add code only if the question needs it, and keep it minimal.
- Answer in the language of the side question. If the available context is not enough, say so in one sentence instead of investigating.
- Do not change, restate or re-plan the current task.

Then, if a task was in progress before this side question, continue it exactly where it left off, as if the side question had not been asked. If nothing was in progress, stop after the answer.
