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
- Never use the Explore agent or spawn sub-agents for code searches. Use grep/find directly.
- Before searching the codebase, ask me for the file path or symbol name so I can provide it.
- Ask me before adding a one-off fix or patch to accomplish your task; chances are there's an architectural issue that needs to be resolved. 
- Never spawn agents unless the task is genuinely multi-step and parallel.
- Prefer Read + grep over any exploratory agent.
- When referencing code, always include file_path:line_number.
- Be concise in your responses. 