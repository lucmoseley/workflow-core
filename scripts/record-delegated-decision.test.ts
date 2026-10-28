// @vitest-environment node
/*
 * record-delegated-decision.js, driven through its command line (#2002).
 *
 * GitHub is a stub `gh` (WFC_GH) keeping #534's comments in a file, with
 * levers that fail the post or drop its URL, so a re-run sees what the first
 * run posted; the config and ledger sit in a throwaway repository.
 *
 * WHAT BREAKING IT COSTS: a decision posted twice, or missing from the ledger
 * the morning review issue lists from, so the founder never sees it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "record-delegated-decision.js");

const sb = freshSandbox((s) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
});

const stub = (name: string) => path.join(sb.dir, "gh", name);
const ledger = () =>
	path.join(sb.repo, ".claude", "tmp", "markers", "delegated-decisions.jsonl");

/**
 * `gh` over #534's comments. Levers: `comment-fails` fails the post;
 * `no-url` posts but prints nothing.
 */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const f = (n) => path.join(process.env.STUB_DIR, n);
const a = process.argv.slice(2);
const say = (o) => { process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); process.exit(0); };
const comments = () => fs.existsSync(f("comments.json")) ? JSON.parse(fs.readFileSync(f("comments.json"), "utf8")) : [];
if (a[0] === "api" && a[1] === "user") say({ login: "me" });
if (a[0] === "api" && a[1] === "repos/acme/widgets/issues/534/comments") say([comments()]);
if (a[0] === "issue" && a[1] === "comment" && a[2] === "534") {
	if (fs.existsSync(f("comment-fails"))) { process.stderr.write("HTTP 502: Bad Gateway\\n"); process.exit(1); }
	const url = "https://github.com/acme/widgets/issues/534#issuecomment-" + (comments().length + 1);
	fs.writeFileSync(f("comments.json"), JSON.stringify([...comments(), { user: { login: "me" }, body: fs.readFileSync(0, "utf8"), html_url: url, created_at: "2026-10-18T01:00:00Z" }]));
	say(fs.existsSync(f("no-url")) ? "" : url + "\\n");
}
process.stderr.write("gh stub: unsupported: " + a.join(" ") + "\\n");
process.exit(1);
`;

const FIELDS: Record<string, string> = {
	"--question": "Which cache key shape for the shortlist?",
	"--taken": "(A) key on repo and issue",
	"--taken-figure": "55%",
	"--runner-up": "(B) key on issue alone",
	"--runner-up-figure": "45%",
	"--rung-rulings": "#1969 ruled one ranking across repos",
	"--rung-web": "none",
	"--rung-subagent": "none",
	"--still-caught": "yes",
	"--reverse": "switch the key to issue alone in pick-next.js",
};

const run = (fields: Record<string, string> = FIELDS, n = "534") => {
	fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
	return runInProcess(SCRIPT, [n, ...Object.entries(fields).flat()], {
		env: {
			...process.env,
			...stubGhScript(sb.dir, STUB).env,
			CLAUDE_CODE_SESSION_ID: "sess-me",
			STUB_DIR: path.join(sb.dir, "gh"),
		},
	});
};

const readPosted = (): { body: string; html_url: string }[] =>
	fs.existsSync(stub("comments.json"))
		? JSON.parse(fs.readFileSync(stub("comments.json"), "utf8"))
		: [];
const readLedger = () =>
	fs.existsSync(ledger())
		? fs
				.readFileSync(ledger(), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

const COMMENT = `**Delegated decision:**

