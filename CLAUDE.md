# grime

Grime is an archival document management platform — a reusable Django app
for ingesting scanned documents, running OCR / NER pipelines, and annotating
pages with tagged regions.

# Project Structure

- Core logic lives in grime/pipeline
- Management commands are wrappers to core logic and live in grime/management/commands
- Internal url endpoints are also wrappers to core logic and live in grime/viewer.py


# Code Style

- Core logic should only exist in one place if possible
- Code craft should be clear and concise. Avoid accumulating unnecessary patches and fixes
- Codebase should use vernacular structure, particularly django vernacular, when possible
- Code should be commented concisely, include example command calls.


# Developer preferences

- Never write migrations or manipulate data in any way.
- Never rebase. Always pull the current branch and add new commits on top.
- Never spawn agents for code searches; use grep/find + Read. Agents only for genuinely parallel multi-step work.
- Before searching the codebase, ask me for the file path or symbol name so I can provide it.
- Ask me before adding a one-off fix or patch to accomplish your task; chances are there's an architectural issue that needs to be resolved. 


# Agent notes (unattended agent-rig runs)

- "Ask me" above means: post a blocking question on the issue and stop.
- Search the codebase yourself with grep/find; there's nobody to ask for paths.
- Setup: `uv sync --group dev`, `npm ci`. Skip `.env`, migrations and
  superuser; there's no database or AWS access.
- After changing `frontend/src/`, run `npm run build` and commit the rebuilt
  files in `grime/static/grime/`, including new `jsx-runtime-*.js` chunks.
  `git rm` chunks no bundle imports anymore.
- No test suite yet. Verify with `python -m compileall grime`, `black --check .`
  and a clean `npm run build`, and say in the PR what you couldn't verify.