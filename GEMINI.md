# Career-Ops for Gemini CLI

> This file is auto-loaded by Gemini CLI as persistent context.
> `AGENTS.md` is the canonical source of truth for project behavior.
> Gemini command entrypoints live in `.gemini/commands/`.

Read `AGENTS.md` first, then apply these Gemini-specific notes:

- Reuse the checked-in core: `modes/*`, `templates/*`, `batch/*`, and the root
  scripts. Do not create a Gemini-only workflow.
- Gemini slash commands map onto the same mode files as the other adapters.
- Keep personalization in `config/profile.yml`, `modes/_profile.md`,
  `article-digest.md`, or `portals.yml`.
- Never submit an application on the user's behalf.

For a standalone evaluator outside the CLI adapter, `gemini-eval.mjs` remains
available as an optional integration script.
