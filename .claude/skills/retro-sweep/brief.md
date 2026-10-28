You are running the `retro` skill on ONE finished Claude Code session, as one of several parallel reviews in a retro sweep.

Spawn no subagents. Commit nothing, file or edit no GitHub issue. Write only your artefact.

Artefact: {{ARTEFACT}}

**Write the artefact's first line now**, before reading anything: `# {{SESSION_ID}} — reading`. A watcher calls an artefact that is absent for four minutes abandoned.

## 1. The skill, as written

Read `{{WFC}}/.agents/skills/retro/SKILL.md` and follow it as written, with these substitutions for this machine:

- "Call the Skill tool with `writing-for-agents`" → read `{{WFC}}/.claude/skills/writing-for-agents/SKILL.md`.
- `AGENTS.md` → the session repo's `CLAUDE.md` (and its `AGENTS.md`, if present), the user's global `CLAUDE.md` in the seat the session ran on (the directory above `projects/` in the raw log's path), and every `@`-import in them.
- `CODING_STANDARDS.md` → `docs/code-standards.md` in the session repo, if present, and workflow-core's standards base, `{{WFC}}/docs/code-standards-base.md`.
- the "reviewer agent" → the `code-reviewer` agent, run through the `/code-review` skill.

**The session repo's always-loaded pool:** {{POOL}}. Its shed ledger — every shed already proposed, paid or ruled out — is §Capture and placement §5 of the session repo's `docs/doc-map.md`, if present. Read it before any candidate that adds to or sheds from `CLAUDE.md`, and say which entry, if any, already covers it.

## 2. The session

- Reduced transcript: `{{TRANSCRIPT}}`. **Read it in pages** (`Read` with `offset` and `limit`, ~150 lines a page — halve it where `Read` refuses on size), never whole. Append each candidate as you meet it.
- **Over ~600 KB** (`wc -c`): read the first and last pages, then the neighbourhood of every `RESULT ERROR`, `HOOK`, `API-ERROR`, `COMPACTION`, `FOUNDER` and `LOOP` line (`grep -n`), and say so on the `Bound:` line.
- Each line opens `L<n>`, the raw log's line number: `{{RAW_LOG}}`. A folded subagent's lines open `[<agentId>] L<n>`, the line of `{{SUBAGENT_DIR}}/agent-<agentId>.jsonl`. Cite those; open a raw log only for a line the reduction cut short.
- Session `{{SESSION_ID}}`, started `{{FIRST_TIMESTAMP}}`, in repo `{{REPO_ROOT}}`.
- Plugin release the session ran (a version is the release the repo pinned): `{{RELEASE}}`. Judge every candidate against workflow-core as it is now (`{{WFC}}` at `{{WFC_HEAD}}`), never against that release.

## 3. Coverage pass, per candidate

For each candidate, check:

- the repo files: `grep` scoped to the machinery directories — `scripts/`, `hooks/`, `.husky/`, `.github/`, `.claude/`, `docs/`, `CLAUDE.md`, never `node_modules`, `.git` or `.next` — in workflow-core and in the session repo;
- the tracker snapshot, every issue in every tracker the run touches, closed ones included: `{{SNAPSHOT}}/*.json` (`title`, `body`) and each tracker's `*.comments.jsonl` (`issue`, `body`), where rulings live — searched with `jq` or `grep`;
- later commits: `git -C <repo> log --oneline --since={{FIRST_TIMESTAMP}} -S'<term>'` or `--grep '<term>'`, in workflow-core and in the session repo;
- at most ONE live `gh search issues "<terms>" --repo <owner/name>` per candidate, only where the snapshot cannot answer, and never with `--state`. Run `gh` in the foreground; re-run an empty result once before believing it.

Classify each candidate as exactly one of, with its source:

- **NEW** — no file, open issue or later commit covers it. Name the searches that came back empty.
- **OPEN** — an open issue tracks it. Cite `owner/name#N` and its title.
- **FIXED-SINCE** — a commit or closed issue after the session fixed it. Cite it.
- **COVERED-THEN** — machinery that existed at the session date already handled it. Cite it.
- **DECLINED** — a closed issue ruled against exactly this change. Cite it.
- **WRONG** — it misreads the session or the repo. Say how.

For each candidate, also say who owns the thing to change: **plugin** (hooks, guards, `scripts/`, skills, the `code-reviewer` agent, rule fragments, `.claude/workflow-core.md`, or anything in workflow-core's own repo) or **adopter** (its `CLAUDE.md`, `AGENTS.md`, output style, standards file, lint or CI).

## 4. The artefact, in this order

After the first line, append each item the moment it lands, never held back for the end:

1. **Each candidate**, as you meet it while reading: its retro category, what happened (transcript line evidence), the proposed environment change, its owner. **A candidate quoting a `FOUNDER` line quotes all of it**, never a summary (#1073). **A remediation the founder explicitly waived in that session** — "I don't mind", "keep it", "that's fine" — is marked **Waived**, citing the waiver's line, and is never filed.
2. **Session summary**, once the transcript is read — title, duration, size, what it set out to do, how it ended.
3. **Each candidate's class**, with its source, the moment its coverage check lands. A coverage pass that appends nothing for minutes reads as a stall, and may be abandoned.
4. `Tally: N candidates — NEW n, OPEN n, FIXED-SINCE n, COVERED-THEN n, DECLINED n, WRONG n`
5. `Cost:` roughly how many tool calls this retro took, and how many went to the coverage pass.
6. `Bound:` what you read exhaustively, and what you only sampled.

Finish by replying with the artefact's path, the tally line, and each NEW candidate in one line, in retro's severity order.
