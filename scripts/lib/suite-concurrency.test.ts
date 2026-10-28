// @vitest-environment node
/*
 * lib/suite-concurrency.js, the guard-suite-concurrency core (#2795), in
 * process: which launches the suite gate refuses under the resting headroom
 * docs/environment.md §6 measures (#2305), sending them to the queue; which
 * second concurrent whole suite it refuses (#2680); which it only warns
 * about; and which rules it hands a quiet launch (mantahostels#1805, #181,
 * #2024, #2237).
 *
 * Every port is a fake the case sets: MemAvailable, the `ps -eo args`
 * listing, the host's package.json scripts and `suiteRunners`, the latches.
 * The rule store is the real one, read through lib/rule-text.js. What the kit
 * makes of a verdict — the envelope, the latch files, the stand-down log on
 * disk, the env seams — is guard-suite-concurrency.test.ts's boundary set.
 *
 * A verdict reads "deny" where the core refuses, "warn" where it hands the
 * session text of its own (the prelude), "allow" where it hands nothing. The
 * ladder cases latch suite-tree-dirty and memory-figure, so the only text an
 * allowed launch could carry is the guard's own warning.
 *
 * Loosen a case here and a second whole suite, or a launch under the measured
 * headroom, runs unrefused or unwarned into the 10 GB cap that earlyoom
 * enforces by killing live sessions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";
import { WHOLE_SLOT_BOUND } from "./whole-slot-bound";

type Gate = { limb: "count" } | { limb: "memory"; mb: number; rungMb: number };
type Verdict = {
	deny?: string;
	gate?: Gate;
	injectRules?: string[];
	skip?: string[];
	prelude?: string;
	latchAfter?: string;
} | null;
type Plain = { plain: boolean } | { fault: string };

const { decide, FULL_LIMB_ID } = require("./suite-concurrency.js") as {
	decide: (command: string, ctx: object) => Verdict;
	FULL_LIMB_ID: string;
};
const { suiteRungMb } = require("./suite-ladder.js") as {
	suiteRungMb: (workers: number) => number;
};
const { WHOLE_SUITE_WORKERS } = require("./suite-bounded.js") as {
	WHOLE_SUITE_WORKERS: number;
};

/** A carried admission weight (#2931). */
interface Weight {
	resolvedFiles: number | null;
	wholeSlot: boolean;
}

/** `n` named test files, as a launch's words. */
const namedFiles = (n: number) =>
	Array.from({ length: n }, (_, i) => `scripts/f${i}.test.ts`).join(" ");
const { hasWrapperCall } = require("./suite-launch.js") as {
	hasWrapperCall: (body: string | null) => boolean;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

/**
 * Neighbours enough that THIS launch is the one the cap refuses —
 * `WHOLE_SUITE_MAX` of them, making the launch the second (#2680).
 *
 * A literal, not read from the core: every case using it is about the
 * boundary, so moving `WHOLE_SUITE_MAX` should fail these rather than slide
 * them.
 */
const NEIGHBOURS_AT_CAP = 1;

/**
 * Neighbours that fill the ladder's last measured rung (SUITE_MAX), so a
 * launch beside them is past every rung and draws the over-the-ladder warn.
 * A literal for the same reason as `NEIGHBOURS_AT_CAP`.
 */
const NEIGHBOURS_PAST_LADDER = 3;

/** MemAvailable far above every rung the cases reach, so no memory warning competes with the verdict under test. */
const ROOMY_MB = 20_000;

/**
 * What a whole-suite launch the cap EXEMPTS reads as at `NEIGHBOURS_AT_CAP`
 * neighbours — an escaped one or a `--queue`. The deny is stood down or never
 * applied, and the one-at-a-time warn is what is left standing (#159).
 * Never "allow": past the cap nothing passes in silence. A part-suite is no
 * exemption: it takes no whole-suite slot and is allowed.
 */
const EXEMPTED = "warn";

/**
 * The rung a whole-suite launch reaches beside `running` whole suites, each
 * WHOLE_SUITE_WORKERS wide, read out of lib/suite-ladder.js rather than copied
 * (mantahostels#2007), which computes it from §6's dips (#2558).
 *
 * A case discriminating only inside a band the ladder sets has to move with it,
 * or raising the figure defangs the case instead of failing it. Cases pinning a
 * boundary keep their literals — the literal is the assertion there.
 */
const wholeRung = (running: number) =>
	suiteRungMb((running + 1) * WHOLE_SUITE_WORKERS);
const ladder1 = () => wholeRung(0);
const ladder2 = () => wholeRung(1);
const ladder3 = () => wholeRung(2);
/** Strictly between two rungs, so a case stays in band when either moves. */
const between = (lo: number, hi: number) => Math.floor((lo + hi) / 2);
/** Clears the one-suite floor and misses the two-suite rung. */
const inBand2 = () => between(ladder1(), ladder2());
/** Clears the two-suite rung and misses the three-suite one. */
const inBand3 = () => between(ladder2(), ladder3());

/** The stamp the fake clock gives every stand-down. */
const NOW = "2026-10-25T10:00:00.000Z";

/** The two rules the ladder cases pre-latch. */
const LADDER_LATCHES: Record<string, string> = {
	"suite-tree-dirty": "",
	"memory-figure": "",
};

/* What one case's calls accumulate. */
let logs: string[];
let standdowns: string[];
/** package.json's `scripts`; null where the host has no package.json. */
let pkg: Record<string, string> | null;
/** The host's declared `suiteRunners`. */
let runners: string[];
/** Whether the stand-down log refuses the append. */
let appendFails: boolean;
/** The argv each `fullLaunchPlain` call was asked about. */
let asked: string[][];

beforeEach(() => {
	logs = [];
	standdowns = [];
	pkg = null;
	runners = [];
	appendFails = false;
	asked = [];
});

interface Over {
	mb?: number | null;
	ps?: string | null;
	vars?: Record<string, string>;
	declaredTest?: string | null;
	modules?: string[];
	told?: string[];
	latches?: Record<string, string>;
	plain?: Plain;
	carriedOf?: (pid: number | null) => Weight | null;
	launchWeight?: Weight | null;
}

/** A context of fakes: a quiet machine, no package.json, no config. */
function harness(over: Over = {}) {
	return kitContextFake({
		cwd: "/repo",
		vars: over.vars ?? {},
		moduleOn: (m: string) => (over.modules ?? ["suites"]).includes(m),
		log: (what: string, detail?: string) =>
			logs.push(detail ? `${what}\t${detail}` : what),
		told: (id: string) => (over.told ?? []).includes(id),
		readLatch: (name: string) => (over.latches ?? LADDER_LATCHES)[name] ?? null,
		availableMb: () => (over.mb === undefined ? ROOMY_MB : over.mb),
		psRows: () => {
			const text = over.ps === undefined ? psWith(0) : over.ps;
			return text
				? text.split("\n").map((args) => ({ pid: null, args }))
				: null;
		},
		carriedOf: over.carriedOf ?? (() => null),
		launchWeight: over.launchWeight ?? null,
		runners: () => runners,
		isWrapperScript: (script: string) =>
			pkg === null ? true : hasWrapperCall(pkg[script] ?? null),
		declaredTest: () =>
			over.declaredTest === undefined ? null : over.declaredTest,
		fullLaunchPlain: (argv: string[]) => {
			asked.push(argv);
			return over.plain ?? { plain: false };
		},
		appendStanddown: (line: string) => {
			if (appendFails) return false;
			standdowns.push(line);
			return true;
		},
		now: () => NOW,
		session: "test",
	});
}

const ESCAPED = { WFC_SUITE_CONCURRENT: "1" };

/** What the verdict hands the session: the deny's reason, or its own text. */
const textOf = (v: Verdict) => v?.deny ?? v?.prelude ?? "";

/** The verdict as the spawned guard's output read. */
const outcome = (v: Verdict) => {
	if (v && "deny" in v) return "deny";
	return v?.prelude ? "warn" : "allow";
};

/** The ids a verdict hands over: requested, less skipped. */
const handed = (v: Verdict) =>
	(v?.injectRules ?? []).filter((id) => !(v?.skip ?? []).includes(id));

/** Every stand-down the core recorded in this case. */
const readStanddowns = () => standdowns.map((l) => JSON.parse(l));

/** Every fail-open record the core logged in this case. */
const readRecords = () => logs.join("\n");

/** A `ps` listing whose every line is `args`, one per process. */
const psListing = (args: string[]) => `${args.join("\n")}\n`;

/**
 * A `ps` listing of `n` one-shot suites plus `watchers` open watchers
 * (mantahostels#1906; the watcher arm is mantahostels#1927), behind two
 * lines that mention the words but are not runners, present in every
 * listing: they pin that the count is anchored on the `.bin/` path.
 */
const psWith = (n: number, watchers = 0) =>
	psListing([
		"bash -l",
		"sh -c NODE_OPTIONS=--max-old-space-size=2048 vitest run",
		"node /r/node_modules/.bin/vitest-not-vitest run",
		...Array.from({ length: n }, () => "node /r/node_modules/.bin/vitest run"),
		// An open watcher: `npm run test:watch` is `vitest` with no subcommand,
		// so its runner line ends at the binary (mantahostels#1927).
		...Array.from(
			{ length: watchers },
			() => "node /r/node_modules/.bin/vitest",
		),
	]);

/** The verdict for `command`, `ps` null where it cannot be read. */
const judge = (
	command: string,
	mb: number | null,
	ps: string | null,
	over: Over = {},
) => {
	const verdict = decide(command, harness({ mb, ps, ...over }));
	return { verdict, text: textOf(verdict) };
};

/** An escaped launch against an arbitrary `ps` listing. */
const withPs = (command: string, mb: number, ps: string | null) =>
	judge(command, mb, ps, { vars: ESCAPED });

/** Runs `command` with MemAvailable unreadable — the core's fail-open branch. */
const failOpen = (command: string) => judge(command, null, psWith(0));

/** Sets the escape (`WFC_SUITE_CONCURRENT=1`), standing both denies down, so the ladder's warn is tested with neighbours running. */
const run = (command: string, mb: number, suites = 0, watchers = 0) =>
	withPs(command, mb, psWith(suites, watchers));

/** The same launch with the count cap live: no escape in the environment. */
const gated = (command: string, mb: number, suites = 0, watchers = 0) =>
	gatedOn(command, mb, psWith(suites, watchers));

/** `gated` against an arbitrary `ps` listing. */
const gatedOn = (command: string, mb: number, ps: string | null) =>
	judge(command, mb, ps);

/*
 * Every deny's first line is what to run instead (#519): the command's own
 * launch with `--queue`, or — where the queue cannot apply — the wait, then
 * that launch.
 */
const expectFixFirst = (command: string, reason: string) => {
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

/** The verdict of a judged launch, a deny's line one checked on the way. */
const fixChecked = (v: Verdict, command: string) => {
	if (v?.deny !== undefined) expectFixFirst(command, v.deny);
	return outcome(v);
};

/** Like `verdict`, but "deny" is a verdict rather than a thrown error. */
const gatedVerdict = (command: string, mb: number, suites = 0, watchers = 0) =>
	fixChecked(gated(command, mb, suites, watchers).verdict, command);

const readDenyReason = (
	command: string,
	mb: number,
	suites = 0,
	watchers = 0,
) => {
	const v = gated(command, mb, suites, watchers).verdict;
	expect(v).toHaveProperty("deny");
	return v?.deny as string;
};

/** An escaped launch's warning text. */
const warning = (command: string, mb: number, suites = 0, watchers = 0) => {
	const v = run(command, mb, suites, watchers).verdict;
	expect(v).not.toHaveProperty("deny");
	expect(v?.prelude).toBeTruthy();
	return v?.prelude as string;
};

const verdict = (command: string, mb: number, suites = 0, watchers = 0) => {
	const v = run(command, mb, suites, watchers).verdict;
	if (v && "deny" in v) throw new Error("the core denied — it must never deny");
	return outcome(v);
};

describe("warns under the ~2900 MB resting floor (a whole suite's rung, #2772)", () => {
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
		expect(r.text).toMatch(/npm run test/);
		expect(r.text).toMatch(/1000 MB/);
	});

	/* The floor's derivation is on `suiteRungMb` in lib/suite-ladder.js
	 * (#1603). */
	it("warns at one MB under the floor and allows at the floor", () => {
		expect(verdict("npm run test", 2899)).toBe("warn");
		expect(verdict("npm run test", 2900)).toBe("allow");
	});
});

