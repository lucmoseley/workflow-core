// @vitest-environment node
/*
 * Pins that check-guard-errors.js reports every guard's fail-open records
 * (mantahostels#147) once each under `--notify`, re-reports rather than trusting
 * silence when its stamp or the log is in doubt, and exits 1 on a recent error
 * in a plain run.
 *
 * Every test here drives the real script end to end through run-in-process,
 * rather than importing pieces of it, with the log and stamp in a fresh
 * sandbox so no run touches the live fail-open log.
 *
 * It is the only reader of that log: loosen a case and a guard that has
 * stopped checking anything — every guard fails open — looks identical to one
 * finding nothing wrong.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { installLib } from "./lib/lib-install-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const { UNRESOLVED_ROOT_SLUG } = createRequire(__filename)(
	"./lib/project-slug.js",
);

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const notify: any = createRequire(__filename)("./lib/notify-report.js");

const SCRIPT = path.join(__dirname, "check-guard-errors.js");

// Every test here writes the log directly, so the directory has to exist first.
const sb = freshSandbox((fresh) =>
	fs.mkdirSync(fresh.stateDir(), { recursive: true }),
);

/** A function, not a captured path: see the note on Sandbox in arbiter-testkit. */
const logPath = () => sb.errorLog();

/**
 * The once-only stamp, which lives in scripts/lib/delivery-stamp.js's store
 * rather than beside the log, one per machine (mantahostels#2244).
 */
const stampPath = () => path.join(notify.base(), "guard-errors.notified");

/**
 * Append one fail-open line, as lib/guard-log.sh and the arbiter's logError both
 * write them. Field 2 is the guard's own script name: since mantahostels#147 they all write
 * here, and it is the only thing that tells them apart.
 */
function logAt(when: Date, what: string, where = "guard-file-claim.sh") {
	fs.appendFileSync(logPath(), `${when.toISOString()}\t${where}\t${what}\n`);
}

/* GITHUB_ACTIONS off, deliberately. check.js writes ::error::/::warning::
 * annotations to STDOUT when it is set, and these tests assert on the human
 * report — so inheriting a CI runner's environment made them pass locally and
 * fail in Actions. Annotation behaviour is check.test.ts's to cover; it sets
 * the variable itself. Every case launches a checker through this one call. */
const run = (
	args: string[],
	extraEnv: Record<string, string> = {},
	script = SCRIPT,
) =>
	runInProcess(script, args, {
		env: { ...process.env, GITHUB_ACTIONS: "", ...extraEnv },
		cwd: sb.repo,
	});

