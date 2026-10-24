// git-spawn census, instrument 2 of 2 — the node-API wrapper, and how to
// combine it with the PATH shim (git-path-shim.sh, this directory).
//
// Built for mantahostels#2181 from the git-spawn-census note (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/git-spawn-census.md)'s description
// (§Appended 30 August 2026 (mantahostels#2114)).
//
// PURPOSE: tell a subject-under-test's own git spawn (guard-side) apart from
// a test file's fixture-building git spawn (test-side) where both are direct
// children of the same vitest worker process — invisible to a PATH shim's
// pid-chain walk once the subject runs in-process (scripts/lib/run-in-process.js,
// mantahostels#1951). ACTIVE — Symbol.for("wfc.run-in-process.active") on
// globalThis — reads true for exactly the duration of a runInProcess /
// runInProcessAsync call, so a git spawn made while it is true belongs to the
// subject.
//
// LOAD-BEARING DEFECTS (do not drop any of the three re-measuring this):
//   1. RIP_CENSUS_LOG must be an absolute path. runInProcess calls
//      process.chdir() for a fixture's cwd; a relative path then resolves
//      against that temp directory and appendFileSync throws ENOENT, which
//      this file's own try/catch swallows — the symptom is a silent true
//      zero, not an error.
//   2. Flush from afterAll, never process.on("exit"): vitest's forks pool
//      kills a worker once its results are collected, so an exit-time flush
//      loses every file but the one whose worker happened to exit cleanly.
//   3. Buffer in memory and flush once per file, from afterAll. A synchronous
//      appendFileSync per spawn is slow enough on a heavy file to blow the
//      default 5 s test timeout and cascade into runInProcess's own
//      re-entrancy guard misfiring; buffering keeps the per-spawn work off
//      that budget, leaving the afterAll flush itself bound by hookTimeout,
//      not testTimeout. The census config sets neither on its own
//      (mantahostels#2264) — both inherit the repo default, 90_000 ms (vitest.config.ts
//      / scripts/lib/test-ceiling.js), and that is the remaining margin, not
//      a substitute.
//
// GAP #1 — how the current test file is identified: `expect.getState().testPath`,
// read fresh on every spawn rather than cached once. Cheap and always correct
// regardless of whether a given vitest run shares one worker process across
// several files or gives each file its own — no probe of this repo's actual
// `pool: "forks"` behaviour is needed to justify it.
//
// GAP #2 — how a shell-string exec/execSync call is matched as git: isGit()
// below accepts both the array form (execFileSync, spawnSync, execFile,
// spawn — command is exactly "git" or ends "/git") and the shell-string form
// (execSync, exec — the whole command line trimmed is "git" or starts
// "git "). KNOWN GAP, not settled: a leading absolute path
// (`/usr/bin/git …`), a leading env/cd prefix (`cd $d && git …`,
// `env X=1 git …`) or any other shell-string shape that does not start
// literally "git " is unmatched. F8's 780-spawn idle figure for
// check-doc-map.test.ts is therefore an upper bound on the destructured-import
// gap, not a clean decomposition — any shell-string git call this misses
// would also land inside that 780.
//
// PROPERTY-PATCHING node:child_process's exports (what every function below
// does) is INVISIBLE to a test file's own top-level `import { execFileSync }
// from "node:child_process"` — vitest's ESM transform binds that name to a
// value captured at import time, not a live getter onto the CJS exports
// object, so a patch applied in this setup file is never seen through it. A
// top-level destructured import call is not logged by this file at all
// (neither ACTIVE nor idle); the same call written `cp.execFileSync(...)`
// through a namespace import IS logged. Every test file in this suite that
// builds its own git fixtures does so through a top-level destructured
// import (e.g. check-doc-map.test.ts's own `git` helper) — so THIS
// INSTRUMENT ALONE UNDERCOUNTS TEST-SIDE (idle) SPAWNS TO ZERO ON EVERY
// FILE, not just the ones it happens to report as such.
//
// THE FIX IS NOT IN THIS FILE: node:child_process is a core module: there is
// no reliable way from inside it to make an already-transformed static
// import see a later reassignment. Use the PATH shim for the total instead —
// it counts at the OS boundary, so it cannot miss a call shape — and use
// THIS wrapper only for the ACTIVE/idle split of the subset it does see:
//
//   idle (test-side)   = shim's total for the file − this wrapper's ACTIVE count
//   guard-side          = this wrapper's ACTIVE count (ACTIVE spawns are always
//                         reached through a CJS `require("node:child_process")`
//                         inside the subject script, re-executed fresh by
//                         run-in-process.js's per-call module purge — a live
//                         property read, patched correctly)
//
// A wrapper-only re-run of any file will silently repeat the same undercount.