- Question: Which cache key shape for the shortlist?
- Taken: (A) key on repo and issue — 55%
- Runner-up: (B) key on issue alone — 45%
- Rung 1, past rulings: #1969 ruled one ranking across repos
- Rung 2, web or vendor docs: none
- Rung 3, fresh subagent: none
- Still caught: yes
- To reverse: switch the key to issue alone in pick-next.js
`;

describe("a recorded decision", () => {
	it("posts the comment in the spec's shape and appends the same entry to the ledger", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(readPosted().map((c) => c.body)).toEqual([COMMENT]);
		expect(readLedger()).toEqual([
			expect.objectContaining({
				repo: "acme/widgets",
				issue: 534,
				comment: "https://github.com/acme/widgets/issues/534#issuecomment-1",
				session: "sess-me",
				question: "Which cache key shape for the shortlist?",
				taken: { option: "(A) key on repo and issue", figure: 55 },
				runnerUp: { option: "(B) key on issue alone", figure: 45 },
				rungs: {
					rulings: "#1969 ruled one ranking across repos",
					web: "none",
					subagent: "none",
				},
				stillClose: true,
				reverse: "switch the key to issue alone in pick-next.js",
			}),
		]);
	});

	it("records a clear call too, as still caught: no", () => {
		const r = run({ ...FIELDS, "--still-caught": "no" });
		expect(r.status).toBe(0);
		expect(readPosted()[0].body).toContain("- Still caught: no\n");
		expect(readLedger()[0].stillClose).toBe(false);
	});

	it("names both still-caught tests in its usage line (#2594)", () => {
		expect(run({}).stderr).toContain(
			"--still-caught yes|no (yes: top two rivals still close, or no option above 65%)",
		);
	});

	it("appends a second decision on the same ticket as its own line", () => {
		run();
		const r = run({ ...FIELDS, "--question": "Which log level?" });
		expect(r.status).toBe(0);
		expect(readPosted()).toHaveLength(2);
		expect(readLedger().map((l) => l.question)).toEqual([
			"Which cache key shape for the shortlist?",
			"Which log level?",
		]);
	});

	it("re-run writes neither a second comment nor a second ledger line", () => {
		run();
		const r = run();
		expect(r.status).toBe(0);
		expect(readPosted()).toHaveLength(1);
		expect(readLedger()).toHaveLength(1);
	});
});

describe("refusals write nothing", () => {
	it.each(Object.keys(FIELDS))("refuses with %s missing", (flag) => {
		const { [flag]: _gone, ...rest } = FIELDS;
		const r = run(rest);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(flag);
		expect(r.stderr).toContain("usage: node scripts/record-delegated");
		expect(readPosted()).toEqual([]);
		expect(readLedger()).toEqual([]);
	});

	it.each([
		["--question", "two\nlines", "spans more than one line"],
		["--rung-web", "  ", "--rung-web is missing or empty"],
		["--taken-figure", "55", "--taken-figure must be a percentage"],
		["--runner-up-figure", "140%", "--runner-up-figure must be a percentage"],
		["--still-caught", "maybe", "--still-caught must be yes or no"],
	])("refuses %s = %j", (flag, value, says) => {
		const r = run({ ...FIELDS, [flag]: value });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(r.stderr).toContain("usage: node scripts/record-delegated");
		expect(readPosted()).toEqual([]);
		expect(readLedger()).toEqual([]);
	});

	it("refuses a non-number ticket", () => {
		const r = run(FIELDS, "abc");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("'abc' is not an issue number");
		expect(r.stderr).toContain("usage: node scripts/record-delegated");
		expect(readPosted()).toEqual([]);
	});
});

describe("a failed write", () => {
	it("a failed post leaves nothing written and says so", () => {
		fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
		fs.writeFileSync(stub("comment-fails"), "");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Nothing written — re-run");
		expect(readLedger()).toEqual([]);
	});

	it("an unwritable ledger after the comment names the half-done state, and a re-run finishes it", () => {
		fs.mkdirSync(ledger(), { recursive: true });
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("HALF DONE");
		expect(r.stderr).toContain("#534 (https://github.com/acme/widgets");
		expect(r.stderr).toContain("Re-run the same command");
		expect(readPosted()).toHaveLength(1);

		fs.rmSync(ledger(), { recursive: true });
		expect(run().status).toBe(0);
		expect(readPosted()).toHaveLength(1);
		// The comment's own time, so the line falls in the review window the
		// comment did.
		expect(readLedger()).toEqual([
			expect.objectContaining({ at: "2026-10-18T01:00:00Z" }),
		]);
	});

	it("a comment posted with no URL printed names the half-done state", () => {
		fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
		fs.writeFileSync(stub("no-url"), "");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("HALF DONE");
		expect(r.stderr).toContain("Re-run the same command");
		expect(readLedger()).toEqual([]);
	});
});
