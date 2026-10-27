// @vitest-environment node
/*
 * THE SPLIT RULE, pinned (mantahostels#1795). arbiter-store.js's header states it; nothing
 * else tests it, because every other suite reaches the families through the
 * facade and so only ever loads them in the facade's own require order.
 *
 * WHAT EACH HALF PROVES. The load probe proves a family module is loadable as
 * the entry point at all and hands back its whole export list either way. It
 * does NOT prove immunity to the cycle hole: a replaced exports object is
 * already whole by the time `require` returns, and the hole is only visible to
 * the sibling that captured the object mid-load, at ITS next call. The static
 * assertions below are what guard that — mutation-tested by rewriting
 * arbiter-content.js's tail as `module.exports = {...}`.
 *
 * Loosen a case here and a family loaded in another order — by a new caller or
 * a reordered require — calls a sibling's function through a half-filled
 * exports object and throws, inside the arbiter every Write and Edit claim
 * goes through.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LIB = __dirname;
const families = fs
	.readdirSync(LIB)
	.filter((f) => /^arbiter-.*\.js$/.test(f) && f !== "arbiter-store.js")
	.sort();

/** The export names `file` hands back when it is the FIRST module loaded. */
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

/** The same, with the facade — and so every family — loaded first. */
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
	it("finds all eighteen — the fifteen families, arbiter-proc.js, arbiter-wait.js and arbiter-tool-record.js", () => {
		expect(families.length).toBe(18);
	});

	for (const file of families) {
		it(`${file} hands back the same exports either way`, () => {
			const alone = keysAlone(file);
			expect(alone).toEqual(keysAfterFacade(file));
			// arbiter-records.js is types only, so its empty list is the right answer.
			if (file !== "arbiter-records.js")
				expect(alone.length).toBeGreaterThan(0);
		});
	}
});

describe("the two disciplines that make the cycle safe", () => {
	const readSource = (f: string) => fs.readFileSync(path.join(LIB, f), "utf8");
	const cyclic = families.filter((f) =>
		readSource(f).includes("biome-ignore lint/suspicious/noImportCycles"),
	);

	it("names the three files the header says are in the cycle", () => {
		expect(cyclic).toEqual([
			"arbiter-content.js",
			"arbiter-locks.js",
			"arbiter-observations.js",
		]);
	});

	it("never destructures a sibling family's require", () => {
		const offenders = families.flatMap((f) =>
			[
				...readSource(f).matchAll(
					/const\s*\{[^}]*\}\s*=\s*require\("\.\/(arbiter-[\w-]+)\.js"\)/g,
				),
			]
				.filter((m) => m[1] !== "arbiter-proc")
				.map((m) => `${f} destructures ${m[1]}.js`),
		);
		expect(offenders).toEqual([]);
	});

	it("fills the exports object in place wherever the requires are cyclic", () => {
		for (const f of cyclic)
			expect(readSource(f)).not.toMatch(/^module\.exports = \{/m);
	});

	it("fills it in place nowhere else, as base §N7's cycle exception allows", () => {
		const inPlace = execFileSync(
			"git",
			["grep", "-lE", "^exports\\.[A-Za-z_$]+ =", "--", "scripts/*.js"],
			{ cwd: path.join(LIB, "../.."), encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.map((f) => path.basename(f));
		expect(inPlace).toEqual(cyclic);
	});
});

/*
 * The arbiter runs inside hooks, so nothing it loads may claim the process's
 * exit. lib/check.js's module body installs uncaughtException and
 * unhandledRejection handlers that end in `process.exit` — right for a checker.
 * mantahostels#2512 split lib/gh-limits.js out of lib/gh.js so arbiter-debts.js could share
 * the tracker ceiling without pulling check.js in behind it.
 */
/**
 * What a fresh process holds after loading `entry`: the lib/check.js entries in
 * its require cache, and the crash handlers check.js's module body installs.
 * Both are process-global and neither survives into a vitest worker that has
 * already loaded something, so this can only be asked in a subprocess.
 */
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
		// The positive control. Without it the assertion below passes on a probe
		// that can no longer find check.js at all — a path regex crossing two
		// layers of escaping is exactly the thing that breaks silently.
		expect(crashProbe("gh.js")).toEqual({
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

/*
 * The dynamic probe above can only be run on a module that LOADS quietly, and
 * the arbiter's real hook entry — scripts/session-arbiter.js — runs its CLI and
 * calls process.exit on require. So the entry graph is walked statically
 * instead: lexical, and blind to a dynamic or computed require, but it reaches
 * the modules session-arbiter.js pulls beside the facade, any of which could
 * acquire lib/check.js without the facade ever seeing it.
 */
describe("nothing the hook entry pulls reaches check.js either", () => {
	const scriptsDir = path.dirname(LIB);
	/** Every local module reachable from `entry` by a literal relative require. */
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
		// Positive control first, for the reason the probe above has one.
		expect(readGraph(path.join(scriptsDir, "check-issue-labels.js"))).toContain(
			path.join(LIB, "check.js"),
		);
		expect(
			readGraph(path.join(scriptsDir, "session-arbiter.js")),
		).not.toContain(path.join(LIB, "check.js"));
	});
});
