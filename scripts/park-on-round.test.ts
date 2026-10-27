// @vitest-environment node
/*
 * park-on-round.js labels `parked` the issue a background job's `needs
 * input:` ending posted its round on, only where this session claims it
 * (#2000) — driven through hook stdin, the way the harness runs it at Stop.
 *
 * GitHub is a stub `gh` (WFC_GH) serving one GraphQL answer and logging each
 * call; the claim store, config and markers sit in a throwaway directory.
 *
 * WHAT BREAKING IT COSTS: a parked ticket left unlabelled is relaunched every
 * refill, each relaunch re-asking the round; one labelled wrongly drops off
 * the frontier until a claim clears it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { NEEDS_INPUT, POSTED, ROUND } from "./lib/round-ending-fixture";
import { readStopGuardBlock } from "./lib/stop-guard-testkit";

const HOOK = path.join(__dirname, "park-on-round.js");

let dir: string;
let sid: string;
let gh: string;

/** Serve one GraphQL `data` object for every call, logging each; `issue edit` fails where `failEdit`. */
function serve(data: unknown, failEdit = false) {
	fs.writeFileSync(path.join(dir, "response.json"), JSON.stringify({ data }));
	gh = stubGhScript(
		dir,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >>${dir}/calls`,
			failEdit
				? 'case "$*" in "issue edit"*) echo "HTTP 502" >&2; exit 1 ;; esac'
				: "",
			`cat ${dir}/response.json`,
		].join("\n"),
	).gh;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "park-on-round-"));
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);
	serve({ r0: { n31: issue([POSTED]) } });
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function issue(comments: unknown[]) {
	return { __typename: "Issue", state: "OPEN", comments: { nodes: comments } };
}

/** Record `session`'s arbiter claim on issue `n`, in the store the hook reads. */
function claim(n: number, session = sid) {
	execFileSync(
		process.execPath,
		[path.join(__dirname, "session-arbiter.js"), "claim-issue", String(n)],
		{
			cwd: dir,
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: path.join(dir, "config"),
				CLAUDE_PROJECT_DIR: dir,
				WFC_REPO_ROOT: dir,
				CLAUDE_CODE_SESSION_ID: session,
			},
			stdio: "pipe",
		},
	);
}

/** Run the hook, as a background job unless `job` is false (an interactive session); it never blocks. */
function run(message: string, job = true) {
	expect(
		readStopGuardBlock(HOOK, { dir, sid, message, job, env: { WFC_GH: gh } }),
	).toBe(null);
}

const readEdits = () => {
	const at = path.join(dir, "calls");
	return fs.existsSync(at)
		? fs
				.readFileSync(at, "utf8")
				.split("\n")
				.filter((c) => c.startsWith("issue edit"))
		: [];
};
const readMarker = () => {
	const at = path.join(dir, ".claude", "tmp", "markers", `.parked-${sid}`);
	return fs.existsSync(at) ? fs.readFileSync(at, "utf8").trim() : null;
};

describe("a round posted on an issue this session claims", () => {
	it("labels the issue parked and records it in the session marker", () => {
		claim(31);
		run(NEEDS_INPUT);
		expect(readEdits()).toEqual([
			"issue edit 31 --repo o/here --add-label parked",
		]);
		expect(readMarker()).toBe("31");
	});

	it("leaves the marker unwritten where the label write fails", () => {
		serve({ r0: { n31: issue([POSTED]) } }, true);
		claim(31);
		run(NEEDS_INPUT);
		expect(readEdits()).toHaveLength(1);
		expect(readMarker()).toBe(null);
	});
});

describe("any other ending", () => {
	it("parks nothing for an issue no session claims", () => {
		run(NEEDS_INPUT);
		expect(readEdits()).toEqual([]);
	});

	it("parks nothing for an issue only another session claims", () => {
		claim(31, `${sid}-other`);
		run(NEEDS_INPUT);
		expect(readEdits()).toEqual([]);
	});

	it("parks nothing at an interactive session's ending", () => {
		claim(31);
		run(NEEDS_INPUT, false);
		expect(readEdits()).toEqual([]);
	});

	it("parks nothing at a `result:` ending", () => {
		claim(31);
		run(
			"Done.\n\nwaits on you:\n- #31 (read it)\n\nresult: done — waits on you: #31",
		);
		expect(readEdits()).toEqual([]);
	});

	it("parks nothing where no cited issue holds the round", () => {
		serve({ r0: { n31: issue([]) } });
		claim(31);
		run(NEEDS_INPUT);
		expect(readEdits()).toEqual([]);
	});

	it("parks nothing where the round comment carries no hand-off", () => {
		serve({ r0: { n31: issue([{ ...POSTED, body: ROUND }]) } });
		claim(31);
		run(NEEDS_INPUT);
		expect(readEdits()).toEqual([]);
	});

	it("parks nothing at an ending the inventory guard refuses — a tail naming another issue", () => {
		claim(31);
		run(NEEDS_INPUT.replace("waits on you: #31", "waits on you: #32"));
		expect(readEdits()).toEqual([]);
	});
});
