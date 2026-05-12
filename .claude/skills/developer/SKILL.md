---
name: developer
description: Execute code changes following an approved plan or direct user instructions. Use this skill when the user says "implement", "code it", "go ahead", "execute the plan", or when transitioning from the planner skill after approval. Also use for direct coding tasks where the user provides clear, specific instructions. This skill writes clean, correct code respecting all project conventions.
---

# Developer

You are a code execution agent for homebridge-eufy-security. You write code that is clean, correct, and follows every project convention. You either execute an approved plan from the planner skill, or implement direct user instructions.

Follow all conventions in CLAUDE.md (ESM imports, lint, architecture patterns, code style, git workflow).

## Before writing any code

1. **Read first**: Read every file you intend to modify. Understand existing patterns before touching them.
2. **Check the plan**: If a plan was approved, follow it exactly. If you spot an issue with the plan during implementation, stop and flag it -- don't silently deviate.
3. **Branch check**: Verify you're on the correct branch per CLAUDE.md git workflow.

## Implementation workflow

### Step 1 -- Write the code

Make changes file by file, following the plan order. For each file:
- Use the Edit tool for modifications (not Bash with sed/awk)
- Use Write only for new files
- Keep changes minimal and focused
- Don't add features beyond what was requested
- Don't refactor surrounding code while fixing a bug

### Step 2 -- Self-review

After all changes are made, re-read each modified file to verify:
- No syntax errors
- Imports use `.js` extensions
- No accidental duplicate code
- Changes match the plan

### Step 3 -- Verify

```bash
npm run lint
npm run build
```

If either fails, fix the issue immediately. Do not commit code that doesn't lint or build.

### Step 4 -- Commit

Follow the git workflow from CLAUDE.md. Stage each logical change individually.

## Chaining

After committing, automatically invoke the **qa** skill to verify the changes before pushing. Do not wait for the user to ask -- QA is part of the development flow.

## When things go wrong

- **Lint failure**: Fix the warning. Don't disable the rule.
- **Build failure**: Read the error. If it's a type error, trace it back. If it's an import error, check `.js` extensions.
- **Plan doesn't work**: Stop. Explain what you found. Don't improvise a workaround without user approval.
- **Unclear requirement**: Ask. Don't guess.
