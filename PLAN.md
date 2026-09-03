# PLAN.md — GitHub Patch API Source of Truth

Status: ACTIVE
Last updated: 2026-09-03
Project: `n0namer/gpts-actions-github-add-api`
Production app: `github-file-patch-api`
Production URL: `https://github-patch.srv1904412.hstgr.cloud`

## North Star

Provide a small, reliable GitHub control-plane Action whose mutations are precise, fail-closed, stale-safe, previewable, independently verifiable, and easy for an LOM to discover and call correctly.

Success means the GPT-facing contract, backend behavior, tests, and production runtime describe the same capabilities and do not force broad file rewrites for common localized edits.

## Authority and anti-drift

Keep these claims separate:

1. **This file (`PLAN.md`)** owns current project direction, phase goal, decisions, DoD, and next bounded move.
2. **Git repository `main`** owns intended source and durable code/docs.
3. **Production runtime** owns what is actually running now.
4. **Current callable Action schema** owns what an LOM can call in the current session.

Never infer runtime state from `main`, and never infer current callability from source/docs alone.

### Current observed state

- GitHub default/source repository: `n0namer/gpts-actions-github-add-api`.
- Repository HEAD observed: `2747a096ac14c509fb52c0a6fb7980852bc68ff8`.
- Production Coolify app: `github-file-patch-api`.
- Production environment: `production`.
- Production branch configured: `archops/github-control-plane-v05`.
- Production commit configured and image-tagged: `9948acf43f71bb4d75fd99b43912ad70a92513b3`.
- Auto-deploy: disabled.
- Container: running, restart_count=0.
- Healthcheck configuration exists but is disabled.
- Production commit already contains `insert_after_exact_once` in `src/patch.mjs`.
- Repository HEAD also exposes `insert_after_exact_once` in source/OpenAPI/tests.
- A call using operation name `insert_after` failed earlier without changing state.
- Therefore the current issue is **not evidence that the edit engine lacks insertion-after support**. The leading hypothesis is a contract/name/callability mismatch: `insert_after` vs `insert_after_exact_once`, or a GPT-facing schema that does not make the supported variant discoverable enough.

## Current stage

**Implementation / course-correction, runtime-contract alignment.**

BMAD routing used:
- `bmad-help` — entry/router.
- `bmad-sprint-status` — restored actual state and identified the next workflow.
- `bmad-correct-course` — classified the discovered discrepancy as a minor implementation correction rather than a replan.

No new PRD/architecture document is required. Existing code is structurally capable; the highest-value work is to remove the capability naming/surface mismatch and lock it with regression evidence.

## Durable decisions

1. Do **not** rewrite the patch engine merely to add insertion-after behavior; `insert_after_exact_once` already exists.
2. Do **not** program by editing GitHub source and then redeploying for this correction.
3. Runtime implementation work must be performed directly in the existing production container/live-patch lane, then verified in the same runtime.
4. GitHub may be updated only for canonical documentation/write-back and later source capture of an already-proven live delta; GitHub is not the debugging primitive.
5. Preserve exact-once/fail-closed semantics: missing or non-unique anchors must not mutate state.
6. Prefer one canonical operation name. If compatibility requires `insert_after`, implement it only as a narrow alias to `insert_after_exact_once`, not as a second semantic engine.
7. Do not create sidecar plans, `PLAN-v2`, or duplicate change proposals. Update this file in place.
8. Separate `actual runtime`, `repo intended`, and `callable schema` in every status update.

## 30-minute execution batch — current

### Goal

Make insertion-after discoverable/callable without increasing mutation blast radius, then prove it in the existing runtime.

### Tasks

1. Observe the live container files and current route/schema handling for patch operations.
2. Determine exactly where `insert_after` is rejected:
   - request schema / Action surface,
   - route validation,
   - operation dispatcher,
   - or caller naming only.
3. Apply the smallest live correction:
   - preferred: expose/accept canonical `insert_after_exact_once`;
   - optional compatibility alias: `insert_after` → `insert_after_exact_once`, only if this materially improves caller reliability.
4. Add/adjust the smallest relevant regression test in the same live source if the runtime contains the test tree.
5. Run bounded validation in the same runtime.
6. Canary:
   - unique anchor preview succeeds;
   - apply/readback succeeds on a safe test target if an owned canary path exists;
   - missing anchor fails closed;
   - duplicate anchor fails closed;
   - stale SHA fails closed where applicable.
7. Capture the proven live delta back to canonical Git source through the designated SourceLoop/source-capture path only after same-runtime proof.

### Definition of Done

DONE only when all are evidenced:

- [ ] Live container path and exact changed file(s) observed.
- [ ] Root cause layer identified with concrete evidence.
- [ ] Smallest correction applied directly to production container; no redeploy used.
- [ ] Existing `insert_after_exact_once` behavior remains intact.
- [ ] If an alias is added, it delegates to exact-once semantics and adds no fuzzy/first-match behavior.
- [ ] Relevant syntax/unit/contract check passes in the same runtime.
- [ ] One successful insertion-after canary is read back.
- [ ] Missing/non-unique anchor negative cases are verified fail-closed.
- [ ] Deployed identity remains the same container/runtime unless a restart is strictly required.
- [ ] Canonical source capture/write-back is completed or explicitly marked `WRITEBACK_BLOCKED`.
- [ ] `PLAN.md` is updated with evidence and the next bounded move.

## Current blocker / capability gap


The production container is visible and inspectable by container inventory, but the available allowlisted live-patch target catalog does not currently register this app/container. Direct target file/exec calls return `unknown_target`, while DEV direct-container exec is mediated as `OBSERVE_REQUIRED: scope_unknown`.

This is a **CAPABILITY_GAP in the current live-patch access surface**, not an application failure. Do not work around it by editing GitHub code + redeploy.

### Next safe move

Register or expose the existing `github-file-patch-api` container as an allowlisted live-patch target (no new container, no redeploy), then immediately execute the current 30-minute batch above.

## Evidence log

### 2026-09-03

- `PLAN.md` was missing at repository root.
- Existing `docs/IMPLEMENTATION_PLAN.md` is historical planning material and is not used as current operational SoT.
- Production Coolify readback identifies app UUID `ptqe39jwjcroa26ubymewg`p, branch `archops/github-control-plane-v05`, commit `9948acf43f71bb4d75fd99b43912ad70a92513b3`, auto-deploy disabled.
- Docker readback identifies running container `ptqe39jwjcroa26ubymtewgw-173756145823`, image tag ending in the same commit SHA, restart_count=0.
- Source readback at production commit shows `insertAfterExactOnce(...)` and dispatcher support for operation type `insert_after_exact_once`.
- Repository HEAD search shows the same capability in `src/patch.mjs`, `src/server.mjs`, `gpts-action-openapi.json`, and tests.
- Previous failed call used/expected `insert_after`; state was reported unchanged.

## Next bounded move

**Expose the existing production container to the allowlisted live-patch target surface, then diagnose and correct the operation-name/callability layer directly in that runtime.**

Why: this is the smallest path to verified value; the edit engine capability already exists, so rebuilding or redeploying would add delay without addressing the proven mismatch.
