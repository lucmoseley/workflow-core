// @vitest-environment node
/*
 * What the core's hooks register, pinned registration by registration.
 *
 * A guard's own tests prove its logic; nothing they do sees whether Claude Code
 * ever runs it, or runs it on the tool it guards. mantahostels#112 and mantahostels#117 both shipped
 * guards that were built and never wired, and `check-guard-registry.js` cannot
 * catch that class: it collects command strings at any depth, so it is
 * event-agnostic and matcher-blind — a guard moved to the wrong event, or given
 * a matcher that drops a tool, passes it.
 *
 * The table is the whole registration list rather than a chosen subset (mantahostels#258),
 * because only against the whole of it can "pins every registration in the
 * file" below fail on a hook added with no assertion at all.
 *
 * The guard-directory tests below assert a narrower thing over a wider set:
 * registration EXISTENCE (any event, any matcher) for every scripts/guard-*
 * file on disk, so a guard nobody wired or tested fails something (mantahostels#1266).
 * Event and matcher correctness for a registered guard stays the table's job.
 *
 * Loosen a row and a guard can be unwired, or moved to an event or matcher that
 * never fires it, while every one of its own tests stays green — the rule it
 * enforces silently stops.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	allRegistrations,
	commandLine,
	type HookEvent,
	registrationsOf,
} from "./lib/hook-wiring";

/**
 * Guards invoked by another script rather than by a hook, so no
 * `.claude/settings.json` registration will ever name them. Commented per
 * entry (mantahostels#1266).
 */
const REGISTERED_ELSEWHERE: Record<string, string> = {};

interface Registration {
	event: HookEvent;
	/**
	 * Substring identifying the registration, ARGUMENTS INCLUDED. The args are
	 * load-bearing, not decoration: concision-backstop.sh is registered twice and
	 * `stop`/`start` is the only thing telling the two apart, so an id naming the
	 * script alone matches both and a swap between them reads as correct.
	 */
	id: string;
	/**
	 * The entry's `if` narrowing verbatim, absent where it carries none.
	 *
	 * Load-bearing the way `args` is: seven guards are registered several times
	 * over since mantahostels#2811, once per permission rule, and every copy shares a command
	 * line. Without this the id below matches all of them and the single-match
	 * assertion reads whichever sorted first — and a narrowing quietly widened
	 * from `Bash(*npm *)` to `Bash(*)` would pass.
	 */
	narrowing?: string;
	/**
	 * The matcher verbatim, or null on the events that carry none.
	 *
	 * Pinned exactly, which `covers` below cannot do: a matcher that is deleted
	 * covers every tool, so every `covers` check still passes while the hook has
	 * silently widened onto tools it was never meant to see.
	 */
	matcher: string | null;
	/**
	 * Tools the hook must fire on, checked against the matcher above.
	 *
	 * Redundant against settings.json, and deliberately: it catches the fix
	 * rather than the break. A narrowed matcher fails the check above, and the
	 * cheap way out is to paste the new string into this table — at which point
	 * this list still names the dropped tool, and still fails.
	 */
	covers: string[];
	/** True where the entry declares no timeout, so a dropped one is not silent. */
	unbounded?: true;
}