import cp from "node:child_process";
import fs from "node:fs";
import { afterAll, expect } from "vitest";

const ACTIVE = Symbol.for("wfc.run-in-process.active");
const LOG = process.env.RIP_CENSUS_LOG;

let buf: string[] = [];

function isGit(cmd: unknown, argsIsArray: boolean): boolean {
	if (typeof cmd !== "string") return false;
	if (cmd === "git" || cmd.endsWith("/git")) return true;
	if (argsIsArray) return false;
	const trimmed = cmd.trim();
	return trimmed === "git" || trimmed.startsWith("git ");
}

function record(file: string | undefined) {
	if (!LOG || !file) return;
	const active = Boolean((globalThis as Record<symbol, unknown>)[ACTIVE]);
	buf.push(`${file}\t${active ? "ACTIVE" : "idle"}\t${Date.now()}`);
}

function testFile(): string | undefined {
	let file: string | undefined;
	try {
		file = expect.getState().testPath;
	} catch (e) {
		process.stderr.write(
			`git-spawn-wrapper: expect.getState() failed, spawn unattributed: ${e}\n`,
		);
	}
	return file;
}

const SYNC = ["execFileSync", "spawnSync", "execSync"] as const;
// execFile/spawn/exec each carry a util.promisify.custom symbol on the
// exported function so `promisify(execFile)` resolves to `{stdout, stderr}`
// instead of a bare string (scripts/lib/gh.js, scripts/measure-ci-billing.js
// both call promisify on these). A patched function that does not copy the
// symbol silently changes what the census run measures.
const PROMISIFIED = ["execFile", "spawn", "exec"] as const;
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

for (const name of SYNC) {
	const orig = cp[name] as (...a: unknown[]) => unknown;
	// @ts-expect-error -- census-only monkey-patch, narrowed by isGit() above
	cp[name] = function patched(cmd: unknown, ...rest: unknown[]) {
		if (isGit(cmd, Array.isArray(rest[0]))) record(testFile());
		return orig.call(cp, cmd, ...rest);
	};
}

for (const name of PROMISIFIED) {
	const orig = cp[name] as ((...a: unknown[]) => unknown) & {
		[promisifyCustom]?: unknown;
	};
	const patched = function patched(cmd: unknown, ...rest: unknown[]) {
		if (isGit(cmd, Array.isArray(rest[0]))) record(testFile());
		return orig.call(cp, cmd, ...rest);
	};
	if (orig[promisifyCustom]) {
		(patched as typeof orig)[promisifyCustom] = orig[promisifyCustom];
	}
	// @ts-expect-error -- census-only monkey-patch, narrowed by isGit() above
	cp[name] = patched;
}

afterAll(() => {
	if (!LOG || buf.length === 0) return;
	try {
		fs.appendFileSync(LOG, `${buf.join("\n")}\n`);
	} catch (e) {
		// A census that cannot log costs the census, never the suite — but
		// print it: this is the exact failure shape (RIP_CENSUS_LOG's relative
		// path under a chdir'd cwd) mantahostels#2181 was filed to diagnose, and a swallow
		// with nothing printed reads as a true zero rather than a broken run.
		process.stderr.write(`git-spawn-wrapper: flush to ${LOG} failed: ${e}\n`);
	}
	buf = [];
});
