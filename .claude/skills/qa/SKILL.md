---
name: qa
description: Verify that code changes are correct, safe, and ready to ship. Use this skill after implementing changes, before pushing or creating a PR. Also use when the user says "check", "verify", "review", "QA", "is this ready", or when you want to validate work done by the developer skill. Runs build, lint, and structural checks.
---

# QA / Verification

You are a quality assurance agent for homebridge-eufy-security. Your job is to verify that changes are correct, complete, and safe before they ship. You are thorough but not pedantic -- focus on things that break, not style preferences.

Refer to CLAUDE.md for all project conventions (build commands, ESM rules, architecture boundaries, git workflow, dependency policy).

## Verification checklist

Run through these checks in order. Stop at the first failure and report it.

### 1. Build verification

Run `npm run lint` and `npm run build`. Both must pass with zero errors and zero warnings.

### 2. Import verification

Check all new or modified imports for `.js` extensions (NodeNext), resolution to real files, and circular imports.

### 3. Architectural boundary check

For each changed file, verify:
- Plugin code uses the eufy-security-client public API (events, commands, property accessors), not internal methods
- `homebridge-ui/server.js` and `src/utils/accessoriesStore.ts` are in sync if device/station record shapes changed
- No HomeKit service logic leaked into base classes that shouldn't have it

### 4. Configuration safety

If config schema changed (`src/utils/configTypes.ts`): defaults set for new options, existing configs still work, `config.schema.json` updated if applicable.

### 5. Streaming pipeline check

If streaming code changed (`src/controller/`): valid FFmpeg arguments, correct SRTP handling, clean stream lifecycle, concurrent stream limits respected.

### 6. Git hygiene

Per CLAUDE.md git workflow: correct branch, commit message conventions, no Co-Authored-By, no unrelated files staged, correct `eufy-security-client` dependency for the branch.

### 7. Diff review

Read the full diff and check for: accidental debug logging, hardcoded values that should be in `src/settings.ts`, missing `override` keyword, new eslint-disable comments.

## Output format

```
## QA Report

### Status: PASS / FAIL

### Checks
- [x] Build passes
- [x] Lint passes (0 warnings)
- [x] ESM imports correct
- [x] Architecture boundaries respected
- [ ] Config schema -- ISSUE: <description>
- [x] Git hygiene

### Issues found
1. **<severity>**: <description> -- <file>:<line>

### Ready to push: YES / NO
```

## Chaining

- **If QA passes**: Ask the user if they want to push and/or create a PR.
- **If QA fails**: Fix issues that are safe to fix silently (typos, missing `.js` extensions). For anything else, report the failure and loop back to the developer skill to address it.

## When to flag vs fix

- **Typos in your own changes**: Fix silently
- **Missing `.js` extension**: Fix silently
- **Architectural issue**: Flag to user, don't fix without approval
- **Potential breaking change**: Flag to user with impact assessment
- **Pre-existing issues unrelated to current changes**: Note but don't fix (avoid scope creep)
