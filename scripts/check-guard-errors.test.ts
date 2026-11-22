// @vitest-environment node

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

const notify = createRequire(__filename)("./lib/notify-report.js");

const SCRIPT = path.join(__dirname, "check-guard-errors.js");

const sb = freshSandbox((fresh) =>
	fs.mkdirSync(fresh.stateDir(), { recursive: true }),
);

const logPath = () => sb.errorLog();

const stampPath = () => path.join(notify.base(), "guard-errors.notified");

function logAt(when: Date, what: string, where = "guard-file-claim.sh") {
	fs.appendFileSync(logPath(), `${when.toISOString()}\t${where}\t${what}\n`);
}

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
		logAt(new Date(), "jq not found");
		run(["--notify"]);
		logAt(
			new Date(Date.now() - 3_600_000),
			"node not found — write allowed unchecked",
		);
		expect(run(["--notify"]).stdout).toContain("node not found");
	});

	it("re-reports everything when the log has been truncated under it", () => {
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
		const src = fs.readFileSync(SCRIPT, "utf8");
		const lastMatch = (re: RegExp) => {
			let at = -1;
			for (const m of src.matchAll(re)) at = m.index;
			return at;
		};
		const stampAt = lastMatch(
			/markDelivered\(\s*ctx,\s*CHECKER,\s*signature\s*\)/g,
		);
		const reportAt = lastMatch(/say\(`\\nLog:/g);
		expect(stampAt).toBeGreaterThanOrEqual(0);
		expect(reportAt).toBeGreaterThanOrEqual(0);
		expect(stampAt).toBeGreaterThan(reportAt);
	});

	it("reports a torn line rather than stamping past it in silence", () => {
		logAt(new Date(), "jq not found");
		fs.appendFileSync(
			logPath(),
			"torn-half arbiter exited 137 on docs/doc-map.md\n",
		);
		logAt(new Date(), "node not found");
		expect(run(["--notify"]).stdout).toContain("torn line");
		expect(run(["--notify"]).stdout.trim()).toBe("");
	});

	it("never stamps past a line still being written", () => {
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
		fs.writeFileSync(
			logPath(),
			`${new Date().toISOString()}\tguard-branch.sh\tjq not found — branch move allowed unchecked`,
		);
		const r = run(["--notify"]);
		expect(r.stdout).toContain("jq not found");
		expect(r.stdout).not.toContain("no guard fail-opens");
	});

	it("does not re-report old entries when the log holds non-ASCII", () => {
		logAt(new Date(), "em dash — first fault");
		run(["--notify"]);
		logAt(new Date(), "second fault");
		const out = run(["--notify"]).stdout;
		expect(out).toContain("second fault");
		expect(out).not.toContain("first fault");
	});

	it("caps a long report and says how much it left out", () => {
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
			expect(
				JSON.parse(notify.readReport("guard-errors").stamp)[logPath()],
			).toMatch(/^\d+\t[0-9a-f]{16}$/);
		});

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
		logAt(new Date(), "jq not found");
		run([]);
		expect(fs.existsSync(stampPath())).toBe(false);
		expect(run(["--notify"]).stdout).toContain("jq not found");
	});

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
	const guards = [
		"guard-branch.sh",
		"guard-commit-form.sh",
		"guard-file-claim.sh",
		"guard-issue-body.sh",
		"guard-issue-close.sh",
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
		logAt(new Date(), "jq not found", "guard-pull-form.sh");
		const r = run([]);
		expect(r.stderr).toContain("guard-branch.sh");
		expect(r.stderr).toContain("guard-pull-form.sh");
	});

	it("collapses a repeated fault to one line with a count", () => {
		for (let i = 0; i < 25; i++)
			logAt(
				new Date(),
				"jq not found — command allowed unchecked",
				"guard-branch.sh",
			);
		logAt(new Date(), "arbiter timed out on docs/doc-map.md");

		const r = run([]);
		expect(r.stderr).toContain("25×");
		expect(r.stderr).toContain("arbiter timed out");
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
		logAt(new Date(), "jq not found", "guard-branch.sh");
		expect(run(["--notify"]).stdout).toContain("jq not found");
		logAt(new Date(), "jq not found", "guard-branch.sh");
		logAt(new Date(), "jq not found", "guard-branch.sh");
		const second = run(["--notify"]);
		expect(second.stdout).toContain("2×");
	});
});

describe("the library the hooks cannot report on themselves", () => {
	const detachedChecker = (drop: string[]) => {
		const at = fs.mkdtempSync(path.join(sb.dir, "detached-"));
		fs.copyFileSync(SCRIPT, path.join(at, "check-guard-errors.js"));
		installLib(path.join(at, "lib"), { keep: (f) => !drop.includes(f) });
		return path.join(at, "check-guard-errors.js");
	};

	const runAt = (script: string) => run([], {}, script);

	it("reports guard-log.sh missing, which no hook can log for itself", () => {
		const r = runAt(detachedChecker(["guard-log.sh"]));
		expect(r.stderr).toContain("guard-log.sh");
		expect(r.status).toBe(1);
	});

	it("says nothing about the library when it is readable", () => {
		const r = runAt(detachedChecker([]));
		expect(r.stderr).not.toContain("unreadable");
		expect(r.status).toBe(0);
	});
});

describe("--notify — errors sharing one timestamp", () => {
	it("reports a second error logged in the same second as the last one reported", () => {
		const when = new Date();
		when.setMilliseconds(0);
		logAt(when, "jq not found — write allowed unchecked");

		expect(run(["--notify"]).stdout).toContain("jq not found");
		expect(run(["--notify"]).stdout.trim()).toBe("");

		logAt(when, "arbiter timed out on docs/doc-map.md");
		const third = run(["--notify"]);
		expect(third.stdout).toContain("arbiter timed out");
	});
});

describe("rotation — bounding a log nothing else trims (mantahostels#181)", () => {
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

		expect(r.stdout.trim()).toBe("");
		expect(fs.existsSync(logPath())).toBe(false);
		expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
	});

	it("rotates on the --notify path where everything was already reported", () => {
		fillPast(2000, new Date());
		runCapped(1024 * 1024, ["--notify"]);
		expect(fs.existsSync(logPath())).toBe(true);

		const second = runCapped(2000, ["--notify"]);

		expect(second.stdout.trim()).toBe("");
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
		logAt(new Date(), "jq not found");
		expect(run([]).stderr).not.toContain(`${logPath()}.1`);

		fs.writeFileSync(`${logPath()}.1`, "an older generation\n");

		expect(run([]).stderr).toContain(
			`Older entries, rotated aside: ${logPath()}.1`,
		);
	});

	it("reports faults logged after a rotation, despite the stale stamp", () => {
		fillPast(2000, new Date());
		runCapped(2000, ["--notify"]);
		expect(fs.existsSync(logPath())).toBe(false);

		logAt(new Date(), "POST-ROTATION — arbiter could not read the lock store");

		expect(runCapped(2000, ["--notify"]).stdout).toContain("POST-ROTATION");
	});

	it("raises a WARN finding when the log cannot be rotated, tagged LOG-ROTATION, and leaves the log in place", () => {
		fillPast(2000, new Date(Date.now() - 30 * 86_400_000));
		fs.mkdirSync(`${logPath()}.1`);
		fs.writeFileSync(path.join(`${logPath()}.1`, "occupied"), "");

		const r = runCapped(2000, ["--json"]);
		const envelope = JSON.parse(r.stdout);

		expect(envelope.outcome).toBe("WARN");
		expect(envelope.findings).toContainEqual(
			expect.objectContaining({ severity: "WARN", tag: "LOG-ROTATION" }),
		);
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
			`${when.toISOString()}\tguard-log.sh\t${what}\n`,
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
		logRootless(
			new Date(),
			"repo root unresolved — rule push-cadence left unlatched",
		);
		expect(run(["--notify"]).stdout).toContain("no repo root");
		expect(run(["--notify"]).stdout).toContain("no repo root");
	});

	it("falls quiet once the records age past the window", () => {
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
		fs.mkdirSync(path.dirname(rootlessLog()), { recursive: true });
		fs.writeFileSync(rootlessLog(), "half a record with no timestamp at all\n");
		expect(run(["--notify"]).stdout).toContain("torn line");
	});

	it("reports a timestamped last line cut short before its message as torn (#1342)", () => {
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
		fs.mkdirSync(path.dirname(rootlessLog()), { recursive: true });
		const line = `${new Date().toISOString()}\tguard-log.sh\t${"x".repeat(200)}\n`;
		fs.writeFileSync(
			rootlessLog(),
			line.repeat(Math.ceil((8 * 1024 * 1024) / line.length) + 1),
		);

		run(["--notify"]);

		expect(fs.existsSync(rootlessLog())).toBe(false);
		expect(fs.existsSync(`${rootlessLog()}.1`)).toBe(true);
	});

	it("says a log it cannot read is unreadable, never all-clear", () => {
		fs.mkdirSync(rootlessLog(), { recursive: true });
		const out = run(["--notify"]).stdout;
		expect(out).toContain("cannot be read");
		expect(out).toContain("EISDIR");
	});
});
