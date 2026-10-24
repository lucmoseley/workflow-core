// @vitest-environment node
/*
 * Pins which comments capture-drain.js reads as captures and as consumed, that
 * `list` gives the undrained ones oldest first, and that `mark` consumes one by
 * a reaction, never a body edit, reporting a failure rather than claiming it
 * drained (mantahostels#640, mantahostels#679).
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth, and no
 * dependence on this repo's own capture comments — which the script reports on
 * and so cannot also be its fixture.
 *
 * The fixtures are the shapes mantahostels#640 settled: a capture on the issue a session was
 * working, one on mantahostels#678 (the standing surface), a consumed one carrying the
 * reaction, and prose that merely mentions the marker mid-body.
 *
 * The capture-drain skill drains through this script: loosen a case and a
 * captured fact can be skipped unseen, marked drained without landing, or
 * erase a parallel session's comment edit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_LOGGED_OUT_NODE, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

/** The marker a capture comment opens with (mantahostels#640), restated so a
 * change to it fails here. */
const MARKER = "**Captured fact:**";

const SCRIPT = path.resolve(__dirname, "capture-drain.js");

let dir: string;

interface Comment {
	id: number;
	issue: number;
	body: string;
	/** days ago */
	age: number;
	/** the reaction summary, omitted entirely on a payload that carries none */
	reactions?: Record<string, number>;
}

interface Fixture {
	comments: Comment[];
	unreachable?: boolean;
}

const CALL_LOG = () => path.join(dir, "calls.log");

const capture = (
	id: number,
	issue: number,
	{
		age,
		fact,
		drained = false,
	}: { age: number; fact: string; drained?: boolean },
): Comment => ({
	id,
	issue,
	age,
	body: `${MARKER} ${fact}`,
	reactions: drained ? { rocket: 1 } : { rocket: 0, "+1": 2 },
});

const stubGh = (fx: Fixture) => {
	fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(fx));

	const stub = `#!/usr/bin/env node
const fs = require("node:fs");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "fixture.json"))}, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALL_LOG())}, argv.join(" ") + "\\n");

const die = (msg) => { process.stderr.write("gh: " + msg + "\\n"); process.exit(1); };
if (fx.unreachable) { ${GH_LOGGED_OUT_NODE} }

const p = argv.find((a) => a.startsWith("repos/")) || "";
if (/\\/reactions$/.test(p)) { process.stdout.write("{}\\n"); return; }
if (/issues\\/comments$/.test(p)) {
  // --slurp wraps each page's array; one page is enough for every fixture here.
  return process.stdout.write(JSON.stringify([fx.comments.map((c) => ({
    id: c.id,
    body: c.body,
    issue_url: "https://api.github.com/repos/o/r/issues/" + c.issue,
    html_url: "http://example/c/" + c.id,
    created_at: new Date(Date.now() - c.age * 864e5).toISOString(),
    reactions: c.reactions,
  }))]) + "\\n");
}
die("unexpected path: " + p);
`;
	return stubGhScript(dir, stub);
};

