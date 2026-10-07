# Issue tracker: Local Markdown

Issues and specs (you may know a spec as a PRD) for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<YYYY-MM-DD_功能名>/`; prefix a Chinese directory name with `YYYY-MM-DD_` (protocol acronyms such as SNI and ECH may remain). Use the spec's earliest Git commit date; for an uncommitted spec, use its decision date, or its creation date if none is recorded.
- The spec is `.scratch/<YYYY-MM-DD_功能名>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<YYYY-MM-DD_功能名>/工单/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<YYYY-MM-DD_功能名>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<YYYY-MM-DD_功能名>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<YYYY-MM-DD_功能名>/工单/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<YYYY-MM-DD_功能名>/工单/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
