# Career-Ops -- Canonical Agent Instructions

`AGENTS.md` is the source of truth for repository behavior.

Agent-specific entrypoints such as `CLAUDE.md`, `GEMINI.md`, `docs/CODEX.md`,
`.claude/`, `.gemini/`, and `.opencode/` are adapters around the same checked-in
core: `modes/*`, `templates/*`, `batch/*`, and the Node scripts in the repo root.

## Core Rule

Reuse the existing modes, scripts, templates, and tracker flow. Do not create
parallel logic for a specific agent runtime.

## Data Contract (Critical)

There are two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (never auto-updated, personalization goes here):**
- `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer (auto-updatable, do not put user data here):**
- `modes/_shared.md`, `modes/oferta.md`, and the other checked-in mode files
- `AGENTS.md`, adapter docs (`CLAUDE.md`, `GEMINI.md`, `docs/CODEX.md`)
- `*.mjs` scripts, `dashboard/*`, `templates/*`, `batch/*`

**The rule:** When the user asks to customize archetypes, narrative, negotiation
scripts, proof points, location policy, or compensation targets, write to
`modes/_profile.md`, `config/profile.yml`, `article-digest.md`, or `portals.yml`.
Never put user-specific behavior in `modes/_shared.md`.

## Update Check

On the first message of each session, run the update checker silently:

```bash
node update-system.mjs check
```

Parse the JSON output:
- `{"status": "update-available", "local": "...", "remote": "...", "changelog": "..."}`:
  tell the user `career-ops update available (v{local} -> v{remote}). Your data (CV, profile, tracker, reports) will NOT be touched. Want me to update?`
  If yes: `node update-system.mjs apply`
  If no: `node update-system.mjs dismiss`
- `{"status": "up-to-date"}`: say nothing
- `{"status": "dismissed"}`: say nothing
- `{"status": "offline"}`: say nothing

The user can also ask to check for updates at any time. To roll back:

```bash
node update-system.mjs rollback
```

## What Career-Ops Is

Career-Ops is an AI-assisted job search operating system: pipeline tracking,
offer evaluation, CV generation, portal scanning, batch processing, and
application support. A compatible AI agent should route into the repo's checked-in
mode files and scripts rather than inventing its own workflow.

### Canonical Files

| File | Function |
|------|----------|
| `data/applications.md` | Canonical application tracker |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `portals.yml` | Query and tracked-company config |
| `templates/cv-template.html` | HTML template for CV generation |
| `templates/cv-template.tex` | LaTeX/Overleaf template |
| `generate-pdf.mjs` | HTML to PDF via Playwright |
| `generate-latex.mjs` | LaTeX validator and pdflatex compiler |
| `scan.mjs` | Zero-token scanner for Greenhouse/Ashby/Lever |
| `check-liveness.mjs` | Posting liveness checker |
| `merge-tracker.mjs` | Merge TSV additions into `data/applications.md` |
| `verify-pipeline.mjs` | Pipeline integrity checks |
| `batch/batch-runner.sh` | Batch orchestrator with configurable agent runner |
| `batch/batch-prompt.md` | Prompt template for batch workers |

## Mode Routing

Use these routing rules unless the current adapter has a stricter local convention.

| User intent | Mode / files to load |
|-------------|----------------------|
| Raw JD text or job URL | `modes/_shared.md` + `modes/auto-pipeline.md` |
| Single evaluation only | `modes/_shared.md` + `modes/oferta.md` |
| Multiple offers | `modes/_shared.md` + `modes/ofertas.md` |
| Portal scan | `modes/_shared.md` + `modes/scan.md` |
| PDF generation | `modes/_shared.md` + `modes/pdf.md` |
| Live application help | `modes/_shared.md` + `modes/apply.md` |
| Pipeline inbox processing | `modes/_shared.md` + `modes/pipeline.md` |
| Tracker status | `modes/tracker.md` |
| Deep company research | `modes/deep.md` |
| Interview prep | `modes/interview-prep.md` |
| Training / certification review | `modes/training.md` |
| Project evaluation | `modes/project.md` |
| Rejection-pattern analysis | `modes/patterns.md` |
| Follow-up cadence | `modes/followup.md` |
| Batch processing | `modes/_shared.md` + `modes/batch.md` |

Treat raw JD text or a job URL as the full auto-pipeline path unless the user
explicitly asks for evaluation only.

## First Run -- Onboarding

Before doing anything else, check whether the system is set up:

1. `cv.md` exists
2. `config/profile.yml` exists
3. `modes/_profile.md` exists
4. `portals.yml` exists

If `modes/_profile.md` is missing, copy `modes/_profile.template.md` to
`modes/_profile.md` silently. This is the user's customization file and should
never be overwritten by system updates.

If any required file is missing, enter onboarding mode and do not proceed with
evaluation, scan, or application workflows until the basics are ready.

### Step 1: CV

If `cv.md` is missing, ask the user to:
1. paste their CV for markdown conversion
2. share a LinkedIn URL for extraction
3. describe their experience so you can draft the CV

Create `cv.md` with standard sections such as Summary, Experience, Projects,
Education, and Skills.

### Step 2: Profile

If `config/profile.yml` is missing:
1. copy `config/profile.example.yml`
2. collect name, email, location, timezone, target roles, and target comp
3. fill `config/profile.yml`

Store user-specific archetype and targeting logic in `modes/_profile.md` or
`config/profile.yml`, not in `modes/_shared.md`.

### Step 3: Portals

If `portals.yml` is missing:
1. copy `templates/portals.example.yml`
2. update `title_filter.positive` and tracked companies based on target roles

### Step 4: Tracker

If `data/applications.md` does not exist, create:

```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

### Step 5: Learn the user

Once the basics exist, proactively collect context that improves evaluations:
- what makes the user unique
- what work excites or drains them
- deal-breakers
- strongest professional achievement
- projects, articles, or case studies

Persist those insights in `config/profile.yml`, `modes/_profile.md`, or
`article-digest.md`.

After every evaluation, update the personalization layer when the user corrects
the system's assumptions.

### Step 6: Ready

Once onboarding is complete, confirm that the user can:
- paste a job URL to evaluate it
- run the scanner
- ask for the command list or mode-specific help

If recurring automation is supported by the active adapter, offer to set up
periodic scans. Otherwise suggest cron or a manual cadence reminder.

## Personalization

Career-Ops is designed to be customized in-repo by the active AI agent.

Common requests and where to write them:
- change archetypes or scoring emphasis: `modes/_profile.md` or `config/profile.yml`
- update personal profile: `config/profile.yml`
- add companies or search queries: `portals.yml`
- add proof points: `article-digest.md`
- change the CV template design: `templates/cv-template.html`
- change shared defaults for everyone: `modes/_shared.md` and related shared docs

## Language Modes

Default modes are in `modes/` (English). Additional language-specific packs are available:
- `modes/de/` for DACH German workflows
- `modes/fr/` for French-language workflows
- `modes/ja/` for Japan-specific workflows
- `modes/pt/` for Portuguese-language workflows
- `modes/ru/` for Russian-language workflows

Switch into those directories when the user explicitly asks for that language,
the profile selects `language.modes_dir`, or the job market and output language
make the local pack the better default.

If the user is applying to English-language roles, keep the default English
mode files unless they ask otherwise.

## Ethical Use (Critical)

- Never submit an application on the user's behalf.
- Fill forms, draft answers, and prepare materials, but stop before clicking
  Submit or taking an equivalent irreversible action.
- Strongly discourage low-fit applications. Scores below 4.0/5 should receive
  an explicit recommendation against applying unless the user has a compelling
  reason.
- Quality over speed. A small number of well-targeted applications beats a
  large batch of weak applications.

## Pipeline Integrity

1. Never add new tracker rows by editing `data/applications.md` directly.
   Write TSV additions in `batch/tracker-additions/` and merge them via
   `node merge-tracker.mjs`.
2. Run `node verify-pipeline.mjs` after batch or tracker-affecting work.
3. All reports must include `**URL:**` and `**Legitimacy:**` in the header.
4. All statuses must stay canonical according to `templates/states.yml`.

## Adapter Notes

The repo already includes agent adapters:
- `CLAUDE.md` and `.claude/`
- `GEMINI.md` and `.gemini/`
- `docs/CODEX.md`
- `.opencode/`

Those files may describe runtime-specific command surfaces, but they must not
replace or contradict the routing, data-contract, ethical, or personalization
rules defined here.
