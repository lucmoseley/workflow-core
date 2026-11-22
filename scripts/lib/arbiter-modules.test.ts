// @vitest-environment node

import { execFileSync } from "node:child_process";
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
	it("finds all sixteen arbiter-*.js modules beside the facade", () => {
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
	const requires = (file: string) =>
		[...fs.readFileSync(file, "utf8").matchAll(/require\("(\.[^"]+)"\)/g)]
			.map((m) => path.resolve(path.dirname(file), m[1]))
			.map((to) => (to.endsWith(".js") ? to : `${to}.js`))
			.filter((to) => fs.existsSync(to));

	it("holds no cycle through a family module, by any path", () => {
		const reachesItself = (start: string) => {
			const seen = new Set<string>();
			const queue = requires(start);
			while (queue.length > 0) {
				const file = queue.pop() as string;
				if (file === start) return true;
				if (seen.has(file)) continue;
				seen.add(file);
				queue.push(...requires(file));
			}
			return false;
		};
		expect(families.filter((f) => reachesItself(path.join(LIB, f)))).toEqual(
			[],
		);
	});

	it("ends each family module on one module.exports, as base §N7 asks of an acyclic file", () => {
		const inPlace = families.filter((f) =>
			/^exports\.[A-Za-z_$]+ =/m.test(readSource(f)),
		);
		expect(inPlace).toEqual([]);
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