describe("the memory ladder queues a launch under its rung (#2305)", () => {
	it("denies a `npm run test` under the floor, line one its `--queue` form", () => {
		const reason = readDenyReason("npm run test", 1000);
		expect(reason.split("\n")[0]).toBe("Run instead: npm run test -- --queue");
		expect(reason).toMatch(
			/MemAvailable is 1000 MB, under the ~2900 MB docs\/environment\.md §6 says a test run needs resting/,
		);
		expect(reason).toMatch(/`--queue` waits for this gate to open/);
		expect(reason).toMatch(/`pretest` reaps finished sessions before the wait/);
	});

	/* The queue's poll reads the limb (lib/suite-queue.js, #2421); the kit
	 * sends the session the deny alone, which the boundary set pins. */
	it("names the limb each deny was reached on, for the queue's poll", () => {
		expect(gated("npm run test", 1000, 0).verdict?.gate).toEqual({
			limb: "memory",
			mb: 1000,
			rungMb: 2900,
		});
		expect(
			gated("npm run test", ROOMY_MB, NEIGHBOURS_AT_CAP).verdict?.gate,
		).toEqual({ limb: "count" });
	});

	it("judges the rung the launch would reach", () => {
		expect(warning("npm run test", inBand2(), 1)).toMatch(
			/under the ~4000 MB .* as suite 2 of 3/,
		);
		expect(gatedVerdict("npm run test", inBand2(), 0)).toBe("allow");
	});

	it("refuses below the floor and allows at it", () => {
		expect(gatedVerdict("npm run test", 2899)).toBe("deny");
		expect(gatedVerdict("npm run test", 2900)).toBe("allow");
	});

	it("names the reap where the launch has no `pretest` of its own", () => {
		expect(readDenyReason("node scripts/run-vitest.js", 1000)).toMatch(
			/Reaping finished-but-resident sessions \(`node \S*reap-finished-sessions\.js`\)/,
		);
	});

	it("sends a non-vitest runner through queue-run.js", () => {
		expect(readDenyReason("pytest", 1000)).toMatch(/`queue-run\.js` waits/);
	});

	it("tells a watcher to free memory first, no queue taking one", () => {
		expect(readDenyReason("npm run test:watch", 1000).split("\n")[0]).toMatch(
			/^Reap finished sessions .* or wait for MemAvailable to reach ~2900 MB, then re-run: npm run test:watch/,
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
		expect(readStanddowns()).toHaveLength(1);
		expect(readStanddowns()[0]).toMatchObject({
			limb: "memory",
			running: 0,
			nth: 1,
		});
	});

	it("records an unread `ps` as no suite running", () => {
		expect(outcome(withPs("npm run test", 1000, null).verdict)).toBe("warn");
		expect(readStanddowns()[0]).toMatchObject({ limb: "memory", running: 0 });
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
		expect(run("npm run test:changed", inBand2(), 1).text).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("warns past the last measured rung", () => {
		expect(verdict("npm run test:changed", 9000, 3)).toBe("warn");
	});

	/* `package.json` runs `test:changed` through `run-vitest.js --changed`,
	 * which prepends `run`, so the runner line carries an argument after it. */
	it("counts a running `--changed` suite as a neighbour", () => {
		const p = psListing(["node /r/node_modules/.bin/vitest run --changed"]);
		expect(withPs("npm run test", inBand2(), p).text).toMatch(
			/as suite 2 of 3/,
		);
	});

	/* Telling a run that is already narrowed to narrow itself is a no-op. */
	it("drops the narrow-the-run advice, which it has already taken", () => {
		expect(run("npm run test:changed", 1000).text).toMatch(
			/already narrowed as far as it goes/,
		);
		expect(run("npm run test:changed", 1000).text).not.toMatch(
			/narrow the run/,
		);
		expect(run("npm run test -- --full", 1000).text).toMatch(/narrow the run/);
	});

	/* A bare `npm run test` IS the narrowed run (mantahostels#3208), so the guard reads
	 * `--full` and nothing else as a whole-suite launch (mantahostels#3209). */
	it("reads a bare `npm run test` as narrowed and `--full` as the whole suite", () => {
		for (const cmd of ["npm run test", "npm test"]) {
			const out = run(cmd, 1000).text;
			expect(out).toMatch(/already narrowed as far as it goes/);
			expect(out).not.toMatch(/narrow the run/);
		}
		const full = run("npm run test -- --full", 1000).text;
		expect(full).toMatch(/or narrow the run/);
		expect(full).not.toMatch(/already narrowed as far as it goes/);
	});

	it("judges a `--full` launch as a bare `npm run test` was judged", () => {
		const out = run("npm run test -- --full", 1000).text;
		expect(out).toMatch(/reaps finished sessions before vitest starts/);
		expect(verdict("npm run test -- --full", 1000)).toBe("warn");
		expect(verdict("npm run test -- --full", 4000)).toBe("allow");
		expect(verdict("npm run test -- --full", 9000, 3)).toBe("warn");
	});

	/* The wrapper form is in SCOPE, so the reading has to hold there and on the
	 * `npm test` spelling too. */
	it("reads the wrapper form on the same flag", () => {
		for (const cmd of [
			"node scripts/run-vitest.js",
			"npm test -- --full",
			"node scripts/run-vitest.js --full",
		]) {
			const out = run(cmd, 1000).text;
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
		expect(run("npm run test:watch", 1000).text).toMatch(/or narrow the run/);
	});

	/* `test:changed` is no lever the deny or watcher text offers: a bare
	 * `npm run test` already selects on the diff (mantahostels#3209). */
	it("keeps `test:changed` out of the deny text and out of the watcher text", () => {
		expect(gated("npm run test", 8000, NEIGHBOURS_AT_CAP).text).not.toMatch(
			/test:changed/,
		);
		expect(run("npm run test:watch", 99_999, 0).text).not.toMatch(
			/test:changed/,
		);
	});

	it("tells both npm suite commands they reap for themselves, so the reading is not the thing to stop on", () => {
		for (const cmd of ["npm run test", "npm run test:changed"]) {
			const out = run(cmd, 1000).text;
			expect([cmd, out]).toEqual([
				cmd,
				expect.stringMatching(/does not say what the run will get/),
			]);
			expect(out).not.toMatch(/reap-finished-sessions\.js/);
		}
	});

	it("scopes the bare `npm test` form, which fires the same pretest", () => {
		const out = run("npm test", 1000).text;
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
				const out = run(cmd, mb, suites).text;
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
		expect(run("npm run test", 1000).text).toMatch(/LIVE neighbour/);
		expect(run("npm run build", 1000).text).toMatch(/LIVE neighbours/);
	});

	/* The direct wrapper and a build take no pre-script, so the hand reap is
	 * the only lever there. */
	it("hands the reap command to a run that has no pretest of its own", () => {
		for (const cmd of ["node scripts/run-vitest.js", "npm run build"]) {
			const out = run(cmd, 1000).text;
			expect(out).toMatch(/node scripts\/reap-finished-sessions\.js/);
			expect(out).not.toMatch(/reaps finished sessions before vitest starts/);
		}
	});
});

describe("counts an open watcher, and prices it as a full rung (mantahostels#1927)", () => {
	it("counts an open watcher as a neighbour", () => {
		expect(verdict("npm run test", inBand2(), 0, 0)).toBe("allow");
		expect(verdict("npm run test", inBand2(), 0, 1)).toBe("warn");
		expect(run("npm run test", inBand2(), 0, 1).text).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("counts watchers and one-shot runs into the same rung", () => {
		// Clears the 2-suite rung and misses the 3-suite one, so only a count
		// that adds the watcher to the run can produce this warning. In band
		// deliberately, not on the 2-suite rung itself.
		const mb = inBand3();
		expect(warning("npm run test", mb, 1, 0)).not.toMatch(/as suite 3 of 3/);
		expect(verdict("npm run test", mb, 1, 1)).toBe("warn");
		expect(run("npm run test", mb, 1, 1).text).toMatch(/as suite 3 of 3/);
	});

	it("puts a launch past the cap when watchers make up the count", () => {
		expect(verdict("npm run test", 99_999, 0, 3)).toBe("warn");
		expect(run("npm run test", 99_999, 0, 3).text).toMatch(/would be suite 4/);
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
		const out = run("npm run test", 99_999, 0, 4).text;
		expect(out).toMatch(/Every one of them is an open watcher/);
		expect(out).not.toMatch(/Wait for one to finish/);
	});

	it("still offers the wait where a one-shot run is among the neighbours", () => {
		const out = run("npm run test", 99_999, 2, 2).text;
		expect(out).toMatch(
			/Wait for a one-shot run to finish, or close one of the 2/,
		);
	});

	it("keeps the plain wait advice when no watcher is running", () => {
		expect(run("npm run test", 99_999, 4, 0).text).toMatch(
			/Wait for one to finish/,
		);
	});
});

describe("tells the two spellings of a one-shot apart (mantahostels#1927)", () => {
	/* `vitest --run` is the form vitest's own docs lead with, and it finishes
	 * like any other one-shot — filing it as a watcher would tell a session to
	 * close a neighbour's run that was about to end on its own. */
	it("counts a `--run` suite as a one-shot, not a watcher", () => {
		const ps = psListing(
			Array.from({ length: 4 }, () => "node /r/node_modules/.bin/vitest --run"),
		);
		const out = withPs("npm run test", 99_999, ps).text;
		expect(out).toMatch(/would be suite 5/);
		expect(out).toMatch(/Wait for one to finish/);
		expect(out).not.toMatch(/open watcher/);
	});

	/* vitest's CLI is cac-parsed, so the subcommand need not come first. */
	it("counts a one-shot whose subcommand follows an option", () => {
		const ps = psListing(
			Array.from(
				{ length: 3 },
				() => "node /r/node_modules/.bin/vitest --silent --run",
			),
		);
		const out = withPs("npm run test", 99_999, ps).text;
		expect(out).toMatch(/would be suite 4/);
		expect(out).toMatch(/Wait for one to finish/);
		expect(out).not.toMatch(/open watcher/);
	});

	/* The subcommand is looked for anywhere in the tail, so an explicit
	 * `--watch` has to win over it — otherwise a watcher reads as a one-shot
	 * and the session is told to wait for something that never ends. */
	it("keeps a watcher a watcher when `run` appears later in its argv", () => {
		const ps = psListing(
			Array.from(
				{ length: 4 },
				() => "node /r/node_modules/.bin/vitest --watch -t run",
			),
		);
		const out = withPs("npm run test", 99_999, ps).text;
		expect(out).toMatch(/Every one of them is an open watcher/);
		expect(out).not.toMatch(/Wait for one to finish/);
	});

	it("still counts it toward the rung", () => {
		const ps = psListing(["node /r/node_modules/.bin/vitest --run --changed"]);
		expect(withPs("npm run test", inBand2(), ps).text).toMatch(
			/as suite 2 of 3/,
		);
	});

	/* The class the header declines to fix: the anchor matches a line that only
	 * names the binary, so a `less` on it is counted as a suite. Pinned so the
	 * declined tightening cannot land unnoticed. */
	it("counts a line that merely names the binary, as the header says it does", () => {
		const ps = psListing(
			Array.from({ length: 3 }, () => "less /r/node_modules/.bin/vitest"),
		);
		expect(withPs("npm run test", 99_999, ps).text).toMatch(/would be suite 4/);
	});

	/* It costs the right rung; only the close-it advice is wrong. */
	it("still misfiles `--watch=false`, as the header says it does", () => {
		const ps = psListing(
			Array.from(
				{ length: 4 },
				() => "node /r/node_modules/.bin/vitest --watch=false",
			),
		);
		expect(withPs("npm run test", 99_999, ps).text).toMatch(/open watcher/);
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
		expect(withPs("npm run test", inBand2(), psListing(wrapped)).text).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("skips every shell and unwrap wrapper as argv[0]", () => {
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
		const ps = psListing([...lines, `node ${runLine}`]);
		expect(withPs("npm run test", inBand2(), ps).text).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("skips a wrapped watcher too, so it is not filed as a second watcher", () => {
		const watch = "node_modules/.bin/vitest";
		const ps = psListing(
			Array.from({ length: 3 }, (_, i) => [
				`/bin/bash -c ${watch}`,
				`node /r${i}/${watch}`,
			]).flat(),
		);
		const out = withPs("npm run test", 99_999, ps).text;
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
			psListing([runLine, runLine, listLine]),
		).text;
		expect(out).toMatch(/as suite 3 of 3/);
		expect(out).not.toMatch(/open watcher/);
	});

	it("still counts a run whose `-t` filter is the word list", () => {
		const ps = psListing([runLine, runLine, `${runLine} -t list`]);
		expect(withPs("npm run test", 99_999, ps).text).toMatch(/would be suite 4/);
	});
});

describe("judges a `npm run test:watch` launch (mantahostels#1927)", () => {
	/* Opening a watcher runs the whole suite immediately, so the launch costs a
	 * full run before it costs anything for holding. */
	it("warns under the one-suite floor, as a full run does, quoting the free memory", () => {
		const out = run("npm run test:watch", 1000).text;
		expect(out).toMatch(/MemAvailable is 1000 MB/);
		expect(out).toMatch(/needs resting/);
	});

	it("takes the rung the running count reaches", () => {
		expect(run("npm run test:watch", inBand2(), 1).text).toMatch(
			/as suite 2 of 3/,
		);
	});

	it("warns even with headroom to spare, because the rung is held not spent", () => {
		expect(verdict("npm run test:watch", 99_999, 0)).toBe("warn");
		const out = run("npm run test:watch", 99_999, 0).text;
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
		expect(out).toMatch(/The command: npm run test:watch/);
		// The command stays LAST, as it is in every other warning here.
		expect(out.trimEnd()).toMatch(/npm run test:watch[^a-z]*$/);
	});

	/* A warning ends the decision, so the guard emits at most one message: the watcher's cost
	 * rides as a limb on whichever warning fires rather than as a second one. */
	it("carries the watcher limb on the headroom warning too", () => {
		const out = run("npm run test:watch", 1000).text;
		expect(out).toMatch(/MemAvailable is 1000 MB/);
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
		expect(out).toMatch(
			/when you stop iterating\. The command: npm run test:watch/,
		);
		expect(out.match(/holds a full rung/g)?.length).toBe(1);
	});

	it("carries it on the over-cap warning too", () => {
		const out = run("npm run test:watch", 99_999, 3).text;
		expect(out).toMatch(/would be suite 4/);
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
	});

	/* A watcher has no `pretest`, so it reaches vitest with the finished
	 * sessions still resident. */
	it("hands it the reap command, not the reaps-for-itself lever", () => {
		const out = run("npm run test:watch", 1000).text;
		expect(out).toMatch(/node scripts\/reap-finished-sessions\.js/);
		expect(out).not.toMatch(/reaps finished sessions before vitest starts/);
	});
});

describe("carries the watcher limb across a compound command (mantahostels#1978)", () => {
	/* A pre-pass finds the watcher before any segment is judged, so the limb
	 * rides on the build's warning instead of being lost. */
	it("puts the limb on an earlier segment's headroom warning", () => {
		const out = run("npm run build && npm run test:watch", 1000).text;
		expect(out).toMatch(/a build run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
		expect(out).toMatch(/holds a full rung for as long as it stays open/);
		// Still one message, not one per segment.
		expect(out.match(/holds a full rung/g)?.length).toBe(1);
	});

	/* The reader is being told to close something the warning's own command
	 * never opens. */
	it("names the watcher's segment, while the warning names its own", () => {
		const out = run("npm run build && npm run test:watch", 1000).text;
		expect(out).toMatch(/WATCHER \(`npm run test:watch`\)/);
		expect(out.trimEnd()).toMatch(/The command: npm run build[^a-z]*$/);
	});

	it("does it for an earlier `npm run test` segment too", () => {
		const out = run("npm run test && npm run test:watch", 1000).text;
		expect(out).toMatch(/a test run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
	});

	it("leaves the first-person limb on the watcher's own segment", () => {
		const out = run("npm run build && npm run test:watch", 99_999).text;
		expect(out).toMatch(/This opens a WATCHER, which runs the whole suite/);
		expect(out).not.toMatch(/Another segment/);
		expect(out.trimEnd()).toMatch(/The command: npm run test:watch[^a-z]*$/);
	});

	/* The pre-pass reads the command's words rather than the script name. */
	it("puts the limb on a bare `npm test` segment", () => {
		const out = run("npm test && npm run test:watch", 1000).text;
		expect(out).toMatch(/a test run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
	});

	/* The cost of deciding the limb command-wide: `||` is flattened like any
	 * other separator, so the limb is hung off a segment whose watcher opens
	 * only if the build fails. Pinned as a known wrong answer. */
	it("hangs the limb off a `||` branch that may never run", () => {
		const out = run("npm run build || npm run test:watch", 1000).text;
		expect(out).toMatch(/a build run needs resting/);
		expect(out).toMatch(/Another segment of this command opens a WATCHER/);
	});

	it("adds no limb to a compound that opens no watcher", () => {
		const out = run("npm run build && npm run test", 1000).text;
		expect(out).toMatch(/needs resting/);
		expect(out).not.toMatch(/WATCHER/);
	});
});

describe("fails open", () => {
	it("allows unchecked where MemAvailable cannot be read", () => {
		expect(failOpen("npm run test").verdict).toBeNull();
	});

	it("records that fail-open", () => {
		failOpen("npm run test");
		expect(readRecords()).toContain("MemAvailable unreadable");
	});

	/* The paired negative: a run that reads MemAvailable records nothing, so a
	 * guard logging on every call could not pass the case above vacuously. */
	it("records nothing when MemAvailable reads fine, warn or allow", () => {
		expect(verdict("npm run test", 1000)).toBe("warn");
		expect(verdict("npm run test", 4000)).toBe("allow");
		expect(readRecords()).toBe("");
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
		expect(warning("npm run test", inBand3(), 1)).not.toMatch(
			/as suite 3 of 3/,
		);
		expect(warning("npm run test", inBand3(), 2)).toMatch(/as suite 3 of 3/);
	});

	it("warns past the cap however much memory is free, naming the suite count and the one-at-a-time rule", () => {
		expect(verdict("npm run test", 99_999, 1)).toBe("warn");
		const r = run("npm run test", 99_999, 1);
		expect(r.text).toMatch(/would be suite 2/);
		expect(r.text).toMatch(/runs whole suites one at a time/);
	});

	/* Inside the ladder the escaped launch's rung still speaks first, the
	 * one-at-a-time warn standing only once it is met. */
	it("warns one at a time, not on memory, at each rung its headroom meets", () => {
		for (const [mb, suites] of [
			[4000, 1],
			[5750, 2],
		]) {
			const out = warning("npm run test", mb, suites);
			expect(out).toMatch(/one at a time/);
			expect(out).not.toMatch(/MemAvailable is/);
		}
	});

	it("names the rung it judged the launch on, and the figure it used", () => {
		expect(run("npm run test", inBand2(), 1).text).toMatch(/as suite 2 of 3/);
		expect(run("npm run test", inBand2(), 1).text).toMatch(/~4000 MB/);
		expect(run("npm run test", inBand3(), 2).text).toMatch(/~5750 MB/);
	});

	/* A build is not on the ladder — §6 measured vitest — so it keeps the
	 * one-suite floor and running suites neither raise its rung nor count it. */
	it("leaves a build on the one-suite floor whatever is running", () => {
		expect(verdict("npm run build", inBand2(), 3)).toBe("allow");
		expect(verdict("next build", 1000, 0)).toBe("warn");
	});

	/** The deny's reason with `lines` running, or null where it allowed. */
	const reasonFor = (command: string, lines: string[]) =>
		withPs(command, ROOMY_MB, psListing(["bash -l", ...lines])).verdict?.deny ??
		null;

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

		it("does not count npm's own `npm run build` and `sh -c next build` lines", () => {
			expect(
				reasonFor("npm run build", ["npm run build", "sh -c next build"]),
			).toBeNull();
		});

		it("does not count a wrapper's line around the runner, only the runner's own", () => {
			expect(
				reasonFor("npm run build", [
					"timeout 600 /r/node_modules/.bin/next build",
				]),
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
		expect(gatedOn("npm run test", 1000, null).text).toMatch(/1000 MB/);
		expect(readRecords()).toContain(
			"ps unreadable — a suite launch judged as if no suite were running",
		);
	});

	/* The watcher limb is built before the count is read, so an unreadable `ps`
	 * must still deliver it rather than dying on the empty two-field read
	 * (mantahostels#1927). */
	it("still warns a watcher launch when ps cannot be read, recording ps as unreadable", () => {
		const r = withPs("npm run test:watch", 99_999, null);
		expect(r.text).toMatch(/This opens a WATCHER/);
		expect(readRecords()).toContain("ps unreadable");
	});

	it("treats a genuine zero count as a successful read, recording nothing", () => {
		expect(verdict("npm run test", 1000, 0)).toBe("warn");
		expect(readRecords()).toBe("");
	});

	/* One `npm run test` puts both an `sh -c ... vitest run` wrapper and the
	 * `.bin/vitest run` runner in ps. */
	it("does not count the npm wrapper line as a second suite", () => {
		// One runner + its wrapper decoy. Counted once, this is suite 2, whose
		// 2-suite rung this misses; counted twice it would read as suite 3.
		expect(run("npm run test", inBand2(), 1).text).toMatch(/as suite 2 of 3/);
	});

	/* The workers are per-suite children and would multiply the count by
	 * maxWorkers; only the runner process is one-per-suite. */
	it("counts the runner, not its worker children", () => {
		const p = psListing([
			"node /r/node_modules/.bin/vitest run",
			...new Array(6).fill("node /r/node_modules/vitest/dist/workers/forks.js"),
		]);
		// One runner + this launch = suite 2, whose 2-suite rung this misses.
		expect(withPs("npm run test", inBand2(), p).text).toMatch(
			/as suite 2 of 3/,
		);
	});
});

describe("the count cap denies a second whole suite (#2680, #155)", () => {
	it("denies a `npm run test` with the ladder's last rung already taken", () => {
		// exempt (mantahostels#2082): deny reason pinned by the "what the refusal tells the session" describe block —
		// this is the exact case readDenyReason() below is called with.
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

	it("denies the second and the third, one whole suite running at a time", () => {
		expect(gatedVerdict("npm run test", 8000, 1)).toBe("deny");
		expect(gatedVerdict("npm run test", 8000, 2)).toBe("deny");
	});

	it("allows a part-suite beside a whole suite", () => {
		expect(
			gatedVerdict(
				"npm run test -- scripts/a.test.ts",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("allow");
	});

	/* A launch naming its files is a touched run, never held at the cap
	 * (#2935); the line binds a running run that carries no record. */
	it("keeps the part-suite line at WHOLE_SLOT_BOUND, not at WHOLE_SUITE_WORKERS (#2931)", () => {
		const at = (command: string, ps: string) =>
			outcome(judge(command, ROOMY_MB, ps).verdict);
		const running = (n: number) =>
			psListing([`node /r/node_modules/.bin/vitest run ${namedFiles(n)}`]);
		expect(at("npm run test -- --full=flag", running(WHOLE_SLOT_BOUND))).toBe(
			"deny",
		);
		expect(
			at("npm run test -- --full=flag", running(WHOLE_SLOT_BOUND - 1)),
		).toBe("allow");
	});

	describe("weighs a running run by the weight its launch record carries (#2931)", () => {
		/* A `--changed` or full run's runner line names no file. */
		const listing = psListing(["node /r/node_modules/.bin/vitest run"]);
		const at = (weight: Weight | null) =>
			outcome(
				judge("npm run test -- --full=flag", ROOMY_MB, listing, {
					carriedOf: () => weight,
				}).verdict,
			);

		it("seats a whole suite beside a run carrying a part-suite's weight", () => {
			expect(at({ resolvedFiles: 40, wholeSlot: false })).toBe("allow");
		});

		it("holds it behind one carrying the whole slot", () => {
			expect(at({ resolvedFiles: 485, wholeSlot: true })).toBe("deny");
		});

		it("weighs a run carrying no record by its runner line", () => {
			expect(at(null)).toBe("deny");
		});
	});

	describe("never holds a touched run at the count cap (#2935)", () => {
		const oneWhole = psListing(["node /r/node_modules/.bin/vitest run"]);
		const at = (command: string, modules = ["suites"]) =>
			outcome(judge(command, ROOMY_MB, oneWhole, { modules }).verdict);
		const named200 = Array.from(
			{ length: 200 },
			(_, i) => `scripts/t${i}.test.ts`,
		).join(" ");

		it("seats a 200-file named run beside a whole suite", () => {
			expect(at(`npm run test -- ${named200}`)).toBe("allow");
			expect(at(`node scripts/run-vitest.js ${named200}`)).toBe("allow");
		});

		it("seats a `--retest` beside it", () => {
			expect(at("npm run test -- --retest scripts/a.test.ts")).toBe("allow");
		});

		it("seats the bare default under `landing`, and holds it with `landing` off", () => {
			expect(at("npm run test", ["suites", "landing"])).toBe("allow");
			expect(at("npm run test")).toBe("deny");
		});

		it("holds a `--changed` or `--full` run, which is no touched run", () => {
			expect(at("npm run test -- --changed", ["suites", "landing"])).toBe(
				"deny",
			);
			expect(at("npm run test -- --full=flag", ["suites", "landing"])).toBe(
				"deny",
			);
		});

		it("still charges a bare touched run, its files unresolved, a whole suite's rung", () => {
			const alone = (command: string) =>
				outcome(
					judge(command, 2000, psWith(0), { modules: ["suites", "landing"] })
						.verdict,
				);
			expect(alone("npm run test")).toBe("deny");
			expect(alone("npm run test -- scripts/a.test.ts")).toBe("allow");
		});
	});

	describe("weighs the queue's launch by the weight it carries (#2931)", () => {
		const oneWhole = psListing(["node /r/node_modules/.bin/vitest run"]);
		const at = (weight: Weight) =>
			outcome(
				judge("npm run test -- --changed", ROOMY_MB, oneWhole, {
					launchWeight: weight,
				}).verdict,
			);

		it("seats a `--changed` run resolving below the bound beside a whole suite", () => {
			expect(at({ resolvedFiles: 40, wholeSlot: false })).toBe("allow");
		});

		it("holds one resolving at the bound at the count cap", () => {
			expect(at({ resolvedFiles: WHOLE_SLOT_BOUND, wholeSlot: true })).toBe(
				"deny",
			);
		});
	});

	/* Asserts the output `EXEMPTED` only names: with the constant flipped to
	 * "allow", every case using it would still pass. Matching the warning's
	 * text keeps a memory warning from satisfying it. */
	it("draws the one-at-a-time warn where an exempted launch gets through", () => {
		const { verdict: v, text } = gated(
			"npm run test -- --queue",
			8000,
			NEIGHBOURS_AT_CAP,
		);
		expect(v).not.toHaveProperty("deny");
		expect(text).toMatch(
			/This would be suite 2 on a machine that runs whole suites one at a time/,
		);
	});

	it("denies a `npm run test:changed` too", () => {
		expect(gatedVerdict("npm run test:changed", 8000, NEIGHBOURS_AT_CAP)).toBe(
			"deny",
		);
	});

	/* #1528: lib/suite-launch.js reads a quoted script name as typed. */
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
		expect(gatedOn("npm run test", 8000, null).verdict).not.toHaveProperty(
			"deny",
		);
	});

	describe("what the refusal tells the session", () => {
		const reason = () =>
			readDenyReason("npm run test", 8000, NEIGHBOURS_AT_CAP);

		it("says the machine runs one at a time", () => {
			expect(reason()).toContain(
				"1 whole suite(s) already running, and the machine runs one at a time",
			);
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
					readDenyReason(command, 8000, NEIGHBOURS_AT_CAP).split("\n")[0],
					command,
				).toBe(`Run instead: ${fix}`);
		});

		/* Handing back the launch alone would drop the `cd` ahead of it. */
		it("tells a compound command to keep its other parts", () => {
			expect(
				readDenyReason(compound, 8000, NEIGHBOURS_AT_CAP).split("\n")[0],
			).toBe(
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
				const first = readDenyReason(command, 8000, NEIGHBOURS_AT_CAP).split(
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
				readDenyReason("npm run test:watch", 8000, NEIGHBOURS_AT_CAP).split(
					"\n",
				)[0],
			).toBe(
				"Wait for one to finish, then re-run: npm run test:watch — a watcher never finishes, so no queue takes it.",
			);
		});

		it("names the escape", () => {
			expect(reason()).toContain("WFC_SUITE_CONCURRENT=1");
		});

		/* The rest is cut to what changes the next call (#519); the entry's
		 * header holds it, which the boundary set pins. */
		it("keeps its reasons out of the deny", () => {
			expect(reason()).not.toContain("TWO AND THREE ARE NOT REFUSED");
		});

		it("tells a session waiting on watchers alone that they never finish", () => {
			const r = readDenyReason("npm run test", 8000, 0, NEIGHBOURS_AT_CAP);
			expect(r).toContain("never finishes on its own");
		});
	});
});

describe("`--queue` is a lever a session may choose (mantahostels#2024, #155)", () => {
	it("never refuses a queued launch, whatever the count", () => {
		expect(
			gatedVerdict("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP),
		).toBe(EXEMPTED);
		expect(
			gatedVerdict("npm run test -- --queue", 8000, NEIGHBOURS_PAST_LADDER),
		).toBe(EXEMPTED);
		expect(gatedVerdict("npm run test -- --queue", 8000, 0)).toBe("allow");
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
		const out = gated("npm run test", 8000, NEIGHBOURS_AT_CAP).text;
		expect(out).toMatch(/--queue/);
		expect(out).toMatch(/Do not write your own waiter/);
	});
});

describe("`--queue` only where package.json's script runs run-vitest.js (#552)", () => {
	const scripts = (body: string, name = "test") => {
		pkg = { [name]: body };
	};

	it("offers an adopter's plain-vitest `test` queue-run.js, not the flag (#1776)", () => {
		scripts("vitest run");
		expect(readDenyReason("npm run test", 8000, NEIGHBOURS_AT_CAP)).toMatch(
			/^Run instead: node scripts\/queue-run\.js -- npm run test\n/,
		);
	});

	it("exempts no `--queue` the plain script would refuse, and re-issues the launch through queue-run.js without it", () => {
		scripts("vitest run");
		expect(
			gatedVerdict("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP),
		).toBe("deny");
		expect(
			readDenyReason("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP),
		).toMatch(/^Run instead: node scripts\/queue-run\.js -- npm run test\n/);
		expect(
			readDenyReason(
				"npm run test -- --queue --changed",
				8000,
				NEIGHBOURS_AT_CAP,
			),
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
					readDenyReason(command, 8000, NEIGHBOURS_AT_CAP).split("\n")[0],
					`${body}: ${command}`,
				).toBe(wait);
			expect(
				readDenyReason(
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
		expect(readDenyReason("npm run test", 8000, NEIGHBOURS_AT_CAP)).toMatch(
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
		).toBe("allow");
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js scripts/foo.test.ts",
				8000,
				NEIGHBOURS_PAST_LADDER,
			),
		).toBe("warn");
	});

	it("never refuses a bounded run carrying flags around the path", () => {
		expect(
			gatedVerdict(
				'node scripts/run-vitest.js scripts/foo.test.ts -t "a name"',
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("allow");
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js -t foo scripts/foo.test.ts",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("allow");
		expect(
			gatedVerdict(
				"node scripts/run-vitest.js 'scripts/foo.test.ts'",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("allow");
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
	const atBound = namedFiles(WHOLE_SLOT_BOUND);

	/* A named run is a touched run, never held at the cap, at the whole-slot
	 * bound or past it (#2935). */
	it.each([
		[two, "allow"],
		[three, "allow"],
		[namedFiles(WHOLE_SLOT_BOUND - 1), "allow"],
		[atBound, "allow"],
	])("beside a whole suite, `%s` gets %s", (files, want) => {
		expect(gatedVerdict(routes.npm(files), 8000, NEIGHBOURS_AT_CAP)).toBe(want);
	});

	describe.each(Object.entries(routes))("on the %s route", (_route, launch) => {
		it("passes a one-file run at 1,500 MB and refuses it at 1,400 MB with no suite running", () => {
			expect(gatedVerdict(launch(one), 1500, 0)).toBe("allow");
			expect(gatedVerdict(launch(one), 1400, 0)).toBe("deny");
		});

		it("refuses a run at the whole-slot bound under a whole suite's rung, never at the count cap (#2935)", () => {
			expect(gatedVerdict(launch(atBound), ladder1() - 1, 0)).toBe("deny");
			expect(gatedVerdict(launch(atBound), 8000, NEIGHBOURS_AT_CAP)).toBe(
				"allow",
			);
		});

		/* Past the ladder the rung is extrapolated, and the over-the-ladder warn
		 * still stands on a run the rung lets through. */
		it("passes a two-file run beside three suites at 6,450 MB and refuses it at 6,400 MB", () => {
			expect(gatedVerdict(launch(two), 6450, NEIGHBOURS_PAST_LADDER)).toBe(
				"warn",
			);
			expect(gatedVerdict(launch(two), 6400, NEIGHBOURS_PAST_LADDER)).toBe(
				"deny",
			);
		});
	});

	it("names the rung it judged a part-suite on, and hands back `--queue`", () => {
		const reason = readDenyReason(routes.npm(two), 1800 - 1, 0);
		expect(reason.split("\n")[0]).toBe(
			`Run instead: npm run test -- ${two} --queue`,
		);
		expect(reason).toMatch(
			/under the ~1800 MB .* for the 2 vitest worker\(s\) its named files can occupy, beside 0 running,/,
		);
	});

	/* §6's table, every cell: 794 MB + the dip + ~300 MB, rounded up to 50.
	 * Each running suite is a whole one, WHOLE_SUITE_WORKERS wide. */
	it.each([
		[0, one, 1450],
		[0, two, 1800],
		[0, three, 2150],
		[1, one, 3250],
		[1, two, 3400],
		[2, one, 4350],
		[2, two, 4700],
		[3, one, 6100],
		[3, two, 6450],
	])("with %i suites running rests `%s` on %i MB", (suites, files, rung) => {
		expect(gatedVerdict(routes.npm(files), rung, suites)).not.toBe("deny");
		expect(gatedVerdict(routes.npm(files), rung - 1, suites)).toBe("deny");
	});

	/* A whole suite beside another is past the count cap, so its rung speaks
	 * only on a launch the cap lets through: the escape here. */
	it.each([
		[1, wholeRung(1)],
		[2, wholeRung(2)],
	])(
		"with %i suites running rests an escaped whole suite on %i MB",
		(suites, rung) => {
			expect(warning("npm run test", rung, suites)).not.toMatch(
				/MemAvailable is/,
			);
			expect(warning("npm run test", rung - 1, suites)).toMatch(
				/MemAvailable is/,
			);
		},
	);

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
});

describe("a running vitest run is weighed by the workers its runner line names (#2560)", () => {
	const runner = (tail: string) => `node /r/node_modules/.bin/vitest${tail}`;
	const oneFile = runner(" run --passWithNoTests a.test.ts");
	const gatedWith = (command: string, mb: number, lines: string[]) =>
		outcome(gatedOn(command, mb, psListing(lines)).verdict);
	const full = "npm run test -- --full=flag";

	it("passes a whole launch beside one running 1-file run at 3,250 MB and refuses it at 3,200 MB", () => {
		expect(gatedWith(full, 3250, [oneFile])).toBe("allow");
		expect(gatedWith(full, 3200, [oneFile])).toBe("deny");
	});

	it("takes no slot of the count cap for three running 1-file runs, charging their workers alone", () => {
		const three = [oneFile, oneFile, oneFile];
		expect(gatedWith(full, 3500, three)).toBe("allow");
		expect(gatedWith(full, 3450, three)).toBe("deny");
	});

	it("weighs a running `-t foo a.test.ts` run at 1 worker", () => {
		const line = [runner(" run -t foo a.test.ts")];
		expect(gatedWith(full, 3250, line)).toBe("allow");
		expect(gatedWith(full, 3200, line)).toBe("deny");
	});

	/* The guard's rung against admission.js's `suiteRungMb`, between rungs and
	 * past 9 workers, where pretest-reap now judges. */
	const whole = runner(" run");
	it.each([
		[[oneFile], full, 6],
		[[oneFile, oneFile], full, 7],
		[[whole, whole, whole, oneFile], "npm run test -- scripts/a.test.ts", 17],
		[
			[whole, whole, whole, runner(" run a.test.ts b.test.ts")],
			"npm run test -- scripts/a.test.ts",
			18,
		],
	] as const)(
		"rests the launch on suiteRungMb's rung (case %#, %i workers)",
		(lines, command, workers) => {
			const reason = gatedOn(command, 1000, psListing([...lines])).text;
			expect(/under the ~(\d+) MB/.exec(reason)?.[1]).toBe(
				String(suiteRungMb(workers)),
			);
		},
	);

	it("names the workers it judged a whole launch on beside a part-suite", () => {
		expect(gatedOn(full, 2450, psListing([oneFile])).text).toContain(
			"needs resting for 6 vitest workers, 1 of them already running",
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
});

describe("records every stand-down of the count cap (mantahostels#2183)", () => {
	it("appends one record when the escape carries a launch past the deny", () => {
		expect(verdict("npm run test", 8000, NEIGHBOURS_AT_CAP)).toBe(EXEMPTED);
		expect(readStanddowns()).toHaveLength(1);
	});

	it("records a stand-down taken as a command prefix, not just in the environment", () => {
		expect(
			gatedVerdict(
				"WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe(EXEMPTED);
		expect(readStanddowns()).toHaveLength(1);
		expect(readStanddowns()[0].command).toBe(
			"WFC_SUITE_CONCURRENT=1 npm run test",
		);
	});

	/* The store must count overrides, and an override is a launch that HAPPENED
	 * (mantahostels#2486). */
	it.each([
		"WFC_SUITE_CONCURRENT=1 npm run test && npm run test",
		"npm run test && WFC_SUITE_CONCURRENT=1 npm run test",
	])("records one stand-down, and does not refuse, for `%s`", (command) => {
		expect(gatedVerdict(command, 8000, NEIGHBOURS_AT_CAP)).toBe(EXEMPTED);
		expect(readStanddowns()).toHaveLength(1);
	});

	it("carries the command, the count it saw and the rung it would have been", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(readStanddowns()[0]).toMatchObject({
			command: "npm run test",
			running: 1,
			nth: 2,
			limb: "count",
			session: "test",
		});
	});

	/* The marker store (`.test-pass-markers.jsonl`) shares no key with this one,
	 * so the join is by time — an unparseable stamp makes the record uncountable
	 * against it. */
	/* The clock's own format is the host's, which the boundary set pins. */
	it("stamps the clock's time, which is what joins it to a marker", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(readStanddowns()[0].at).toBe(NOW);
	});

	it("appends rather than replacing, so a session's overrides accumulate", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		run("npm run test:changed", 8000, NEIGHBOURS_AT_CAP);
		expect(readStanddowns().map((r) => r.command)).toEqual([
			"npm run test",
			"npm run test:changed",
		]);
	});

	it("records nothing for the first suite, which the deny never reached", () => {
		expect(verdict("npm run test", 8000, 0)).toBe("allow");
		expect(readStanddowns()).toEqual([]);
	});

	it("records nothing for a bounded wrapper run, exempt on its own account", () => {
		run(
			"node scripts/run-vitest.js scripts/foo.test.ts",
			8000,
			NEIGHBOURS_AT_CAP,
		);
		expect(readStanddowns()).toEqual([]);
	});

	it("records nothing for a queued launch, which obeys the gate", () => {
		run("npm run test -- --queue", 8000, NEIGHBOURS_AT_CAP);
		expect(readStanddowns()).toEqual([]);
	});

	it("records nothing for a build, which is off the ladder entirely", () => {
		run("npm run build", 8000, NEIGHBOURS_AT_CAP);
		expect(readStanddowns()).toEqual([]);
	});

	it("records nothing for a command that is neither a test nor a build", () => {
		run("echo hello", 8000, NEIGHBOURS_AT_CAP);
		expect(readStanddowns()).toEqual([]);
	});

	it("records nothing when the deny actually fires", () => {
		expect(gatedVerdict("npm run test", 8000, NEIGHBOURS_AT_CAP)).toBe("deny");
		expect(readStanddowns()).toEqual([]);
	});

	/* Unrecorded, and never refused — the launch reaching the one-at-a-time
	 * warn rather than a deny is the fail-open landing where it should. */
	it("fails open on an unwritable log, letting the launch through unrecorded", () => {
		appendFails = true;
		const r = run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(r.verdict).not.toHaveProperty("deny");
		expect(r.text).toMatch(
			/This would be suite 2 on a machine that runs whole suites one at a time/,
		);
	});

	it("still warns on the ladder after standing the deny down", () => {
		expect(verdict("npm run test", 1000, NEIGHBOURS_AT_CAP)).toBe("warn");
		expect(readStanddowns()).toHaveLength(1);
	});

	/* One hook fires per COMMAND, before any of it runs, so a second stand-down
	 * in the same command reads the same `ps` as the first and its `nth` would
	 * describe a machine state that never existed. */
	it("writes one record for a compound command, not one per segment", () => {
		run("npm run test && npm run test:changed", 8000, NEIGHBOURS_AT_CAP);
		expect(readStanddowns()).toHaveLength(1);
		expect(readStanddowns()[0].command).toBe("npm run test");
	});

	it("records the fail-open when the log cannot be appended to", () => {
		appendFails = true;
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(readRecords()).toContain("went uncounted");
	});

	it("says nothing to guard-errors.log when the append lands", () => {
		run("npm run test", 8000, NEIGHBOURS_AT_CAP);
		expect(readRecords()).toBe("");
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
		expect(readStanddowns()).toEqual([]);
	});

	it("takes no escape from a `bg-run.sh` job name", () => {
		expect(
			gatedVerdict(
				"scripts/bg-run.sh run WFC_SUITE_CONCURRENT=1 npm run test",
				8000,
				NEIGHBOURS_AT_CAP,
			),
		).toBe("deny");
		expect(readStanddowns()).toEqual([]);
	});

	/* The boundary the widened `carriesVar` could have broken: an escape
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
		expect(readStanddowns()).toHaveLength(1);
		expect(readStanddowns()[0].command).toBe(
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
			readDenyReason("env npm run test:watch", 8000, NEIGHBOURS_AT_CAP),
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
		expect(readStanddowns()).toHaveLength(1);
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
		expect(readStanddowns()).toHaveLength(1);
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
	const guardOut = (
		command: string,
		lines: string[],
		config?: { suiteRunners: string[] },
	) => {
		if (config) runners = config.suiteRunners;
		return gatedOn(command, ROOMY_MB, psListing(["bash -l", ...lines]));
	};
	const judged = (
		command: string,
		lines: string[],
		config?: { suiteRunners: string[] },
	) => fixChecked(guardOut(command, lines, config).verdict, command);

	it("counts running `node --test`, pytest and Python test files toward the cap", () => {
		for (const other of [
			nodeTest,
			"python3 -m pytest -n 2",
			"/home/u/.venv/bin/pytest scripts",
			"python3 scripts/footer_sources.test.py",
		])
			expect(judged("npm run test", [other])).toBe("deny");
	});

	it("counts a `node --test` run once, not once per child", () => {
		expect(
			guardOut("npm run test", [nodeTest, nodeChild, nodeChild]).text,
		).toMatch(/1 whole suite\(s\) already running/);
	});

	it("does not count a script that merely takes a --test argument, or inline code", () => {
		expect(
			judged("npm run test", [
				"node scripts/x.js --test",
				"python3 -c import sys;exec(eval(sys.stdin.readline()))",
				"python3 scripts/arctic_shift.py",
			]),
		).toBe("allow");
	});

	it("denies a second when the launch is itself one of them", () => {
		for (const launch of [
			"node --test scripts/a.test.js",
			"python3 scripts/footer_sources.test.py",
			"python3 -m pytest",
			"pytest -x",
		])
			expect(judged(launch, ["python3 scripts/b.test.py"])).toBe("deny");
		expect(judged("node --test scripts/a.test.js", [])).toBe("allow");
	});

	const readDenyLine = (command: string) =>
		gatedOn(command, ROOMY_MB, psListing([vitest, vitest, vitest])).verdict
			?.deny as string;

	it("hands the launch through queue-run.js, not `--queue` (#1776)", () => {
		const reason = readDenyLine("node --test scripts/a.test.js 2>&1");
		expect(reason.split("\n")[0]).toBe(
			"Run instead: node scripts/queue-run.js -- node --test scripts/a.test.js 2>&1",
		);
		expect(reason).not.toMatch(/run-vitest\.js's alone/);
		expect(reason).toMatch(/WFC_SUITE_CONCURRENT=1, which is recorded/);
	});

	it("puts queue-run.js behind the assignments and ahead of a wrapper", () => {
		expect(
			readDenyLine(
				`FOO=1 timeout 600 python3 scripts/b.test.py -k "a b"`,
			).split("\n")[0],
		).toBe(
			`Run instead: FOO=1 node scripts/queue-run.js -- timeout 600 python3 scripts/b.test.py -k "a b"`,
		);
		expect(readDenyLine("cd sub && pytest -x").split("\n")[0]).toBe(
			"Run the command with this launch in place of its own: node scripts/queue-run.js -- pytest -x",
		);
	});

	it("leaves a loop's or a condition's keyword out of the queued launch", () => {
		for (const command of [
			"for t in a b; do pytest -q; done",
			"if true; then pytest -q; fi",
			"true && { pytest -q; }",
		])
			expect(readDenyLine(command).split("\n")[0]).toBe(
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
				"node /p/scripts/queue-run.js -- node --test scripts/a.test.js",
			]),
		).toBe("allow");
	});

	it("reads them as one-shots, never as open watchers", () => {
		const r = gatedOn(
			"npm run test",
			ROOMY_MB,
			psListing([nodeTest, nodeTest, "python3 scripts/b.test.py"]),
		);
		expect(r.text).toMatch(/Run instead: npm run test -- --queue/);
		expect(r.text).not.toMatch(/watcher/);
	});

	it("counts and judges the host's declared suiteRunners", () => {
		const config = { suiteRunners: ["scripts/build-site.js"] };
		const build = "node /home/u/fb/scripts/build-site.js";
		expect(judged("npm run test", [build], config)).toBe("deny");
		expect(judged("node scripts/build-site.js", [vitest], config)).toBe("deny");
	});

	it("ignores a runner script no config declares", () => {
		const build = "node /home/u/fb/scripts/build-site.js";
		expect(judged("npm run test", [build])).toBe("allow");
		expect(judged("node scripts/build-site.js", [vitest, vitest, vitest])).toBe(
			"allow",
		);
	});
});

/*
 * THE PRE-EMPTIVE LIMBS (mantahostels#1805, #181, #2024, #2237), reached only
 * where nothing spoke. What the core asks for is read here: the ids it hands
 * over, the prelude ahead of them, the latch the limb takes. That each is said
 * once a session, the latch files being the kit's, is the boundary set's.
 */
const QUIET_MB = Math.floor(8_000_000 / 1024);
const QUIET_PS = "sleep 1\n";
const { readFullLaunchPlain } = require("./full-launch-plain.js") as {
	readFullLaunchPlain: (argv: string[]) => Plain;
};

/** The verdict on a quiet machine, every rule unlatched. */
const quiet = (command: string, over: Over = {}) =>
	decide(
		command,
		harness({ mb: QUIET_MB, ps: QUIET_PS, latches: {}, ...over }),
	);

describe("a suite launch on a quiet machine is handed the rule", () => {
	it.each([
		["npm run test", "the full suite"],
		["npm test", "the same script without `run`"],
		["npm run test:changed", "the narrowed run reads the same tree"],
	])("%s is handed suite-tree-dirty — %s", (command) => {
		const v = quiet(command);
		expect(v).not.toHaveProperty("deny");
		expect(handed(v)).toContain("suite-tree-dirty");
	});

	it("spends one id and stays far inside the ceiling", () => {
		// Fails once a second cluster fires on `npm run test` and shares the ceiling.
		const v = quiet("npm run test");
		expect(handed(v)).toEqual(["suite-tree-dirty"]);
		expect(v?.prelude).toBeUndefined();
		expect(
			Buffer.byteLength(readRuleText("suite-tree-dirty"), "utf8"),
		).toBeLessThan(4000);
	});
});

/*
 * MUTATION ANCHORS. A handed id reads the same file the kit does, so it moves
 * with a mutation to the fragment instead of catching it.
 *
 * Reads the fragment directly, not the emission (mantahostels#2230): a row over
 * the emission stops catching a clause moved to a second fragment once one
 * joins this trigger.
 *
 * The fragment is hard-wrapped at ~80 columns, so a clause straddles a newline
 * whenever a reflow moves it. Collapsing the fragment's whitespace pins the
 * words and never the wrapping — so a wrap CANNOT be pinned here.
 */
const carries = (clause: string) =>
	expect(readRuleText("suite-tree-dirty").replace(/\s+/g, " ")).toContain(
		clause,
	);

describe("the injected rule still carries its operative clauses", () => {
	it("a clause no fragment carries fails", () => {
		expect(() => carries("a clause no fragment carries")).toThrow();
	});

	it.each([
		["#273", "the incident, without which the rule is a bare assertion"],
		["globalSetup", "where the two messages come from"],
		["— GONE", "the marker on a claim nobody will release"],
		["re-run before believing the result", "the act it asks for"],
		["a dirty file under no claim at all", "the blind spot"],
	])("suite-tree-dirty keeps %s — %s", (clause) => {
		carries(clause);
	});
});

const FIGURE = (kind: string) =>
	`BEFORE THIS ${kind} RUN, MemAvailable reads ${QUIET_MB} MB.`;

describe("a build or a whole-suite launch is handed the memory figure (#2024)", () => {
	it.each([
		["npm run build", "a build", "BUILD"],
		["next build", "the direct form of one", "BUILD"],
		["npm run test -- --full=rule-edit", "the whole suite", "FULL TEST"],
		["npm run test:py", "the whole pytest suite", "FULL TEST"],
	])(
		"%s is handed the reading ahead of the rule — %s",
		(command, _why, kind) => {
			const v = quiet(command);
			expect(v?.prelude).toBe(FIGURE(kind));
			expect(handed(v)).toContain("memory-figure");
		},
	);

	it("a build is handed no suite-tree-dirty", () => {
		const v = quiet("npm run build");
		expect(handed(v)).toEqual(["memory-figure"]);
		expect(v?.prelude).toBe(FIGURE("BUILD"));
	});

	it.each([
		["npm run test", "the diff's selection, not the whole suite"],
		["npm run test:changed", "the explicit narrowed spelling"],
		[
			"npm run test:py -- scripts/lib/test_a.py",
			"a pytest run naming its file",
		],
		["npm run test:watch", "a watcher, which has no end to read after"],
	])("%s is handed no figure — %s", (command) => {
		const v = quiet(command);
		expect(v?.prelude ?? "").not.toContain("MemAvailable reads");
		expect(handed(v)).not.toContain("memory-figure");
	});

	/* The figure goes out with the rule's first telling alone. */
	it("hands no figure once the rule's latch is spent", () => {
		const v = quiet("npm run build", { latches: { "memory-figure": "" } });
		expect(v?.prelude).toBeUndefined();
		expect(v?.injectRules).toContain("memory-figure");
	});

	it("reads the figure off the first build or whole-suite launch in the command", () => {
		const v = decide(
			"npm run build && npm run test -- --full",
			harness({ mb: QUIET_MB, ps: QUIET_PS, latches: {} }),
		);
		expect(v?.prelude).toBe(FIGURE("BUILD"));
	});

	it("a short machine gets the headroom warn, which names the reading, and no rule", () => {
		const v = quiet("npm run build", { mb: Math.floor(100_000 / 1024) });
		expect(v?.prelude).toContain("MemAvailable is 97 MB");
		expect(handed(v)).toEqual([]);
	});
});

describe("things that are not a suite launch", () => {
	it.each([
		[
			"npm run test:py -- scripts/lib/test_a.py",
			"pytest is off the ladder, and a named file owes no figure",
		],
		["npm run lint", "not a test run"],
		["echo 'npm run test when green'", "prose about a run"],
	])("%s is handed nothing — %s", (command) => {
		expect(quiet(command)).toBeNull();
	});
});

describe("a warning outranks the injection, and leaves it unlatched", () => {
	it("a watcher launch is warned about and handed no rule, on any machine", () => {
		// THE ONE SUITE LAUNCH THAT NEVER GETS THIS RULE. `npm run test:watch`
		// always draws the watcher warning (mantahostels#1927) — it costs a rung
		// for as long as it is open — so the injection is unreachable on it
		// however quiet the machine. The rule is not spent: nothing is latched.
		const v = quiet("npm run test:watch");
		expect(v?.prelude).toContain("This opens a WATCHER");
		expect(v?.injectRules).toEqual([]);
		expect(v).not.toHaveProperty("latchAfter");
	});

	it("a short machine gets the headroom warn and no rule", () => {
		// A `--queue` launch, since a plain one is refused (#2305).
		const v = quiet("npm run test -- --queue", {
			mb: Math.floor(100_000 / 1024),
		});
		expect(v?.prelude).toContain("MemAvailable is");
		expect(v?.injectRules).toEqual([]);
	});
});

/* The plain-`--full` limb (#181). Its fire needle keys on this clause. */
const LIMB = "WOULD MEET THE PUSH GATE HERE";

/** A quiet launch whose limb is judged by the real port, its render half
 * standing at WFC_READ_GRAPH_RENDERS's `renders`. */
const limbed = (command: string, renders: "0" | "1", over: Over = {}) => {
	const was = process.env.WFC_READ_GRAPH_RENDERS;
	process.env.WFC_READ_GRAPH_RENDERS = renders;
	try {
		return decide(command, {
			...harness({ mb: QUIET_MB, ps: QUIET_PS, latches: {}, ...over }),
			fullLaunchPlain: (argv: string[]) => {
				asked.push(argv);
				return readFullLaunchPlain(argv);
			},
		});
	} finally {
		if (was === undefined) delete process.env.WFC_READ_GRAPH_RENDERS;
		else process.env.WFC_READ_GRAPH_RENDERS = was;
	}
};

describe("a plain --full over a tree whose read graph renders is told a bare run would do", () => {
	it.each([
		["npm run test -- --full", "the spelling the rule itself names"],
		["npm test -- --full", "the same script without `run`"],
		["node scripts/run-vitest.js --full", "the wrapper, reached directly"],
		[`npm "run" "test" -- --full`, "quoted words, read as typed (#1528)"],
	])("%s draws the limb — %s", (command) => {
		const v = limbed(command, "1");
		// A notice, not a refusal: the launch still goes ahead.
		expect(v).not.toHaveProperty("deny");
		expect(v?.prelude).toContain(LIMB);
		expect(v?.prelude).toContain("no whole-suite run is owed");
		expect(v?.prelude).toContain("not a refusal");
		expect(v?.latchAfter).toBe(FULL_LIMB_ID);
		expect(handed(v)).toContain("suite-tree-dirty");
	});

	it("asks the port about the launch's own argv, quoted words read as typed", () => {
		limbed(`npm "run" "test" -- --full`, "1");
		limbed("node scripts/run-vitest.js --full", "1");
		expect(asked).toEqual([["--", "--full"], ["--full"]]);
	});

	it("stays plain under every wrapper flag the launch carries (#188)", () => {
		const cmd = "npm run test -- --full=rule-edit --queue --isolated --shared";
		expect(limbed(cmd, "1")?.prelude).toContain(LIMB);
	});

	it("rides ahead of the memory figure in one prelude", () => {
		const prelude = limbed("npm run test -- --full", "1")?.prelude ?? "";
		expect(prelude.indexOf(LIMB)).toBeGreaterThanOrEqual(0);
		expect(prelude.indexOf(LIMB)).toBeLessThan(
			prelude.indexOf(FIGURE("FULL TEST")),
		);
	});

	it("still travels once suite-tree-dirty's own latch is spent", () => {
		// THE REASON THE LIMB HAS A LATCH OF ITS OWN. A session whose first
		// launch was narrowed has already spent the rule's latch, and the
		// `--full` it types later is exactly the launch this limb is for.
		const v = limbed("npm run test -- --full", "1", {
			latches: { "suite-tree-dirty": "" },
		});
		expect(v?.prelude).toContain(LIMB);
	});

	/* The render is paid once a session: a told limb never asks the port. */
	it("is unsaid, and the port unasked, once its own latch is told", () => {
		const v = limbed("npm run test -- --full", "1", {
			told: [FULL_LIMB_ID],
		});
		expect(v?.prelude ?? "").not.toContain(LIMB);
		expect(v).not.toHaveProperty("latchAfter");
		expect(asked).toEqual([]);
	});

	it("leaves the limb unsaid, on the record, where the port faults", () => {
		const v = quiet("npm run test -- --full", { plain: { fault: "boom" } });
		expect(v?.prelude ?? "").not.toContain(LIMB);
		expect(readRecords()).toContain(
			"the plain-`--full` check did not run — limb unsaid: boom",
		);
	});

	/* A LADDER WARN ON THE SAME LAUNCH OUTRANKS IT, and the limb lands on the
	 * next `--full`. */
	it("is outranked by a ladder warn on the same launch", () => {
		const v = limbed("npm run test -- --full --queue", "1", { mb: 1000 });
		expect(v?.prelude).toContain("MemAvailable is 1000 MB");
		expect(v?.prelude).not.toContain(LIMB);
		expect(asked).toEqual([]);
	});
});

describe("the limb is silent on everything else", () => {
	it.each([
		[
			"npm run test -- --full scripts/guard-suite-concurrency.test.ts",
			"named test files bound the run past the whole suite",
		],
		["npm run test -- --full -t nope", "a name filter narrows it further"],
		[
			"npm run test -- --full --testNamePattern=nope",
			"the long spelling of the same filter",
		],
		["npm run test -- --full --project unit", "a project filter, likewise"],
		["npm run test -- --full --project=unit", "and its `=` spelling"],
		["npm run test", "no --full at all: this run is already the diff's"],
		["npm run test:changed", "nor is the explicit narrowed spelling one"],
	])("%s draws no limb — %s", (command) => {
		expect(limbed(command, "1")?.prelude ?? "").not.toContain(LIMB);
	});

	it("is silent where the read graph will not render", () => {
		// The one case where `--full` is the right call: a bare run would
		// escalate to it anyway (#998).
		const v = limbed("npm run test -- --full", "0");
		expect(v?.prelude ?? "").not.toContain(LIMB);
		expect(handed(v)).toContain("suite-tree-dirty");
	});

	it("a watcher launch draws the watcher warning and no limb", () => {
		const v = limbed("npm run test:watch", "1");
		expect(v?.prelude).toContain("This opens a WATCHER");
		expect(v?.prelude).not.toContain(LIMB);
	});
});

describe("an adopter's whole-suite launch is handed rule:targeted-runs (#2237)", () => {
	const adopter = ({ test = "npm run test", script = "vitest run" } = {}) => {
		pkg = { test: script };
		return test;
	};
	const told = (command: string, declared: string, modules = ["suites"]) =>
		handed(quiet(command, { declaredTest: declared, modules })).includes(
			"targeted-runs",
		);

	it.each([
		["npm run test", "as declared"],
		["npm test", "the same script without `run`"],
		["npm t", "npm's alias for `test`"],
		["npm run-script test", "npm's alias for `run`"],
		["npm run test --", "a lone `--` narrows nothing"],
	])("%s is told — %s", (command) => {
		expect(told(command, adopter())).toBe(true);
	});

	it.each([
		["npm run test -- scripts/a.test.ts", "a named file"],
		["npm run test -- -t parses", "a name filter"],
		["npm run test:changed", "another script"],
	])("%s is not — %s", (command) => {
		expect(told(command, adopter())).toBe(false);
	});

	it("leads the ids, ahead of the suite-tree-dirty rule", () => {
		const v = quiet("npm run test", { declaredTest: adopter() });
		expect(handed(v)).toEqual(["targeted-runs", "suite-tree-dirty"]);
	});

	it("is silent with suites off", () => {
		expect(told("npm run test", adopter(), ["roadmap"])).toBe(false);
	});

	it("is silent where the declared command runs run-vitest.js, which selects from the diff", () => {
		expect(
			told("npm run test", adopter({ script: "node scripts/run-vitest.js" })),
		).toBe(false);
	});

	it("is silent where the host declares no test command", () => {
		adopter();
		expect(told("npm run test", "")).toBe(false);
	});

	it("reads a declared command other than an npm script", () => {
		const declared = adopter({ test: "node --test" });
		expect(told("node --test", declared)).toBe(true);
		expect(told("node --test a.test.js", declared)).toBe(false);
	});

	it.each(["yarn test", "npx vitest run"])(
		"%s, declared, is told (#2303)",
		(command) => {
			expect(told(command, adopter({ test: command }))).toBe(true);
		},
	);
});

describe("a bare `tsc` the type-check slot would hold is sent to `queue-run.js --tsc` (#3163)", () => {
	const { TSC_RUNG_MB } = require("./tsc-slot.js") as { TSC_RUNG_MB: number };
	const running = psListing([
		"bash -l",
		"node /r/node_modules/.bin/tsc --noEmit",
	]);

	it.each([
		"tsc --noEmit",
		"npx tsc --noEmit",
		"node_modules/.bin/tsc -p tsconfig.strict.json --noEmit",
		"npm exec tsc -- --noEmit",
		"node node_modules/typescript/bin/tsc --noEmit",
	])(
		"%s beside a running `tsc` is denied, line one the wrapped form",
		(command) => {
			const { text } = judge(command, ROOMY_MB, running);
			expect(text.split("\n")[0]).toBe(
				`Run instead: node scripts/queue-run.js --tsc -- ${command}`,
			);
			expect(text).toContain("A `tsc` is already running");
		},
	);

	it("is denied under its rung, naming the reading and the rung", () => {
		const { text } = judge("tsc --noEmit", TSC_RUNG_MB - 1, psWith(0));
		expect(text).toContain(
			`MemAvailable is ${TSC_RUNG_MB - 1} MB, under the ~${TSC_RUNG_MB} MB`,
		);
	});

	it("keeps the rest of a compound command", () => {
		const { text } = judge("cd app && npx tsc --noEmit", ROOMY_MB, running);
		expect(text.split("\n")[0]).toBe(
			"Run the command with this launch in place of its own: node scripts/queue-run.js --tsc -- npx tsc --noEmit",
		);
	});

	it.each([
		["a free slot", "tsc --noEmit", psWith(0)],
		[
			"the wrapped form",
			"node scripts/queue-run.js --tsc -- tsc --noEmit",
			running,
		],
		[
			"`npm run typecheck`, which holds the slot itself",
			"npm run typecheck",
			running,
		],
		["a word merely naming tsc", "cat tsconfig.json", running],
		["an unread `ps` at a roomy reading", "tsc --noEmit", null],
	])("passes %s", (_label, command, ps) => {
		expect(outcome(judge(command, ROOMY_MB, ps).verdict)).toBe("allow");
	});

	it("is not stood down by the suite escape", () => {
		expect(
			outcome(
				judge("tsc --noEmit", ROOMY_MB, running, { vars: ESCAPED }).verdict,
			),
		).toBe("deny");
	});
});
