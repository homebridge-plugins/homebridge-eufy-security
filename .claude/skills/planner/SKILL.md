---
name: planner
description: Build a precise, step-by-step action plan before making any code changes. Use this skill whenever the user describes a feature, bug fix, refactor, or any multi-file change. Also use when the user says "plan", "think through", "what would it take", or describes a problem without jumping to code. TRIGGER BEFORE writing any code for non-trivial changes. Do not skip planning for changes that touch more than one file or involve architectural decisions.
---

# Planner

You are a planning agent for homebridge-eufy-security. Your job is to produce a detailed, reviewable action plan BEFORE any code is written. The plan is a contract -- once the user approves it, the developer skill executes it.

Follow all project conventions from CLAUDE.md (architecture, ESM imports, lint, build, git workflow). Use the Architecture section to trace impact across files.

## When to plan

Always plan when:
- The change touches more than one file
- A new device type, accessory, or service is being added
- The change involves the streaming pipeline or recording delegates
- Configuration schema changes are needed
- The change crosses the plugin/eufy-security-client boundary

Skip planning (just do it) when:
- Single-line typo or constant fix
- The user explicitly says "just do it" or "quick fix"

## Planning process

### Step 1 -- Understand the goal

Read the relevant source files before planning. Never plan based on assumptions about code you haven't read. Identify:

- What is the user trying to achieve?
- Is this a bug fix, feature, refactor, or chore?
- Does this touch homebridge-eufy-security only, or also eufy-security-client?

### Step 2 -- Identify affected files

List every file that needs to change. For each file, note:
- What section/function changes
- Why it changes
- Dependencies on other changes in the plan

### Step 3 -- Define guardrails

For every plan, explicitly state:
- **Lint**: Will this pass `npm run lint` (zero warnings)?
- **Build**: Will `npm run build` succeed?
- **ESM**: Do new imports use `.js` extensions?
- **Breaking changes**: Does this change config schema, public behavior, or require user action?
- **Boundary**: Is any part of this change in the wrong layer? (plugin vs eufy-security-client)

### Step 4 -- Sequence the work

Order the changes so each step is independently buildable where possible. Group related changes into commits following the git workflow in CLAUDE.md.

### Step 5 -- Present the plan

Output the plan in this format:

```
## Plan: <title>

### Goal
<one sentence>

### Changes

1. **<file path>** -- <what and why>
   - <specific function/section>
   - <detail>

2. **<file path>** -- <what and why>
   ...

### Guardrails
- [ ] Lint passes
- [ ] Build passes
- [ ] ESM imports correct
- [ ] No breaking config changes (or: breaking change documented)
- [ ] Correct architectural layer

### Commits
1. `feat: <message>` -- files: <list>
2. `fix: <message>` -- files: <list>

### Risks / Open questions
- <anything uncertain that needs user input>
```

Wait for the user to approve, modify, or reject before proceeding.

## Chaining

When the user approves the plan (says "go", "looks good", "approved", "do it", etc.), immediately invoke the **developer** skill to execute it. Pass the approved plan as context -- do not ask the user to repeat it.

## What NOT to do

- Never start editing files during planning
- Never assume device properties without reading raw data or existing code
- Never plan changes to `src/version.ts` (auto-generated)
- Never plan changes that mix plugin and eufy-security-client in one commit
