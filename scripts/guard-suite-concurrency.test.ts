// @vitest-environment node
/*
 * guard-suite-concurrency.sh refuses a `npm run test` or `npm run test:changed`
 * launched under the resting headroom docs/environment.md §6 measures for a
 * suite, sending it to the queue (#2305), and a `npm run test:watch` short of
 * the rung a watcher holds for as long as it stays open (mantahostels#1927). A
 * FOURTH concurrent suite is refused the same way (#155).
 *
 * The real guard is spawned with a fabricated `/proc/meminfo` at WFC_MEMINFO
 * and a stub `ps` at WFC_PS, so each case sets its own headroom and neighbour
 * count and no verdict depends on the machine running the suite.
 *
 * The guard is a `PreToolUse` Bash hook in self-plugin/hooks/hooks.json: loosen
 * a case here and a fourth suite, or a launch under the measured headroom, runs
 * unrefused or unwarned into the 10 GB cap that earlyoom enforces by killing
 * live sessions.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";
import {
	DRAW_MARGIN_MB,
	EARLYOOM_FLOOR_MB,
	readRunningVitestSuites,
	SUITE_MAX,
	SUITE_RESTING_MB,
	SUITE_WORKERS,
	suiteRungMb,
} from "./lib/admission.js";
import { writePsStub } from "./lib/ps-stub";
import { shellConst } from "./lib/shell-const-testkit";

const GUARD = path.resolve(__dirname, "guard-suite-concurrency.sh");

/**
 * Neighbours enough that THIS launch is the one the cap refuses — `SUITE_MAX`
 * of them, making the launch the fourth (#155).
 *
 * A literal, not read from the guard: every case using it is about the
 * boundary, so moving `SUITE_MAX` should fail these rather than slide them.
 */
const NEIGHBOURS_AT_CAP = 3;

/** MemAvailable far above the three-suite rung (3650 MB), so no memory warning competes with the verdict under test. */
const ROOMY_MB = 20_000;

/**
 * What a launch the cap EXEMPTS reads as at `NEIGHBOURS_AT_CAP` neighbours — an
 * escaped one, a `--queue`, a run naming fewer test files than SUITE_WORKERS. The deny is stood down or
 * never applied, and the guard's over-the-ladder warn is what is left standing
 * (#159). Never "allow": past the last measured rung nothing passes in silence.
 */
const EXEMPTED = "warn";

/**
 * The whole-suite rungs, read out of admission.js rather than copied
 * (mantahostels#2007), which the guard computes from §6's dips (#2558).
 *
 * A case discriminating only inside a band the ladder sets has to move with it,
 * or raising the figure defangs the case instead of failing it. Cases pinning a
 * boundary keep their literals — the literal is the assertion there.
 *
 * Called from inside a case, not resolved at module scope: a module-scope
 * throw takes every case in this file down as an unnamed collection error.
 */
const ladder1 = () => SUITE_RESTING_MB[1];
const ladder2 = () => SUITE_RESTING_MB[2];
const ladder3 = () => SUITE_RESTING_MB[3];
/** Strictly between two rungs, so a case stays in band when either moves. */
const between = (lo: number, hi: number) => Math.floor((lo + hi) / 2);
/** Clears the one-suite floor and misses the two-suite rung. */
const inBand2 = () => between(ladder1(), ladder2());
/** Clears the two-suite rung and misses the three-suite one. */
const inBand3 = () => between(ladder2(), ladder3());

let dir: string;

/** A `/proc/meminfo` reporting `mb` available. */
const meminfo = (mb: number) => {
	const p = path.join(dir, "meminfo");
	fs.writeFileSync(p, `MemAvailable: ${mb * 1024} kB\n`);
	return p;
};

/**
 * The guard's environment, with its fail-open log redirected at `dir`.
 *
 * Since mantahostels#147 the guard records every fail-open under CLAUDE_CONFIG_DIR, and the
 * cases below provoke one deliberately (mantahostels#1452). Residual: lib/guard-log.sh still derives the leaf
 * directory from the inherited CLAUDE_PROJECT_DIR, so the log's exact path is
 * not pinned here and `records()` scans for it.
 */
const env = (extra: Record<string, string>) => ({
	...process.env,
	CLAUDE_CONFIG_DIR: path.join(dir, "config"),
	/* The rule-injection latch lands at CLAUDE_PROJECT_DIR (guard-parse.sh's
	 * _gp_rule_marker, through gr_root). Inherited, two things go wrong at once:
	 * the suite writes `.rule-injected-*-test` into the real checkout, and every
	 * verdict below turns on whether an EARLIER run already consumed the handout
	 * — unlatched it arrives as `additionalContext`, which reads here as a
	 * `warn`, and a clean checkout is never latched (mantahostels#2025). `dir` is per-test,
	 * so each gets a root of its own. */
	CLAUDE_PROJECT_DIR: dir,
	/* The plain-`--full` limb (#181) is off for the same reason, and by its own
	 * seam: it fires on any `--full` this file launches over a rendering read graph,
	 * and its notice reads here as a `warn` exactly as the handout above does.
	 * The verdicts below are about the memory ladder and the suite count, so
	 * `0` keeps the limb out of them; guard-suite-rule-injection.test.ts is
	 * where it is exercised. */
	WFC_READ_GRAPH_RENDERS: "0",
	...extra,
});

/** Every fail-open record the guard wrote under the redirected config dir. */
const records = () => {
	const root = path.join(dir, "config", "projects");
	if (!fs.existsSync(root)) return "";
	return fs
		.readdirSync(root)
		.map((leaf) => {
			const log = path.join(root, leaf, "guard-errors.log");
			return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
		})
		.join("");
};

/** Every stand-down the guard recorded under this test's own root. */
const standdowns = () => {
	const log = path.join(
		dir,
		".claude",
		"tmp",
		"markers",
		".suite-standdowns.jsonl",
	);
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l));
};

/** A stub `ps` whose every line is `args`, one per process. */
const psLines = (args: string[]) =>
	writePsStub(dir, args, {
		name: `ps-lines-${args.length}-${args.join("").length}`,
	});

/** The guard's spawn result for `command` against an arbitrary `ps` stub. */
const withPs = (command: string, mb: number, ps: string) =>
	spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: env({
			WFC_MEMINFO: meminfo(mb),
			WFC_PS: ps,
			WFC_SUITE_CONCURRENT: "1",
		}),
	});

/**
 * A stub `ps` reporting `n` one-shot suites plus `watchers` open watchers
 * (mantahostels#1906; the watcher arm is mantahostels#1927).
 *
 * EVERY CASE PINS `ps` at WFC_PS, through this stub or another. The guard
 * shells out to the real `ps` otherwise, so the resting-floor cases below
 * would pass or fail on how many neighbours happen to be running.
 */
const psWith = (n: number, watchers = 0) =>
	writePsStub(
		dir,
		[
			"bash -l",
			// Two lines that mention the words but are not runners, present in
			// every stub: they pin that the count is anchored on the `.bin/` path.
			"sh -c NODE_OPTIONS=--max-old-space-size=2048 vitest run",
			"node /r/node_modules/.bin/vitest-not-vitest run",
			...Array.from(
				{ length: n },
				() => "node /r/node_modules/.bin/vitest run",
			),
			// An open watcher: `npm run test:watch` is `vitest` with no subcommand,
			// so its runner line ends at the binary (mantahostels#1927).
			...Array.from(
				{ length: watchers },
				() => "node /r/node_modules/.bin/vitest",
			),
		],
		{ name: `ps-${n}-${watchers}` },
	);

/** Runs `command` with MemAvailable unreadable — the guard's fail-open branch. */
const failOpen = (command: string) =>
	spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: env({
			WFC_MEMINFO: path.join(dir, "does-not-exist"),
			WFC_PS: psWith(0),
		}),
	});

/** Sets the escape (`WFC_SUITE_CONCURRENT=1`), standing both denies down, so the ladder's warn is tested with neighbours running. */
const run = (command: string, mb: number, suites = 0, watchers = 0) =>
	spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: env({
			WFC_MEMINFO: meminfo(mb),
			WFC_PS: psWith(suites, watchers),
			WFC_SUITE_CONCURRENT: "1",
		}),
	});

/**
 * The same launch with the count cap live.
 *
 * The escape is CLEARED EXPLICITLY, not merely left unset: `env` spreads
 * `process.env`, so a run launched from a shell that exported
 * `WFC_SUITE_CONCURRENT` — a benchmark waiting for a clear machine did
 * exactly this — inherits it and every case below silently passes against a
 * guard that stood itself down. The guard reads `-z`, so "" is unset to it.
 */
const gated = (command: string, mb: number, suites = 0, watchers = 0) =>
	gatedOn(command, mb, psWith(suites, watchers));

/** `gated` against an arbitrary `ps` stub. */
function gatedOn(command: string, mb: number, ps: string) {
	return spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: env({
			WFC_MEMINFO: meminfo(mb),
			WFC_PS: ps,
			WFC_SUITE_CONCURRENT: "",
			// The queue poll's mark, which a session never sets (#2421).
			WFC_SUITE_GATE_LIMB: "",
		}),
	});
}

/*
 * Every deny's first line is what to run instead (#519): the command's own
 * launch with `--queue`, or — where the queue cannot apply — the wait, then
 * that launch.
 */
const expectFixFirst = (command: string, out: string) => {
	const reason: string =
		JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
	const first = reason.split("\n")[0];
	const launch =
		first.match(
			/^(?:Run instead|Run the command with this launch in place of its own): (.+?)(?: --)? --queue$/,
		) ??
		first.match(
			/, then re-run(?: the command with this launch in place of its own)?: (.+) — a watcher never finishes, so no queue takes it\.$/,
		) ??
		first.match(
			/^(?:Run instead|Run the command with this launch in place of its own): (?:[A-Za-z_]\w*=\S* )*node \S*queue-run\.js -- (.+)$/,
		);
	expect(launch, `first line for ${command}: ${first}`).toBeTruthy();
	expect(command, first).toContain(launch?.[1]);
};

/** Like `verdict`, but "deny" is a verdict rather than a thrown error. */
const gatedVerdict = (
	command: string,
	mb: number,
	suites = 0,
	watchers = 0,
) => {
	const r = gated(command, mb, suites, watchers);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) {
		expectFixFirst(command, out);
		return "deny";
	}
	if (/"additionalContext"/.test(out)) return "warn";
	expect(out).toBe("");
	return "allow";
};

const denyReason = (command: string, mb: number, suites = 0, watchers = 0) => {
	const out = gated(command, mb, suites, watchers).stdout ?? "";
	const hook = JSON.parse(out).hookSpecificOutput;
	expect(hook.permissionDecision).toBe("deny");
	return hook.permissionDecisionReason as string;
};

