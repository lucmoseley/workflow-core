/*
 * The fail-open record tests for scripts/lib/guard-log.sh, shared by every guard
 * that sources it through lib/guard-parse.sh (mantahostels#147).
 *
 * Every guard here fails open by house rule (mantahostels#103 §6): a missing jq, a payload
 * it cannot parse, a library it cannot read all ALLOW the action rather than
 * wedge 10-12 concurrent sessions. That makes a disarmed guard look exactly like
 * a guard finding nothing wrong, so each fail-open leaves a line in the log
 * check-guard-errors.js reads.
 *
 * What is guard-specific — which payload it judges, which field it reads —
 * arrives through the fixture.
 *
 * guard-file-claim.sh has its own copy of these cases, in its own test file: it
 * takes lib/guard-log.sh directly and none of lib/guard-parse.sh, so the load
 * failure this fixture provokes cannot happen to it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourcedLibs } from "./guard-parse-fixture";

// The reader's own derivation, not a copy of it. lib/guard-log.sh's header makes
// this the invariant that matters — "WHERE IT LANDS must equal session-arbiter.js's
// errorLog() byte for byte … drift puts every fail-open in a directory
// check-guard-errors.js never reads" — and a second spelling of the rule here
// would keep these suites green through exactly that drift.
const { errorLog } = createRequire(import.meta.url)("./lib/arbiter-store.js");

export interface GuardLogFixture {
	/** The real guard under test. */
	guard: string;
	/** A payload the guard DENIES — the control that it is still armed. */
	denied: unknown;
	/**
	 * What an armed verdict on `denied` looks like on stdout, where the guard
	 * acts by some envelope other than a deny: guard-dispatch-rewrite.sh never
	 * denies, and rewrites instead (#515). Defaults to a deny.
	 */
	armed?: RegExp;
	/** The same payload with the field the guard reads emptied away. */
	fieldless: unknown;
	/** What the guard says about that payload. */
	fieldlessMatch: RegExp;
	/** A payload the guard judges and passes: an ordinary, legitimate action. */
	benign: unknown;
	/**
	 * Files under scripts/lib/ the guard reaches for by some route other than
	 * `source`, and so `sourcedLibs` cannot see. guard-sweep-fire.sh runs
	 * `node lib/sweep-budget.js`; without this the detached copies below
	 * lose their counter, the guard fails open exactly as designed, and the
	 * control case reads as a broken guard.
	 */
	extraLibs?: string[];
	/*
	 * Read at test time, not at describe time: the temp dirs are built in
	 * beforeEach, so these paths do not exist when the fixture is called.
	 */
	ctx: () => {
		/** A temp root the detached copies are written into. */
		dir: string;
		/** CLAUDE_CONFIG_DIR: where the log lands. Never the founder's real one. */
		config: string;
		/** CLAUDE_PROJECT_DIR: the repo the guard judges against. */
		project: string;
		/** Guard-specific environment on top of those two. */
		env?: Record<string, string>;
	};
}

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

/** The merged environment's defined entries alone — what a child is handed. */
const definedEnv = (
	merged: Record<string, string | undefined>,
): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(merged)) {
		if (v !== undefined) env[k] = v;
	}
	return env;
};

/**
 * Where check-guard-errors.js will look, for the guard-specific cases that live
 * outside describeFailOpenLog and would otherwise spell the derivation out again.
 */
export const failOpenLogPath = (config: string, project: string): string =>
	asChild(config, project, () => errorLog());

