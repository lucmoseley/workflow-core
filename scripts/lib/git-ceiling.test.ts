/*
 * git-ceiling.test.ts — pins the ceiling every --touched-by git read runs
 * under, and the notice naming a slow run's next read (#2210).
 *
 * The ceiling and the notice are driven by an injected clock; only the kill
 * case crosses the real clock, since the kill is execFileSync's own timeout.
 * Breaking it lets the census step resolve-ticket.js names hang a closing
 * session silently again.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Required, not imported: readCommittedBytes tests for this module's own
// CeilingPassed, which an ESM import of it would load a second copy of.
const require = createRequire(import.meta.url);
const { readCommittedBytes } = require("./census-digest.js");
const { CeilingPassed, buildGitCeiling } = require("./git-ceiling.js");
const { TOUCHED_BY_CEILING_MS } = require("./touched-by.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ceiling-"));
	execFileSync("git", ["init", "-q", dir]);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const clock = () => {
	let t = 1_000_000;
	return {
		now: () => t,
		at: (ms: number) => {
			t = 1_000_000 + ms;
		},
	};
};

const run = (ceiling: import("./git-ceiling.js").GitCeiling) =>
	ceiling.git(
		["-C", dir, "rev-parse", "--git-dir"],
		{ encoding: "utf8" },
		"git rev-parse",
	);

describe("buildGitCeiling (#2210)", () => {
	it("runs a read a second short of --touched-by's ceiling, and refuses one at it", () => {
		const c = clock();
		const ceiling = buildGitCeiling({
			label: "--touched-by",
			ms: TOUCHED_BY_CEILING_MS,
			now: c.now,
			say: () => undefined,
		});
		// A second short, not a millisecond: what is left is the read's real timeout.
		c.at(TOUCHED_BY_CEILING_MS - 1000);
		expect(run(ceiling)).toMatch(/\.git/);
		c.at(TOUCHED_BY_CEILING_MS);
		expect(() => run(ceiling)).toThrow(CeilingPassed);
		expect(() => run(ceiling)).toThrow(
			"--touched-by passed its 30s ceiling before git rev-parse",
		);
	});

	it("names each read it waits on once the run has used 5s, and none before", () => {
		const c = clock();
		const said: string[] = [];
		const ceiling = buildGitCeiling({
			label: "--touched-by",
			ms: TOUCHED_BY_CEILING_MS,
			now: c.now,
			say: (line: string) => said.push(line),
		});
		c.at(4999);
		run(ceiling);
		expect(said).toEqual([]);
		c.at(5000);
		run(ceiling);
		expect(said).toEqual([
			"--touched-by: waiting on git rev-parse (5s of 30s used)",
		]);
	});

	it("kills a read that outlives what is left of the ceiling, naming it", () => {
		// Crosses the real clock: the kill is execFileSync's own timeout, which
		// no injected clock reaches.
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nsleep 30\n", {
			mode: 0o755,
		});
		const c = clock();
		const ceiling = buildGitCeiling({
			label: "--touched-by",
			ms: 300,
			now: c.now,
		});
		expect(() =>
			ceiling.git(
				["diff-tree", "HEAD"],
				{ env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
				"git diff-tree HEAD",
			),
		).toThrow(
			"--touched-by passed its 0.3s ceiling waiting on git diff-tree HEAD, and killed it",
		);
	});

	it("lets readCommittedBytes throw a passed ceiling rather than read it as an absent path", () => {
		fs.writeFileSync(path.join(dir, "a.txt"), "on disk\n");
		const c = clock();
		const ceiling = buildGitCeiling({
			label: "--touched-by",
			ms: 10,
			now: c.now,
		});
		c.at(10);
		expect(() => readCommittedBytes(dir, "a.txt", "HEAD", { ceiling })).toThrow(
			CeilingPassed,
		);
		expect(readCommittedBytes(dir, "a.txt", "HEAD")?.toString()).toBe(
			"on disk\n",
		);
	});
});
