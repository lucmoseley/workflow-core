// @vitest-environment node
/*
 * read-hand-off.js is the pick-up step for a ticket a parked session left a
 * `**Hand-off:**` block on (#2391). Each case runs the script in a throwaway
 * git repo, against a stub `gh` serving the issue's comments, and reads its
 * verdict line.
 *
 * WHAT BREAKING IT COSTS: a fresh session applies a stale diff over a
 * neighbour's newer work, or trusts a Base the tree has moved past.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catFixture, GH_FAILING_SCRIPT, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "read-hand-off.js");

let dir: string;
let gh: string;

const git = (...args: string[]) =>
	String(
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", ...args],
			{ cwd: dir, encoding: "utf8", stdio: "pipe" },
		),
	).trim();

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-hand-off-"));
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git("init", "-q", "-b", "main");
	git("add", "a.txt");
	git("commit", "-qm", "base");
	gh = stubGhScript(dir, catFixture(path.join(dir, "comments.json"))).gh;
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Serve `bodies` as the issue's comments, oldest first. */
const serve = (...bodies: string[]) =>
	fs.writeFileSync(
		path.join(dir, "comments.json"),
		JSON.stringify([bodies.map((body, i) => ({ body, html_url: `u${i}` }))]),
	);

const run = (args = ["31"]) =>
	runInProcess(SCRIPT, args, {
		cwd: dir,
		env: {
			...process.env,
			WFC_GH: gh,
			CLAUDE_PROJECT_DIR: dir,
			WFC_REPO_ROOT: dir,
			CLAUDE_CODE_SESSION_ID: "abcdef123456",
		},
	});

/** A real `git diff` of a.txt from "one" to "two", its `index` line and all,
 * which `--3way` needs to merge rather than fail outright. */
const realDiff = () => {
	fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
	const diff = git("diff");
	git("checkout", "-q", "a.txt");
	return `\`\`\`diff\n${diff}\n\`\`\``;
};
const handOff = (base: string, done: string, diff = realDiff()) =>
	`❓ **Q1** Which?\n\n**Hand-off:**\n- Base: ${base}\n- Done: ${done}\n- Left: finish it\n- Blocked on: Q1\n- Uncommitted: a.txt\n<details>\n\n${diff}\n\n</details>`;

describe("read-hand-off.js", () => {
	it("says so where no comment carries a block", () => {
		serve("a plain comment");
		const r = run();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No hand-off on #31: start from the ticket.");
	});

	it("passes over prose quoting the header, newer than the block or alone", () => {
		serve("A `**Hand-off:**` block carries Base and Done.");
		expect(run().stdout).toContain("No well-formed hand-off on #31");
	});

	it("exits 1 where the comments cannot be read, 2 on a usage error", () => {
		gh = stubGhScript(dir, GH_FAILING_SCRIPT).gh;
		expect(run().status).toBe(1);
		expect(run(["x"]).status).toBe(2);
	});

	it("passes the newest well-formed record whose Base, Done and diff all check, writing the diff", () => {
		const head = git("rev-parse", "HEAD");
		serve(
			handOff("0000000", "none"),
			handOff(head, `${head.slice(0, 7)} base`),
			"Picking this up from its `**Hand-off:**` block.",
		);
		const out = run().stdout;
		expect(out).toContain("Usable: every check passed.");
		expect(out).not.toContain("Base: 0000000");
		const file = path.join(dir, ".claude", "tmp", "hand-off-31-abcdef12.diff");
		expect(fs.readFileSync(file, "utf8")).toContain("+two");
		expect(out).toContain(`git apply --3way ${file}`);
	});

	it("passes a diff already in the working tree, as the refill loop's hand-off leaves it (#2659)", () => {
		const head = git("rev-parse", "HEAD");
		serve(handOff(head, "none"));
		fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
		const out = run().stdout;
		expect(out).toContain(
			"Usable: every check passed. Its diff is already in the working tree",
		);
	});

	it("reads a Base off HEAD's line, a Done off main and a conflicting diff as reference only", () => {
		const diff = realDiff();
		git("checkout", "-qb", "side");
		fs.writeFileSync(path.join(dir, "a.txt"), "side\n");
		git("commit", "-qam", "side");
		const side = git("rev-parse", "HEAD");
		git("checkout", "-q", "main");
		fs.writeFileSync(path.join(dir, "a.txt"), "three\n");
		git("commit", "-qam", "moved");
		serve(handOff(side, `${side} side`, diff));
		const out = run().stdout;
		expect(out).toContain(`Base ${side} is not an ancestor of HEAD`);
		expect(out).toContain(`Done sha ${side} is not on main`);
		expect(out).toContain("the diff does not apply cleanly");
		expect(out).toContain("Reference only:");
		expect(out).toContain("Say so on #31");
	});
});
