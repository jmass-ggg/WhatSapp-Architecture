# LumaChat development workflow

## Find the task context

- Start with `git status`, then locate the relevant module with `rg --files` or targeted `rg -n` symbol searches. Do not scan or read the whole repository at the start of each task.
- Read only task-relevant files and direct dependencies. Read architecture docs only for architectural changes; do not reread unchanged files in the same task.
- For frontend-only work, avoid Docker, databases, migrations, and unrelated modules unless a concrete dependency requires them.
- Never scan `.venv`, `node_modules`, `dist`, caches, generated assets, database files, or benchmark reports. Expand investigation only for a concrete dependency, failing test, or security concern.

## Implement

- Give a brief implementation plan, then code. Reuse existing functions, components, and SDK integrations.
- Make minimal, targeted changes. Avoid unrelated features, refactors, dependency upgrades, and documentation rewrites.
- Preserve working FastAPI, Synapse, PostgreSQL, and Matrix crypto functionality. For E2EE or authentication changes, prioritize correctness and security over speed.

## Verify

- Run relevant unit tests after changes and fix actual failures instead of rerunning passing tests.
- For affected frontend changes, run TypeScript checks and one frontend build after implementation succeeds.
- Run the full backend suite only for backend changes or important integration boundaries. Run expensive browser, E2EE, or load tests only when relevant, with one final verification pass.
- Never suppress genuine errors, weaken security checks, or alter real secrets for test convenience.

## Work efficiently

- Keep terminal output concise; inspect relevant error sections instead of printing huge diffs or logs.
- Avoid unnecessary background processes, restarting healthy containers, and repeated full-repository reviews.
- Record important discoveries briefly for later tasks. Stop when acceptance criteria are satisfied.

## Finish

- Report only files modified, features implemented, tests and results, genuine limitations, and Git status.
- Preserve Git history and the existing GitHub remote. Do not commit or push unless requested.
