# llm-agent-design

Researched: 2026-10-21

## Instructions and rules

- Keep always-loaded instructions short: keep a line only if removing it would cause a mistake; a long file buries its rules. code.claude.com/docs/en/best-practices; code.claude.com/docs/en/memory (under 200 lines per file) [standard or field body]
- Write only what the model cannot infer: commands, conventions that differ from defaults, gotchas, project decisions. Leave out language conventions, file tours and "write clean code". Claude Code best practices [standard or field body]; cursor.com/docs/rules; docs.cline.bot/customization/cline-rules [named expert]
- Start with a minimal prompt on the strongest model, then add a line only for a failure you have seen. Anthropic, "Effective context engineering for AI agents" (2025-09-29); OpenAI, "A practical guide to building agents" (2025: build with the strongest model first, then try smaller ones) [named expert]
- Give the reason and a canonical example rather than a list of edge cases. Effective context engineering; Cline rules ("Include the why", "Point to examples"); Cursor rules [named expert]
- "IMPORTANT" on one line at most; spread emphasis stops working, and "if in doubt, use X" overtriggers X. Claude Code best practices; Anthropic "Prompting best practices" (Claude 4.x) [standard or field body]
- Placement: a fact goes in CLAUDE.md; a procedure, or knowledge needed only sometimes, goes in a skill; anything that must happen every time goes in a hook. code.claude.com/docs/en/skills; Claude Code best practices; claude.com blog "How Claude Code works in large codebases" [standard or field body]
- Skill descriptions: put the trigger first, because the combined `description`+`when_to_use` text is cut at 1,536 characters; `disable-model-invocation: true` for side-effecting workflows; SKILL.md under 500 lines, references one hop away. code.claude.com/docs/en/skills; platform.claude.com agent-skills best practices [standard or field body]
- After compaction a skill keeps its first 5,000 tokens (25,000 shared by all skills): put task-long guidance near the top as standing rules. code.claude.com/docs/en/skills [standard or field body]
- Untuned skills trigger autonomously ~50% of the time (Seleznov, "650 Trials"; DEV "2 Fixes for 95% Activation"); single-author figures, no default [unverified]

## Context management

- Context is finite and quality falls as it fills, gradually and by task: no fill threshold is measured. Chroma, "Context Rot" (2025-07-14); "The Complexity Trap", arXiv:2508.21433 [named expert]; Claude Platform docs, compaction ("response quality degrades as a conversation grows") [named expert]
- Load just in time: keep paths and links in context and read the content when it is needed. Effective context engineering [named expert]; Gemini CLI system prompt (github.com/google-gemini/gemini-cli, `prompts/snippets.ts`), one vendor's product [unverified]
- On Opus 4.5 and later, one build can run as one continuous session with automatic compaction. Anthropic, Prithvi Rajasekaran, "Harness design for long-running application development" (2026-03-24) [named expert]
- Compaction drops what lives only in the conversation, and repeated compaction compounds it: standing "do not" rules and which files were touched. So keep long work's rules, plan and progress in files, and after each compaction re-read them and the git log and diff, treating the summary as a hint. CONPACT, arXiv:2608.11242; ConstraintRot, arXiv:2606.22528; TRACE, arXiv:2608.06503; arXiv:2610.31778; Factory Research, "Evaluating Context Compression for AI Agents" (2025-12-16) [named expert]; Claude Code changelog 2.1.293 [standard or field body]
- Tools return only high-signal output: paginate, filter or truncate by default, and make error text tell the agent what to change. Anthropic, "Writing effective tools for AI agents" (2025-09-11); Building effective agents (poka-yoke the arguments) [named expert]
- Keep agent state such as a feature list in JSON rather than Markdown, because the model overwrites it less. Anthropic, "Effective harnesses for long-running agents" (2025-11-26) [named expert]

## Orchestration and subagents