export const describeFailOpenLog = ({
	guard: guardPath,
	denied,
	armed = /"permissionDecision"\s*:\s*"deny"/,
	fieldless,
	fieldlessMatch,
	benign,
	extraLibs = [],
	ctx,
}: GuardLogFixture) => {
	describe("the fail-open record", () => {
		const guardName = path.basename(guardPath);

		/** Where check-guard-errors.js will look for it. */
		const logPath = (): string =>
			asChild(ctx().config, ctx().project, () => errorLog());

		/** The log, parsed exactly as check-guard-errors.js parses it. */
		const faults = () => {
			const at = logPath();
			if (!fs.existsSync(at)) return [];
			return fs
				.readFileSync(at, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [when, where, what] = line.split("\t");
					return { when, where, what };
				});
		};

		const run = (
			payload: unknown,
			opts: { guard?: string; env?: Record<string, string | undefined> } = {},
		) => {
			const env = definedEnv({
				...process.env,
				CLAUDE_CONFIG_DIR: ctx().config,
				CLAUDE_PROJECT_DIR: ctx().project,
				...(ctx().env ?? {}),
				...(opts.env ?? {}),
			});
			const r = spawnSync(opts.guard ?? guardPath, [], {
				cwd: ctx().project,
				encoding: "utf8",
				input: typeof payload === "string" ? payload : JSON.stringify(payload),
				env: env as NodeJS.ProcessEnv,
				// A guess, never measured: a guard past it is hung, not slow.
				timeout: 10_000,
			});
			if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
			return r;
		};

		const denies = (r: ReturnType<typeof run>) => armed.test(r.stdout ?? "");

		/** A copy of the guard whose libraries can be removed one at a time. */
		const detach = (drop: string[] = []) => {
			const at = fs.mkdtempSync(path.join(ctx().dir, "detached-"));
			fs.mkdirSync(path.join(at, "lib"));
			const guard = path.join(at, guardName);
			fs.copyFileSync(guardPath, guard);
			fs.chmodSync(guard, 0o755);
			for (const lib of [
				"guard-log.sh",
				...sourcedLibs(guardPath),
				...extraLibs,
			]) {
				if (drop.includes(lib)) continue;
				fs.copyFileSync(
					path.resolve(__dirname, "lib", lib),
					path.join(at, "lib", lib),
				);
			}
			return guard;
		};

		/**
		 * A PATH holding everything the guard reaches for except one tool. Nothing
		 * else provokes the missing-binary branches, which are the fail-opens most
		 * worth recording — and the ones under which the record itself is hardest to
		 * write.
		 */
		const pathWithout = (missing: string) => {
			const at = fs.mkdtempSync(path.join(ctx().dir, `bin-no-${missing}-`));
			for (const tool of [
				// bash first: the shebang is `#!/usr/bin/env bash`, so without it the
				// guard never starts and the case under test never runs.
				"bash",
				"cat",
				"date",
				"mkdir",
				"dirname",
				"git",
				"realpath",
				"sed",
				"timeout",
				"jq",
			]) {
				if (tool === missing) continue;
				try {
					const real = execFileSync("bash", ["-c", `command -v ${tool}`], {
						encoding: "utf8",
					}).trim();
					if (real) fs.symlinkSync(real, path.join(at, tool));
				} catch {
					// Absent from this machine too, which is the state the test wants.
				}
			}
			return at;
		};

		/*
		 * A guard that CRASHED also emits no verdict, so "no deny" alone would pass
		 * whether it allowed deliberately or died on line 1. A clean exit 0, silent
		 * stderr and a line in the log are what separate a recorded fail-open from
		 * a guard that simply fell over.
		 */
		const expectLogged = (r: ReturnType<typeof run>, match: RegExp) => {
			expect(r.status).toBe(0);
			expect(r.stderr ?? "").toBe("");
			expect(denies(r)).toBe(false);
			const logged = faults();
			expect(logged).toHaveLength(1);
			const [entry] = logged;
			expect(entry).toMatchObject({
				where: guardName,
				what: expect.stringMatching(match),
			});
		};

		it("the detached copy still denies — the control for the cases below", () => {
			expect(denies(run(denied, { guard: detach() }))).toBe(true);
			expect(faults()).toEqual([]);
		});

		it("records the shared parser failing to load", () => {
			// The fault that disarms the guard completely, and the reason
			// lib/guard-log.sh is sourced separately: sourced together, this one case
			// could never be recorded.
			const guard = detach(["guard-parse.sh"]);
			expectLogged(run(denied, { guard }), /guard-parse\.sh did not load/);
		});

		it("records a missing jq", () => {
			expectLogged(
				run(denied, { env: { PATH: pathWithout("jq") } }),
				/jq not found/,
			);
		});

		it("records a payload that is not JSON", () => {
			expectLogged(run("not json at all"), /did not parse/);
		});

		it("records a payload whose shape no longer carries what it reads", () => {
			// Every matched payload carries that field today, so an empty extraction
			// means the payload's shape changed under the guard — the exact defect
			// that let NotebookEdit writes through unchecked.
			expectLogged(run(fieldless), fieldlessMatch);
		});

		it("names itself in field 2, so the guards are told apart in one log", () => {
			// Derived from $0 rather than written by hand, so a renamed guard cannot
			// go on logging under its old name.
			run("not json at all");
			const [first] = faults();
			expect(first).toMatchObject({ where: guardName });
		});

		it("writes three tab-separated fields with a parseable timestamp", () => {
			// check-guard-errors.js splits on \t and calls Date.parse on field 1; a
			// line it cannot parse is reported as torn and its message never shown.
			run("not json at all");
			const line = fs.readFileSync(logPath(), "utf8").trimEnd();
			expect(line.split("\t")).toHaveLength(3);
			expect(
				Number.isFinite(Date.parse(line.slice(0, line.indexOf("\t")))),
			).toBe(true);
		});

		it("says nothing about an ordinary action it judged and passed", () => {
			// Every entry in this log claims something went unprotected, so the
			// normal case must never appear in it.
			const r = run(benign);
			expect(r.status).toBe(0);
			expect(denies(r)).toBe(false);
			expect(faults()).toEqual([]);
		});

		it("treats an empty payload as nothing to check, not a fault", () => {
			expect(run("").status).toBe(0);
			expect(faults()).toEqual([]);
		});

		it("stays armed, and silent, when guard-log.sh itself is missing", () => {
			// The one fail-open nothing can record. The guard must still judge — it
			// loses its voice, not its verdict — and check-guard-errors.js closes
			// this from the other end by probing the library's readability.
			const guard = detach(["guard-log.sh"]);
			expect(denies(run(denied, { guard }))).toBe(true);
			expect(faults()).toEqual([]);
		});
	});
};
