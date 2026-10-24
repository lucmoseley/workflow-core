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

- Context is finite and recall falls as it fills ("context rot"). Claude Code best practices [standard or field body]; Effective context engineering [named expert]
- Load just in time: keep paths and links in context and read the content when it is needed. Effective context engineering [named expert]; Gemini CLI system prompt (github.com/google-gemini/gemini-cli, `prompts/snippets.ts`), one vendor's product [unverified]
- Long work keeps state outside context (progress file, task list, git commits as checkpoints); each new session reads them and runs a basic check first. Anthropic, "Effective harnesses for long-running agents" (2025-11-26); Effective context engineering (NOTES.md) [named expert]
- Tools return only high-signal output: paginate, filter or truncate by default, and make error text tell the agent what to change. Anthropic, "Writing effective tools for AI agents" (2025-09-11); Building effective agents (poka-yoke the arguments) [named expert]
- Keep agent state such as a feature list in JSON rather than Markdown, because the model overwrites it less. Effective harnesses only [unverified]

## Orchestration and subagents

- Use the simplest design that works: one agent with tools, or a fixed workflow, before a multi-agent system. Add agents only when instructions branch too much or the tools overlap. Anthropic, "Building effective agents" (2024-12); OpenAI practical guide ("maximize a single agent's capabilities first"); Google Cloud, "Choose a design pattern for your agentic AI system" [named expert]
- Give a subagent a narrow, read-mostly question that returns a short answer. Keep writes in one thread. Cognition, Walden Yan, "Don't build multi-agents" (2025-06-12) [named expert]; code.claude.com/docs/en/sub-agents; Claude Code best practices [standard or field body]
- A delegation prompt has four parts: objective, output format, which tools and sources to use, and task boundaries. Anthropic, "How we built our multi-agent research system" (2025-06) [named expert]; sub-agents docs; agent-teams docs [standard or field body]
- State effort tiers in the prompt; the agent cannot size effort itself (1 agent, 3-10 calls for a fact; 2-4 subagents for a comparison; multi-agent costs ~15x a chat's tokens). Multi-agent research system [named expert]; Gemini CLI prompt (three proportional tiers), one vendor's product [unverified]
- Parallel writers need separate files or worktrees (`isolation: worktree`), because two agents editing one file overwrite each other. Agent-teams docs; sub-agents docs; Cognition [standard or field body] [named expert]
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
- Inspect AI 0.3.282 (UK AISI) and promptfoo 0.124.1, read 2026-10-21: open-source agent/prompt eval harnesses; only their repos vouch [unverified]
- obra/superpowers v7.0.0, read 2026-10-21: planning/TDD/review skill library; only its repo vouches [unverified]
