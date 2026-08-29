# ERRORS.md

Evidence-backed error memory for this repository. Read before serious work here. Record material verified local errors; dedupe recurrence; never store secrets. Cross-repo lessons may be linked here without claiming the incident occurred locally.

## XERR-2026-08-29-001 — Goal hierarchy drift

- **Status:** ACTIVE_PREVENTION
- **Scope:** cross-repo lesson; canonical incident occurred in `n0namer/gpts-actions`, not necessarily here.
- **Source:** `n0namer/gpts-actions/ERRORS.md`, `ERR-2026-08-29-001`.
- **Symptom:** a current milestone/gate or development pipeline can be mistaken for the Project North Star; Phase Goal can disappear as a distinct level.
- **Evidence:** system-prompt review found the missing hierarchy and misleading progress/ETA risk.
- **Cause (high confidence):** project SoT and execution-state concepts were compressed too aggressively.
- **Impact:** work may optimize a local gate while reporting it as project completion.
- **Prevention:** resolve target project SoT first; keep `Project North Star -> Phase Goal -> gate/DoD -> next bounded move` distinct. `PROJECT_PIPELINE` tracks execution state; runtime reports actual state.
- **Verification rule:** before serious project work/replan, state the four levels from current evidence; if a level is unsupported, retrieve/repair SoT rather than invent it.

## Entry contract

Local incidents should record ID/date/status, symptom/impact, evidence, cause+confidence, fix, prevention, verification, and commit/issue links when available. `RESOLVED` requires evidence. Reopen/link recurrence instead of duplicating it.
