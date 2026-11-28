// @vitest-environment node
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
import { spellSiblingTestsIfUntested } from "./lib/registrations.js";

// code-edges loads: ../.claude/settings.json

const REGISTERED_ELSEWHERE: Record<string, string> = {};

interface Registration {
	event: HookEvent;
	id: string;
	narrowing?: string;
	matcher: string | null;
	covers: string[];
}

const REGISTRATIONS: Registration[] = [
	{
		event: "PreToolUse",
		id: "scripts/guard-dispatch.js",
		matcher:
			"Bash|Write|Edit|NotebookEdit|Skill|Read|Glob|ListAgents|Agent|Task",
		covers: [
			"Bash",
			"Write",
			"Edit",
			"NotebookEdit",
			"Skill",
			"Read",
			"Glob",
			"ListAgents",
			"Agent",
			"Task",
		],
	},

	{
		// #2787
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
		// #289
		event: "PostToolUse",
		id: "scripts/record-divergence.js",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		// #2405
		event: "PostToolUse",
		id: "scripts/start-lander-on-push.js",
		narrowing: "Bash(*push*)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		// #1575 #4032
		event: "PostToolUse",
		id: "scripts/guard-lost-verdict.js",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		event: "PostToolUseFailure",
		id: "scripts/guard-lost-verdict.js",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		// #4446
		event: "PostToolUseFailure",
		id: "scripts/record-divergence.js",
		narrowing: "Bash(git *)",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		// #2026
		event: "PostToolUseFailure",
		id: "scripts/guard-failed-call-rules.js",
		matcher: "Bash",
		covers: ["Bash"],
	},
	{
		// #2026
		event: "PostToolBatch",
		id: "scripts/guard-failed-call-rules.js",
		matcher: null,
		covers: [],
	},

	{
		event: "UserPromptSubmit",
		id: "scripts/name-issue-session.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "UserPromptSubmit",
		id: "scripts/inject-tracker-docs.js",
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
		event: "SubagentStop",
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
		id: "scripts/guard-typecheck-owed.js",
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
		id: "scripts/guard-held-ticket.js",
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
		event: "Stop",
		id: "scripts/practice-guard.sh stop",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/machine-figures.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/replay-notify-reports.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/guard-plugin-gap.js",
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
		id: "scripts/inject-tracker-docs.js",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/reap-orphan-hooks.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-orphan-wait-loops.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-kernel-stall.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-release-lag.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-main-checkout-cutover.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-interop-latency.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-refill-loop-stop.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-idle-efforts.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-harness-canary.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-orphaned-edits.js --notify --write --hourly",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/audit-escape-lines.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/session-arbiter.js prune-markers --detach",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/session-start-sweeps.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "PreToolUse",
		id: "scripts/self-plugin-canary.sh",
		matcher: null,
		covers: [],
	},
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
		id: "scripts/guard-main-checkout-job.js",
		matcher: "startup|resume",
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-ci-status.js --notify --write",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/check-seat-utilisation.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "SessionStart",
		id: "scripts/reap-finished-sessions.js --notify",
		matcher: null,
		covers: [],
	},
	{
		event: "PreCompact",
		id: "scripts/clear-rule-latch.sh",
		matcher: null,
		covers: [],
	},
	{
		event: "PreCompact",
		id: "scripts/inject-compaction-count.js",
		matcher: null,
		covers: [],
	},
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
			where: r.narrowing ? `if: ${r.narrowing}` : "unnarrowed",
		})),
	)("$event runs $id, $where", ({ event, id, narrowing, matcher, covers }) => {
		const found = registrationsOf(event, id).filter(
			(r) => (r.if ?? null) === (narrowing ?? null),
		);
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
				spellSiblingTestsIfUntested(file, (p) =>
					fs.existsSync(path.join(__dirname, "..", p)),
				) !== null,
		);

		expect(untested).toEqual([]);
	});
});
