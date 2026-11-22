// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LIB = __dirname;
const families = fs
	.readdirSync(LIB)
	.filter((f) => /^arbiter-.*\.js$/.test(f) && f !== "arbiter-store.js")
	.sort();

const keysAlone = (file: string) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(JSON.stringify(Object.keys(require(${JSON.stringify(path.join(LIB, file))})).sort()))`,
			],
			{ encoding: "utf8" },
		),
	) as string[];

const keysAfterFacade = (file: string) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				"-e",
				`require(${JSON.stringify(path.join(LIB, "arbiter-store.js"))});
				 process.stdout.write(JSON.stringify(Object.keys(require(${JSON.stringify(path.join(LIB, file))})).sort()))`,
			],
			{ encoding: "utf8" },
		),
	) as string[];

describe("every family module loads as the entry point", () => {
	it("finds all sixteen — the thirteen families, arbiter-proc.js, arbiter-wait.js and arbiter-tool-record.js", () => {
		expect(families.length).toBe(16);
	});

	for (const file of families) {
		it(`${file} hands back the same exports either way`, () => {
			const alone = keysAlone(file);
			expect(alone).toEqual(keysAfterFacade(file));
			if (file !== "arbiter-records.js")
				expect(alone.length).toBeGreaterThan(0);
		});
	}
});

describe("the family modules' require graph", () => {
	const readSource = (f: string) => fs.readFileSync(path.join(LIB, f), "utf8");
	const siblings = (f: string) =>
		[...readSource(f).matchAll(/require\("\.\/(arbiter-[\w-]+\.js)"\)/g)].map(
			(m) => m[1],
		);

	it("holds no cycle", () => {
		const done = new Set<string>();
		const cycles: string[] = [];
		const visit = (f: string, trail: string[]) => {
			if (trail.includes(f)) {
				cycles.push([...trail.slice(trail.indexOf(f)), f].join(" → "));
				return;
			}
			if (done.has(f)) return;
			for (const to of siblings(f)) visit(to, [...trail, f]);
			done.add(f);
		};
		for (const f of families) visit(f, []);
		expect(cycles).toEqual([]);
	});

	it("leaves no scripts/*.js filling its exports object in place, as base §N asks", () => {
		const grep = spawnSync(
			"git",
			["grep", "-lE", "^exports\\.[A-Za-z_$]+ =", "--", "scripts/*.js"],
			{ cwd: path.join(LIB, "../.."), encoding: "utf8" },
		);
		expect({ status: grep.status, files: grep.stdout.trim() }).toEqual({
			status: 1,
			files: "",
		});
	});
});

const crashProbe = (entry: string) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				"-e",
				`require(${JSON.stringify(path.join(LIB, entry))});
				 process.stdout.write(JSON.stringify({
				   check: Object.keys(require.cache).filter((k) => /[\\/]lib[\\/]check.js$/.test(k)).length,
				   uncaught: process.listenerCount("uncaughtException"),
				   unhandled: process.listenerCount("unhandledRejection"),
				 }))`,
			],
			{ encoding: "utf8" },
		),
	) as { check: number; uncaught: number; unhandled: number };

describe("check.js never enters the arbiter's require graph", () => {
	it("sees check.js and its handlers where they ARE loaded", () => {
		expect(crashProbe("check.js")).toEqual({
			check: 1,
			uncaught: 1,
			unhandled: 1,
		});
	});

	it("loads the whole facade with neither", () => {
		expect(crashProbe("arbiter-store.js")).toEqual({
			check: 0,
			uncaught: 0,
			unhandled: 0,
		});
	});
});

describe("nothing the hook entry pulls reaches check.js either", () => {
	const scriptsDir = path.dirname(LIB);
	const readGraph = (entry: string) => {
		const seen = new Set<string>();
		const queue = [entry];
		while (queue.length > 0) {
			const file = queue.pop() as string;
			if (seen.has(file) || !fs.existsSync(file)) continue;
			seen.add(file);
			for (const m of fs
				.readFileSync(file, "utf8")
				.matchAll(/require\("(\.[^"]+)"\)/g)) {
				const to = path.resolve(path.dirname(file), m[1]);
				queue.push(to.endsWith(".js") ? to : `${to}.js`);
			}
		}
		return seen;
	};

	it("reaches lib/check.js from a checker, and never from the arbiter", () => {
		expect(readGraph(path.join(scriptsDir, "check-issue-labels.js"))).toContain(
			path.join(LIB, "check.js"),
		);
		expect(
			readGraph(path.join(scriptsDir, "session-arbiter.js")),
		).not.toContain(path.join(LIB, "check.js"));
	});
});
