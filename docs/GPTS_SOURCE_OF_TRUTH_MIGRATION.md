# Future Plan — Move GPTS instructions from Google Docs to GitHub source of truth

## Purpose

After GitHub ADD is implemented, use it to migrate GPTS operating instructions from Google Docs into GitHub and keep them updated there.

Goal: stop manually updating GPT Builder instructions every time a source document changes.

## Important reality check

GPT Builder instructions do not automatically reload an external system prompt file just because a GitHub link is pasted inside instructions.

To read current files at runtime, GPTS must have a tool/action/browser route that can fetch those files, and the system prompt must explicitly instruct it to fetch them for project-like tasks.

Therefore the correct design is:

```text
GPT Builder static Instructions = small stable bootstrap
GitHub repository files = current source of truth
GPTS runtime behavior = fetch manifest/source files when project work starts
```

## Access model decision

There are two possible access models.

### Option A — public raw files

Use raw GitHub URLs such as:

```text
https://raw.githubusercontent.com/n0namer/<repo>/main/instructions/MANIFEST.md
```

Pros:

- simplest;
- no auth;
- GPTS can fetch via browser/web action if available.

Cons:

- instructions are public;
- not suitable for secrets or sensitive internal prompts.

### Option B — authenticated GitHub fetch

Use a GitHub Action / GitHub ADD endpoint to fetch private repo files.

Pros:

- private source of truth;
- can keep operational docs private.

Cons:

- GPTS must have an action with auth;
- bootstrap must explicitly call that action;
- more moving parts.

## Recommended MVP

For speed, use public non-secret instruction files first, or use existing private GitHub connector when available.

Do not put secrets in instruction files.

Use GitHub ADD later for safe patch/write-back, not necessarily for initial read if direct GitHub/raw fetch works.

## Target repository structure

Create or use a dedicated repo for GPTS operating instructions, separate from project-specific repos.

Suggested repo name:

```text
gpts-operating-system
```

Suggested structure:

```text
instructions/
  SYSTEM_PROMPT_BOOTSTRAP.md
  MANIFEST.md
  SOURCE_MAP.md
  OPERATOR_PROTOCOL.md
  CAPABILITY_CARDS.md
  PROJECT_PIPELINE_PROTOCOL.md
  DONE_AND_EVIDENCE_GATE.md
  RECOVERY_RUNBOOKS.md
  CHANGELOG.md

projects/
  PRJ-002/
    PROJECT_PIPELINE.md
    CANVAS.md
    TASKS.yaml

archive/google-docs-migration/
  <exported snapshots>
```

## What to migrate from Google Docs

Current Google Docs source set should be migrated into GitHub as markdown files.

Known source roles from current GPTS setup:

- System Prompt / bootstrap instructions;
- Operator Protocol;
- Capability Cards;
- runtime/source map or supporting docs;
- Project Pipeline references.

Migration rule:

```text
Google Docs are source during migration only.
After migration, GitHub becomes source of truth.
```

## Bootstrap system prompt pattern

The GPT Builder Instructions should stay short and stable.

It should contain:

```text
You are an operating GPTS. GitHub is the source of truth for current instructions.
For any project-like or unclear request, fetch MANIFEST first, then follow Source Map.
Do not rely on stale memory if fetched sources are available.
If source fetch fails, report SOURCE_ACCESS_BLOCKED_WITH_EVIDENCE.
Never mark DONE without DoD + evidence + validator PASS + write-back.
```

Then include exact source links.

Example:

```text
Source of truth manifest:
https://raw.githubusercontent.com/n0namer/gpts-operating-system/main/instructions/MANIFEST.md

Fallback index:
https://raw.githubusercontent.com/n0namer/gpts-operating-system/main/instructions/SOURCE_MAP.md
```

## Runtime protocol

For project-like work:

```text
1. Fetch MANIFEST.md.
2. Fetch SOURCE_MAP.md.
3. Identify active project and required files.
4. Fetch PROJECT_PIPELINE_PROTOCOL.md.
5. Fetch active project PROJECT_PIPELINE.md / TASKS.yaml.
6. Execute one bounded move.
7. Write back to source of truth when required.
8. If write-back fails, mark WRITEBACK_BLOCKED with evidence.
```

## Why system prompt should not contain all instructions

Full instructions in GPT Builder become stale and hit size limits.

Better:

```text
Static GPT Builder prompt = bootloader
GitHub files = current operating system
```

## Update workflow after GitHub ADD exists

When updating instructions:

```text
1. Read current GitHub instruction file.
2. Prepare marker-based patch.
3. Use GitHub ADD /patch/preview.
4. Inspect diff.
5. Use GitHub ADD /patch/apply.
6. Reread file.
7. Record commit SHA.
```

This removes manual copy/paste updates.

## Required markers in instruction files

Add stable markers for patching:

```text
<!-- GPTS:START system-bootstrap -->
...
<!-- GPTS:END system-bootstrap -->

<!-- GPTS:START source-map -->
...
<!-- GPTS:END source-map -->

<!-- GPTS:START recovery-runbooks -->
...
<!-- GPTS:END recovery-runbooks -->
```

## DoD for migration

- All Google Docs instruction sources exported to GitHub markdown.
- `MANIFEST.md` lists all current source files and read order.
- `SOURCE_MAP.md` maps old Google Docs links to GitHub files.
- GPT Builder Instructions contain only stable bootstrap + manifest links.
- GPTS can fetch manifest and at least one linked instruction file.
- Project-like task triggers source fetch without user reminder.
- Write-back target is GitHub, not Google Docs.
- Google Docs marked as migrated/archived or fallback only.

## Open questions

- Which repository will hold global GPTS instructions: existing repo or new `gpts-operating-system`?
- Should source files be public raw links or private authenticated GitHub fetch?
- Which GPTS Actions will be available inside the actual GPTS: GitHub connector, Web fetch, GitHub ADD, or n8n bridge?
- Will GPT Builder Instructions be manually updated once with bootstrap, or generated from GitHub by an external script?

## Recommendation

Do this in two phases:

### Phase 1 — after GitHub ADD MVP works

- migrate docs to GitHub markdown;
- add manifest and source map;
- update GPT Builder system prompt once with bootstrap links;
- validate runtime read.

### Phase 2 — automate write-back

- use GitHub ADD for marker-based instruction updates;
- use TASKS.yaml / changelog for instruction changes;
- stop editing Google Docs as source of truth.