const run = (fx: Fixture, args: string[]) => {
	const stub = stubGh(fx);
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, ...stub.env, CLAUDE_PROJECT_DIR: dir },
	});
	const log = CALL_LOG();
	return {
		status: r.status ?? -1,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		stdout: r.stdout ?? "",
		calls: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
				: [],
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-drain-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The rows `list --all --json` reads off these comment bodies and reaction summaries. */
const listed = (comments: Pick<Comment, "body" | "reactions">[]) => {
	const r = run(
		{
			comments: comments.map((c, i) => ({
				id: i + 1,
				issue: 1,
				age: 1,
				...c,
			})),
		},
		["list", "--all", "--json"],
	);
	expect(r.status, r.out).toBe(0);
	return JSON.parse(r.stdout);
};

/** The fact the drain reads off one comment body, or null where it is no capture. */
const factOf = (body: string | null) =>
	listed([{ body: body as string }])[0]?.fact ?? null;

/** Whether the drain reads a capture carrying `reactions` as consumed. */
const drainedBy = (reactions?: Record<string, number>) =>
	listed([{ body: `${MARKER} a fact`, reactions }])[0].drained;

describe("what counts as a capture", () => {
	it("reads the fact off a comment opening with the marker", () => {
		expect(factOf(`${MARKER} gh hangs in a sandboxed foreground Bash.`)).toBe(
			"gh hangs in a sandboxed foreground Bash.",
		);
	});

	it("allows leading blank lines before the marker", () => {
		expect(factOf(`\n\n${MARKER} the drain owns duplicate-checking.`)).toBe(
			"the drain owns duplicate-checking.",
		);
	});

	it("keeps a multi-line fact whole", () => {
		expect(factOf(`${MARKER} first line\nsecond line`)).toBe(
			"first line\nsecond line",
		);
	});

	it("ignores prose that merely mentions the marker mid-body", () => {
		// This repo's own docs quote the phrase; none of them is a capture.
		expect(
			factOf(`The comment opens with ${MARKER} and states the fact.`),
		).toBeNull();
	});

	it("ignores an empty comment", () => {
		expect(factOf("")).toBeNull();
		expect(factOf(null)).toBeNull();
	});
});

describe("consumed state", () => {
	it("reads the drain reaction off the payload's summary", () => {
		expect(drainedBy({ rocket: 1 })).toBe(true);
	});

	it("does not read an unrelated reaction as consumed", () => {
		// +1 and eyes get added by hand while reading a comment.
		expect(drainedBy({ rocket: 0, "+1": 3, eyes: 1 })).toBe(false);
	});

	it("treats a payload carrying no reaction summary as undrained", () => {
		// The safe direction: a capture shown again is noise; one swept past is lost.
		expect(drainedBy(undefined)).toBe(false);
	});
});

describe("list", () => {
	const listFixture: Fixture = {
		comments: [
			capture(11, 679, { age: 3, fact: "the drain marks with a reaction" }),
			capture(12, 678, { age: 20, fact: "captured outside any ticket" }),
			capture(13, 640, { age: 9, fact: "already placed", drained: true }),
			{ id: 14, issue: 640, age: 1, body: "an ordinary comment" },
		],
	};

	it("finds captures on both surfaces — a worked issue and mantahostels#678", () => {
		const r = run(listFixture, ["list"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("#679");
		expect(r.stdout).toContain("#678");
	});

	it("lists undrained only, oldest first", () => {
		const r = run(listFixture, ["list"]);
		expect(r.stdout).not.toContain("[13]");
		expect(r.stdout).not.toContain("an ordinary comment");
		expect(r.stdout.indexOf("[12]")).toBeLessThan(r.stdout.indexOf("[11]"));
	});

	it("counts the drained ones in the total it reports", () => {
		const r = run(listFixture, ["list"]);
		expect(r.stdout).toContain("2 capture(s)");
		expect(r.stdout).toContain("of 3 on the tracker");
	});

	it("shows the drained ones under --all", () => {
		const r = run(listFixture, ["list", "--all"]);
		expect(r.stdout).toContain("[13]");
		expect(r.stdout).toContain("drained");
	});

	it("emits machine-readable rows under --json", () => {
		const rows = JSON.parse(run(listFixture, ["list", "--json"]).stdout);
		expect(rows.map((c: { id: number }) => c.id)).toEqual([12, 11]);
		expect(rows[0].issue).toBe(678);
	});

	it("says so when nothing is undrained", () => {
		const r = run(
			{
				comments: [capture(13, 640, { age: 9, fact: "placed", drained: true })],
			},
			["list"],
		);
		expect(r.stdout).toContain("No undrained captures");
	});

	it("reports an unreachable gh rather than an empty queue", () => {
		const r = run({ comments: [], unreachable: true }, ["list"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain("could not read the tracker");
	});
});

describe("mark", () => {
	it("reacts to the comment and never edits its body", () => {
		const r = run({ comments: [] }, ["mark", "11"]);
		expect(r.status).toBe(0);
		const call = r.calls().join(" ");
		expect(call).toContain("issues/comments/11/reactions");
		expect(call).toContain("content=rocket");
		expect(call).toContain("--method POST");
		expect(call).not.toContain("PATCH");
		expect(call).not.toContain("body=");
	});

	it("refuses without a comment id, asking for exactly one numeric id, and makes no call", () => {
		const r = run({ comments: [] }, ["mark"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain("exactly one numeric comment id");
		expect(r.calls()).toEqual([]);
	});

	it("refuses two ids, naming the count it got and making no call, rather than silently marking one", () => {
		const r = run({ comments: [] }, ["mark", "11", "12"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain("got 2");
		expect(r.calls()).toEqual([]);
	});

	it("reports a failed reaction rather than claiming the capture drained", () => {
		const r = run({ comments: [], unreachable: true }, ["mark", "11"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain("could not react to comment 11");
		expect(r.out).not.toContain("Marked comment");
	});
});

describe("invocation", () => {
	it("refuses an unknown subcommand, naming it and its usage", () => {
		const r = run({ comments: [] }, ["drain-everything"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("unknown command: drain-everything");
		expect(r.out).toContain("usage:");
	});

	it("refuses an unknown flag before reading the tracker, naming the flag and its usage", () => {
		const r = run({ comments: [] }, ["list", "--al"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("unknown flag: --al");
		expect(r.out).toContain("usage:");
		expect(r.calls()).toEqual([]);
	});
});