const REGISTRATIONS: Registration[] = [
	{
		event: "PreToolUse",
		id: "scripts/guard-last30days.sh",
		matcher: "Skill",
		covers: ["Skill"],
		unbounded: true,
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-review-rules.sh",
		matcher: "Skill",
		covers: ["Skill"],
	},
	{
		event: "PreToolUse",
		id: "scripts/inject-review-tier.sh",
		matcher: "Skill",
		covers: ["Skill"],
	},
	{
		event: "PreToolUse",
		id: "scripts/inject-founder-wording.sh",
		matcher: "Skill",
		covers: ["Skill"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-branch.sh",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-commit-form.sh",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-registry-atomicity.sh",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-registry-atomicity.sh",
		narrowing: "Bash(*commit-paths.js*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-commit-form.sh",
		narrowing: "Bash(*commit-paths.js*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-pull-form.sh",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-push-rules.sh",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-bg-job.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-issue-body.sh",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-issue-close.sh",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-issue-create-label.sh",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-anthropic-report.sh",
		narrowing: "Bash(*gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-tracker-rules.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-issue-phase-scope.sh",
		narrowing: "Bash(*gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-stale-script.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-claimed-bash-write.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-self-match.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-wait-loop.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-file-claim.sh",
		matcher: "Write|Edit|NotebookEdit",
		covers: ["Write", "Edit", "NotebookEdit"],
	},
	{
		event: "PreToolUse",
		id: "scripts/inject-test-rules.sh",
		matcher: "Write|Edit|NotebookEdit",
		covers: ["Write", "Edit", "NotebookEdit"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-citation-tracker.sh",
		matcher: "Write|Edit",
		covers: ["Write", "Edit"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-dispatch-rewrite.sh",
		matcher: "Agent|Task",
		covers: ["Agent", "Task"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-blind-dispatch.sh",
		matcher: "Agent|Task",
		covers: ["Agent", "Task"],
	},
	/* mantahostels#2811 split this guard in two: the Bash limb is narrowed to the four
	 * command shapes its Bash routes classify, one entry per rule, and the
	 * Read|ListAgents limb stays unnarrowed because neither tool has a command
	 * to match on. A `Bash(…)` rule left on the joint matcher would have matched
	 * no Read call at all (hooks.md:123). */
	{
		event: "PreToolUse",
		id: "scripts/guard-agent-poll.sh",
		matcher: "Read|ListAgents",
		covers: ["Read", "ListAgents"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-agent-poll.sh",
		narrowing: "Bash(*sleep *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-agent-poll.sh",
		narrowing: "Bash(true*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-agent-poll.sh",
		narrowing: "Bash(:*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-agent-poll.sh",
		narrowing: "Bash(exit*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* mantahostels#2570. ListAgents is missing from this matcher deliberately, and not by
		 * oversight: guard-agent-poll.sh above already caps it at two calls in
		 * five minutes, and on the measured corpus the repeat rule split near
		 * evenly there. The PostToolUse recorder below must carry the same
		 * matcher — a tool guarded but not recorded can never fire. */
		event: "PreToolUse",
		id: "scripts/guard-echo-call.sh",
		matcher: "Bash|Read",
		covers: ["Bash", "Read"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*npm *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*node *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*next *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*python*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*pytest*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*npx *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*yarn *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*pnpm *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*bun *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*make *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*cargo *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-concurrency.sh",
		narrowing: "Bash(*go test*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-vitest-wrapper.sh",
		narrowing: "Bash(*vitest *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-vitest-wrapper.sh",
		narrowing: "Bash(*npx *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-suite-background.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-unasked-rerun.sh",
		narrowing: "Bash(*npm *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-headroom-read.sh",
		narrowing: "Bash(*free *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-headroom-read.sh",
		narrowing: "Bash(*/proc/meminfo*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-node-heap.sh",
		narrowing: "Bash(*max-old-space-size*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-node-heap.sh",
		narrowing: "Bash(*max_old_space_size*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-rm-unchecked.sh",
		narrowing: "Bash(*rm *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-recursive-dot-read.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-root-find.sh",
		narrowing: "Bash(*find *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-ugrep-pattern.sh",
		narrowing: "Bash(grep *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* mantahostels#2595. Read joined the matcher because a Bash-only hook never fires on
		 * a `Read` call, and `Read` is the majority of an /implement session's
		 * read calls on some models.
		 *
		 * mantahostels#2811 then split the two apart: the Bash limb judges `cat`, `sed` and
		 * `awk` alone, so it takes a rule for each, and the Read limb gets a
		 * matcher of its own because a `Bash(…)` rule matches no Read call
		 * (hooks.md:123). */
		event: "PreToolUse",
		id: "scripts/guard-wide-read.sh",
		matcher: "Read",
		covers: ["Read"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-wide-read.sh",
		narrowing: "Bash(*cat *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-wide-read.sh",
		narrowing: "Bash(*sed *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-wide-read.sh",
		narrowing: "Bash(*awk *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-npm-install.sh",
		narrowing: "Bash(*npm *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-npm-install.sh",
		narrowing: "Bash(*npx *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-check-sh.sh",
		narrowing: "Bash(*shellcheck *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-check-sh.sh",
		narrowing: "Bash(*npm *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-sweep-fire.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-hook-escape.sh",
		narrowing: "Bash(*WFC_ALLOW_*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PreToolUse",
		id: "scripts/guard-branch-publish.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* The Bash redirect limb and the file-tool limb share one predicate, so
		 * one registration; the guard picks its limb off .tool_name (mantahostels#3380). */
		event: "PreToolUse",
		id: "scripts/guard-root-scratch.sh",
		matcher: "Bash|Write|Edit|NotebookEdit",
		covers: ["Bash", "Write", "Edit", "NotebookEdit"],
	},
	{
		/* One registration over four tools, not one per tool: the preamble prints
		 * both the variable and the path it resolved to, and the expanded one is
		 * the spelling the file tools can carry. The guard picks its limb off
		 * .tool_name (mantahostels#2406). */
		event: "PreToolUse",
		id: "scripts/guard-job-dir-scratch.sh",
		matcher: "Bash|Write|Edit|NotebookEdit",
		covers: ["Bash", "Write", "Edit", "NotebookEdit"],
	},
	{
		/* `Write` alone: `Edit` must match the old text, so it never replaces a
		 * neighbour's scratch blind (#1167). */
		event: "PreToolUse",
		id: "scripts/guard-scratch-overwrite.sh",
		matcher: "Write",
		covers: ["Write"],
	},

	{
		/* mantahostels#2570, the other half of guard-echo-call.sh above: the guard cannot see
		 * a response at PreToolUse, so this records one. Same matcher, for the
		 * reason given there. */
		event: "PostToolUse",
		id: "scripts/record-tool-echo.sh",
		matcher: "Bash|Read",
		covers: ["Bash", "Read"],
	},
	{
		/* #1784: an image's size is only in the Read RESPONSE. */
		event: "PostToolUse",
		id: "scripts/guard-image-budget.sh",
		matcher: "Read",
		covers: ["Read"],
	},
	{
		event: "PostToolUse",
		id: "scripts/place-new-issue.sh",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PostToolUse",
		id: "scripts/refresh-claims.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PostToolUse",
		id: "scripts/record-issue-claim.sh",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PostToolUse",
		id: "scripts/release-issue-claim.sh",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PostToolUse",
		id: "scripts/record-acts.sh",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #289: the refusal itself is only visible in the RESPONSE, so this is
		 * PostToolUse and not a PreToolUse guard. Narrowed to `git *` because a
		 * pull reached through a wrapper is unseen anyway — the same blind spot
		 * guard-pull-form.sh carries — so the wider matcher buys nothing. */
		event: "PostToolUse",
		id: "scripts/record-divergence.sh",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #2405: only a push that succeeded starts the lander, and only
		 * PostToolUse sees one. Unanchored, as its walker reads a push behind
		 * gp_unwrap's wrappers. */
		event: "PostToolUse",
		id: "scripts/start-lander-on-push.sh",
		narrowing: "Bash(*push*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #1575: the cut verdict is only visible in the RESPONSE. One glob
		 * every launch spelling holds, never two — the guard's header says
		 * why (#1661). */
		event: "PostToolUse",
		id: "scripts/guard-lost-verdict.sh",
		narrowing: "Bash(*test*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* A call exiting non-zero reaches this event instead (#1575). */
		event: "PostToolUseFailure",
		id: "scripts/guard-lost-verdict.sh",
		narrowing: "Bash(*test*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #2026: a killed call fails, so only this event sees its exit code.
		 * Unnarrowed, as any command can be killed. */
		event: "PostToolUseFailure",
		id: "scripts/guard-failed-call-rules.sh",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #2026: a refused Skill is turned away in input validation, before any
		 * per-call hook; only the batch's results carry it. No matcher. */
		event: "PostToolBatch",
		id: "scripts/guard-failed-call-rules.sh",
		matcher: null,
		covers: [],
	},
	// The formatter and the write recorder are ONE registration (mantahostels#295). Matching
	// hooks run in parallel, so as two they raced and the recorder often stored
	// the pre-format bytes — making the session's own formatter read as a clobber
	// at its next write. post-write.sh runs them in order.
	{
		event: "PostToolUse",
		id: "scripts/post-write.sh",
		matcher: "Write|Edit|NotebookEdit",
		covers: ["Write", "Edit", "NotebookEdit"],
	},
	// Both of mantahostels#1806's seams are ONE registration: two entries naming this script
	// carry no arguments to tell them apart, so `id` above could not. The Read
	// seam's research-scratch scoping lives inside the script — a matcher cannot
	// filter on a path.
	{
		event: "PostToolUse",
		id: "scripts/scan-injection.js",
		matcher: "WebFetch|WebSearch|Read",
		covers: ["WebFetch", "WebSearch", "Read"],
	},

	// UserPromptSubmit, Stop, SessionStart cover no tool; SessionStart's one
	// matcher reads the start's `source`.
	{
		event: "UserPromptSubmit",
		id: "scripts/name-issue-session.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "UserPromptSubmit",
		id: "scripts/inject-tracker-docs.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "UserPromptSubmit",
		id: "scripts/inject-founder-wording.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "UserPromptSubmit",
		id: "scripts/unpark-on-prompt.js",
		matcher: null,
		covers: [],
	},
	{
		event: "UserPromptSubmit",
		id: "scripts/mark-presence.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/concision-backstop.sh stop",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-priced-options.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-inventory.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-jev-advisory.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-selection-sum.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-uncommitted-work.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-session-ceiling.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-lost-deny.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-automode-refusal.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-unpushed-commits.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/guard-paste-self-match.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/park-on-round.js",
		matcher: null,
		covers: [],
	},
	{
		event: "Stop",
		id: "scripts/refill-wake.sh",
		matcher: null,
		covers: [],
	},
	{
		/* Replays what the SessionStart producers below persisted at an earlier
		 * start, before any of them runs again (mantahostels#2277). Its position in
		 * .claude/settings.json is what carries that, and nothing here asserts it:
		 * this table pins the event, the matcher and the timeout, never the order
		 * (mantahostels#2299 review). */
		event: "SessionStart",
		id: "scripts/replay-notify-reports.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-plugin-gap.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/concision-backstop.sh start",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/name-issue-session.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/inject-tracker-docs.sh",
		matcher: null,
		covers: [],
	},
	{
		/* Silent while no wait loop has outlived its session, so this line is
		 * absent from a healthy session start — but it re-reports a standing one
		 * at every start, deliberately unlike the ghost sweep above (mantahostels#2043). */
		event: "SessionStart",
		id: "scripts/check-orphan-wait-loops.js --notify",
		matcher: null,
		covers: [],
	},
	{
		/* Silent on a clean or unreadable kernel log; warns at every start while
		 * the running boot holds an RCU stall (#867). */
		event: "SessionStart",
		id: "scripts/check-kernel-stall.js --notify",
		matcher: null,
		covers: [],
	},
	{
		/* Silent unless the refill loop stopped on no progress or the allowance
		 * cut since the stop it last named; names each such stop once (#2014). */
		event: "SessionStart",
		id: "scripts/check-refill-loop-stop.js --notify",
		matcher: null,
		covers: [],
	},
	{
		/* Silent unless the installed Claude Code's probe went red; a version
		 * neither passed nor probed launches the probe detached (#2037). */
		event: "SessionStart",
		id: "scripts/check-harness-canary.js --notify",
		matcher: null,
		covers: [],
	},
	{
		/* Silent; files each orphaned edit's triage issue once per path and blob
		 * (#813), the report read on `npm run status` (#2038). */
		event: "SessionStart",
		id: "scripts/check-orphaned-edits.js --notify",
		matcher: null,
		covers: [],
	},
	{
		/* Silent; starts the detached judging batch at most every six hours
		 * (#671), its standing read on `npm run status` (#2038). */
		event: "SessionStart",
		id: "scripts/audit-escape-lines.js --notify",
		matcher: null,
		covers: [],
	},
	// Detached since mantahostels#1899: the sweep's cost tracks the record backlog, not the
	// session, so it cannot be held to a 10s hook budget — and nothing in the
	// starting session reads it.
	{
		event: "SessionStart",
		id: "scripts/session-arbiter.js prune-markers --detach",
		matcher: null,
		covers: [],
	},
	// The other SessionStart entry that nothing waits on: it detaches its sweep and
	// returns (mantahostels#1251). What it must do once detached is proved behaviourally in
	// sweep-debts-detached.test.ts.
	{
		event: "SessionStart",
		id: "scripts/sweep-debts-detached.sh",
		matcher: null,
		covers: [],
	},
	// The core settings' one hook (#2473).
	{
		event: "PreToolUse",
		id: "scripts/self-plugin-canary.sh",
		matcher: null,
		covers: [],
	},
	// Silent; the marker scripts/self-plugin-canary.sh reads (#2438).
	{
		event: "SessionStart",
		id: "scripts/write-self-plugin-marker.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/inject-compaction-count.js",
		matcher: "compact",
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-ci-status.js --notify",
		matcher: null,
		covers: [],
	},
	{
		/* Fires the spend policy's only upward trigger, when every live seat is at
		 * 100% of its weekly allowance with more than 24h to the earliest reset
		 * (mantahostels#1740, built at mantahostels#1776); otherwise it prints only the unread-seat panel,
		 * and usually nothing. ad6edc1e lifted it off with seventeen reporters and
		 * mantahostels#2680 put it back alone, its daily reading being a series nothing
		 * reconstructs. */
		event: "SessionStart",
		id: "scripts/check-seat-utilisation.js --notify",
		matcher: null,
		covers: [],
	},
	// Unlike its six siblings this one `cd`s into the project first: the checker
	// resolves `docs/…` and shells git against the cwd, where they are
	// cwd-independent (mantahostels#391).
	{
		event: "SessionStart",
		id: "scripts/reap-finished-sessions.js --notify",
		matcher: null,
		covers: [],
	},
	// PreCompact takes no matcher either, and fires on no tool at all (mantahostels#1804).
	{
		event: "PreCompact",
		id: "scripts/clear-rule-latch.sh",
		matcher: null,
		covers: [],
	},
	/* Both triggers, so a manual compaction overwrites an auto one's marker
	 * that never reached SessionStart (#1148). */
	{
		event: "PreCompact",
		id: "scripts/inject-compaction-count.js",
		matcher: null,
		covers: [],
	},
	/* Materialises the plugin version the repo's pin declares, where the
	 * founder consented to that tag and no neighbour is live (#247). */
	{
		event: "SessionEnd",
		id: "scripts/reconcile-plugin.js --session-end",
		matcher: null,
		covers: [],
	},
];

describe("hook registrations", () => {
	it.each(
		REGISTRATIONS.map((r) => ({
			...r,
			/* The row's own label. `$narrowing` direct renders "undefined" on an
			 * unnarrowed row. */
			where: r.narrowing ? `if: ${r.narrowing}` : "unnarrowed",
		})),
	)(
		"$event runs $id, $where",
		({ event, id, narrowing, matcher, covers, unbounded }) => {
			const found = registrationsOf(event, id).filter(
				(r) => (r.if ?? null) === (narrowing ?? null),
			);
			// One, or every assertion below reads whichever happened to sort first.
			expect(
				found,
				`${id} is not registered on ${event}${narrowing ? ` with if: ${narrowing}` : " unnarrowed"}`,
			).toHaveLength(1);

			expect(
				found[0].matcher ?? null,
				`${id}'s matcher on ${event} has changed`,
			).toBe(matcher);

			for (const tool of covers) {
				expect(
					new RegExp(`^(${found[0].matcher})$`).test(tool),
					`${id} no longer fires on ${tool}`,
				).toBe(true);
			}

			if (unbounded) {
				expect(found[0].timeout, `${id} has gained a timeout`).toBeUndefined();
			} else {
				expect(
					typeof found[0].timeout,
					`${id} has lost its timeout, so it now runs unbounded`,
				).toBe("number");
			}
		},
	);

	it("pins every registration in the file, so a new hook cannot arrive unasserted", () => {
		// The event comes from the file, not from HookEvent, so a hook registered
		// on an event nothing here knows of is unpinned rather than unseen.
		const unpinned = allRegistrations()
			.filter(
				(reg) =>
					!REGISTRATIONS.some(
						(r) =>
							r.event === reg.event &&
							commandLine(reg).includes(r.id) &&
							(r.narrowing ?? null) === (reg.if ?? null),
					),
			)
			.map(
				(reg) =>
					`${reg.event}: ${commandLine(reg).slice(0, 60)}${reg.if ? ` if: ${reg.if}` : ""}`,
			);

		expect(unpinned).toEqual([]);
	});

	// Excludes scripts/lib/guard-*.sh and guard-*-fixture.ts.
	const guardFiles = fs
		.readdirSync(__dirname)
		.filter((f) => /^guard-.+\.(sh|js)$/.test(f));

	it("scripts/guard-*.{sh,js} actually exist to enumerate", () => {
		expect(guardFiles.length).toBeGreaterThan(0);
	});

	it("every REGISTERED_ELSEWHERE entry is commented, not just keyed", () => {
		const uncommented = Object.entries(REGISTERED_ELSEWHERE)
			.filter(([, comment]) => comment.trim() === "")
			.map(([file]) => file);

		expect(uncommented).toEqual([]);
	});

	it("every scripts/guard-*.{sh,js} is registered on a hook or allowlisted", () => {
		const registrations = allRegistrations();
		const unwired = guardFiles.filter(
			(file) =>
				!registrations.some((r) =>
					commandLine(r).includes(`scripts/${file}`),
				) && !(file in REGISTERED_ELSEWHERE),
		);

		expect(unwired).toEqual([]);
	});

	it("every scripts/guard-*.{sh,js} has a sibling scripts/guard-<name>.test.ts", () => {
		const untested = guardFiles.filter(
			(file) =>
				!fs.existsSync(
					path.join(__dirname, file.replace(/\.(sh|js)$/, ".test.ts")),
				),
		);

		expect(untested).toEqual([]);
	});
});