const verdict = (command: string, mb: number, suites = 0, watchers = 0) => {
	const r = run(command, mb, suites, watchers);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out))
		throw new Error("guard denied — it must never deny");
	if (/"additionalContext"/.test(out)) return "warn";
	expect(out).toBe("");
	return "allow";
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-suite-concurrency-"));
	/* Pre-latch the two rules this guard hands out — its closing
	 * `gp_rule suite-tree-dirty memory-figure` — inside this test's own root.
	 *
	 * Redirecting CLAUDE_PROJECT_DIR alone is not enough and is actively worse:
	 * a fresh root is never latched, so the handout fires on EVERY call instead
	 * of once, and it arrives as `additionalContext`, which `verdict` reads as a
	 * `warn`. Latched here, no call below carries one, and the only
	 * `additionalContext` a test can see is the guard's own warning.
	 *
	 * The name is guard-parse.sh's `_gp_rule_marker` format,
	 * `.rule-injected-<id>-<agent>-<sid>`, with `main` for a non-subagent call
	 * and the `session_id` every payload in this file sends. The marker lives
	 * under `gr_markers_dir` (`.claude/tmp/markers`), not the root itself
	 * (mantahostels#3515 F8, issue #2). */
	const markersDir = path.join(dir, ".claude", "tmp", "markers");
	fs.mkdirSync(markersDir, { recursive: true });
	for (const id of ["suite-tree-dirty", "memory-figure"])
		fs.writeFileSync(
			path.join(markersDir, `.rule-injected-${id}-main-test`),
			"",
		);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("warns under the ~2150 MB resting floor (rung 1 measured at #1603)", () => {
	it("warns a `npm run test` under the floor", () => {
		expect(verdict("npm run test", 1000)).toBe("warn");
	});

	it('warns a quoted `npm run "test"` (#1528)', () => {
		expect(verdict(`npm run "test"`, 1000)).toBe("warn");
	});

	it("warns a `npm run build`", () => {
		expect(verdict("npm run build", 1000)).toBe("warn");
	});

	it("warns a bare `next build`", () => {
		expect(verdict("next build", 1000)).toBe("warn");
	});

	it("names the offending command in the warning", () => {
		const r = run("npm run test", 1000);
		expect(r.stdout).toMatch(/npm run test/);
		expect(r.stdout).toMatch(/1000 MB/);
	});

	/* The floor's derivation is on `rung_mb` in guard-suite-concurrency.sh
	 * (#1603). */
	it("warns at one MB under the floor and allows at the floor", () => {
		expect(verdict("npm run test", 2149)).toBe("warn");
		expect(verdict("npm run test", 2150)).toBe("allow");
	});
});

describe("the memory ladder queues a launch under its rung (#2305)", () => {
	it("denies a `npm run test` under the floor, line one its `--queue` form", () => {
		const reason = denyReason("npm run test", 1000);
		expect(reason.split("\n")[0]).toBe("Run instead: npm run test -- --queue");
		expect(reason).toMatch(
			/MemAvailable is 1000 MB, under the ~2150 MB docs\/environment\.md §6 says a test run needs resting/,
		);
		expect(reason).toMatch(/`--queue` waits for this gate to open/);
		expect(reason).toMatch(/`pretest` reaps finished sessions before the wait/);
	});

	/* The queue's poll alone asks for the limb mark (lib/suite-queue.js); a
	 * session's envelope carries no key Claude Code does not document (#2421). */
	it("keeps a session's deny on either limb to the documented envelope", () => {
		for (const [mb, suites] of [
			[1000, 0],
			[ROOMY_MB, NEIGHBOURS_AT_CAP],
		])
			expect(
				Object.keys(JSON.parse(gated("npm run test", mb, suites).stdout)),
			).toEqual(["hookSpecificOutput"]);
	});

	it("judges the rung the launch would reach", () => {
		expect(denyReason("npm run test", inBand2(), 1)).toMatch(
			/under the ~3250 MB .* as suite 2 of 3/,
		);
		expect(gatedVerdict("npm run test", inBand2(), 0)).toBe("allow");
	});

	it("refuses below the floor and allows at it", () => {
		expect(gatedVerdict("npm run test", 2149)).toBe("deny");
		expect(gatedVerdict("npm run test", 2150)).toBe("allow");
	});

	it("names the reap where the launch has no `pretest` of its own", () => {
		expect(denyReason("node scripts/run-vitest.js", 1000)).toMatch(
			/Reaping finished-but-resident sessions \(`node \S*reap-finished-sessions\.js`\)/,
		);
	});

	it("sends a non-vitest runner through queue-run.js", () => {
		expect(denyReason("pytest", 1000)).toMatch(/`queue-run\.js` waits/);
	});

	it("tells a watcher to free memory first, no queue taking one", () => {
		expect(denyReason("npm run test:watch", 1000).split("\n")[0]).toMatch(
			/^Reap finished sessions .* or wait for MemAvailable to reach ~2150 MB, then re-run: npm run test:watch/,
		);
	});

	it.each([
		[
			"a `--queue` launch, which waits for this gate",
			"npm run test -- --queue",
		],
		["a build, off the ladder", "npm run build"],
	])("only warns %s", (_what, command) => {
		expect(gatedVerdict(command, 1000)).toBe("warn");
	});

	it("records an escaped launch as a memory stand-down", () => {
		expect(gatedVerdict("WFC_SUITE_CONCURRENT=1 npm run test", 1000, 0)).toBe(
			"warn",
		);
		expect(standdowns()).toHaveLength(1);
		expect(standdowns()[0]).toMatchObject({
			limb: "memory",
			running: 0,
			nth: 1,
		});
	});

	it("records an unread `ps` as no suite running", () => {
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test" },
			}),
			env: env({
				WFC_MEMINFO: meminfo(1000),
				WFC_PS: path.join(dir, "does-not-exist"),
				WFC_SUITE_CONCURRENT: "1",
			}),
		});
		expect(r.stdout).toMatch(/"additionalContext"/);
		expect(standdowns()[0]).toMatchObject({ limb: "memory", running: 0 });
	});
});

describe("allows above the floor and anything not a test/build", () => {
	it("allows a `npm run test` with headroom to spare", () => {
		expect(verdict("npm run test", 4000)).toBe("allow");
	});

	it("allows an unrelated command regardless of headroom", () => {
		expect(verdict("git status", 100)).toBe("allow");
	});

	it("allows `npm run test:py` — the ladder was measured against vitest, not pytest", () => {
		expect(verdict("npm run test:py", 100)).toBe("allow");
	});

	it("allows a command that only mentions the words, never runs them", () => {
		expect(verdict('echo "reminder: npm run test later"', 100)).toBe("allow");
	});
});

describe("judges a narrowed run on the full-suite ladder (mantahostels#1906, mantahostels#3209)", () => {
	it("warns under the one-suite floor", () => {
		expect(verdict("npm run test:changed", 1000)).toBe("warn");
	});

	it("allows above it", () => {
		expect(verdict("npm run test:changed", 4000)).toBe("allow");
	});

	it("takes the rung the running count reaches, as a full run does", () => {
		expect(run("npm run test:changed", inBand2(), 1).stdout).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("warns past the last measured rung", () => {
		expect(verdict("npm run test:changed", 9000, 3)).toBe("warn");
	});

	/* `package.json` runs `test:changed` through `run-vitest.js --changed`,
	 * which prepends `run`, so the runner line carries an argument after it. */
	it("counts a running `--changed` suite as a neighbour", () => {
		const p = writePsStub(
			dir,
			["node /r/node_modules/.bin/vitest run --changed"],
			{ name: "ps-changed" },
		);
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test" },
			}),
			env: env({
				WFC_MEMINFO: meminfo(inBand2()),
				WFC_PS: p,
				WFC_SUITE_CONCURRENT: "1",
			}),
		});
		expect(r.stdout).toMatch(/as suite 2 of 3/);
	});

	/* Telling a run that is already narrowed to narrow itself is a no-op. */
	it("drops the narrow-the-run advice, which it has already taken", () => {
		expect(run("npm run test:changed", 1000).stdout).toMatch(
			/already narrowed as far as it goes/,
		);
		expect(run("npm run test:changed", 1000).stdout).not.toMatch(
			/narrow the run/,
		);
		expect(run("npm run test -- --full", 1000).stdout).toMatch(
			/narrow the run/,
		);
	});

	/* Since mantahostels#3208 a bare `npm run test` IS the narrowed run, so the guard reads
	 * `--full` and nothing else as a whole-suite launch (mantahostels#3209). */
	it("reads a bare `npm run test` as narrowed and `--full` as the whole suite", () => {
		for (const cmd of ["npm run test", "npm test"]) {
			const out = run(cmd, 1000).stdout;
			expect(out).toMatch(/already narrowed as far as it goes/);
			expect(out).not.toMatch(/narrow the run/);
		}
		const full = run("npm run test -- --full", 1000).stdout;
		expect(full).toMatch(/or narrow the run/);
		expect(full).not.toMatch(/already narrowed as far as it goes/);
	});

	it("judges a `--full` launch as a bare `npm run test` was judged", () => {
		const out = run("npm run test -- --full", 1000).stdout;
		expect(out).toMatch(/reaps finished sessions before vitest starts/);
		expect(verdict("npm run test -- --full", 1000)).toBe("warn");
		expect(verdict("npm run test -- --full", 4000)).toBe("allow");
		expect(verdict("npm run test -- --full", 9000, 3)).toBe("warn");
	});

	/* The wrapper form is in SCOPE and its behaviour flipped with the rest, so
	 * the reading has to hold there and on the `npm test` spelling too. */
	it("reads the wrapper form on the same flag", () => {
		for (const cmd of [
			"node scripts/run-vitest.js",
			"npm test -- --full",
			"node scripts/run-vitest.js --full",
		]) {
			const out = run(cmd, 1000).stdout;
			const narrow = /already narrowed as far as it goes/.test(out);
			expect([cmd, narrow]).toEqual([cmd, !cmd.includes("--full")]);
		}
	});

	/* `narrowed` must reach the lever string and nothing else: the deny, the
	 * `--queue` allowance and the stand-down all read `bounded`/`queued`. */
	it("leaves the deny, the queue allowance and the stand-down alone", () => {
		for (const cmd of ["npm run test", "npm run test -- --full"]) {
			expect([cmd, gatedVerdict(cmd, 8000, NEIGHBOURS_AT_CAP)]).toEqual([
				cmd,
				"deny",
			]);
			expect([
				cmd,
				gatedVerdict(`${cmd} --queue`, 8000, NEIGHBOURS_AT_CAP),
			]).toEqual([cmd, EXEMPTED]);
			expect([
				cmd,
				gatedVerdict(`WFC_SUITE_CONCURRENT=1 ${cmd}`, 8000, NEIGHBOURS_AT_CAP),
			]).toEqual([cmd, EXEMPTED]);
		}
	});

	/* The watcher runs everything and takes no `--full`, so the flag's absence
	 * must not read it as narrowed. */
	it("keeps a watcher off the narrowed reading", () => {
		expect(run("npm run test:watch", 1000).stdout).toMatch(/or narrow the run/);
	});

	/* `test:changed` is no longer a change a reader can make from here — a bare
	 * `npm run test` already selects on the diff (mantahostels#3209). */
	it("keeps `test:changed` out of the deny text and out of the watcher text", () => {
		expect(gated("npm run test", 8000, NEIGHBOURS_AT_CAP).stdout).not.toMatch(
			/test:changed/,
		);
		expect(run("npm run test:watch", 99_999, 0).stdout).not.toMatch(
			/test:changed/,
		);
	});

	it("tells both npm suite commands they reap for themselves, so the reading is not the thing to stop on", () => {
		for (const cmd of ["npm run test", "npm run test:changed"]) {
			const out = run(cmd, 1000).stdout;
			expect([cmd, out]).toEqual([
				cmd,
				expect.stringMatching(/does not say what the run will get/),
			]);
			expect(out).not.toMatch(/reap-finished-sessions\.js/);
		}
	});

	it("scopes the bare `npm test` form, which fires the same pretest", () => {
		const out = run("npm test", 1000).stdout;
		expect(out).toMatch(/needs resting/);
		expect(out).toMatch(/does not say what the run will get/);
	});

	/* pretest-reap.js judges the rung for the suite being started (#627), and
	 * `test:changed` has its own pre-script (#633), so both keep the lever on
	 * every rung. */
	it("gives both npm suite commands the reaps-for-itself lever at rungs 2 and 3", () => {
		for (const cmd of ["npm run test", "npm run test:changed"]) {
			for (const [mb, suites] of [
				[inBand2(), 1],
				[inBand3(), 2],
			] as const) {
				const out = run(cmd, mb, suites).stdout;
				expect([cmd, suites, out]).toEqual([
					cmd,
					suites,
					expect.stringMatching(
						new RegExp(
							`as suite ${suites + 1} of 3[\\s\\S]*does not say what the run will get`,
						),
					),
				]);
				expect(out).not.toMatch(/reap-finished-sessions\.js/);
			}
		}
	});

	/* The reap stops FINISHED sessions, so a live neighbour's memory is
	 * reclaimed by nothing — both levers say so. */
	it("says the reap reaches no live neighbour, whichever lever it offers", () => {
		expect(run("npm run test", 1000).stdout).toMatch(/LIVE neighbour/);
		expect(run("npm run build", 1000).stdout).toMatch(/LIVE neighbours/);
	});

	/* The direct wrapper and a build take no pre-script, so the hand reap is
	 * the only lever there. */
	it("hands the reap command to a run that has no pretest of its own", () => {
		for (const cmd of ["node scripts/run-vitest.js", "npm run build"]) {
			const out = run(cmd, 1000).stdout;
			expect(out).toMatch(/node scripts\/reap-finished-sessions\.js/);
			expect(out).not.toMatch(/reaps finished sessions before vitest starts/);
		}
	});
});

