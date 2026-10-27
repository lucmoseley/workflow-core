/*
 * The fail-open log's path and a reader of it, for any test of a script that
 * writes a fail-open record (mantahostels#147). A disarmed guard looks exactly
 * like a guard finding nothing wrong, so each fail-open leaves a line in the
 * log check-guard-errors.js reads.
 */

import fs from "node:fs";
import { createRequire } from "node:module";

// The reader's own derivation, not a copy of it. lib/guard-log.sh's header makes
// this the invariant that matters — "WHERE IT LANDS must equal session-arbiter.js's
// errorLog() byte for byte … drift puts every fail-open in a directory
// check-guard-errors.js never reads" — and a second spelling of the rule here
// would keep these suites green through exactly that drift.
const { errorLog } = createRequire(import.meta.url)("./lib/arbiter-store.js");

/**
 * errorLog() reads the environment, and these cases hand the guard its config and
 * project through the CHILD's environment alone — so it is set here for the length
 * of the call and put back. Synchronous throughout, and Vitest runs a file's tests
 * in sequence, so nothing observes the window.
 */
const asChild = <T>(config: string, project: string, fn: () => T): T => {
	const saved = [
		process.env.CLAUDE_CONFIG_DIR,
		process.env.CLAUDE_PROJECT_DIR,
	] as const;
	process.env.CLAUDE_CONFIG_DIR = config;
	process.env.CLAUDE_PROJECT_DIR = project;
	try {
		return fn();
	} finally {
		for (const [k, v] of [
			["CLAUDE_CONFIG_DIR", saved[0]],
			["CLAUDE_PROJECT_DIR", saved[1]],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
};

/**
 * Where check-guard-errors.js will look, so a test never spells the derivation
 * out again.
 */
export const failOpenLogPath = (config: string, project: string): string =>
	asChild(config, project, () => errorLog());

/**
 * Everything written to that log so far, or "" where nothing has been. One
 * project's log by errorLog()'s own derivation, where lib/guard-errors-log.ts
 * globs every project's and so cannot catch the derivation drifting.
 */
export const readFailOpenLog = (config: string, project: string): string => {
	const at = failOpenLogPath(config, project);
	return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
};

/** That log's records, as [time, guard, reason, …] each. */
export const readFailOpenRecords = (
	config: string,
	project: string,
): string[][] =>
	readFailOpenLog(config, project)
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
