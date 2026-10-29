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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	allRegistrations,
	buildCommandLine,
	type HookEvent,
	registrationsOf,
} from "./lib/hook-wiring";
import { buildMissingSiblingNames } from "./lib/registrations.js";

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
	 * over (mantahostels#2811), once per permission rule, and every copy shares a command
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
}

const REGISTRATIONS: Registration[] = [
	{
		event: "PreToolUse",
		id: "scripts/guard-dispatch.js",
		matcher: "Bash|Write|Edit|NotebookEdit|Skill|Read|ListAgents|Agent|Task",
		covers: [
			"Bash",
			"Write",
			"Edit",
			"NotebookEdit",
			"Skill",
			"Read",
			"ListAgents",
			"Agent",
			"Task",
		],
	},

	{
		/* #2787: every always-on PostToolUse core runs from one entry, over the
		 * union of their tools; each core's own tools are its manifest row's. */
		event: "PostToolUse",
		id: "scripts/guard-dispatch.js",
		matcher: "Bash|Read|Write|Edit|NotebookEdit|WebFetch|WebSearch",
		covers: [
			"Bash",
			"Read",
			"Write",
			"Edit",
			"NotebookEdit",
			"WebFetch",
			"WebSearch",
		],
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
		id: "scripts/record-issue-claim.js",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PostToolUse",
		id: "scripts/release-issue-claim.js",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PostToolUse",
		id: "scripts/record-acts.js",
		narrowing: "Bash(gh *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #289: the refusal itself is only visible in the RESPONSE, so this is
		 * PostToolUse and not a PreToolUse guard. Narrowed to `git *` because a
		 * pull reached through a wrapper is unseen anyway — the same blind spot
		 * the guard-pull-form core carries — so the wider matcher buys nothing. */
		event: "PostToolUse",
		id: "scripts/record-divergence.js",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #2405: only a push that succeeded starts the lander, and only
		 * PostToolUse sees one. Unanchored, as its walker reads a push behind
		 * unwrap's wrappers. */
		event: "PostToolUse",
		id: "scripts/start-lander-on-push.js",
		narrowing: "Bash(*push*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #1575: the cut verdict is only visible in the RESPONSE. One glob
		 * every launch spelling holds, never two — the guard's header says
		 * why (#1661). */
		event: "PostToolUse",
		id: "scripts/guard-lost-verdict.js",
		narrowing: "Bash(*test*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* A call exiting non-zero reaches this event instead (#1575). */
		event: "PostToolUseFailure",
		id: "scripts/guard-lost-verdict.js",
		narrowing: "Bash(*test*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #2026: a killed call fails, so only this event sees its exit code.
		 * Unnarrowed, as any command can be killed. */
		event: "PostToolUseFailure",
		id: "scripts/guard-failed-call-rules.js",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		/* #2026: a refused Skill is turned away in input validation, before any
		 * per-call hook; only the batch's results carry it. No matcher. */
		event: "PostToolBatch",
		id: "scripts/guard-failed-call-rules.js",
		matcher: null,
		covers: [],
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
		id: "scripts/inject-founder-wording.js",
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
		id: "scripts/guard-exhausted-map.js",
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
		id: "scripts/guard-session-id-prose.js",
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
		/* Silent while no hook run is orphaned past the ceiling; kills and names
		 * each one it finds, so a standing one never re-reports (#2922). */
		event: "SessionStart",
		id: "scripts/reap-orphan-hooks.js --notify",
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
		/* Silent on a fast or unprobeable interop bridge; warns at every start
		 * while two policy queries in a row are slow, logging evidence (#3564). */
		event: "SessionStart",
		id: "scripts/check-interop-latency.js --notify",
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
	// Detached (mantahostels#1899): the sweep's cost tracks the record backlog, not the
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
	)("$event runs $id, $where", ({ event, id, narrowing, matcher, covers }) => {
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

		expect(
			typeof found[0].timeout,
			`${id} has lost its timeout, so it now runs unbounded`,
		).toBe("number");
	});

	it("pins every registration in the file, so a new hook cannot arrive unasserted", () => {
		// The event comes from the file, not from HookEvent, so a hook registered
		// on an event nothing here knows of is unpinned rather than unseen.
		const unpinned = allRegistrations()
			.filter(
				(reg) =>
					!REGISTRATIONS.some(
						(r) =>
							r.event === reg.event &&
							buildCommandLine(reg).includes(r.id) &&
							(r.narrowing ?? null) === (reg.if ?? null),
					),
			)
			.map(
				(reg) =>
					`${reg.event}: ${buildCommandLine(reg).slice(0, 60)}${reg.if ? ` if: ${reg.if}` : ""}`,
			);

		expect(unpinned).toEqual([]);
	});

	// Excludes scripts/lib/guard-*.sh and guard-*-fixture.ts. Tracked and
	// unignored files only: the shims keep-hook-shims.js holds at retired
	// scripts are ignored through .git/info/exclude (#2879).
	const guardFiles = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "--", "guard-*"],
		{ cwd: __dirname, encoding: "utf8" },
	)
		.split("\n")
		.filter(
			(f) =>
				/^guard-[^/]+\.(sh|js)$/.test(f) &&
				fs.existsSync(path.join(__dirname, f)),
		);

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
					buildCommandLine(r).includes(`scripts/${file}`),
				) && !(file in REGISTERED_ELSEWHERE),
		);

		expect(unwired).toEqual([]);
	});

	it("every scripts/guard-*.{sh,js} has a sibling test", () => {
		const untested = guardFiles.filter(
			(file) =>
				buildMissingSiblingNames(file, (p) =>
					fs.existsSync(path.join(__dirname, "..", p)),
				) !== null,
		);

		expect(untested).toEqual([]);
	});
});