describe("counts an open watcher, and prices it as a full rung (mantahostels#1927)", () => {
	it("counts an open watcher as a neighbour", () => {
		expect(verdict("npm run test", inBand2(), 0, 0)).toBe("allow");
		expect(verdict("npm run test", inBand2(), 0, 1)).toBe("warn");
		expect(run("npm run test", inBand2(), 0, 1).stdout).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("counts watchers and one-shot runs into the same rung", () => {
		// Clears the 2-suite rung and misses the 3-suite one, so only a count
		// that adds the watcher to the run can produce this warning. In band
		// deliberately, not on the 2-suite rung itself.
		const mb = inBand3();
		expect(verdict("npm run test", mb, 1, 0)).toBe("allow");
		expect(verdict("npm run test", mb, 1, 1)).toBe("warn");
		expect(run("npm run test", mb, 1, 1).stdout).toMatch(/as suite 3 of 3/);
	});

	it("puts a launch past the cap when watchers make up the count", () => {
		expect(verdict("npm run test", 99_999, 0, 3)).toBe("warn");
		expect(run("npm run test", 99_999, 0, 3).stdout).toMatch(
			/would be suite 4/,
		);
	});

	/* Between the one-suite floor and the 2-suite rung, and nowhere else:
	 * counting the decoy would put this launch on the 2-suite rung and warn, so
	 * the case discriminates. */
	it("does not count a binary whose name merely starts with vitest", () => {
		expect(verdict("npm run test", ladder1(), 0, 0)).toBe("allow");
	});

	/* "Wait for one to finish" is advice a session cannot take when the thing
	 * it would wait on never finishes. */
	it("tells a capped launch to close a watcher rather than wait for it", () => {
		const out = run("npm run test", 99_999, 0, 4).stdout;
		expect(out).toMatch(/Every one of them is an open watcher/);
		expect(out).not.toMatch(/Wait for one to finish/);
	});

	it("still offers the wait where a one-shot run is among the neighbours", () => {
		const out = run("npm run test", 99_999, 2, 2).stdout;
		expect(out).toMatch(
			/Wait for a one-shot run to finish, or close one of the 2/,
		);
	});

	it("keeps the plain wait advice when no watcher is running", () => {
		expect(run("npm run test", 99_999, 4, 0).stdout).toMatch(
			/Wait for one to finish/,
		);
	});
});

describe("tells the two spellings of a one-shot apart (mantahostels#1927)", () => {
	/* `vitest --run` is the form vitest's own docs lead with, and it finishes
	 * like any other one-shot — filing it as a watcher would tell a session to
	 * close a neighbour's run that was about to end on its own. */
	it("counts a `--run` suite as a one-shot, not a watcher", () => {
		const ps = psLines(
			Array.from({ length: 4 }, () => "node /r/node_modules/.bin/vitest --run"),
		);
		const out = withPs("npm run test", 99_999, ps).stdout;
		expect(out).toMatch(/would be suite 5/);
		expect(out).toMatch(/Wait for one to finish/);
		expect(out).not.toMatch(/open watcher/);
	});

	/* vitest's CLI is cac-parsed, so the subcommand need not come first. */
	it("counts a one-shot whose subcommand follows an option", () => {
		const ps = psLines(
			Array.from(
				{ length: 3 },
				() => "node /r/node_modules/.bin/vitest --silent --run",
			),
		);
		const out = withPs("npm run test", 99_999, ps).stdout;
		expect(out).toMatch(/would be suite 4/);
		expect(out).toMatch(/Wait for one to finish/);
		expect(out).not.toMatch(/open watcher/);
	});

	/* The subcommand is looked for anywhere in the tail, so an explicit
	 * `--watch` has to win over it — otherwise a watcher reads as a one-shot
	 * and the session is told to wait for something that never ends. */
	it("keeps a watcher a watcher when `run` appears later in its argv", () => {
		const ps = psLines(
			Array.from(
				{ length: 4 },
				() => "node /r/node_modules/.bin/vitest --watch -t run",
			),
		);
		const out = withPs("npm run test", 99_999, ps).stdout;
		expect(out).toMatch(/Every one of them is an open watcher/);
		expect(out).not.toMatch(/Wait for one to finish/);
	});

	it("still counts it toward the rung", () => {
		const ps = psLines(["node /r/node_modules/.bin/vitest --run --changed"]);
		expect(withPs("npm run test", inBand2(), ps).stdout).toMatch(
			/as suite 2 of 3/,
		);
	});

	/* The class the header declines to fix: the anchor matches a line that only
	 * names the binary, so a `less` on it is counted as a suite. Pinned so the
	 * declined tightening cannot land unnoticed. */
	it("counts a line that merely names the binary, as the header says it does", () => {
		const ps = psLines(
			Array.from({ length: 3 }, () => "less /r/node_modules/.bin/vitest"),
		);
		expect(withPs("npm run test", 99_999, ps).stdout).toMatch(
			/would be suite 4/,
		);
	});

	/* It costs the right rung; only the close-it advice is wrong. */
	it("still misfiles `--watch=false`, as the header says it does", () => {
		const ps = psLines(
			Array.from(
				{ length: 4 },
				() => "node /r/node_modules/.bin/vitest --watch=false",
			),
		);
		expect(withPs("npm run test", 99_999, ps).stdout).toMatch(/open watcher/);
	});
});

describe("counts one line per real suite, never its wrappers (#1127)", () => {
	/* A Bash-tool launch spelled with the path: the tool's shell line, the
	 * `timeout` line and the runner all carry `.bin/vitest`. */
	const runLine = "node_modules/.bin/vitest run";
	const wrapped = [
		`/bin/bash -c source /snap.sh && eval 'timeout 300 ${runLine}'`,
		`timeout 300 ${runLine}`,
		`node ${runLine}`,
	];

	it("reads a wrapped run as one suite", () => {
		expect(withPs("npm run test", inBand2(), psLines(wrapped)).stdout).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("skips every shell and gp_unwrap wrapper as argv[0]", () => {
		const lines = [
			"bash",
			"timeout 300",
			"sh",
			"-bash",
			"dash",
			"/usr/bin/zsh",
			"nohup",
			"setsid",
			"env",
			"time",
			"command",
			"stdbuf",
			"nice",
			"ionice",
			"xargs",
			"sudo",
		].map((w) => `${w} ${runLine}`);
		const ps = psLines([...lines, `node ${runLine}`]);
		expect(withPs("npm run test", inBand2(), ps).stdout).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("skips a wrapped watcher too, so it is not filed as a second watcher", () => {
		const watch = "node_modules/.bin/vitest";
		const ps = psLines(
			Array.from({ length: 3 }, (_, i) => [
				`/bin/bash -c ${watch}`,
				`node /r${i}/${watch}`,
			]).flat(),
		);
		const out = withPs("npm run test", 99_999, ps).stdout;
		expect(out).toMatch(/would be suite 4/);
		expect(out).toMatch(/Every one of them is an open watcher/);
	});
});

describe("never counts a `vitest list` selection probe as a suite (#1180)", () => {
	const runLine = "node /r/node_modules/.bin/vitest run";
	const listLine =
		"node /r/node_modules/.bin/vitest list --changed HEAD --filesOnly";

	it("reads 2 `vitest run` + 1 `vitest list` as 2, neither filed as a watcher", () => {
		const out = withPs(
			"npm run test",
			inBand2(),
			psLines([runLine, runLine, listLine]),
		).stdout;
		expect(out).toMatch(/as suite 3 of 3/);
		expect(out).not.toMatch(/open watcher/);
	});

	it("still counts a run whose `-t` filter is the word list", () => {
		const ps = psLines([runLine, runLine, `${runLine} -t list`]);
		expect(withPs("npm run test", 99_999, ps).stdout).toMatch(
			/would be suite 4/,
		);
	});
});

describe("judges a `npm run test:watch` launch (mantahostels#1927)", () => {
	/* Opening a watcher runs the whole suite immediately, so the launch costs a
	 * full run before it costs anything for holding. */
	it("warns under the one-suite floor, as a full run does, quoting the free memory", () => {
		const out = run("npm run test:watch", 1000).stdout;
		expect(out).toMatch(/MemAvailable is 1000 MB/);
		expect(out).toMatch(/needs resting/);
	});

	it("takes the rung the running count reaches", () => {
		expect(run("npm run test:watch", inBand2(), 1).stdout).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("warns even with headroom to spare, because the rung is held not spent", () => {
		expect(verdict("npm run test:watch", 99_999, 0)).toBe("warn");
		const out = run("npm run test:watch", 99_999, 0).stdout;
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
		expect(out).toMatch(/The command: npm run test:watch/);
		// The command stays LAST, as it is in every other warning here.
		expect(out.trimEnd()).toMatch(/npm run test:watch[^a-z]*$/);
	});

	/* gp_warn exits, so the guard emits at most one message: the watcher's cost
	 * rides as a limb on whichever warning fires rather than as a second one. */
	it("carries the watcher limb on the headroom warning too", () => {
		const out = run("npm run test:watch", 1000).stdout;
		expect(out).toMatch(/MemAvailable is 1000 MB/);
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
		expect(out).toMatch(
			/when you stop iterating\. The command: npm run test:watch/,
		);
		expect(out.match(/additionalContext/g)?.length).toBe(1);
	});

	it("carries it on the over-cap warning too", () => {
		const out = run("npm run test:watch", 99_999, 3).stdout;
		expect(out).toMatch(/would be suite 4/);
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
	});

	/* A watcher has no `pretest`, so it reaches vitest with the finished
	 * sessions still resident. */
	it("hands it the reap command, not the reaps-for-itself lever", () => {
		const out = run("npm run test:watch", 1000).stdout;
		expect(out).toMatch(/node scripts\/reap-finished-sessions\.js/);
		expect(out).not.toMatch(/reaps finished sessions before vitest starts/);
	});
});

describe("carries the watcher limb across a compound command (mantahostels#1978)", () => {
	/* A pre-pass finds the watcher before any segment is judged, so the limb
	 * rides on the build's warning instead of being lost. */
	it("puts the limb on an earlier segment's headroom warning", () => {
		const out = run("npm run build && npm run test:watch", 1000).stdout;
		expect(out).toMatch(/a build run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
		// Still one message, not one per segment.
		expect(out.match(/additionalContext/g)?.length).toBe(1);
	});

	/* The reader is being told to close something the warning's own command
	 * never opens. */
	it("names the watcher's segment, while the warning names its own", () => {
		const out = run("npm run build && npm run test:watch", 1000).stdout;
		expect(out).toMatch(/WATCHER \(`npm run test:watch`\)/);
		expect(out.trimEnd()).toMatch(/The command: npm run build[^a-z]*$/);
	});

	it("does it for an earlier `npm run test` segment too", () => {
		const out = run("npm run test && npm run test:watch", 1000).stdout;
		expect(out).toMatch(/a test run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
	});

	it("leaves the first-person limb on the watcher's own segment", () => {
		const out = run("npm run build && npm run test:watch", 99_999).stdout;
		expect(out).toMatch(/This opens a WATCHER, which runs the whole suite/);
		expect(out).not.toMatch(/Another segment/);
		expect(out.trimEnd()).toMatch(/The command: npm run test:watch[^a-z]*$/);
	});

	/* The pre-pass reads the command's words rather than the script name. */
	it("puts the limb on a bare `npm test` segment", () => {
		const out = run("npm test && npm run test:watch", 1000).stdout;
		expect(out).toMatch(/a test run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
	});

	/* The cost of deciding the limb command-wide: `||` is flattened like any
	 * other separator, so the limb is hung off a segment whose watcher opens
	 * only if the build fails. Pinned as a known wrong answer. */
	it("hangs the limb off a `||` branch that may never run", () => {
		const out = run("npm run build || npm run test:watch", 1000).stdout;
		expect(out).toMatch(/a build run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
	});

	/* The paired negative, so the cases above cannot pass on a limb attached
	 * unconditionally. */
	it("adds no limb to a compound that opens no watcher", () => {
		const out = run("npm run build && npm run test", 1000).stdout;
		expect(out).toMatch(/needs resting/);
		expect(out).not.toMatch(/WATCHER/);
	});
});

describe("fails open", () => {
	it("allows unchecked where MemAvailable cannot be read", () => {
		const r = failOpen("npm run test");
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
	});

	it("records that fail-open under CLAUDE_CONFIG_DIR, not the live log", () => {
		failOpen("npm run test");
		expect(records()).toContain("MemAvailable unreadable");
	});

	/* The paired negative: a run that reads MemAvailable records nothing, so a
	 * guard logging on every call could not pass the case above vacuously. */
	it("records nothing when MemAvailable reads fine, warn or allow", () => {
		expect(verdict("npm run test", 1000)).toBe("warn");
		expect(verdict("npm run test", 4000)).toBe("allow");
		expect(records()).toBe("");
	});
});

describe("counts the suites already running (mantahostels#1906)", () => {
	it("picks the 2-suite rung when one is already going", () => {
		// Clears the 1-suite rung and misses the 2-suite one, so the count is the only thing
		// that can produce a warning here.
		expect(verdict("npm run test", inBand2(), 0)).toBe("allow");
		expect(verdict("npm run test", inBand2(), 1)).toBe("warn");
	});

	it("picks the 3-suite rung when two are already going", () => {
		expect(verdict("npm run test", inBand3(), 1)).toBe("allow");
		expect(verdict("npm run test", inBand3(), 2)).toBe("warn");
	});

	it("warns past the last measured rung however much memory is free, naming the suite count and the rung measured to", () => {
		expect(verdict("npm run test", 99_999, 3)).toBe("warn");
		const r = run("npm run test", 99_999, 3);
		expect(r.stdout).toMatch(/would be suite 4/);
		expect(r.stdout).toMatch(/measured to 3/);
	});

	it("still allows each rung when its own headroom is met", () => {
		expect(verdict("npm run test", 3250, 1)).toBe("allow");
		expect(verdict("npm run test", 3650, 2)).toBe("allow");
	});

	it("names the rung it judged the launch on, and the figure it used", () => {
		expect(run("npm run test", inBand2(), 1).stdout).toMatch(/as suite 2 of 3/);
		// The rung's own value, so a silent edit to a dip or the margin fails here
		// rather than merely shifting which side of the boundary a case lands.
		expect(run("npm run test", inBand2(), 1).stdout).toMatch(/~3250 MB/);
		expect(run("npm run test", inBand3(), 2).stdout).toMatch(/~3650 MB/);
	});

	/* A build is not on the ladder — §6 measured vitest — so it keeps the
	 * one-suite floor and running suites neither raise its rung nor count it. */
	it("leaves a build on the one-suite floor whatever is running", () => {
		expect(verdict("npm run build", inBand2(), 3)).toBe("allow");
		expect(verdict("next build", 1000, 0)).toBe("warn");
	});

	/** The deny's reason with `lines` running, or null where it allowed. */
	const reasonFor = (command: string, lines: string[]) => {
		const out = withPs(
			command,
			ROOMY_MB,
			psLines(["bash -l", ...lines]),
		).stdout;
		if (!/"permissionDecision"\s*:\s*"deny"/.test(out)) return null;
		return JSON.parse(out).hookSpecificOutput
			.permissionDecisionReason as string;
	};

	/* #1733: a build beside a running `next build` is refused with the rule,
	 * whatever the headroom. The literal anchors fail if the print is dropped. */
	describe("a second build", () => {
		const runner = "node /r/node_modules/.bin/next build";
		// The title Next 16 gives its build process (next/dist/cli/next-build.js).
		const titled = "next-build (v16.3.3)";

		it.each([
			"npm run build",
			"next build",
			"npx next build",
			"/r/node_modules/.bin/next build",
			"timeout 600 npm run build",
			"npm --prefix app run build",
			"npm -C app run build",
			"npm --prefix=app --silent run build",
			"npm -w app run build",
			"npm run --silent build",
			// #1778: a valued flag spelled apart from its value, and npm's
			// aliases for `run`.
			"npm --loglevel warn run build",
			"npm --cache /tmp/npm-cache run build",
			"npm --userconfig .npmrc run --if-present build",
			"npm rum build",
			"npm run-s build",
		])(
			"%s beside a running `next build` is denied with the rule",
			(command) => {
				for (const line of [runner, titled]) {
					const why = reasonFor(command, [line]);
					expect(why).toContain("already running");
					expect(why).toContain("NEVER RUN TWO BUILDS");
					expect(why).toContain("[n]ext([- ]build| dev)");
				}
			},
		);

		it.each([
			"npm --prefix build run test",
			"npm -w build run lint",
			"npm --cache build run test",
			"npm --tag build run lint",
			"npm ru build",
		])("%s is not read as a build", (command) => {
			expect(reasonFor(command, [runner])).toBeNull();
		});

		it("counts no `npm run` build, and records why, when lib/npm-options.sh is missing", () => {
			const scripts = path.join(dir, "scripts");
			copyLibs(path.join(scripts, "lib"), sourcedLibs(GUARD), [
				"npm-options.sh",
			]);
			fs.copyFileSync(GUARD, path.join(scripts, "guard-suite-concurrency.sh"));
			const launch = (command: string) =>
				spawnSync(path.join(scripts, "guard-suite-concurrency.sh"), [], {
					encoding: "utf8",
					input: JSON.stringify({
						session_id: "test",
						tool_name: "Bash",
						tool_input: { command },
					}),
					env: env({
						WFC_MEMINFO: meminfo(ROOMY_MB),
						WFC_PS: psLines(["bash -l", runner]),
						WFC_SUITE_CONCURRENT: "1",
					}),
				});
			const r = launch("npm run build");
			expect(r.status).toBe(0);
			expect(r.stdout ?? "").not.toContain('"deny"');
			expect(records()).toContain("lib/npm-options.sh did not load");
			/* A build spelled without npm does not lean on the lib. */
			expect(launch("next build").stdout ?? "").toContain('"deny"');
		});

		it("does not count npm's own `npm run build` and `sh -c next build` lines", () => {
			expect(
				reasonFor("npm run build", ["npm run build", "sh -c next build"]),
			).toBeNull();
		});

		it("does not count a process that only quotes the words", () => {
			expect(
				reasonFor("npm run build", [
					'claude -p "run next build twice"',
					"vim docs/next build notes.md",
				]),
			).toBeNull();
		});

		it("does not count a running test suite as a build", () => {
			expect(
				reasonFor("npm run build", ["node /r/node_modules/.bin/vitest run"]),
			).toBeNull();
		});

		it("does not refuse a test suite beside a running build", () => {
			expect(reasonFor("npm run test", [runner])).toBeNull();
		});
	});

	/* #1759: a dev server beside a running `next dev` is refused with the same
	 * rule. */
	describe("a second dev server", () => {
		const devServer = [
			"node /r/node_modules/.bin/next dev",
			"next-server (v16.3.3)",
		];

		it.each([
			"npm run dev",
			"next dev",
			"npx next dev",
			"/r/node_modules/.bin/next dev --port 3001",
			"npm --prefix app run dev",
			"npm --loglevel warn run dev",
			"nohup npm run dev",
		])("%s beside a running `next dev` is denied with the rule", (command) => {
			const why = reasonFor(command, devServer);
			expect(why).toContain("`next dev` server is already running");
			expect(why).toContain("OR TWO DEV SERVERS");
		});

		it("allows the first dev server", () => {
			expect(reasonFor("npm run dev", [])).toBeNull();
		});

		it("does not count `next start`, npm's own lines or a build as a dev server", () => {
			expect(
				reasonFor("npm run dev", [
					"node /r/node_modules/.bin/next start",
					"next-server (v16.3.3)",
					"npm run dev",
					"sh -c next dev",
					"node /r/node_modules/.bin/next build",
				]),
			).toBeNull();
		});

		it("does not refuse a build beside a running dev server", () => {
			expect(reasonFor("npm run build", devServer)).toBeNull();
		});
	});

	/* Fails open exactly like every other read here: an unreadable `ps` must
	 * leave the headroom check standing, never refuse and never guess a count.
	 *
	 * PAIRED WITH THE CASE BELOW ON PURPOSE. `grep -c` prints 0 and exits 1 on
	 * no match, so an unreadable ps and a genuine zero count can reach the
	 * caller identically; the fail-open record is what separates them. */
	it("falls back to the headroom floor when ps cannot be read, and records it", () => {
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test" },
			}),
			env: env({
				WFC_MEMINFO: meminfo(1000),
				WFC_PS: path.join(dir, "no-such-ps"),
			}),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/1000 MB/);
		expect(records()).toContain("ps unreadable");
	});

	/* The watcher limb is built before the count is read, so an unreadable `ps`
	 * must still deliver it rather than dying on the empty two-field read
	 * (mantahostels#1927). */
	it("still warns a watcher launch when ps cannot be read, recording ps as unreadable", () => {
		const r = withPs(
			"npm run test:watch",
			99_999,
			path.join(dir, "no-such-ps"),
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/This opens a WATCHER/);
		expect(records()).toContain("ps unreadable");
	});

	it("treats a genuine zero count as a successful read, recording nothing", () => {
		expect(verdict("npm run test", 1000, 0)).toBe("warn");
		expect(records()).toBe("");
	});

	/* One `npm run test` puts both an `sh -c ... vitest run` wrapper and the
	 * `.bin/vitest run` runner in ps. */
	it("does not count the npm wrapper line as a second suite", () => {
		// One runner + its wrapper decoy. Counted once, this is suite 2, whose
		// 2-suite rung this misses; counted twice it would read as suite 3.
		expect(run("npm run test", inBand2(), 1).stdout).toMatch(/as suite 2 of 3/);
	});

	/* The workers are per-suite children and would multiply the count by
	 * maxWorkers; only the runner process is one-per-suite. */
	it("counts the runner, not its worker children", () => {
		const p = writePsStub(
			dir,
			[
				"node /r/node_modules/.bin/vitest run",
				...new Array(6).fill(
					"node /r/node_modules/vitest/dist/workers/forks.js",
				),
			],
			{ name: "ps-workers" },
		);
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test" },
			}),
			env: env({
				WFC_MEMINFO: meminfo(inBand2()),
				WFC_PS: p,
				WFC_SUITE_CONCURRENT: "1",
			}),
		});
		// One runner + this launch = suite 2, whose 2-suite rung this misses.
		expect(r.stdout).toMatch(/as suite 2 of 3/);
	});
});

describe("the count cap denies a fourth concurrent suite (#155)", () => {
	it("denies a `npm run test` with the ladder's last rung already taken", () => {
		// exempt (mantahostels#2082): deny reason pinned by the "what the refusal tells the session" describe block —
		// this is the exact case denyReason() below is called with.
		expect(gatedVerdict("npm run test", 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
	});

	it("denies with headroom to spare — this is not a headroom reading", () => {
		expect(gatedVerdict("npm run test", ROOMY_MB, NEIGHBOURS_AT_CAP)).toBe(
			"deny",
		);
	});

	it("allows the first suite", () => {
		expect(gatedVerdict("npm run test", 8000, 0)).toBe("allow");
	});

	it("allows the second and the third, which the bench measured", () => {
		expect(gatedVerdict("npm run test", 8000, 1)).toBe("allow");
		expect(gatedVerdict("npm run test", 8000, 2)).toBe("allow");
	});

	/* Asserts the output `EXEMPTED` only names: with the constant flipped to
	 * "allow", every case using it would still pass. Matching the warning's
	 * text keeps a memory warning from satisfying it. */
	it("draws the over-the-ladder warn where an exempted launch gets through", () => {
		const out =
			gated("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP).stdout ?? "";
		expect(out).not.toMatch(/"deny"/);
		expect(out).toMatch(/This would be suite 4 on a machine measured to 3/);
	});

	it("denies a `npm run test:changed` too", () => {
		expect(gatedVerdict("npm run test:changed", 8000, NEIGHBOURS_AT_CAP)).toBe(
			"deny",
		);
	});

	/* #1528: lib/suite-launch.sh reads a quoted script name as typed. */
	it('denies a quoted `npm run "test"` too, and leaves test:py unjudged', () => {
		expect(gatedVerdict(`npm run "test"`, 8000, NEIGHBOURS_AT_CAP)).toBe(
			"deny",
		);
		expect(gatedVerdict("npm run test:py", 8000, NEIGHBOURS_AT_CAP)).toBe(
			"allow",
		);
	});

	it("counts an open watcher as the suite already running", () => {
		// exempt (mantahostels#2082): deny reason pinned directly by "tells a session waiting on watchers
		// alone that they never finish", same watcher-counts-as-running params.
		expect(gatedVerdict("npm run test", 8000, 0, NEIGHBOURS_AT_CAP)).toBe(
			"deny",
		);
	});

	it("leaves a build alone — it is not on the ladder and not counted", () => {
		expect(gatedVerdict("npm run build", 8000, NEIGHBOURS_AT_CAP)).toBe(
			"allow",
		);
	});

	it("denies a watcher launch when a one-shot is already running", () => {
		expect(gatedVerdict("npm run test:watch", 8000, NEIGHBOURS_AT_CAP)).toBe(
			"deny",
		);
	});

	it("still applies the memory ladder once nothing else is running", () => {
		expect(gatedVerdict("npm run test", 1000, 0)).toBe("deny");
	});

	it("stands down with WFC_SUITE_CONCURRENT set", () => {
		expect(verdict("npm run test", 8000, NEIGHBOURS_AT_CAP)).not.toBe("deny");
	});

	/*
	 * The escape as the deny text spells it: a prefix on the command (mantahostels#2486).
	 *
	 * These use `gated*`, which CLEARS the variable from the guard's own
	 * environment. The guard is a `PreToolUse` hook, so the prefix has not been
	 * applied to anything by the time it runs.
	 */
	it("stands down on the prefix the deny text hands over", () => {
		expect(
			gatedVerdict(
				"WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
	});

	it("takes any non-empty value, the presence being the signal", () => {
		expect(
			gatedVerdict(
				"WFC_SUITE_CONCURRENT=yes npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
	});

	it("denies on an empty assignment, which is the variable unset", () => {
		expect(
			gatedVerdict(
				"WFC_SUITE_CONCURRENT= npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
	});

	/* Read off the leading assignments, so a bare word later in the command is
	 * not one — `--reporter WFC_SUITE_CONCURRENT=1` would be an argument. */
	it("denies a command whose only `WFC_SUITE_CONCURRENT=` is an argument", () => {
		expect(
			gatedVerdict(
				"npm run test -- WFC_SUITE_CONCURRENT=1",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
	});

	/* Command-wide, not per segment. The deny's own unit is the command — a
	 * `PreToolUse` deny stops all of it — so an escape scoped to one segment
	 * would let a compound command be denied AND recorded as a stand-down. */
	it("stands down a compound command where any one launch carries the escape", () => {
		expect(
			gatedVerdict(
				"WFC_SUITE_CONCURRENT=1 npm run test && npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
	});

	it("allows unchecked when ps cannot be read — the gate fails open", () => {
		const missing = path.join(dir, "no-such-ps");
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test" },
			}),
			env: env({ WFC_MEMINFO: meminfo(8000), WFC_PS: missing }),
		});
		expect(r.stdout ?? "").not.toMatch(/"deny"/);
	});

	describe("what the refusal tells the session", () => {
		const reason = () => denyReason("npm run test", 8000, NEIGHBOURS_AT_CAP);

		it("says the ladder stops at three", () => {
			expect(reason()).toContain("ladder stops at 3");
		});

		const typedFixes = [
			["npm run test", "npm run test -- --queue"],
			["npm test", "npm test -- --queue"],
			["npm run test -- --full=push", "npm run test -- --full=push --queue"],
			["node scripts/run-vitest.js", "node scripts/run-vitest.js --queue"],
			[
				"timeout 900 npm run test:changed > log 2>&1",
				"timeout 900 npm run test:changed > log 2>&1 -- --queue",
			],
			["npm run test # why", "npm run test -- --queue"],
		];
		const compound = 'cd x && npm run test -- -t "a & b" 2>&1 | tail -5';

		it("opens with the launch as typed, `--queue` added", () => {
			for (const [command, fix] of typedFixes)
				expect(
					denyReason(command, 8000, NEIGHBOURS_AT_CAP).split("\n")[0],
					command,
				).toBe(`Run instead: ${fix}`);
		});

		/* Handing back the launch alone would drop the `cd` ahead of it. */
		it("tells a compound command to keep its other parts", () => {
			expect(denyReason(compound, 8000, NEIGHBOURS_AT_CAP).split("\n")[0]).toBe(
				'Run the command with this launch in place of its own: npm run test -- -t "a & b" 2>&1 --queue',
			);
		});

		/* #1007, the next three. */
		it("allows every launch it suggests, re-submitted at the cap", () => {
			for (const command of [
				...typedFixes.map(([typed]) => typed),
				compound,
				"npm run test 2>&1 | tail -5",
				"npm run test >&2",
				"npm run test -- -t x 2>&1",
				'npm run test 2>&1 -- -t "a & b"',
			]) {
				const first = denyReason(command, 8000, NEIGHBOURS_AT_CAP).split(
					"\n",
				)[0];
				const fix = first.match(
					/^(?:Run instead|Run the command with this launch in place of its own): ((.+?)(?: --)? --queue)$/,
				);
				expect(fix, `${command}: ${first}`).toBeTruthy();
				const [, suggested, launch] = fix as RegExpMatchArray;
				expect(suggested, command).not.toMatch(/--queue.*--queue|-- .*-- /);
				const resubmitted = command
					.replace(/\s*#.*$/, "")
					.replace(launch, suggested);
				expect(
					gatedVerdict(resubmitted, 8000, NEIGHBOURS_AT_CAP),
					resubmitted,
				).not.toBe("deny");
			}
		});

		it("reads `--queue` and `--` behind a redirection", () => {
			for (const command of [
				"npm run test 2>&1 -- --queue | tail -5",
				"npm run test > log 2>&1 -- --queue",
				"npm run test -- -t x 2>&1 --queue",
				"npm run test &>log -- --queue",
				'npm run test 2>&1 -- -t "a & b" --queue',
			])
				expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP), command).toBe(
					EXEMPTED,
				);
		});

		it("reads no `--queue` that is not this launch's own as its flag", () => {
			for (const command of [
				'npm run test 2>&1 -- -t "--queue"',
				'grep -c "npm run test 2>&1 --queue" log; npm run test',
				'echo "npm run test 2>&1 -- --queue" && npm run test',
				"echo npm run test 2>&1 --queue && npm run test",
			])
				expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP), command).toBe(
					"deny",
				);
		});

		it("opens a watcher's refusal with the wait, the queue not applying", () => {
			expect(
				denyReason("npm run test:watch", 8000, NEIGHBOURS_AT_CAP).split(
					"\n",
				)[0],
			).toBe(
				"Wait for one to finish, then re-run: npm run test:watch — a watcher never finishes, so no queue takes it.",
			);
		});

		it("names the escape", () => {
			expect(reason()).toContain("WFC_SUITE_CONCURRENT=1");
		});

		/* The rest is cut to what changes the next call (#519). */
		it("keeps its reasons in the header, not the deny", () => {
			expect(reason()).not.toContain("TWO AND THREE ARE NOT REFUSED");
			const header = fs.readFileSync(GUARD, "utf8").split("\nhere=")[0];
			for (const text of ["#482", "2,113 bytes", "86%", "#155"])
				expect(header, text).toContain(text);
		});

		it("tells a session waiting on watchers alone that they never finish", () => {
			const r = denyReason("npm run test", 8000, 0, NEIGHBOURS_AT_CAP);
			expect(r).toContain("never finishes on its own");
		});
	});
});

describe("`--queue` is a lever a session may choose (mantahostels#2024, #155)", () => {
	it("never refuses a queued launch, whatever the count", () => {
		expect(
			gatedVerdict("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP),
		).toBe(EXEMPTED);
		expect(gatedVerdict("npm run test -- --queue", 8000, 1)).toBe("allow");
	});

	it("takes the wrapper's own spelling too", () => {
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js --queue",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
	});

	it("still denies the same launch without the flag", () => {
		expect(gatedVerdict("npm run test", 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
	});

	/* The flag says WHEN to run, never how much memory the run needs, so the
	 * ladder is untouched by it. */
	it("does not exempt a queued launch from the memory ladder", () => {
		expect(gatedVerdict("npm run test -- --queue", 1000, 0)).toBe("warn");
	});

	/* `--queue` starts with a dash, so `runner_test_file_count` must keep skipping it
	 * rather than reading it as a named test file — which would make the whole
	 * suite look narrowed and cheap. */
	it("is not mistaken for a named test file", () => {
		expect(
			gatedVerdict("node scripts/run-vitest.js", 8000, NEIGHBOURS_AT_CAP),
		).toBe("deny");
	});

	it("names the queue route in the denial, so a session need not invent one", () => {
		const out = gated("npm run test", 8000, NEIGHBOURS_AT_CAP).stdout ?? "";
		expect(out).toMatch(/--queue/);
		expect(out).toMatch(/Do not write your own waiter/);
	});
});

describe("`--queue` only where package.json's script runs run-vitest.js (#552)", () => {
	const scripts = (body: string, name = "test") =>
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { [name]: body } }),
		);

	it("offers an adopter's plain-vitest `test` queue-run.js, not the flag (#1776)", () => {
		scripts("vitest run");
		expect(denyReason("npm run test", 8000, NEIGHBOURS_AT_CAP)).toMatch(
			/^Run instead: node scripts\/queue-run\.js -- npm run test\n/,
		);
	});

	it("exempts no `--queue` the plain script would refuse, and re-issues the launch through queue-run.js without it", () => {
		scripts("vitest run");
		expect(
			gatedVerdict("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP),
		).toBe("deny");
		expect(
			denyReason("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP),
		).toMatch(/^Run instead: node scripts\/queue-run\.js -- npm run test\n/);
		expect(
			denyReason("npm run test -- --queue --changed", 8000, NEIGHBOURS_AT_CAP),
		).toMatch(
			/^Run instead: node scripts\/queue-run\.js -- npm run test -- --changed\n/,
		);
		expect(
			gatedVerdict(
				"node scripts/queue-run.js -- npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).not.toBe("deny");
	});

	it("offers the flag on a package.json it cannot parse, and logs the fail-open", () => {
		fs.writeFileSync(path.join(dir, "package.json"), "{");
		expect(denyReason("npm run test", 8000, NEIGHBOURS_AT_CAP)).toMatch(
			/^Run instead: npm run test -- --queue\n/,
		);
		expect(records()).toContain("package.json unreadable");
	});

	it("gives a watcher the wait, not queue-run.js, whichever body its script has (#1927)", () => {
		const wait =
			"Wait for one to finish, then re-run: npm run test:watch — a watcher never finishes, so no queue takes it.";
		for (const body of [
			"NODE_OPTIONS=--max-old-space-size=2048 vitest",
			"node scripts/run-vitest.js --watch",
		]) {
			scripts(body, "test:watch");
			for (const command of [
				"npm run test:watch",
				"npm run test:watch -- --queue",
			])
				expect(
					denyReason(command, 8000, NEIGHBOURS_AT_CAP).split("\n")[0],
					`${body}: ${command}`,
				).toBe(wait);
			expect(
				denyReason(
					"cd /tmp && npm run test:watch",
					8000,
					NEIGHBOURS_AT_CAP,
				).split("\n")[0],
				body,
			).toBe(
				"Wait for one to finish, then re-run the command with this launch in place of its own: npm run test:watch — a watcher never finishes, so no queue takes it.",
			);
		}
	});

	it("still offers the flag where the script reaches the runner through the resolver", () => {
		scripts("node scripts/lib/resolve-core.js scripts/run-vitest.js");
		expect(denyReason("npm run test", 8000, NEIGHBOURS_AT_CAP)).toMatch(
			/^Run instead: npm run test -- --queue\n/,
		);
		expect(
			gatedVerdict("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP),
		).toBe(EXEMPTED);
	});
});

describe("the wrapper form is in scope, so it is not a bypass (mantahostels#2015)", () => {
	it("denies a bare `node scripts/run-vitest.js` — the whole suite renamed", () => {
		expect(
			gatedVerdict("node scripts/run-vitest.js", 8000, NEIGHBOURS_AT_CAP),
		).toBe("deny");
	});

	it("never refuses one naming its own test files, which is bounded", () => {
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js scripts/foo.test.ts",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
		expect(
			gatedVerdict("node scripts/run-vitest.js scripts/foo.test.ts", 8000, 1),
		).toBe("allow");
	});

	it("never refuses a bounded run carrying flags around the path", () => {
		expect(
			gatedVerdict(
				'node scripts/run-vitest.js scripts/foo.test.ts -t "a name"',
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js -t foo scripts/foo.test.ts",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js 'scripts/foo.test.ts'",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
	});

	/* #1196: `foo` is the flag's value, not a file; every file still runs. */
	it("denies one whose only bare word is a flag's value", () => {
		for (const command of [
			"node scripts/run-vitest.js -t foo",
			"node scripts/run-vitest.js --testNamePattern foo",
		])
			expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP), command).toBe(
				"deny",
			);
	});

	it("denies one carrying flags and no path at all", () => {
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js --changed",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
	});

	it("still puts an unbounded wrapper run on the memory ladder", () => {
		expect(gatedVerdict("node scripts/run-vitest.js", 1000, 0)).toBe("deny");
	});

	it("reads the path's last segment, not any node command", () => {
		expect(
			gatedVerdict("node scripts/something-else.js", 8000, NEIGHBOURS_AT_CAP),
		).toBe("allow");
	});

	it("counts a redirection as the end of the arguments, not a path", () => {
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js > /tmp/out.log",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
	});
});

describe("a run naming its test files is charged by the vitest workers it can occupy (#2558)", () => {
	const routes = {
		npm: (files: string) => `npm run test -- ${files}`,
		wrapper: (files: string) => `node scripts/run-vitest.js ${files}`,
	};
	const one = "scripts/a.test.ts";
	const two = "scripts/a.test.ts scripts/b.test.ts";
	const three = "scripts/a.test.ts scripts/b.test.ts scripts/c.test.ts";

	describe.each(Object.entries(routes))("on the %s route", (_route, launch) => {
		it("passes a one-file run at 1,500 MB and refuses it at 1,400 MB with no suite running", () => {
			expect(gatedVerdict(launch(one), 1500, 0)).toBe("allow");
			expect(gatedVerdict(launch(one), 1400, 0)).toBe("deny");
		});

		it("refuses a three-file run at 2,100 MB and at the count cap, as a whole suite", () => {
			expect(gatedVerdict(launch(three), 2100, 0)).toBe("deny");
			expect(gatedVerdict(launch(three), ladder1() - 1, 0)).toBe("deny");
			expect(gatedVerdict(launch(three), 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
		});

		/* Past the cap the rung is extrapolated, and the over-the-ladder warn
		 * still stands on a run the rung lets through. */
		it("passes a two-file run beside three suites at 4,400 MB and refuses it at 4,300 MB", () => {
			expect(gatedVerdict(launch(two), 4400, NEIGHBOURS_AT_CAP)).toBe(EXEMPTED);
			expect(gatedVerdict(launch(two), 4300, NEIGHBOURS_AT_CAP)).toBe("deny");
		});
	});

	it("names the rung it judged a part-suite on, and hands back `--queue`", () => {
		const reason = denyReason(routes.npm(two), 1800 - 1, 0);
		expect(reason.split("\n")[0]).toBe(
			`Run instead: npm run test -- ${two} --queue`,
		);
		expect(reason).toMatch(
			/under the ~1800 MB .* for the 2 vitest worker\(s\) its named files can occupy, beside 0 running,/,
		);
	});

	/* §6's table, every cell: 794 MB + the dip + ~300 MB, rounded up to 50.
	 * The whole-suite column is admission.js's SUITE_RESTING_MB. */
	it.each([
		[0, one, 1450],
		[0, two, 1800],
		[0, three, SUITE_RESTING_MB[1]],
		[1, one, 2500],
		[1, two, 2900],
		[1, three, SUITE_RESTING_MB[2]],
		[2, one, 3400],
		[2, two, 3500],
		[2, three, SUITE_RESTING_MB[3]],
		[3, one, 4000],
		[3, two, 4350],
	])("with %i suites running rests `%s` on %i MB", (suites, files, rung) => {
		expect(gatedVerdict(routes.npm(files), rung, suites)).not.toBe("deny");
		expect(gatedVerdict(routes.npm(files), rung - 1, suites)).toBe("deny");
	});

	it.each([
		"npm run test",
		"npm run test -- --adopt x.js",
		"npm run test -- --adopt scripts/foo.test.ts",
		"npm run test -- -t foo",
		"npm run test:changed",
		"npm run test:changed -- scripts/foo.test.ts",
	])("charges `%s`, which names no bound, a whole suite", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
		expect(gatedVerdict(command, ladder1() - 1, 0)).toBe("deny");
	});

	/* A bare word vitest reads as a path filter (#2559). A flag's value is no
	 * file, however it is shaped. */
	it.each([
		"npm run test -- run scripts/foo.test.ts",
		"npm run test -- -t scripts/foo.test.ts",
	])("charges `%s` a whole suite, its file no bound (#2559)", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
		expect(gatedVerdict(command, ladder1() - 1, 0)).toBe("deny");
	});

	it("still refuses a watcher, which runs the whole suite whatever it names", () => {
		expect(
			gatedVerdict(
				"npm run test:watch -- scripts/foo.test.ts",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
	});

	it("never refuses a queued part-suite", () => {
		expect(gatedVerdict(`${routes.npm(one)} --queue`, 1000, 0)).toBe("warn");
	});

	it("prices workers off the maxWorkers vitest.config.ts pins", () => {
		const config = fs.readFileSync(
			path.join(__dirname, "..", "vitest.config.ts"),
			"utf8",
		);
		expect(
			shellConst(
				path.join(__dirname, "lib", "suite-bounded.sh"),
				"SUITE_WORKERS",
			),
		).toBe(Number(/maxWorkers: (\d+)/.exec(config)?.[1]));
	});

	it("holds earlyoom's line and the margin equal to admission.js's", () => {
		expect(shellConst(GUARD, "EARLYOOM_MB")).toBe(EARLYOOM_FLOOR_MB);
		expect(shellConst(GUARD, "MARGIN_MB")).toBe(DRAW_MARGIN_MB);
	});
});

describe("a running vitest run is weighed by the workers its runner line names (#2560)", () => {
	const lib = path.join(__dirname, "lib", "suite-bounded.sh");
	const admission = path.join(__dirname, "lib", "admission.js");
	const runner = (tail: string) => `node /r/node_modules/.bin/vitest${tail}`;
	const oneFile = runner(" run --passWithNoTests a.test.ts");
	const gatedWith = (command: string, mb: number, lines: string[]) => {
		const out = gatedOn(command, mb, psLines(lines)).stdout ?? "";
		if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
		return /"additionalContext"/.test(out) ? "warn" : "allow";
	};
	const full = "npm run test -- --full=flag";

	it("passes a whole launch beside one running 1-file run at 2,500 MB and refuses it at 2,450 MB", () => {
		expect(gatedWith(full, 2500, [oneFile])).toBe("allow");
		expect(gatedWith(full, 2450, [oneFile])).toBe("deny");
	});

	it("takes no slot of the count cap for three running 1-file runs, charging their workers alone", () => {
		const three = [oneFile, oneFile, oneFile];
		expect(gatedWith(full, 3250, three)).toBe("allow");
		expect(gatedWith(full, 3200, three)).toBe("deny");
	});

	it("weighs a running `-t foo a.test.ts` run at 1 worker", () => {
		const line = [runner(" run -t foo a.test.ts")];
		expect(gatedWith(full, 2500, line)).toBe("allow");
		expect(gatedWith(full, 2450, line)).toBe("deny");
	});

	/* The guard's rung against admission.js's `suiteRungMb`, between rungs and
	 * past 9 workers, where pretest-reap now judges. */
	const whole = runner(" run");
	it.each([
		[[oneFile], full, 4],
		[[oneFile, oneFile], full, 5],
		[[whole, whole, whole, oneFile], "npm run test -- scripts/a.test.ts", 11],
		[
			[whole, whole, whole, runner(" run a.test.ts b.test.ts")],
			"npm run test -- scripts/a.test.ts",
			12,
		],
	] as const)(
		"rests the launch on suiteRungMb's rung (case %#, %i workers)",
		(lines, command, workers) => {
			const reason = gatedOn(command, 1000, psLines([...lines])).stdout ?? "";
			expect(/under the ~(\d+) MB/.exec(reason)?.[1]).toBe(
				String(suiteRungMb(workers)),
			);
		},
	);

	it("names the workers it judged a whole launch on beside a part-suite", () => {
		expect(gatedOn(full, 2450, psLines([oneFile])).stdout).toContain(
			"needs resting for 4 vitest workers, 1 of them already running",
		);
	});

	it.each([
		["a filter word", runner(" run run a.test.ts")],
		["a watcher", runner(" a.test.ts")],
	])(
		"counts a running run carrying %s toward the cap, as whole",
		(_kind, line) => {
			expect(gatedWith(full, 8000, [line, line, line])).toBe("deny");
		},
	);

	const listed = (file: string, re: RegExp) =>
		re.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "";
	const valued = listed(lib, /^SUITE_VALUED_FLAGS=' (.+) '$/m).split(" ");

	it("keeps admission.js's valued flags equal to the guard lib's (#630)", () => {
		const js = [
			...listed(
				admission,
				/^const SUITE_VALUED_FLAGS = new Set\(\[([^\]]+)\]\);$/m,
			).matchAll(/"([^"]+)"/g),
		].map((m) => m[1]);
		expect(js).toEqual(valued);
	});

	/* One fixture set, read by lib/suite-bounded.sh's `vitest_line_workers` and
	 * admission.js's `readRunningVitestSuites` (#630). */
	it("weighs every fixture line alike in both readings", () => {
		const fixtures: [string, number][] = [
			[runner(" run"), 3],
			[runner(" run --passWithNoTests a.test.ts"), 1],
			[runner(" run a.test.ts b.spec.tsx"), 2],
			[runner(" run a.test.ts b.test.ts c.test.ts d.test.ts"), 3],
			[runner(" run run a.test.ts"), 3],
			[runner(" run -t foo a.test.ts"), 1],
			[runner(" run --testNamePattern=foo a.test.ts"), 1],
			[runner(" run --unknownFlag x a.test.ts"), 3],
			[runner(" run scripts/lib/"), 3],
			[runner(" --silent --run a.test.ts"), 1],
			[runner(" run --watch a.test.ts"), 3],
			[runner(" a.test.ts"), 3],
			[runner(""), 3],
			["node_modules/.bin/vitest run a.test.ts", 1],
			...valued.map((flag): [string, number] => [
				runner(` run ${flag} x a.test.ts`),
				1,
			]),
		];
		const lines = fixtures.map(([line]) => line);
		const bash = spawnSync(
			"bash",
			[
				"-c",
				'source "$1"; shift; for l in "$@"; do vitest_line_workers "$l"; done',
				"_",
				lib,
				...lines,
			],
			{ encoding: "utf8" },
		);
		const was = process.env.WFC_PS;
		const node = lines.map((line, i) => {
			process.env.WFC_PS = writePsStub(dir, [line], { name: `ps-${i}` });
			const r = readRunningVitestSuites();
			return r.ok ? r.workers : null;
		});
		if (was === undefined) delete process.env.WFC_PS;
		else process.env.WFC_PS = was;
		const want = fixtures.map(([, w]) => w);
		expect(bash.stdout.trim().split("\n").map(Number)).toEqual(want);
		expect(node).toEqual(want);
	});

	it("keeps the one-shot and watcher patterns equal to the guard lib's (#630)", () => {
		for (const name of ["VITEST_ONESHOT", "VITEST_WATCH"]) {
			const bash = listed(lib, new RegExp(`^${name}='(.+)'$`, "m"));
			const node = listed(
				admission,
				new RegExp(`^const ${name} = /(.+)/;$`, "m"),
			);
			expect(bash, name).toBeTruthy();
			expect(node.replaceAll("\\/", "/"), name).toBe(bash);
		}
	});

	it("holds the dips, the cap and the workers equal to admission.js's", () => {
		const dips = listed(GUARD, /^SUITE_DIP_MB=\((.+)\)$/m);
		expect(dips).toBeTruthy();
		expect(listed(admission, /^const SUITE_DIP_MB = \[(.+)\];$/m)).toBe(
			dips.split(" ").join(", "),
		);
		expect(shellConst(GUARD, "SUITE_MAX")).toBe(SUITE_MAX);
		expect(shellConst(lib, "SUITE_WORKERS")).toBe(SUITE_WORKERS);
		expect([1, 4, 10, 11].map(suiteRungMb)).toEqual([1450, 2500, 4000, 4350]);
	});
});

describe("lib/suite-bounded.sh's `runner_test_file_count`, the files a launch is bounded to", () => {
	const lib = path.join(__dirname, "lib", "suite-bounded.sh");
	/** The count it prints for `argv`, or null where it returns unbounded. */
	const count = (argv: string) => {
		const r = spawnSync(
			"bash",
			[
				"-c",
				'source "$1"; shift; runner_test_file_count node run-vitest.js "$@"',
				"_",
				lib,
				...(argv ? argv.split(" ") : []),
			],
			{ encoding: "utf8" },
		);
		return r.status === 0 ? r.stdout.trim() : null;
	};
	it.each([
		["", null],
		["scripts/foo.test.ts", "1"],
		["a.test.ts b.spec.tsx c.test.js d.test.mts", "4"],
		["-t foo scripts/foo.spec.tsx", "1"],
		["--retest a.test.ts", "1"],
		["--changed HEAD a.test.ts", "1"],
		["--full=coverage a.test.ts", "1"],
		["--queue a.test.ts", "1"],
		["-t foo", null],
		["--changed", null],
		["--changed a.test.ts", null],
		["--changed=HEAD a.test.ts", "1"],
		["scripts/lib/", null],
		["--adopt x.js", null],
		["--adopt a.test.ts", null],
		["a.test.ts --adopt x.js", null],
	])(
		"reads `%s` as bounded to %s test file(s), null being unbounded",
		(argv, files) => {
			expect(count(argv)).toBe(files);
		},
	);

	it.each(["run new-repo.test.ts", "-t a.test.ts"])(
		"reads `%s` as unbounded (#2559)",
		(argv) => {
			expect(count(argv)).toBeNull();
		},
	);
});

/*
 * The stand-down record (mantahostels#2183).
 *
 * The record must follow the escape and nothing else — a file counting launches
 * rather than overrides answers a different question from mantahostels#2162's.
 */
describe("records every stand-down of the count cap (mantahostels#2183)", () => {
	it("appends one record when the escape carries a launch past the deny", () => {
		expect(verdict("npm run test", 8000, NEIGHBOURS_AT_CAP)).toBe(EXEMPTED);
		expect(standdowns()).toHaveLength(1);
	});

	it("records a stand-down taken as a command prefix, not just in the environment", () => {
		expect(
			gatedVerdict(
				"WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
		expect(standdowns()).toHaveLength(1);
		expect(standdowns()[0].command).toBe("WFC_SUITE_CONCURRENT=1 npm run test");
	});

	/* The store must count overrides, and an override is a launch that HAPPENED
	 * (mantahostels#2486). */
	it.each([
		"WFC_SUITE_CONCURRENT=1 npm run test && npm run test",
		"npm run test && WFC_SUITE_CONCURRENT=1 npm run test",
	])("records one stand-down, and does not refuse, for `%s`", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe(EXEMPTED);
		expect(standdowns()).toHaveLength(1);
	});

	it("carries the command, the count it saw and the rung it would have been", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(standdowns()[0]).toMatchObject({
			command: "npm run test",
			running: 3,
			nth: 4,
			limb: "count",
			session: "test",
		});
	});

	/* The marker store (`.test-pass-markers.jsonl`) shares no key with this one,
	 * so the join is by time — an unparseable stamp makes the record uncountable
	 * against it. */
	it("stamps a parseable ISO time, which is what joins it to a marker", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		const at = standdowns()[0].at as string;
		expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Number.isFinite(Date.parse(at))).toBe(true);
	});

	it("appends rather than replacing, so a session's overrides accumulate", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		run("npm run test:changed", 8000, NEIGHBOURS_AT_CAP);
		expect(standdowns().map((r) => r.command)).toEqual([
			"npm run test",
			"npm run test:changed",
		]);
	});

	it("records nothing for the first suite, which the deny never reached", () => {
		expect(verdict("npm run test", 8000, 0)).toBe("allow");
		expect(standdowns()).toEqual([]);
	});

	it("records nothing for a bounded wrapper run, exempt on its own account", () => {
		run(
			"node scripts/run-vitest.js scripts/foo.test.ts",
			8000,
			NEIGHBOURS_AT_CAP,
		);
		expect(standdowns()).toEqual([]);
	});

	it("records nothing for a queued launch, which obeys the gate", () => {
		run("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP);
		expect(standdowns()).toEqual([]);
	});

	it("records nothing for a build, which is off the ladder entirely", () => {
		run("npm run build", 8000, NEIGHBOURS_AT_CAP);
		expect(standdowns()).toEqual([]);
	});

	it("records nothing for a command that is neither a test nor a build", () => {
		run("echo hello", 8000, NEIGHBOURS_AT_CAP);
		expect(standdowns()).toEqual([]);
	});

	it("records nothing when the deny actually fires", () => {
		expect(gatedVerdict("npm run test", 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
		expect(standdowns()).toEqual([]);
	});

	/* Unrecorded, and never refused — the launch reaching the over-the-ladder
	 * warn rather than a deny is the fail-open landing where it should. */
	it("fails open on an unwritable log, letting the launch through unrecorded", () => {
		fs.mkdirSync(
			path.join(dir, ".claude", "tmp", "markers", ".suite-standdowns.jsonl"),
		);
		const r = run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(r.status).toBe(0);
		expect(r.stderr ?? "").toBe("");
		expect(r.stdout ?? "").not.toMatch(/"deny"/);
		expect(r.stdout ?? "").toMatch(
			/This would be suite 4 on a machine measured to 3/,
		);
	});

	it("still warns on the ladder after standing the deny down", () => {
		expect(verdict("npm run test", 1000, NEIGHBOURS_AT_CAP)).toBe("warn");
		expect(standdowns()).toHaveLength(1);
	});

	/* One hook fires per COMMAND, before any of it runs, so a second stand-down
	 * in the same command reads the same `ps` as the first and its `nth` would
	 * describe a machine state that never existed. */
	it("writes one record for a compound command, not one per segment", () => {
		run("npm run test && npm run test:changed", 8000, NEIGHBOURS_AT_CAP);
		expect(standdowns()).toHaveLength(1);
		expect(standdowns()[0].command).toBe("npm run test");
	});

	it("records the fail-open when the log cannot be appended to", () => {
		fs.mkdirSync(
			path.join(dir, ".claude", "tmp", "markers", ".suite-standdowns.jsonl"),
		);
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(records()).toContain("went uncounted");
	});

	it("says nothing to guard-errors.log when the append lands", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(records()).toBe("");
	});
});

/*
 * A wrapper standing in front of the command word (mantahostels#2511).
 *
 * `is_test` reads the head word, so before the strip an `env`, `nohup`,
 * `setsid` or `bg-run.sh run <name>` prefix meant the scope test never saw
 * `npm` at all: the throughput deny was absent AND — worse — an
 * `env WFC_SUITE_CONCURRENT=1 npm run test` stood the gate down with no line
 * in `.suite-standdowns.jsonl`.
 */
describe("strips a wrapper before the scope test (mantahostels#2511)", () => {
	it.each([
		"env npm run test",
		"nohup npm run test",
		"setsid npm run test",
		"time npm run test",
		"command npm run test",
		"stdbuf -oL npm run test",
		/* `timeout`'s duration is a bare positional, so a flag sweep alone
		 * leaves `900` standing where the command word is looked for. */
		"timeout 900 npm run test",
		"timeout -k 10 900 npm run test",
		"env -u FOO npm run test",
		"env -C /tmp npm run test",
		"env --unset FOO npm run test",
		"env --chdir /tmp npm run test",
		"/usr/bin/env npm run test",
		"nohup setsid env npm run test",
		"scripts/bg-run.sh run suite npm run test",
	])("denies `%s` with a suite already running", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
	});

	it("puts a wrapped launch on the memory ladder too", () => {
		expect(gatedVerdict("env npm run test", 1000, 0)).toBe("deny");
	});

	it("strips a wrapper in front of the runner form", () => {
		expect(
			gatedVerdict("env node scripts/run-vitest.js", 8000, NEIGHBOURS_AT_CAP),
		).toBe("deny");
	});

	/* A false strip is the failure the other way: it would make an unrelated
	 * command read as the suite launch standing behind it. */
	it.each([
		"env npm run lint",
		"scripts/bg-run.sh check npm run test",
		"scripts/bg-run.sh npm run test",
		"npx vitest run",
	])("does not read `%s` as a suite launch", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("allow");
	});

	/* A wrapper with nothing behind it unwraps to no words at all, and the
	 * scope test must not be handed an empty argument list. */
	it.each(["env", "timeout 900", "scripts/bg-run.sh run suite"])(
		"allows `%s`, which wraps nothing",
		(command) => {
			expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("allow");
		},
	);

	/* The escape inside an `env` prefix is an ARGUMENT to `env`, not a leading
	 * shell assignment, so it is read off the assignments the strip dropped. */
	it("honours the escape spelled inside an `env` prefix", () => {
		expect(
			gatedVerdict(
				"env WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
	});

	/*
	 * ONLY an `env` carries an assignment, and only an assignment is read.
	 *
	 * `nohup WFC_SUITE_CONCURRENT=1 npm run test` execs a program of that
	 * name and launches no suite, and a `bg-run.sh` job name is free text — so
	 * honouring either would write a row into the store mantahostels#2162 prices the gate
	 * from for an override that never happened.
	 */
	it("takes no escape from an assignment behind a `nohup`", () => {
		expect(
			gatedVerdict(
				"nohup WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("allow");
		expect(standdowns()).toEqual([]);
	});

	it("takes no escape from a `bg-run.sh` job name", () => {
		expect(
			gatedVerdict(
				"scripts/bg-run.sh run WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
		expect(standdowns()).toEqual([]);
	});

	/* The boundary the widened `gp_carries_var` could have broken: an escape
	 * after the command word is an argument to it, not a prefix. */
	it("still takes no escape from an argument to the wrapped command", () => {
		expect(
			gatedVerdict(
				"env npm run test -- WFC_SUITE_CONCURRENT=1",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
	});

	it("records that stand-down", () => {
		expect(
			gatedVerdict(
				"env WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
		expect(standdowns()).toHaveLength(1);
		expect(standdowns()[0].command).toBe(
			"env WFC_SUITE_CONCURRENT=1 npm run test",
		);
	});

	it("denies a wrapped launch whose escape is empty", () => {
		expect(
			gatedVerdict(
				"env WFC_SUITE_CONCURRENT= npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
	});

	it("counts a wrapped watcher as the watcher it opens", () => {
		expect(
			denyReason("env npm run test:watch", 8000, NEIGHBOURS_AT_CAP),
		).toContain("WATCHER");
	});
});

/* The rest of the wrapper class (mantahostels#2552). */
describe("strips the rest of the wrapper class (mantahostels#2552)", () => {
	it.each([
		"sudo npm run test",
		"sudo -u root npm run test",
		"nice npm run test",
		"nice -n 5 npm run test",
		/* `nice`'s obsolete adjustment spelling is one flag word, so the sweep
		 * needs nothing for it — but reading it as a value-taker would eat
		 * `npm`. */
		"nice -5 npm run test",
		"ionice -c2 npm run test",
		"ionice -c 2 -n 0 npm run test",
		"xargs npm run test",
		"xargs -n 1 npm run test",
		"xargs -I {} npm run test",
		"nice ionice -c 2 npm run test",
		/* The separate-value spellings of wrappers already in the list. */
		"stdbuf -o L npm run test",
		"stdbuf -i 0 -e L npm run test",
		"env -S 'npm run test'",
		"env --split-string 'npm run test'",
		"env --split-string='npm run test'",
		/* An OPTIONAL-value flag must NOT be swept as a value-taker: swept, it
		 * eats `npm` and the launch goes unjudged. `xargs -e[END]`/`-i[R]` and
		 * `sudo -h` — `--help` as readily as `--host` — are the three. */
		"xargs --eof npm run test",
		"xargs --replace npm run test",
		"sudo -h npm run test",
		"sudo -D /tmp npm run test",
		"sudo --user root npm run test",
		"sudo --close-from 3 npm run test",
	])("denies `%s` with a suite already running", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
	});

	/*
	 * `allow` ALONE PROVES NOTHING HERE — it is also the verdict for a launch
	 * the strip never saw, so a regression dropping a wrapper leaves this green.
	 * The stand-down RECORD is the discriminating signal: it is written only
	 * where the escape carried a launch the guard had recognised.
	 */
	it.each([
		"WFC_SUITE_CONCURRENT=1 sudo npm run test",
		"WFC_SUITE_CONCURRENT=1 nice -n 5 npm run test",
		"WFC_SUITE_CONCURRENT=1 ionice -c 2 npm run test",
		"WFC_SUITE_CONCURRENT=1 xargs -n 1 npm run test",
		"WFC_SUITE_CONCURRENT=1 stdbuf -o L npm run test",
		"WFC_SUITE_CONCURRENT=1 stdbuf -i 0 -e L npm run test",
		"env WFC_SUITE_CONCURRENT=1 stdbuf -o L npm run test",
		"WFC_SUITE_CONCURRENT=1 env -S 'npm run test'",
		"WFC_SUITE_CONCURRENT=1 env --split-string 'npm run test'",
		"WFC_SUITE_CONCURRENT=1 env --split-string='npm run test'",
	])("stands down for `%s`, and records it", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe(EXEMPTED);
		expect(standdowns()).toHaveLength(1);
	});

	/* An assignment inside the split string is an `env` assignment like any
	 * other. */
	it("reads an escape from inside the split string", () => {
		expect(
			gatedVerdict(
				"env -S 'WFC_SUITE_CONCURRENT=1 npm run test'",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
		expect(standdowns()).toHaveLength(1);
	});

	/* A wrapper that runs out of words judges nothing rather than crashing. */
	it.each(["env -S", "stdbuf -o", "xargs -n", "sudo -u"])(
		"allows `%s`, which wraps nothing",
		(command) => {
			expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("allow");
		},
	);

	it.each(["sudo npm run lint", "xargs grep -n test", "nice npm run lint"])(
		"does not read `%s` as a suite launch",
		(command) => {
			expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe("allow");
		},
	);
});

describe("counts and judges a suite vitest does not run (#330)", () => {
	const vitest = "node /r/node_modules/.bin/vitest run";
	const nodeTest = "node --test --experimental-test-coverage scripts/a.test.js";
	// `node --test`'s per-file children carry no `--test` of their own.
	const nodeChild =
		"/usr/bin/node --test-coverage-lines=0 --test-isolation=process scripts/a.test.js";
	const judged = (command: string, lines: string[], config?: object) => {
		if (config) {
			fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, ".claude", "workflow-core.json"),
				JSON.stringify(config),
			);
		}
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command },
			}),
			env: env({
				WFC_MEMINFO: meminfo(ROOMY_MB),
				WFC_PS: psLines(["bash -l", ...lines]),
				WFC_SUITE_CONCURRENT: "",
			}),
		});
		const out = r.stdout ?? "";
		if (/"permissionDecision"\s*:\s*"deny"/.test(out)) {
			expectFixFirst(command, out);
			return "deny";
		}
		return /"additionalContext"/.test(out) ? "warn" : "allow";
	};

	it("counts running `node --test`, pytest and Python test files toward the cap", () => {
		for (const other of [
			nodeTest,
			"python3 -m pytest -n 2",
			"/home/u/.venv/bin/pytest scripts",
			"python3 scripts/footer_sources.test.py",
		])
			expect(judged("npm run test", [vitest, vitest, other])).toBe("deny");
	});

	it("counts a `node --test` run once, not once per child", () => {
		expect(
			judged("npm run test", [vitest, nodeTest, nodeChild, nodeChild]),
		).toBe("allow");
	});

	it("does not count a script that merely takes a --test argument, or inline code", () => {
		expect(
			judged("npm run test", [
				vitest,
				vitest,
				"node scripts/x.js --test",
				"python3 -c import sys;exec(eval(sys.stdin.readline()))",
				"python3 scripts/arctic_shift.py",
			]),
		).toBe("allow");
	});

	it("denies a fourth when the launch is itself one of them", () => {
		const three = [nodeTest, nodeTest, "python3 scripts/b.test.py"];
		for (const launch of [
			"node --test scripts/a.test.js",
			"python3 scripts/footer_sources.test.py",
			"python3 -m pytest",
			"pytest -x",
		])
			expect(judged(launch, three)).toBe("deny");
		expect(judged("node --test scripts/a.test.js", three.slice(1))).toBe(
			"allow",
		);
	});

	const denyLine = (command: string) => {
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command },
			}),
			env: env({
				WFC_MEMINFO: meminfo(ROOMY_MB),
				WFC_PS: psLines([vitest, vitest, vitest]),
				WFC_SUITE_CONCURRENT: "",
			}),
		});
		const reason: string = JSON.parse(r.stdout).hookSpecificOutput
			.permissionDecisionReason;
		return reason;
	};

	it("hands the launch through queue-run.js, not `--queue` (#1776)", () => {
		const reason = denyLine("node --test scripts/a.test.js 2>&1");
		expect(reason.split("\n")[0]).toBe(
			"Run instead: node scripts/queue-run.js -- node --test scripts/a.test.js 2>&1",
		);
		expect(reason).not.toMatch(/run-vitest\.js's alone/);
		expect(reason).toMatch(/WFC_SUITE_CONCURRENT=1, which is recorded/);
	});

	it("puts queue-run.js behind the assignments and ahead of a wrapper", () => {
		expect(
			denyLine(`FOO=1 timeout 600 python3 scripts/b.test.py -k "a b"`).split(
				"\n",
			)[0],
		).toBe(
			`Run instead: FOO=1 node scripts/queue-run.js -- timeout 600 python3 scripts/b.test.py -k "a b"`,
		);
		expect(denyLine("cd sub && pytest -x").split("\n")[0]).toBe(
			"Run the command with this launch in place of its own: node scripts/queue-run.js -- pytest -x",
		);
	});

	it("leaves a loop's or a condition's keyword out of the queued launch", () => {
		for (const command of [
			"for t in a b; do pytest -q; done",
			"if true; then pytest -q; fi",
			"true && { pytest -q; }",
		])
			expect(denyLine(command).split("\n")[0]).toBe(
				"Run the command with this launch in place of its own: node scripts/queue-run.js -- pytest -q",
			);
	});

	it("lets a launch through queue-run.js past the cap, as it lets `--queue`", () => {
		const three = [nodeTest, nodeTest, "python3 scripts/b.test.py"];
		for (const launch of [
			"node scripts/queue-run.js -- node --test scripts/a.test.js",
			"timeout 900 node /p/scripts/queue-run.js -- pytest -x",
		])
			expect(judged(launch, three)).toBe("warn");
		expect(judged("node scripts/queue-run.js -- node --test", [])).toBe(
			"allow",
		);
	});

	it("counts a queue-run.js waiter as no suite of its own", () => {
		expect(
			judged("npm run test", [
				vitest,
				vitest,
				"node /p/scripts/queue-run.js -- node --test scripts/a.test.js",
			]),
		).toBe("allow");
	});

	it("reads them as one-shots, never as open watchers", () => {
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test" },
			}),
			env: env({
				WFC_MEMINFO: meminfo(ROOMY_MB),
				WFC_PS: psLines([nodeTest, nodeTest, "python3 scripts/b.test.py"]),
				WFC_SUITE_CONCURRENT: "",
			}),
		});
		expect(r.stdout).toMatch(/Run instead: npm run test -- --queue/);
		expect(r.stdout).not.toMatch(/watcher/);
	});

	it("counts and judges the host's declared suiteRunners", () => {
		const config = { suiteRunners: ["scripts/build-site.js"] };
		const build = "node /home/u/fb/scripts/build-site.js";
		expect(judged("npm run test", [vitest, vitest, build], config)).toBe(
			"deny",
		);
		expect(
			judged("node scripts/build-site.js", [vitest, vitest, vitest], config),
		).toBe("deny");
	});

	it("ignores a runner script no config declares", () => {
		const build = "node /home/u/fb/scripts/build-site.js";
		expect(judged("npm run test", [vitest, vitest, build])).toBe("allow");
		expect(judged("node scripts/build-site.js", [vitest, vitest, vitest])).toBe(
			"allow",
		);
	});
});