describe("--notify — the quiet path", () => {
	it("says nothing and exits 0 when there is nothing to report", () => {
		const r = run(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("reports an error, then stays silent about that same error", () => {
		logAt(new Date(), "jq not found — write allowed unchecked");

		const first = run(["--notify"]);
		expect(first.stdout).toContain("jq not found");
		expect(first.status).toBe(0);

		expect(run(["--notify"]).stdout.trim()).toBe("");
	});

	it("reports again when a NEW error arrives after a notice", () => {
		logAt(new Date(Date.now() - 60_000), "jq not found");
		run(["--notify"]);
		logAt(new Date(), "arbiter timed out on docs/doc-map.md");
		expect(run(["--notify"]).stdout).toContain("arbiter timed out");
	});

	it("reports an error stamped EARLIER than the last notice", () => {
		// WSL2 steps its clock backwards on suspend/resume, so a genuinely new fault
		// can arrive stamped before one already reported. The log is APPEND-ONLY, so
		// this appends rather than rewriting it — truncation is not a state the real
		// log reaches.
		logAt(new Date(), "jq not found");
		run(["--notify"]);
		logAt(
			new Date(Date.now() - 3_600_000),
			"node not found — write allowed unchecked",
		);
		expect(run(["--notify"]).stdout).toContain("node not found");
	});

	it("re-reports everything when the log has been truncated under it", () => {
		// What has already been reported is tracked as a byte offset into the log,
		// so a log that has shrunk is different content at the same offsets. Reading
		// on would skip real errors; reading again at worst repeats one.
		logAt(new Date(), "jq not found");
		run(["--notify"]);
		fs.writeFileSync(logPath(), "");
		logAt(new Date(), "node not found");
		expect(run(["--notify"]).stdout).toContain("node not found");
	});

	it("re-reports an error whose stamp has gone, rather than trusting silence", () => {
		logAt(new Date(), "jq not found");
		const stamp = stampPath();
		expect(fs.existsSync(stamp)).toBe(false);
		run(["--notify"]);
		expect(fs.existsSync(stamp)).toBe(true);
		fs.rmSync(stamp);
		expect(run(["--notify"]).stdout).toContain("jq not found");
	});

	it("writes the stamp only after the report, by source order", () => {
		// This asserts on the source, which is unusual, and does so because the
		// failure is real and no runtime test can reach it. Reproducing it needs the
		// report write to fail: piping stdout at /dev/full does not do it, because
		// console.log swallows the error and carries on to the stamp.
		const src = fs.readFileSync(SCRIPT, "utf8");
		// Whitespace-tolerant: the formatter wraps this call across lines as soon as
		// its arguments grow, and a literal needle silently stopped matching the
		// first time that happened.
		const lastMatch = (re: RegExp) => {
			let at = -1;
			for (const m of src.matchAll(re)) at = m.index;
			return at;
		};
		// Anchored on the REPORT's stamp, never the INERT warning's, which is a
		// second markDelivered call further down the file and would satisfy the
		// ordering below whatever the report's own did.
		const stampAt = lastMatch(
			/markDelivered\(\s*ctx,\s*CHECKER,\s*signature\s*\)/g,
		);
		const reportAt = lastMatch(/say\(`\\nLog:/g);
		// Both anchors must be FOUND before their order means anything: lastIndexOf
		// returns -1 on a miss, so `stampAt > reportAt` would pass vacuously the
		// first time anyone reworded the report line, and this test would stop
		// guarding the ordering without ever failing to say so.
		expect(stampAt).toBeGreaterThanOrEqual(0);
		expect(reportAt).toBeGreaterThanOrEqual(0);
		expect(stampAt).toBeGreaterThan(reportAt);
	});

	it("reports a torn line rather than stamping past it in silence", () => {
		// A writer killed mid-append leaves a partial line that merges with the next
		// entry; neither half has a parseable timestamp. Dropping such a line while
		// stamping the full file swallowed it — and every entry torn with it — for
		// good.
		logAt(new Date(), "jq not found");
		fs.appendFileSync(
			logPath(),
			"torn-half arbiter exited 137 on docs/doc-map.md\n",
		);
		logAt(new Date(), "node not found");
		expect(run(["--notify"]).stdout).toContain("torn line");
		expect(run(["--notify"]).stdout.trim()).toBe(""); // told once, like any fault
	});

	it("never stamps past a line still being written", () => {
		// The log's final bytes may be an append in flight: parse and stamp only
		// through the last newline, or the line's completed form sits below the
		// stamp on every later run.
		logAt(new Date(), "jq not found");
		fs.appendFileSync(
			logPath(),
			`${new Date().toISOString()}\tguard-file-claim.sh\tarbiter exi`,
		);
		expect(run(["--notify"]).stdout).toContain("jq not found");
		fs.appendFileSync(
			logPath(),
			"ted 137 on docs/doc-map.md — write allowed unchecked\n",
		);
		expect(run(["--notify"]).stdout).toContain("exited 137");
	});

	it("never calls a log all-clear because its one fault lacks a newline", () => {
		// Parsing only through the last newline is right; DROPPING what follows was
		// not. With no newline anywhere the slice came back empty and this check —
		// the one built to catch a guard failing open in silence — printed
		// "no guard fail-opens" and exited 0 over a log holding a fault. A full disk
		// truncates a record exactly this way, and it never completes.
		fs.writeFileSync(
			logPath(),
			`${new Date().toISOString()}\tguard-branch.sh\tjq not found — branch move allowed unchecked`,
		);
		const r = run(["--notify"]);
		expect(r.stdout).toContain("jq not found");
		expect(r.stdout).not.toContain("no guard fail-opens");
	});

	it("does not re-report old entries when the log holds non-ASCII", () => {
		// The stamp is a byte offset plus a digest of the bytes it covers; measuring
		// either over UTF-16 units instead makes every stamp after an em dash read
		// as a different log, and the whole file is re-reported on every run.
		logAt(new Date(), "em dash — first fault");
		run(["--notify"]);
		logAt(new Date(), "second fault");
		const out = run(["--notify"]).stdout;
		expect(out).toContain("second fault");
		expect(out).not.toContain("first fault");
	});

	it("caps a long report and says how much it left out", () => {
		// In --notify the whole report is injected into a session's start-up
		// context, so an unbounded one costs every session that day.
		for (let i = 0; i < 25; i++) logAt(new Date(), `failure ${i}`);
		const out = run(["--notify"]).stdout;
		expect(out).toContain("failure 19");
		expect(out).not.toContain("failure 20");
		expect(out).toContain("and 5 more");
	});

	it("ignores errors older than the window", () => {
		logAt(new Date(Date.now() - 30 * 86_400_000), "ancient failure");
		expect(run(["--notify"]).stdout.trim()).toBe("");
	});

	it("does not re-report a fault to a SECOND plan, the two sharing one log (#383)", () => {
		/* Every plan's errorLog() is the first plan's, and the stamp is one file for
		 * the machine: a fault plan A was told of is not news to plan B. */
		const planB = path.join(path.dirname(sb.home), "plan-b");
		const plans = {
			WFC_CLAUDE_CONFIG_A: sb.home,
			WFC_CLAUDE_CONFIG_B: planB,
			WFC_CLAUDE_CONFIG_C: planB,
		};
		const asPlan = (cfg: string) =>
			run(["--notify"], { ...plans, CLAUDE_CONFIG_DIR: cfg });

		logAt(new Date(), "plan A fault");
		expect(asPlan(sb.home).stdout).toContain("plan A fault");
		expect(asPlan(planB).stdout.trim()).toBe("");

		logAt(new Date(), "plan B fault");
		const out = asPlan(planB).stdout;
		expect(out).toContain("plan B fault");
		expect(out).not.toContain("plan A fault");
		expect(asPlan(sb.home).stdout.trim()).toBe("");
	});

	/*
	 * The producer's stdout is no longer the delivery under persist mode, so its
	 * own stamp must not suppress anything (mantahostels#1975, mantahostels#2244).
	 */
	describe("under persist mode", () => {
		const persist = (args: string[]) => run(args, { WFC_NOTIFY_PERSIST: "1" });

		it("reports the same fault on every run, however stamped", () => {
			logAt(new Date(), "jq not found");
			expect(run(["--notify"]).stdout).toContain("jq not found");
			expect(fs.existsSync(stampPath())).toBe(true);

			for (const _ of [1, 2]) {
				expect(persist(["--notify"]).status).toBe(0);
				expect(notify.readReport("guard-errors").text).toContain(
					"jq not found",
				);
			}
		});

		it("carries the signature instead of stamping with it", () => {
			logAt(new Date(), "jq not found");

			persist(["--notify"]);

			expect(fs.existsSync(stampPath())).toBe(false);
			// One entry per LOG: a byte offset into it and a digest of those bytes.
			expect(
				JSON.parse(notify.readReport("guard-errors").stamp)[logPath()],
			).toMatch(/^\d+\t[0-9a-f]{16}$/);
		});

		/* mantahostels#2277: asserted on the source, as "writes the stamp only after the
		 * report, by source order" above is, because the branch this guards is
		 * unreachable at runtime here — `procStartOf(process.pid)` reads this
		 * process's own real /proc, which succeeds on every machine this suite
		 * runs on, so INERT can never actually fire in a test. */
		it("withholds the INERT stamp where a library probe also fired, by source", () => {
			const src = fs.readFileSync(SCRIPT, "utf8");
			const from = src.indexOf("const withInertStamp = (result) =>");
			expect(from).toBeGreaterThanOrEqual(0);
			const clause = src.slice(from, from + 200);
			expect(clause).toMatch(
				/inertStamp\s*&&\s*ctx\.findings\.every\(\s*\(f\)\s*=>\s*f\.tag\s*===\s*"INERT"\s*\)/,
			);
		});
	});
});

describe("the plain report, as npm run check:guard-errors", () => {
	it("exits 1 on a recent error, quoting it, so a human is told to look", () => {
		logAt(new Date(), "jq not found");
		const r = run([]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("jq not found");
	});

	it("does not consume the --notify notice by stamping", () => {
		// A hand-run report and the --notify notice are different audiences. If the
		// plain run stamped, running it once by hand would silence the next
		// --notify run about errors nobody had told its reader about.
		logAt(new Date(), "jq not found");
		run([]);
		expect(fs.existsSync(stampPath())).toBe(false);
		expect(run(["--notify"]).stdout).toContain("jq not found");
	});

	/* Human-readable output goes to stderr; stdout is reserved for machine readers
	 * — the --json envelope and Actions' workflow commands (mantahostels#155 — the checker
	 * family's exit-code and severity model — decision 7).
	 * --notify is the one case that inverts it, built for a SessionStart hook,
	 * which injects only stdout. */
	it("exits 0 and says so on stderr when the log is clean", () => {
		const r = run([]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK");
		expect(r.stdout).toBe("");
	});

	it("rejects a nonsense window rather than defaulting silently, naming the --days flag", () => {
		const r = run(["--days", "0"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--days must be a positive number.");
	});
});

describe("every guard, not just the file-claim one (mantahostels#147)", () => {
	// The whole PreToolUse set, per .claude/settings.json. A guard added without a
	// row here is one this check has never been shown to report by name.
	const guards = [
		"guard-branch.sh",
		"guard-commit-form.sh",
		"guard-file-claim.sh",
		"guard-issue-body.sh",
		"guard-issue-close.sh",
		"guard-last30days.sh",
		"guard-pull-form.sh",
	];

	it.each(guards)("reports a fail-open logged by %s", (where) => {
		logAt(new Date(), "jq not found — command allowed unchecked", where);
		const r = run([]);
		expect(r.stderr).toContain(where);
		expect(r.stderr).toContain("jq not found");
		expect(r.status).toBe(1);
	});

	it("names every guard that spoke, not just the first", () => {
		logAt(new Date(), "jq not found", "guard-branch.sh");
		logAt(new Date(), "jq not found", "guard-last30days.sh");
		const r = run([]);
		expect(r.stderr).toContain("guard-branch.sh");
		expect(r.stderr).toContain("guard-last30days.sh");
	});

	it("collapses a repeated fault to one line with a count", () => {
		// Every guard on the Bash matcher runs on EVERY Bash call, so one missing jq
		// writes hundreds of identical lines where the file-claim guard alone wrote one
		// per write. Ungrouped, the 20-line cap shows that single fault twenty times
		// and hides every other fault behind it.
		for (let i = 0; i < 25; i++)
			logAt(
				new Date(),
				"jq not found — command allowed unchecked",
				"guard-branch.sh",
			);
		logAt(new Date(), "arbiter timed out on docs/doc-map.md");

		const r = run([]);
		expect(r.stderr).toContain("25×");
		// The rarer fault is still visible, not buried under the 25.
		expect(r.stderr).toContain("arbiter timed out");
		// The count of occurrences is not lost to the grouping.
		expect(r.stderr).toContain("26 guard fail-open(s)");
	});

	it("keeps two different faults from one guard apart", () => {
		logAt(new Date(), "jq not found", "guard-branch.sh");
		logAt(new Date(), "no command in payload", "guard-branch.sh");
		const r = run([]);
		expect(r.stderr).toContain("jq not found");
		expect(r.stderr).toContain("no command in payload");
		expect(r.stderr).not.toContain("2×");
	});

	it("reports a repeat that is still ongoing, under --notify", () => {
		// Grouping must not swallow a fault that keeps happening: the group is
		// filtered by the byte offset first, so only the unreported occurrences are
		// counted and a still-broken guard is reported again.
		logAt(new Date(), "jq not found", "guard-branch.sh");
		expect(run(["--notify"]).stdout).toContain("jq not found");
		logAt(new Date(), "jq not found", "guard-branch.sh");
		logAt(new Date(), "jq not found", "guard-branch.sh");
		const second = run(["--notify"]);
		expect(second.stdout).toContain("2×");
	});
});

describe("the libraries the guards cannot report on themselves", () => {
	/*
	 * A copy of the checker with its own lib/, so a library can be removed without
	 * touching the real one — which would disarm every guard in every parallel
	 * session on this machine for as long as the test ran.
	 */
	const detachedChecker = (drop: string[]) => {
		const at = fs.mkdtempSync(path.join(sb.dir, "detached-"));
		fs.copyFileSync(SCRIPT, path.join(at, "check-guard-errors.js"));
		installLib(path.join(at, "lib"), { keep: (f) => !drop.includes(f) });
		return path.join(at, "check-guard-errors.js");
	};

	const runAt = (script: string) => run([], {}, script);

	it.each(["guard-log.sh", "guard-parse.sh"])(
		"reports %s missing, which no guard can log for itself",
		(lib) => {
			// The one fail-open with no record: with the logger gone every guard
			// degrades to a silent allow, and with the parser gone every guard that
			// sources it disarms outright — both writing nothing to the log below, so an
			// all-clear here would be manufactured by the very fault being looked for.
			const r = runAt(detachedChecker([lib]));
			expect(r.stderr).toContain(lib);
			expect(r.status).toBe(1);
		},
	);

	it("says nothing about the libraries when both are readable", () => {
		const r = runAt(detachedChecker([]));
		expect(r.stderr).not.toContain("unreadable");
		expect(r.status).toBe(0);
	});
});

describe("--notify — errors sharing one timestamp", () => {
	it("reports a second error logged in the same second as the last one reported", () => {
		// lib/guard-log.sh stamps whole seconds (`%H:%M:%S.000Z`), so two
		// fail-opens in the same second are indistinguishable by time — and a burst
		// is exactly when several arrive at once. On the timestamp alone the second
		// one is newer than nothing, so it would be suppressed permanently.
		const when = new Date();
		when.setMilliseconds(0);
		logAt(when, "jq not found — write allowed unchecked");

		expect(run(["--notify"]).stdout).toContain("jq not found");
		expect(run(["--notify"]).stdout.trim()).toBe(""); // same error, already told

		logAt(when, "arbiter timed out on docs/doc-map.md");
		const third = run(["--notify"]);
		expect(third.stdout).toContain("arbiter timed out");
	});
});

describe("rotation — bounding a log nothing else trims (mantahostels#181)", () => {
	/* WFC_ROTATE_AT keeps these cases off an 8 MB write each; the last case in
	 * this block leaves it unset, covering the real default. */
	const runCapped = (cap: number, args: string[] = []) =>
		run(args, { WFC_ROTATE_AT: String(cap) });

	function fillPast(cap: number, when: Date, what = "jq not found") {
		while (!fs.existsSync(logPath()) || fs.statSync(logPath()).size <= cap)
			logAt(when, what);
	}

	it("moves an oversized log aside and leaves the live path empty", () => {
		fillPast(2000, new Date());
		const before = fs.readFileSync(logPath());

		runCapped(2000, ["--notify"]);

		expect(fs.existsSync(logPath())).toBe(false);
		expect(fs.readFileSync(`${logPath()}.1`)).toEqual(before);
	});

	it("leaves a log under the cap alone", () => {
		logAt(new Date(), "jq not found");
		const before = fs.readFileSync(logPath());

		runCapped(1024 * 1024, ["--notify"]);

		expect(fs.readFileSync(logPath())).toEqual(before);
		expect(fs.existsSync(`${logPath()}.1`)).toBe(false);
	});

	it("rotates when every entry is too old to report", () => {
		fillPast(2000, new Date(Date.now() - 30 * 86_400_000));

		const r = runCapped(2000, ["--notify"]);

		expect(r.stdout.trim()).toBe(""); // nothing in the window to report
		expect(fs.existsSync(logPath())).toBe(false);
		expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
	});

	it("rotates on the --notify path where everything was already reported", () => {
		fillPast(2000, new Date());
		runCapped(1024 * 1024, ["--notify"]); // reports, stamps, too small to rotate
		expect(fs.existsSync(logPath())).toBe(true);

		const second = runCapped(2000, ["--notify"]);

		expect(second.stdout.trim()).toBe(""); // nothing NEW since the stamp
		expect(fs.existsSync(logPath())).toBe(false);
	});

	it("keeps one generation, replacing the previous .1", () => {
		fs.writeFileSync(`${logPath()}.1`, "an older generation\n");
		fillPast(2000, new Date());
		const before = fs.readFileSync(logPath());

		runCapped(2000, ["--notify"]);

		expect(fs.readFileSync(`${logPath()}.1`)).toEqual(before);
	});

	it("names the rotated generation in the report, and only once it exists", () => {
		// Rotation is the one thing that puts entries where this report does not
		logAt(new Date(), "jq not found");
		expect(run([]).stderr).not.toContain(`${logPath()}.1`);

		fs.writeFileSync(`${logPath()}.1`, "an older generation\n");

		expect(run([]).stderr).toContain(
			`Older entries, rotated aside: ${logPath()}.1`,
		);
	});

	it("reports faults logged after a rotation, despite the stale stamp", () => {
		// The stamp records a byte offset plus a digest of the bytes it covers. A
		// rotated log restarts at 0, so the offset is meaningless against it — the
		// digest is what catches that and forces a fresh read. Without it a fault
		fillPast(2000, new Date());
		runCapped(2000, ["--notify"]);
		expect(fs.existsSync(logPath())).toBe(false);

		logAt(new Date(), "POST-ROTATION — arbiter could not read the lock store");

		expect(runCapped(2000, ["--notify"]).stdout).toContain("POST-ROTATION");
	});

	it("raises a WARN finding when the log cannot be rotated, tagged LOG-ROTATION, and leaves the log in place", () => {
		// Entries dated outside the window, so the fail-opens themselves raise
		// nothing — otherwise their FAIL outranks this WARN and the severity
		// assertion below passes whatever rotate() did.
		fillPast(2000, new Date(Date.now() - 30 * 86_400_000));
		fs.mkdirSync(`${logPath()}.1`);
		fs.writeFileSync(path.join(`${logPath()}.1`, "occupied"), "");

		const r = runCapped(2000, ["--json"]);
		const envelope = JSON.parse(r.stdout);

		expect(envelope.outcome).toBe("WARN");
		expect(envelope.findings).toContainEqual(
			expect.objectContaining({ severity: "WARN", tag: "LOG-ROTATION" }),
		);
		// WARN never gates (mantahostels#155), and the log is still there to be read next time.
		expect(r.status).toBe(0);
		expect(fs.existsSync(logPath())).toBe(true);
	});

	it("rotates at the declared 8 MB default, with no override in force", () => {
		const when = new Date();
		const line = `${when.toISOString()}\tguard-commit-form.sh\t${"x".repeat(200)}\n`;
		fs.writeFileSync(
			logPath(),
			line.repeat(Math.ceil((8 * 1024 * 1024) / line.length) + 1),
		);
		expect(fs.statSync(logPath()).size).toBeGreaterThan(8 * 1024 * 1024);

		run(["--notify"]);

		expect(fs.existsSync(logPath())).toBe(false);
		expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
	});
});

describe("the records written with no repo root at all (mantahostels#2438)", () => {
	/**
	 * gl_log's fallback directory, a sibling of this sandbox's own state
	 * directory rather than anything under it — with no root there is no project
	 * to file under.
	 */
	const rootlessLog = () =>
		path.join(
			path.dirname(sb.stateDir()),
			UNRESOLVED_ROOT_SLUG,
			"guard-errors.log",
		);

	function logRootless(when: Date, what: string) {
		fs.mkdirSync(path.dirname(rootlessLog()), { recursive: true });
		fs.appendFileSync(
			rootlessLog(),
			`${when.toISOString()}\tguard-parse.sh\t${what}\n`,
		);
	}

	it("reports them, where before nothing read them at all", () => {
		logRootless(
			new Date(),
			"repo root unresolved — rule push-cadence left unlatched",
		);
		const r = run(["--notify"]);
		expect(r.stdout).toContain("no repo root");
		expect(r.stdout).toContain("rule push-cadence left unlatched");
		expect(r.status).toBe(0);
	});

	it("names guard-root.sh, which is what a session has to go and fix", () => {
		logRootless(
			new Date(),
			"repo root unresolved — rule push-cadence left unlatched",
		);
		expect(run([]).stderr).toContain("scripts/lib/guard-root.sh");
	});

	it("keeps reporting it, rather than stamping it away after one session", () => {
		// Deliberately unlike the main log: this one is read by every project, so a
		// stamp the first session to start wrote would silence it in all the others.
		logRootless(
			new Date(),
			"repo root unresolved — rule push-cadence left unlatched",
		);
		expect(run(["--notify"]).stdout).toContain("no repo root");
		expect(run(["--notify"]).stdout).toContain("no repo root");
	});

	it("falls quiet once the records age past the window", () => {
		// What stops the report above outliving the fault: nothing clears the file,
		// so --days is the only thing that ever ends it.
		logRootless(
			new Date(Date.now() - 9 * 86_400_000),
			"repo root unresolved — rule push-cadence left unlatched",
		);
		expect(run(["--notify"]).stdout.trim()).toBe("");
	});

	it("says nothing when the fallback log was never written", () => {
		expect(run(["--notify"]).stdout.trim()).toBe("");
	});

	it("reports a torn line rather than passing over it in silence", () => {
		// No parseable timestamp means a writer died mid-append. It has no age, so
		// the --days window cannot judge it — dropping it would lose the entries it
		// mangled with it.
		fs.mkdirSync(path.dirname(rootlessLog()), { recursive: true });
		fs.writeFileSync(rootlessLog(), "half a record with no timestamp at all\n");
		expect(run(["--notify"]).stdout).toContain("torn line");
	});

	it("reports a timestamped last line cut short before its message as torn (#1342)", () => {
		// This log is parsed past its last newline, so a record cut off after its
		// guard field reaches the parser whole. It used to print as the fault "undefined".
		fs.mkdirSync(path.dirname(rootlessLog()), { recursive: true });
		fs.writeFileSync(rootlessLog(), `${new Date().toISOString()}\tguard-x.sh`);
		const out = run(["--notify"]).stdout;
		expect(out).toContain("torn line");
		expect(out).not.toContain("undefined");
	});

	it("caps the body at 20 groups and counts the rest", () => {
		for (let i = 0; i < 21; i++)
			logRootless(
				new Date(),
				`repo root unresolved — rule r${i} left unlatched`,
			);
		const out = run(["--notify"]).stdout;
		expect(out).toContain("... and 1 more");
		expect(out).not.toContain("rule r20 left unlatched");
	});

	it("rotates it, the every-Bash-call guards writing here too", () => {
		// Unrotated (mantahostels#181), this log's readFileSync ran inside the SessionStart
		// hook's 10 s ceiling, in every project, while the checker was one.
		fs.mkdirSync(path.dirname(rootlessLog()), { recursive: true });
		const line = `${new Date().toISOString()}\tguard-parse.sh\t${"x".repeat(200)}\n`;
		fs.writeFileSync(
			rootlessLog(),
			line.repeat(Math.ceil((8 * 1024 * 1024) / line.length) + 1),
		);

		run(["--notify"]);

		expect(fs.existsSync(rootlessLog())).toBe(false);
		expect(fs.existsSync(`${rootlessLog()}.1`)).toBe(true);
	});

	it("says a log it cannot read is unreadable, never all-clear", () => {
		// mantahostels#174: unreadable must not look like empty.
		fs.mkdirSync(rootlessLog(), { recursive: true });
		const out = run(["--notify"]).stdout;
		expect(out).toContain("cannot be read");
		expect(out).toContain("EISDIR");
	});
});
