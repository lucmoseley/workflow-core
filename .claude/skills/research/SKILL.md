---
name: research
---

Spin up a **background agent** to do the research, so you keep working while it reads. A subagent does the job below itself (`rule:dispatch-grandchild`), appending to the file its own dispatch's `Artefact:` line names.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source. Name that file on an `Artefact: <path>` line in the dispatch prompt and have the agent append to it as findings land — a dispatch without that line gets one supplied under `.claude/tmp/agents/`, not where this note belongs (workflow-core#515).
3. Post it on the issue it answers, never in `docs/research/` (`docs/agents/issue-tracker.md` §Research artefacts, workflow-core#2335).
