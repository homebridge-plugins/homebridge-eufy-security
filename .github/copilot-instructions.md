# Copilot Instructions — homebridge-eufy-security

## Git Workflow

**IMPORTANT: Create the branch BEFORE editing any files.**

```bash
# Create dedicated branch from beta before making any changes
git checkout beta-*.*.* && git pull origin beta-*.*.*
git checkout -b [fix/feat/chore]/<short-description>

# Stage and commit each change individually (concise, single-line, spirit-based)
git add <file>
git commit -m "fix: <concise description of what changed and why>"

# Push and create PR
git push -u origin fix/<short-description>
gh pr create --base beta-*.*.* --title "<concise title>" --body-file /tmp/pr-body.md
```

### Commit message rules
- One line, no line breaks mid-sentence
- Describe the **spirit** of the change, not the code diff

### PR body
- Write to `/tmp/pr-body-<branch>.md` using `create_file`, **never** use heredoc (`cat << EOF`) in the terminal — quotes and special characters in the body will break it
- Describe the **spirit** of the change, not the code diff
- Concise description of the problem and fix
- PR body is **not** the release note — keep it focused on the code change for reviewers

### Release notes
- Write to `/tmp/release-notes-<version>.md` using `create_file`
- **Audience is end users** — focus on what matters to them: new devices, behaviour changes, removed settings, required actions
- **Concise, bullet-driven** — no markdown tables, no verbose paragraphs. Short section intros (1–2 sentences max) followed by bullet lists
- **No internal milestones** — don't mention "first GA since X" or beta iteration counts in the title/header
- **Structure for a branch** (e.g., `4.4.x`), not a single version:
  - Individual `## v4.4.x` entries at the top with version-specific changes
  - A shared `## What's in 4.4.x` section below covering the full branch for users arriving at any point release
- **Required actions front and center** — if users need to change config or upgrade Node.js, say so early and clearly
- **Tone**: direct, no filler, no emojis. End with a short one-line thank-you to testers if applicable

### Issue comments
- Use `gh issue comment <number> --repo homebridge-plugins/homebridge-eufy-security --body "<message>"`
- Use first person ("I")
- Thank the user by @mention
- Be formal and concise
- **Audience is end users** — keep language simple, no internal jargon or technical deep-dives
- Don't scope a fix to a specific device when it applies broadly (e.g. "all cameras using P2P" not "the E42")
- When a fix is merged, check the published beta version (`npm view @homebridge-plugins/homebridge-eufy-security dist-tags`) and mention it in the comment

## Dependency Updates — `eufy-security-client`

**CRITICAL: `eufy-security-client` version policy**
- **`beta-*.*.*` branches** — use the `dev` dist-tag (`"eufy-security-client": "dev"`) to always pick up the latest dev release
- **`master` branch** — **NEVER** use the `dev` dist-tag. Always use a pinned stable version (e.g. `"eufy-security-client": "^3.7.2"`). Before merging to master, replace `"dev"` with the corresponding stable release version.

When updating the `eufy-security-client` version in `package.json`:

1. Check the upstream changelog and README at https://github.com/bropat/eufy-security-client/blob/master/README.md
2. Identify breaking changes, new features, or device support changes
3. Summarize the impact concisely in the **PR body** so end users understand what changed and why the update matters (e.g. new device support, bug fixes, API changes)
4. If there are breaking changes, note any required code adjustments in this plugin

## Linting & Building

- Run `npm run lint` before committing to ensure zero warnings/errors
- The lint script runs: `eslint 'src/**/*.ts' --max-warnings=0`
- `@typescript-eslint/no-explicit-any` is globally disabled — do **not** add `eslint-disable` comments for it
- Fix all warnings; the build enforces `--max-warnings=0`
- Run `npm run build` before pushing to ensure the project compiles without errors
