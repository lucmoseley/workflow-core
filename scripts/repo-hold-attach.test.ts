// @vitest-environment node
/*
 * Two sessions meeting one founder act (#3858), each step as a session makes
 * it: the round guard's refusal, the hold CLI, then the second session's ending
 * through the real Stop hooks.
 *
 * WHAT BREAKING IT COSTS: an attached ending refused means the founder gets the
 * round the hold exists to spare him; one let through unattached ends a job with
 * its question asked nowhere; one left unlabelled is relaunched every refill.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { runCore, toolCall } from "./lib/guard-core-testkit";
import { parseHoldId } from "./lib/repo-hold-fixture";
import { HAND_OFF, POSTED, ROUND } from "./lib/round-ending-fixture";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import { readStopGuardReason } from "./lib/stop-guard-testkit";

const PRICED = path.join(__dirname, "guard-priced-options.js");
const INVENTORY = path.join(__dirname, "guard-inventory.js");
const PARK = path.join(__dirname, "park-on-round.js");
const HOLD = path.join(__dirname, "repo-hold.js");
const ARBITER = path.join(__dirname, "session-arbiter.js");

let dir: string;
let store: string;
let gh: string;
let raiser: string;
let attacher: string;
const SID = "session-b";

const hold = (args: string[], job: string) =>
	runInProcess(HOLD, args, {
		cwd: dir,
		env: {
			...process.env,
			WFC_REFILL_DIR: store,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_JOB_DIR: job,
			CLAUDE_CODE_SESSION_ID: "",
		},
	});

const raise = () =>
	hold(
		["raise", "--act", "repair main", "--issue", "12", "--clear-issue", "12"],
		raiser,
	);

/** A job's round post, as the dispatcher judges it. */
const postRound = (ticket: number, job: string, session: string) =>
	runCore(
		"guard-round-holds",
		toolCall(
			"Bash",
			{ command: `gh issue comment ${ticket} --body-file ${dir}/round.md` },
			{ session_id: session },
		),
		{ root: dir, env: { CLAUDE_JOB_DIR: job } },
	).output?.permissionDecisionReason ?? "";

/** The ending `attach` prints, as the session fills it in. */
const buildEnding = (attachOutput: string) =>
	`Parked on the open hold.\n\n${attachOutput
		.slice(attachOutput.indexOf("waits on you:"))
		.replaceAll("#<yours>", "#31")
		.trimEnd()}`;

const stop = (guard: string, message: string, job = attacher) =>
	readStopGuardReason(guard, {
		dir,
		sid: SID,
		message,
		job,
		env: { WFC_GH: gh, WFC_REFILL_DIR: store },
	});

const readCalls = () => {
	const at = path.join(dir, "calls");
	return fs.existsSync(at) ? fs.readFileSync(at, "utf8").split("\n") : [];
};

const buildIssue = (comments: unknown[]) => ({
	__typename: "Issue",
	state: "OPEN",
	comments: { nodes: comments },
});

/** Serve #12's round and, where `handOff`, #31's hand-off from every call. */
function serve(handOff = true) {
	fs.writeFileSync(
		path.join(dir, "response.json"),
		JSON.stringify({
			data: {
				r0: {
					n12: buildIssue([POSTED]),
					n40: buildIssue([]),
					n31: buildIssue(
						handOff
							? [{ ...POSTED, body: HAND_OFF.replace("Q1", "hold") }]
							: [],
					),
				},
			},
		}),
	);
	gh = stubGhScript(
		dir,
		`#!/bin/sh\nprintf '%s\\n' "$*" >>${shellQuote(dir)}/calls\ncat ${shellQuote(dir)}/response.json`,
	).gh;
}

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hold-attach-")));
	store = path.join(dir, "store");
	raiser = path.join(dir, "seat", "jobs", "aaaa1111");
	attacher = path.join(dir, "seat", "jobs", "bbbb2222");
	fs.mkdirSync(path.join(dir, ".claude", "tmp", "markers"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);
	fs.writeFileSync(path.join(dir, "round.md"), `${ROUND}\n`);
	vi.stubEnv("WFC_REFILL_DIR", store);
	serve();
	const claimed = runInProcess(ARBITER, ["claim-issue", "31"], {
		cwd: dir,
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			CLAUDE_PROJECT_DIR: dir,
			WFC_REPO_ROOT: dir,
			CLAUDE_CODE_SESSION_ID: SID,
		},
		stdin: "",
	});
	expect(claimed.status, claimed.stderr).toBe(0);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("two sessions meeting one act (#3858)", () => {
	it("makes one round and one hold, the second session attached", () => {
		expect(postRound(12, raiser, "session-a")).toContain("none open");
		const id = parseHoldId(raise().stdout);
		expect(postRound(12, raiser, "session-a")).toBe("");

		const told = postRound(31, attacher, SID);
		expect(told).toContain("repair main");
		expect(told).toContain(id);
		expect(hold(["attach", id], attacher).status).toBe(0);

		const listed = hold(["list"], "").stdout;
		expect(listed).toContain("1 open");
		expect(listed).toContain("sessions: aaaa1111, bbbb2222");
	});
});