- Use the simplest design that works: one agent with tools, or a fixed workflow, before a multi-agent system. Add agents only when instructions branch too much or the tools overlap. Anthropic, "Building effective agents" (2024-12); OpenAI practical guide ("maximize a single agent's capabilities first"); Google Cloud, "Choose a design pattern for your agentic AI system" [named expert]
- Coupled work goes to one writer: splitting it across parallel agents loses on strong models. Khatua et al., "CooperBench"; Kim et al., "Towards a Science of Scaling Agent Systems"; Xia, Wu, Park, "Passes Alone, Fails Together"; Cognition, Walden Yan, "Multi-Agents: What's Actually Working" (2026-04-22); Carlini, "Building a C compiler with a team of parallel Claudes" (2026-02-05) [named expert]
- Split work to run in parallel only where every unit passes a strict independence test: it has its own oracle, changes no interface or schema another unit reads, has no order dependency on another, and shares little co-change history. File overlap alone is a weak test. CooperBench; Kim et al.; Carlini [named expert]; agent-teams docs [standard or field body]
- One task per session: start fresh between unrelated tasks, after two failed corrections, and between writing a spec and building it. No study compares one long session with sequential fresh sessions for one coupled build. Claude Code best practices [standard or field body]; SWE-Milestone; FeatureArc [named expert]
- Give a subagent a narrow, read-mostly question that returns a short answer. Keep writes in one thread. Cognition, Walden Yan, "Don't build multi-agents" (2025-06-12) [named expert]; code.claude.com/docs/en/sub-agents [standard or field body]
- A delegation prompt has four parts: objective, output format, which tools and sources to use, and task boundaries. Anthropic, "How we built our multi-agent research system" (2025-06) [named expert]; sub-agents docs; agent-teams docs [standard or field body]
- State effort tiers in the prompt; the agent cannot size effort itself (1 agent, 3-10 calls for a fact; 2-4 subagents for a comparison; multi-agent costs ~15x a chat's tokens). Multi-agent research system [named expert]; Gemini CLI prompt (three proportional tiers), one vendor's product [unverified]
- Parallel writers need separate files or worktrees (`isolation: worktree`), because two agents editing one file overwrite each other. Agent-teams docs; sub-agents docs [standard or field body]; Cognition [named expert]
- Review in a fresh context, asking only for gaps in correctness or stated requirements: a reviewer told to find gaps always finds some. Claude Code best practices; Building effective agents (evaluator-optimizer); Google Cloud patterns (review and critique) [named expert]

## Permissions and hooks

- Instructions are advisory; hooks are deterministic. Anything that must bind goes in a hook or permission rule. Claude Code memory docs; hooks guide; OWASP LLM06:2025 Excessive Agency ("complete mediation": authorisation is enforced outside the model) [standard or field body]
- Least privilege: give each agent the minimum tools and scopes it needs (`tools` / `disallowedTools`, narrow tools rather than a general shell). OWASP LLM06:2025; sub-agents docs; MCP spec 2025-11-25 security best practices (scope minimisation) [standard or field body]
- Rate each tool's risk (read or write, reversible or not, money involved). High-risk or irreversible acts, and retries past a set limit, go to a human. OWASP LLM06:2025 [standard or field body]; OpenAI practical guide; Google Cloud patterns (human in the loop) [named expert]
- Never combine private data, untrusted content and outward communication in one agent. Prompt-level defences do not reliably stop injection. Simon Willison, "The lethal trifecta" (2025-06-16) [named expert]; Meta AI, "Agents Rule of Two" (2025-10-31) [named expert]
- Deny beats ask beats allow, and no allow carves out of a deny; Bash argument patterns are fragile, so bound files and network with the sandbox; a Stop hook exits early on `stop_hook_active`. code.claude.com/docs/en/permissions; hooks guide [standard or field body]

## Evaluation of agent rules

- Build evals before writing long instructions. Start with 20-50 cases drawn from real failures, and include cases where the behaviour should not fire. Anthropic, "Demystifying evals for AI agents" (2026-01-09); Hamel Husain and Shreya Shankar, "Evals FAQ" (2026-09) [named expert]; agent-skills best practices [standard or field body]
- Use pass/fail graders that check the outcome, not the path taken. Prefer code graders; calibrate any LLM judge against humans. Demystifying evals; Evals FAQ; multi-agent research system [named expert]
- Read transcripts. A score alone hides graders that are unfair or broken. Demystifying evals; Evals FAQ (review at least 100 traces); multi-agent research system [named expert]
- Run each case several times on clean state, against a without-the-rule baseline: a high score alone does not show the rule helped. Plugin evals docs (3 runs by default, WITH/W/OUT delta) [standard or field body]; Demystifying evals (pass@k vs pass^k, isolated trials) [named expert]

## Tools

- `claude plugin eval` (Claude Code v2.1.269 or later, read 2026-10-21): plugin and skill eval suites with a no-plugin baseline and CI gating. code.claude.com/docs/en/plugin-evals [standard or field body]
- skill-creator (anthropics/skills, untagged, read 2026-10-21): per-skill evals and trigger-description tuning, own `evals.json` format. Plugin evals docs [standard or field body]
- MCP Inspector 2.11.0, read 2026-10-21: interactive MCP server tester. github.com/modelcontextprotocol/inspector [standard or field body]
- Inspect AI 0.3.282 (UK AISI) and promptfoo 0.124.1, read 2026-10-21: open-source agent/prompt eval harnesses. github.com/UKGovernmentBEIS/inspect_ai; github.com/promptfoo/promptfoo [standard or field body]. Only their own docs vouch, so they set no default to use them
- obra/superpowers v7.0.1, read 2026-10-26: planning/TDD/review skill library. github.com/obra/superpowers [standard or field body]; Simon Willison vouches for the plugin as a whole, not for its use in agent design (simonwillison.net/2025/Oct/10/superpowers/) [named expert]. No source vouches for using it here, so it sets no default
