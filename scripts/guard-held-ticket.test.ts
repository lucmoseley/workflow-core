// @vitest-environment node
/*
 * Pins the Stop guard that refuses a session-ending turn while the session
 * claims an unfinished build unit — an open, unparked `kind:ticket` with an
 * unticked, unwaived criterion (#4535) — and every exit it lets through.
 *
 * Breaking it either lets a session stop mid-unit again (#4495), or blocks a
 * session that parked, waits, or is past the tripwire or the backstop.
 *
 * Each case runs the guard through stop-guard-testkit against a sandboxed
 * arbiter store and `gh` served by stubGhRoutes, so no real tracker is read.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, issueClaims } from "./lib/arbiter-testkit";
import { GH_NOT_FOUND } from "./lib/gh-fake";
import { type RouteAnswer, stubGhRoutes } from "./lib/gh-stub";
import { readStopGuardReason } from "./lib/stop-guard-testkit";

const { recordCompactions } = createRequire(__filename)(
	"./lib/compaction-set.js",
);
const hookBlock = createRequire(__filename)("./lib/hook-block.js");

const GUARD = path.join(__dirname, "guard-held-ticket.js");
const ME = "sess-me";
const UNIT = 800;
const AT = `repos/acme/widgets/issues/${UNIT}`;

const sb = freshSandbox((s) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
});

const UNMET = "## Acceptance criteria\n\n- [x] one\n- [ ] two\n";

const unit = ({
	state = "open",
	labels = ["kind:ticket", "takes:implement"],
	body = UNMET,
} = {}): RouteAnswer => ({
	kind: "issue",
	value: {
		number: UNIT,
		state,
		labels: labels.map((name) => ({ name })),
		body,
	},
});

/** A transcript whose last turn stands at `tokens`. */
const transcriptAt = (tokens: number) => {
	const file = path.join(sb.dir, `${ME}.jsonl`);
	fs.writeFileSync(
		file,
		`${JSON.stringify({
			type: "assistant",
			timestamp: "2026-11-09T00:00:00Z",
			requestId: "req_0",
			message: {
				usage: {
					input_tokens: 1,
					cache_creation_input_tokens: 1,
					cache_read_input_tokens: tokens - 2,
				},
			},
		})}\n`,
	);
	return file;
};

const reasonFor = (
	routes: Record<string, RouteAnswer> = { [AT]: unit() },
	{
		claim = true,
		message = "Done.\n\nresult: slice one landed",
		tokens = 120_000 as number | null,
	} = {},
) => {
	if (claim) issueClaims.claimIssue(UNIT, { sessionId: ME });
	return readStopGuardReason(GUARD, {
		dir: sb.repo,
		sid: ME,
		config: sb.home,
		message,
		transcript:
			tokens === null
				? path.join(sb.dir, "absent.jsonl")
				: transcriptAt(tokens),
		env: stubGhRoutes(sb.dir, routes).env,
	});
};

describe("a claimed unfinished build unit", () => {
	it("refuses a `result:` ending, naming the unit and the four exits", () => {
		const reason = reasonFor();
		expect(reason).toContain(`#${UNIT}`);
		expect(reason).toContain("No ticket comment or body note moves");
		for (const exit of [
			"scripts/park-blocked.sh",
			"a `needs input:` park with its `**Hand-off:**` block",
			"the 300,000 tripwire",
			"the compaction backstop's hand-off",
		])
			expect(reason).toContain(exit);
	});

	it("refuses an ending with no status marker", () => {
		expect(reasonFor(undefined, { message: "All done here." })).toContain(
			`#${UNIT}`,
		);
	});

	it("blocks at most three times a session", () => {
		const reasons = [1, 2, 3, 4].map(() => reasonFor());
		expect(reasons.slice(0, 3).every((r) => r.includes(`#${UNIT}`))).toBe(true);
		expect(reasons[3]).toBe("");
	});
});

describe("a stop it allows", () => {
	it.each([
		["needs input:", "Asked.\n\nneeds input: which parser — waits on you: #9"],
		["waiting:", "Lander running.\n\nwaiting: the lander, testing abc123"],
	])("allows a `%s` ending", (_, message) => {
		expect(reasonFor(undefined, { message })).toBe("");
	});

	it.each([
		["parked", unit({ labels: ["kind:ticket", "parked"] })],
		["closed", unit({ state: "closed" })],
		["finished", unit({ body: "## Acceptance criteria\n\n- [x] one\n" })],
		[
			"waived on its open criterion",
			unit({
				body: "## Acceptance criteria\n\n- [ ] two **waived:** out of scope\n",
			}),
		],
		["not a kind:ticket", unit({ labels: ["wayfinder:map"] })],
	])("allows where the unit is %s", (_, answer) => {
		expect(reasonFor({ [AT]: answer })).toBe("");
	});

	it("allows a session past the 300,000 tripwire", () => {
		expect(reasonFor(undefined, { tokens: 310_000 })).toBe("");
	});

	it("allows a session whose tripwire block is spent, though compacted since", () => {
		hookBlock.charge({
			prefix: ".session-ceiling-nagged-hard-",
			sessionId: ME,
			max: 1,
		});
		expect(reasonFor()).toBe("");
	});

	it("allows a session at the compaction backstop", () => {
		recordCompactions(
			ME,
			Array.from({ length: 10 }, (_, i) => `compaction-${i}`),
		);
		expect(reasonFor()).toBe("");
	});

	it("allows a session holding no claim", () => {
		expect(reasonFor(undefined, { claim: false })).toBe("");
	});

	it("fails open where the issue cannot be read", () => {
		expect(reasonFor({ [AT]: GH_NOT_FOUND })).toBe("");
	});

	it("is silent where the transcript cannot be read", () => {
		expect(reasonFor(undefined, { tokens: null })).toBe("");
	});
});