describe("an attached session's ending", () => {
	let id: string;
	let parked: string;
	beforeEach(() => {
		id = parseHoldId(raise().stdout);
		parked = buildEnding(hold(["attach", id], attacher).stdout);
	});

	it("passes both stop guards with no round, its line naming the hold's issue", () => {
		expect(parked).toMatch(/^needs input: .*#12/m);
		expect(stop(PRICED, parked)).toBe("");
		expect(stop(INVENTORY, parked)).toBe("");
	});

	it("labels its own ticket parked and marks it, and leaves the hold's issue alone", () => {
		stop(PARK, parked);

		const edits = readCalls().filter((c) => c.startsWith("issue edit"));
		expect(edits).toEqual(["issue edit 31 --repo o/here --add-label parked"]);
		expect(
			fs.readFileSync(
				path.join(dir, ".claude", "tmp", "markers", `.parked-${SID}`),
				"utf8",
			),
		).toContain("31");
	});

	it("is refused by the inventory guard with no hand-off on its ticket", () => {
		serve(false);

		expect(stop(INVENTORY, parked)).toContain("hand-off");
	});

	it("is refused by the inventory guard on a ticket it has not claimed, naming the claim", () => {
		const unclaimed = parked.replaceAll("#31", "#40");

		expect(stop(INVENTORY, unclaimed)).toContain("claim-issue.js");
	});

	it("is refused where it also puts a decision by letter", () => {
		const message = parked.replace(
			"Parked on the open hold.",
			"Should I (A) wait or (B) retry?",
		);

		expect(stop(PRICED, message)).toContain("with no `❓ **Qn**` round");
	});

	it("is refused once the hold is gone, as its question then waits on nothing", () => {
		hold(["lift", id], "");

		expect(stop(PRICED, parked)).toContain("with no `❓ **Qn**` round");
	});

	it("is refused where its line leaves out the hold's issue", () => {
		const message = parked.replace(/#12/g, "#31");

		expect(stop(PRICED, message)).toContain("with no `❓ **Qn**` round");
	});
});

describe("an act whose words read as a question or an option", () => {
	it("still gets an ending that passes both guards", () => {
		const id = parseHoldId(
			hold(
				[
					"raise",
					"--act",
					"answer Q2 (A) or (B)",
					"--issue",
					"12",
					"--clear-issue",
					"12",
				],
				raiser,
			).stdout,
		);
		const message = buildEnding(hold(["attach", id], attacher).stdout);

		expect(stop(PRICED, message)).toBe("");
		expect(stop(INVENTORY, message)).toBe("");
	});
});

describe("a session not attached", () => {
	it("cannot end on a hold's id, parks nothing, and is told the route", () => {
		const id = parseHoldId(raise().stdout);
		const elsewhere = path.join(dir, "seat", "jobs", "cccc3333");
		const message = buildEnding(hold(["attach", id], elsewhere).stdout);

		const refused = stop(PRICED, message);

		expect(refused).toContain("with no `❓ **Qn**` round");
		expect(refused).toContain("repo-hold.js attach");
		stop(PARK, message);
		expect(readCalls().filter((c) => c.startsWith("issue edit"))).toEqual([]);
	});

	it("cannot end on the hold it raised, with its round still owed", () => {
		const id = parseHoldId(raise().stdout);
		const elsewhere = path.join(dir, "seat", "jobs", "cccc3333");
		const message = buildEnding(hold(["attach", id], elsewhere).stdout);

		expect(stop(PRICED, message, raiser)).toContain(
			"with no `❓ **Qn**` round",
		);
	});
});
