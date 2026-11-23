import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, emptyRepoTemplate } from "./git-fixture";

const require = createRequire(import.meta.url);
const { readCommittedBytes } = require("./census-digest.js");
const { CeilingPassed, buildGitCeiling } = require("./git-ceiling.js");
const { TOUCHED_BY_CEILING_MS } = require("./touched-by.js");

const emptyRepo = defineTemplate(emptyRepoTemplate);

let dir: string;

beforeEach(() => {
	dir = emptyRepo.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "git-ceiling-")),
	);
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
