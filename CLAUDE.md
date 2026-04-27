# Career-Ops for Claude Code

Read `AGENTS.md` first. It is the canonical source for routing, onboarding,
data-contract rules, ethical constraints, and pipeline integrity.

This file exists only as the Claude adapter.

## Claude-Specific Notes

- Reuse the checked-in core: `modes/*`, `templates/*`, `batch/*`, and the root
  scripts. Do not create a Claude-only workflow.
- Claude command entrypoints live in `.claude/skills/career-ops/SKILL.md`.
- When browser automation is available, prefer Playwright for live job
  verification and application assistance.
- Keep personalization in `config/profile.yml`, `modes/_profile.md`,
  `article-digest.md`, or `portals.yml`.
- Never submit an application on the user's behalf.
