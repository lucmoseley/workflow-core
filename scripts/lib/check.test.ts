// @vitest-environment node
/*
 * Direct tests for the checker family's reporting tail (mantahostels#156), against the
 * alphabet settled at mantahostels#155 (the checker family's exit-code and severity
 * model).
 *
 * Driven through a fixture checker rather than a real one, so a test that fails
 * here is the library's fault and never a checker's.
 *
 * Every checker the .husky/pre-commit stack and CI run reports through this
 * tail: loosen a case here and a checker that crashed reads as one that ran
 * clean, or a finding exits on the wrong code and a gate passes it.
 *
 * spawn-kept: the import-closure block reads the require cache, which this
 * file's own persist tests fill in-process (#459). And `spawnRun`'s async
 * run() cases: runCheck's `beforeExit` listener, which reports a run() that
 * never settles, fires only in a process the checker has to itself (#1586).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENVELOPE_FRAME_KEYS } from "./envelope-frame-keys";
import { runRecordFile } from "./notify-report-testkit";
import { runInProcess, runInProcessAsync } from "./run-in-process";

const LIB = path.resolve(__dirname, "check.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-lib-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a checker whose run() body is `body`; returns its path for run().
 * An `"async"` run() first awaits `later()`, a turn of the event loop, so
 * `body` runs after runCheck has returned.
 */
const checker = (body: string, spec = "", kind: "sync" | "async" = "sync") => {
	const file = path.join(dir, "fixture-check.js");
	const head =
		kind === "async" ? "async run(ctx) { await later();" : "run(ctx) {";
	fs.writeFileSync(
		file,
		`const { runCheck } = require(${JSON.stringify(LIB)});
const later = () => new Promise((resolve) => setImmediate(resolve));
runCheck({
  name: "fixture",
  usage: "node fixture-check.js [--warn] [--json]",
  ${spec}
  ${head} ${body} },
});
`,
	);
	return file;
};

const run = (
	file: string,
	args: string[] = [],
	env: Record<string, string> = {},
) => {
	const r = runInProcess(file, args, {
		cwd: dir,
		env: { ...process.env, GITHUB_ACTIONS: "", ...env },
	});
	return {
		status: r.status,
		stdout: r.stdout,
		stderr: r.stderr,
		out: `${r.stdout}${r.stderr}`,
	};
};

describe("the five outcomes and their exit codes", () => {
	it("OK exits 0 and prints the checker's own OK line", () => {
		const c = checker(`return { okLine: "nothing to report here." };`);
		const r = run(c);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: nothing to report here.");
	});

	it("a FAIL finding exits 1, printing the FAIL count with its noun", () => {
		const c = checker(
			`ctx.fail("TAG", "a thing went wrong"); return { noun: "things" };`,
		);
		const r = run(c);
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 things");
	});

	it("a WARN finding exits 0 — real, deliberately not gating", () => {
		const c = checker(
			`ctx.warn("TAG", "a thing is off"); return { noun: "things" };`,
		);
		const r = run(c);
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN: 1 things");
	});

	it("SKIP exits 0 — could not run, and not the repo's fault", () => {
		const c = checker(`ctx.skip("GitHub is unreachable.");`);
		const r = run(c);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP: GitHub is unreachable.");
	});

	it("BROKEN exits 2, printing its reason — the checker itself cannot do its job", () => {
		const c = checker(`ctx.broken("the roadmap will not parse.");`);
		const r = run(c);
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN: the roadmap will not parse.");
	});

	it("takes the worst severity present as the outcome", () => {
		const c = checker(
			`ctx.warn("W", "minor"); ctx.fail("F", "major"); ctx.warn("W", "minor2"); return { noun: "problems" };`,
		);
		const r = run(c);
		expect(r.status).toBe(1);
		// counts what drove the outcome — the FAIL findings, not all three
		expect(r.out).toContain("FAIL: 1 problems");
	});
});

describe("--warn, the caller-side cap", () => {
	it("demotes a FAIL outcome to WARN and stops it gating", () => {
		const c = checker(
			`ctx.fail("TAG", "a thing went wrong"); return { noun: "things" };`,
		);
		expect(run(c).status).toBe(1);
		const r = run(c, ["--warn"]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN: 1 things");
	});

	it("leaves the finding's own severity alone", () => {
		const c = checker(`ctx.fail("TAG", "bad"); return { noun: "things" };`);
		const j = JSON.parse(run(c, ["--warn", "--json"]).stdout);
		expect(j.outcome).toBe("WARN");
		expect(j.findings[0].severity).toBe("FAIL");
	});

	// A checker that cannot run has not been asked a question it can answer.
	it("cannot cap BROKEN", () => {
		const c = checker(`ctx.broken("unreadable input");`);
		const r = run(c, ["--warn"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});

	it("leaves an OK run alone", () => {
		const c = checker(`return { okLine: "clean." };`);
		expect(run(c, ["--warn"]).status).toBe(0);
	});
});

describe("--notify", () => {
	/* Claude Code reads a non-zero SessionStart hook as the hook itself being
	 * broken, so every outcome has to come back 0. */
	it("exits 0 on every outcome, BROKEN included", () => {
		expect(
			run(checker(`ctx.fail("T","x"); return {};`), ["--notify"]).status,
		).toBe(0);
		expect(run(checker(`ctx.broken("bad usage");`), ["--notify"]).status).toBe(
			0,
		);
		expect(run(checker(`ctx.skip("nope");`), ["--notify"]).status).toBe(0);
	});

	it("still prints the report when it swallows the exit code", () => {
		const r = run(checker(`ctx.broken("bad usage");`), ["--notify"]);
		expect(r.stdout).toContain("BROKEN: bad usage");
	});

	/* Its stdout is injected into every session that starts, so a clean run has
	 * to say nothing at all. */
	it("stays silent on an OK or SKIP run", () => {
		for (const body of [
			`return { okLine: "clean." };`,
			`ctx.skip("no net");`,
		]) {
			const r = run(checker(body), ["--notify"]);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
		}
	});

	it("still reports a WARN under --notify", () => {
		const r = run(checker(`ctx.warn("T","iffy"); return { noun: "n" };`), [
			"--notify",
		]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("WARN: 1 n");
		expect(r.stderr).toBe("");
	});

	it("moves the report to stdout", () => {
		const c = checker(
			`ctx.say("detail line"); ctx.fail("T","x"); return { noun: "n" };`,
		);
		const plain = run(c);
		expect(plain.stderr).toContain("detail line");
		expect(plain.stdout).not.toContain("detail line");

		const notified = run(c, ["--notify"]);
		expect(notified.stdout).toContain("detail line");
		expect(notified.stdout).toContain("FAIL: 1 n");
		expect(notified.stderr).toBe("");
	});
});

describe("stream discipline", () => {
	it("puts human-readable output on stderr by default", () => {
		const c = checker(`ctx.say("a detail"); return { okLine: "clean." };`);
		const r = run(c);
		expect(r.stderr).toContain("a detail");
		expect(r.stderr).toContain("OK: clean.");
		expect(r.stdout).toBe("");
	});

	it("suppresses human output under --json so stdout stays parseable", () => {
		const c = checker(
			`ctx.say("a detail"); ctx.fail("T","x"); return { noun: "n", data: { extra: 1 } };`,
		);
		const r = run(c, ["--json"]);
		expect(r.stderr).toBe("");
		expect(() => JSON.parse(r.stdout)).not.toThrow();
		expect(r.stdout).not.toContain("a detail");
	});

	/* --json-text buys the report back as a FIELD, never as loose text (mantahostels#2490).
	 * Opt-in, because replay-notify-reports.js's `--json` exists to print no
	 * report and asserts on stdout not carrying one. */
	it("carries human output as `text` under --json-text, and only then", () => {
		const c = checker(`ctx.say("a detail"); ctx.fail("T","x"); return {};`);
		expect(JSON.parse(run(c, ["--json"]).stdout).text).toBeUndefined();
		const r = run(c, ["--json", "--json-text"]);
		expect(() => JSON.parse(r.stdout)).not.toThrow();
		expect(JSON.parse(r.stdout).text).toBe("a detail");
	});
});

describe("the --json envelope", () => {
	it("carries the name, outcome, exit code, count and findings", () => {
		const c = checker(
			`ctx.fail("TAG", "a thing"); return { noun: "things", data: { mine: [1, 2] } };`,
		);
		const r = run(c, ["--json"]);
		expect(r.status).toBe(1);
		const j = JSON.parse(r.stdout);
		expect(j.checker).toBe("fixture");
		expect(j.outcome).toBe("FAIL");
		expect(j.exit).toBe(1);
		expect(j.count).toBe(1);
		expect(j.noun).toBe("things");
		expect(j.findings).toEqual([
			{ severity: "FAIL", tag: "TAG", message: "a thing" },
		]);
		expect(j.mine).toEqual([1, 2]);
	});

	it("reports SKIP and BROKEN in the envelope too", () => {
		const skipped = JSON.parse(
			run(checker(`ctx.skip("no net");`), ["--json"]).stdout,
		);
		expect(skipped.outcome).toBe("SKIP");
		expect(skipped.exit).toBe(0);
		expect(skipped.summary).toContain("no net");

		const broken = JSON.parse(
			run(checker(`ctx.broken("bad file");`), ["--json"]).stdout,
		);
		expect(broken.outcome).toBe("BROKEN");
		expect(broken.exit).toBe(2);
	});

	it("does not let the checker's payload clobber the envelope", () => {
		const c = checker(
			`ctx.warn("T", "a real finding");
			 return { noun: "n", data: { findings: [], count: 99, checker: "wrong" } };`,
		);
		const j = JSON.parse(run(c, ["--json"]).stdout);
		expect(j.checker).toBe("fixture");
		expect(j.count).toBe(1);
		expect(j.findings).toHaveLength(1);
		expect(j.findings[0].message).toBe("a real finding");
	});

	it("carries a finding's extra data through", () => {
		const c = checker(
			`ctx.fail("TAG", "a thing", { number: 42, url: "u" }); return {};`,
		);
		const j = JSON.parse(run(c, ["--json"]).stdout);
		expect(j.findings[0].number).toBe(42);
		expect(j.findings[0].url).toBe("u");
	});

	/*
	 * mantahostels#2600: lib/fault-profiles.js's `doc-map` profile reads ENVELOPE_FRAME_KEYS
	 * to tell the envelope frame apart from a checker's own payload. A key
	 * added to `finish()`'s frame without joining that Set would leak through
	 * that profile silently (mantahostels#2594) — this pins that it cannot, on a checker
	 * with no `data` of its own, so every key on the envelope is frame.
	 */
	it("carries no key outside ENVELOPE_FRAME_KEYS when the checker adds no data", () => {
		const c = checker(`ctx.fail("TAG", "a thing"); return {};`);
		const j = JSON.parse(run(c, ["--json", "--json-text"]).stdout);
		for (const key of Object.keys(j))
			expect(ENVELOPE_FRAME_KEYS, `unexpected envelope key "${key}"`).toContain(
				key,
			);
	});
});

describe("annotations", () => {
	const inCi = { GITHUB_ACTIONS: "true" };

	it("emits nothing outside Actions", () => {
		const c = checker(
			`ctx.fail("T", "a thing"); ctx.warn("T", "iffy"); return {};`,
		);
		expect(run(c).stdout).not.toContain("::");
	});

	it("emits ::error:: for FAIL and ::warning:: for WARN, on stdout", () => {
		const c = checker(`ctx.fail("T","bad"); ctx.warn("T","iffy"); return {};`);
		const r = run(c, [], inCi);
		expect(r.stdout).toContain("::error::bad");
		expect(r.stdout).toContain("::warning::iffy");
	});

	/* Severity and exit come off one value, or a demoted exit leaves an
	 * ::error:: on a green job (mantahostels#155). */
	it("demotes the annotation with the exit code under --warn", () => {
		const c = checker(`ctx.fail("T","bad"); return {};`);
		const r = run(c, ["--warn"], inCi);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("::error::");
		expect(r.stdout).toContain("::warning::bad");
	});

	it("annotates BROKEN as an error", () => {
		const r = run(checker(`ctx.broken("cannot parse");`), [], inCi);
		expect(r.stdout).toContain("::error::cannot parse");
	});

	it("emits none on a clean run", () => {
		const r = run(checker(`return { okLine: "clean." };`), [], inCi);
		expect(r.stdout).not.toContain("::");
	});

	/* Workflow commands are line-oriented: a newline inside one silently ends it
	 * and leaves the rest as loose log text. Checker messages are multi-line
	 * routinely. */
	it("flattens a multi-line message onto one line", () => {
		const c = checker(
			"ctx.fail('T', 'first line\\n        second line'); return {};",
		);
		const r = run(c, [], inCi);
		expect(r.stdout).toContain("::error::first line second line");
	});

	it("suppresses annotations under --json so stdout stays parseable", () => {
		const c = checker(`ctx.fail("T","bad"); return {};`);
		const r = run(c, ["--json"], inCi);
		expect(r.stdout).not.toContain("::error::");
		expect(() => JSON.parse(r.stdout)).not.toThrow();
	});
});

describe("argv", () => {
	it("exposes bare arguments in order", () => {
		const c = checker(
			`ctx.say("args=" + ctx.args.join(",")); return { okLine: "x" };`,
		);
		expect(run(c, ["one", "--warn", "two"]).stderr).toContain("args=one,two");
	});

	it("keeps a declared flag's value out of the positionals", () => {
		const c = checker(
			`ctx.say("ref=" + ctx.value("--ref", "main") + " args=" + ctx.args.join(","));
			 return { okLine: "x" };`,
			`valueFlags: ["--ref"],`,
		);
		const r = run(c, ["--ref", "origin/main", "path.md"]);
		expect(r.stderr).toContain("ref=origin/main args=path.md");
	});

	it("falls back when a declared flag is absent", () => {
		const c = checker(
			`ctx.say("ref=" + ctx.value("--ref", "main")); return { okLine: "x" };`,
			`valueFlags: ["--ref"],`,
		);
		expect(run(c).stderr).toContain("ref=main");
	});

	it("treats a value-less flag as BROKEN, naming the flag and its usage, not as a finding", () => {
		const c = checker(
			`ctx.value("--ref"); return { okLine: "x" };`,
			`valueFlags: ["--ref"],`,
		);
		const r = run(c, ["--ref"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("--ref needs a value");
		expect(r.out).toContain("usage:");
	});

	/* #920: `--help` ran the check rather than printing its usage. */
	it.each(["--help", "-h"])(
		"answers %s with the usage and exit 0, running nothing",
		(flag) => {
			const c = checker(`ctx.say("RAN"); return { okLine: "x" };`);
			const r = run(c, ["--json", flag]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("usage: node fixture-check.js [--warn] [--json]\n");
			expect(r.out).not.toContain("RAN");
		},
	);

	/* #938: a flag the checker never reads ran the check with its defaults. */
	describe("an undeclared flag", () => {
		const ran = `ctx.say("RAN"); return { okLine: "x" };`;

		it.each([
			["a boolean", "--bogus"],
			["a --name=value", "--bogus=1"],
		])(
			"refuses %s as BROKEN before run(), naming the flag with usage",
			(_, flag) => {
				const r = run(checker(ran), [flag]);
				expect(r.status).toBe(2);
				expect(r.out).toContain(
					"unknown flag: --bogus\nusage: node fixture-check.js",
				);
				expect(r.out).not.toContain("RAN");
			},
		);

		it("carries the refusal in the --json envelope", () => {
			const r = run(checker(ran), ["--json", "--bogus"]);
			expect(JSON.parse(r.stdout)).toMatchObject({
				outcome: "BROKEN",
				exit: 2,
			});
			expect(JSON.parse(r.stdout).summary).toContain("unknown flag: --bogus");
		});

		it("refuses a declared flag spelled --name=value, which has() never sees", () => {
			const r = run(checker(ran, `flags: ["--all"],`), ["--all=1"]);
			expect(r.status).toBe(2);
			expect(r.out).toContain("--all takes its value as the next argument");
		});

		it("accepts a declared boolean", () => {
			const c = checker(
				`ctx.say("all=" + ctx.has("--all")); return { okLine: "x" };`,
				`flags: ["--all"],`,
			);
			const r = run(c, ["--all"]);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("all=true");
		});

		it("accepts a declared value flag", () => {
			const c = checker(
				`ctx.say("ref=" + ctx.value("--ref")); return { okLine: "x" };`,
				`valueFlags: ["--ref"],`,
			);
			expect(run(c, ["--ref", "main"]).stderr).toContain("ref=main");
		});

		it("skips a declared value flag's value, even one starting --", () => {
			const c = checker(
				`ctx.say("RAN"); return { okLine: "x" };`,
				`valueFlags: ["--why"],`,
			);
			const r = run(c, ["--why", "--bogus"]);
			expect(r.status).toBe(0);
			expect(r.out).toContain("RAN");
		});

		it("accepts the library's own flags undeclared", () => {
			const r = run(checker(ran), ["--warn", "--json-text"]);
			expect(r.status).toBe(0);
			expect(r.out).toContain("RAN");
		});

		it("accepts --root undeclared on a direction-gating checker", () => {
			const c = checker(
				`ctx.say("args=" + ctx.args.join(",")); return { okLine: "x" };`,
				`against: { profile: "cli-args", materialise: "tree" },`,
			);
			const r = run(c, ["--root", dir, "kept"]);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("args=kept");
		});

		it("does not refuse a token after --", () => {
			const c = checker(
				`ctx.say("args=" + ctx.args.join(",")); return { okLine: "x" };`,
			);
			const r = run(c, ["--", "--bogus"]);
			expect(r.status).toBe(0);
		});

		it("refuses before --against or the module gate run, naming the unknown flag", () => {
			const c = checker(ran, `module: "no-such-module",`);
			const r = run(c, ["--bogus", "--against", "HEAD"]);
			expect(r.status).toBe(2);
			expect(r.out).toContain("unknown flag: --bogus");
		});

		it("loses to --help", () => {
			const r = run(checker(ran), ["--bogus", "--help"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("usage: node fixture-check.js [--warn] [--json]\n");
		});
	});

	it("usageError is BROKEN and prints the usage line", () => {
		const c = checker(`ctx.usageError("--days must be a positive number.");`);
		const r = run(c);
		expect(r.status).toBe(2);
		expect(r.out).toContain("--days must be a positive number.");
		expect(r.out).toContain("usage: node fixture-check.js");
	});

	describe("numberValue", () => {
		const numberChecker = (bound: string) =>
			checker(
				`ctx.say("n=" + ctx.numberValue("--n", 5, "${bound}")); return { okLine: "x" };`,
				`valueFlags: ["--n"],`,
			);

		it("reads the flag's number, or the fallback where it is absent", () => {
			const c = numberChecker("positive");
			expect(run(c, ["--n", "2.5"]).stderr).toContain("n=2.5");
			expect(run(c).stderr).toContain("n=5");
		});

		it.each([
			["positive", "0", "--n must be a positive number."],
			["positive", "abc", "--n must be a positive number."],
			["non-negative", "-1", "--n must be a non-negative number."],
			["non-negative", "Infinity", "--n must be a non-negative number."],
		])(
			"refuses a %s flag given %s as a usage error, naming the flag and the number it must be",
			(bound, given, message) => {
				const r = run(numberChecker(bound), ["--n", given]);
				expect(r.status).toBe(2);
				expect(r.out).toContain(message);
			},
		);

		it("takes zero where the bound is non-negative", () => {
			const r = run(numberChecker("non-negative"), ["--n", "0"]);
			expect(r.stderr).toContain("n=0");
		});
	});
});

describe("an unexpected throw", () => {
	/* A crash is the checker being broken, not a finding about the thing it
	 * checks — the misattribution mantahostels#164 (the ENOBUFS-reported-as-a-SKIP ticket)
	 * was filed over. */
	it("is BROKEN, not a finding, and carries the stack", () => {
		const c = checker(`throw new TypeError("undefined is not a function");`);
		const r = run(c);
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
		expect(r.out).toContain("undefined is not a function");
		expect(r.out).toContain("fixture-check.js");
	});
});

const spawnRun = (
	file: string,
	args: string[] = [],
	env: Record<string, string> = {},
) => {
	const r = spawnSync("node", [file, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, GITHUB_ACTIONS: "", ...env },
	});
	return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
};

const AGAINST_SPEC = `against: { profile: "guard-test-isolation", materialise: "tree" },`;

describe("an async run() (#1586)", () => {
	const spawned = (body: string, spec = "", args: string[] = []) =>
		spawnRun(checker(body, spec, "async"), args);

	it("is awaited, its resolved value read as the result", () => {
		const r = spawned(`return { okLine: "awaited and clean." };`);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: awaited and clean.");
	});

	it("gates on a FAIL raised after the await", () => {
		const r = spawned(`ctx.fail("F", "late"); return { noun: "late things" };`);
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 late things");
	});

	it("SKIPs on ctx.skip after the await", () => {
		const r = spawned(`ctx.skip("GitHub is unreachable.");`);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP: GitHub is unreachable.");
	});

	it("is BROKEN on ctx.broken after the await", () => {
		const r = spawned(`ctx.broken("the payload will not parse.");`);
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN: the payload will not parse.");
	});

	it("is BROKEN with the stack on any other rejection", () => {
		const r = spawned(`throw new TypeError("late failure");`);
		expect(r.status).toBe(2);
		expect(r.out).toContain(
			"unhandled error in fixture: TypeError: late failure",
		);
		expect(r.out).toContain("fixture-check.js");
	});

	it("is BROKEN, not a silent OK, when its Promise never settles", () => {
		const r = spawned("await new Promise(() => {});");
		expect(r.status).toBe(2);
		expect(r.out).toContain(
			"run() returned a Promise that never settled — every await in run() must resolve or reject.",
		);
	});

	it("reaches the --json envelope through the same finish()", () => {
		const r = spawned(`ctx.fail("F", "late"); return { noun: "x" };`, "", [
			"--json",
		]);
		expect(r.status).toBe(1);
		const j = JSON.parse(r.stdout);
		expect(j.outcome).toBe("FAIL");
		expect(j.count).toBe(1);
	});

	it("is refused as BROKEN under --against, naming the gap", () => {
		const r = spawned("return {};", AGAINST_SPEC, ["--against", "HEAD"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain(
			"fixture declares `against` and its run() is async, but --against has no async path yet",
		);
	});

	it("is refused as BROKEN where a plain run() returns a Promise on an against spec", () => {
		const file = checker(
			`return Promise.reject(new Error("never seen"));`,
			AGAINST_SPEC,
		);
		const r = run(file);
		expect(r.status).toBe(2);
		expect(r.out).toContain("--against has no async path yet");
		expect(r.out).not.toContain("never seen");
	});

	/* The parent never calls run(), so this reaches the refusal through the
	 * re-exec'd index side, not the keyword check — a second process, as in
	 * the --against block below. */
	it("is refused as BROKEN under --against where a plain run() returns a Promise", () => {
		const root = fs.mkdtempSync(path.join(dir, "repo-"));
		const git = (...a: string[]) => spawnSync("git", a, { cwd: root });
		git("init", "-q", ".");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		git("commit", "-q", "--allow-empty", "-m", "seed");
		const file = path.join(root, "fixture-check.js");
		fs.copyFileSync(checker("return Promise.resolve({});", AGAINST_SPEC), file);
		git("add", "--", "fixture-check.js");
		const r = runInProcess(file, ["--against", "HEAD"], {
			cwd: root,
			env: { ...process.env, GITHUB_ACTIONS: "" },
		});
		expect(r.status).toBe(2);
		expect(r.stdout + r.stderr).toContain("--against has no async path yet");
	});

	it("folds a rejection run() started but never awaited as a throw", () => {
		const r = spawned(
			`const stray = Promise.reject(new Error("never awaited"));
			 await later();
			 await stray;`,
		);
		expect(r.status).toBe(2);
		expect(r.out).toContain("unhandled error in fixture: Error: never awaited");
		expect(r.out).not.toContain("threw before it could check anything");
	});

	it("SKIPs where that stray rejection is a ctx.skip", () => {
		const r = spawned(
			`const stray = (async () => ctx.skip("GitHub is unreachable."))();
			 await later();
			 await stray;`,
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP: GitHub is unreachable.");
	});

	it("exits 0 under --notify on BROKEN, printing it", () => {
		const r = spawned(`ctx.broken("late breakage.");`, "", ["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("BROKEN: late breakage.");
	});
});

describe("the summary line", () => {
	it("is <SEVERITY>: <count> <the checker's own noun>", () => {
		const c = checker(
			`ctx.fail("T","a"); ctx.fail("T","b"); ctx.fail("T","c"); return { noun: "unplaced issues" };`,
		);
		expect(run(c).stderr).toContain("FAIL: 3 unplaced issues");
	});

	/* Some checkers count finer than their own findings — citations are counted
	 * per citation across a surface that is one finding. */
	it("honours an explicit count over the finding total", () => {
		const c = checker(
			`ctx.fail("T","one surface"); return { noun: "citations", count: 17 };`,
		);
		expect(run(c).stderr).toContain("FAIL: 17 citations");
	});

	it("counts WARN findings when they are what drove the outcome", () => {
		const c = checker(
			`ctx.warn("T","a"); ctx.warn("T","b"); return { noun: "stale entries" };`,
		);
		expect(run(c).stderr).toContain("WARN: 2 stale entries");
	});
});

describe("dirtied() — the clean-but-changed-a-tracked-file channel (mantahostels#2665)", () => {
	/*
	 * status-report.js's verdict() (scripts/status-report.js:177-183) drops a
	 * checker's whole body when its LAST line is its own OK:/SKIP: summary.
	 * dirtied() exists to survive that: it must print AFTER the summary, so
	 * the note — not the summary — is the last line.
	 */
	it("prints the note after the OK summary, as the new last line", () => {
		const c = checker(
			`ctx.dirtied("data/x.json needs committing."); return { okLine: "clean." };`,
		);
		const lines = run(c).stderr.trim().split("\n");
		expect(lines.at(-1)).toBe("data/x.json needs committing.");
		expect(lines.some((l) => l.startsWith("OK: clean."))).toBe(true);
		expect(
			lines.indexOf(lines.find((l) => l.startsWith("OK:")) ?? ""),
		).toBeLessThan(lines.length - 1);
	});

	it("prints nothing extra when a run never calls it", () => {
		const c = checker(`return { okLine: "clean." };`);
		expect(run(c).stderr.trim()).toBe("OK: clean.");
	});

	it("prints after the summary on SKIP too", () => {
		const c = checker(
			`ctx.dirtied("data/x.json needs committing."); ctx.skip("nothing to check here.");`,
		);
		const lines = run(c).stderr.trim().split("\n");
		expect(lines.at(-1)).toBe("data/x.json needs committing.");
	});

	it("is suppressed under --notify, matching --notify's own OK/SKIP silence", () => {
		const c = checker(
			`ctx.dirtied("data/x.json needs committing."); return { okLine: "clean." };`,
		);
		const r = run(c, ["--notify"]);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
	});

	it("carries no --json envelope key — say() only, nothing reads it yet", () => {
		const c = checker(
			`ctx.dirtied("data/x.json needs committing."); return { okLine: "clean." };`,
		);
		const r = run(c, ["--json"]);
		expect(JSON.parse(r.stdout)).not.toHaveProperty("dirty");
	});

	/*
	 * The cross-file contract mantahostels#2665 relies on: status-report.js's verdict()
	 * (scripts/status-report.js:177-183) reads a run as non-clean whenever its
	 * LAST line matches neither /^OK:/ nor /^SKIP:/. Pinned here, against
	 * verdict()'s own regexes, rather than only against the literal note text
	 * — a future checker's dirtied() message that happened to start with "OK:"
	 * would defeat this channel without either file's own tests catching it.
	 */
	it("makes the note read as non-clean under status-report.js's own OK:/SKIP: regexes", () => {
		const c = checker(
			`ctx.dirtied("data/x.json needs committing."); return { okLine: "clean." };`,
		);
		const lastLine = run(c).stderr.trim().split("\n").at(-1) ?? "";
		expect(lastLine).not.toMatch(/^OK:/);
		expect(lastLine).not.toMatch(/^SKIP:/);
	});
});

describe("gaps a review pass found", () => {
	/*
	 * `--days --json` must not read `--json` as the value of `--days`. Without
	 * the guard the checker silently runs against a nonsense value AND loses the
	 * flag the caller actually passed.
	 */
	it("rejects a flag whose value is the next flag, naming the flag that needs a value", () => {
		const c = checker(
			`ctx.say("days=" + ctx.value("--days")); return { okLine: "x" };`,
			`valueFlags: ["--days"],`,
		);
		const r = run(c, ["--days", "--json"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("--days needs a value");
	});

	/*
	 * A checker that raised findings and then hit a SKIP did not finish, so it
	 * has no verdict. The findings stay — they were genuinely raised — but
	 * counting them puts "1 finding(s)" beside "SKIP: GitHub unreachable".
	 */
	it("counts nothing on a run that did not complete", () => {
		const c = checker(
			`ctx.fail("T", "found before the wheels came off"); ctx.skip("GitHub unreachable.");`,
		);
		const r = run(c, ["--json"]);
		const j = JSON.parse(r.stdout);
		expect(j.outcome).toBe("SKIP");
		expect(j.count).toBe(0);
		expect(j.summary).toBe("SKIP: GitHub unreachable.");
		// Kept, so the reader can see how far the run got.
		expect(j.findings).toHaveLength(1);
	});

	it("does the same for a run that broke", () => {
		const c = checker(
			`ctx.fail("T", "found first"); ctx.broken("the roadmap will not parse.");`,
		);
		const j = JSON.parse(run(c, ["--json"]).stdout);
		expect(j.outcome).toBe("BROKEN");
		expect(j.count).toBe(0);
	});

	/*
	 * A SessionStart hook reads stdout into the session. --json takes that same
	 * stream, so the pair must still exit 0 and still put the envelope there —
	 * a non-zero exit makes Claude Code treat the hook itself as broken.
	 */
	it("--notify --json keeps exit 0 and still emits the envelope", () => {
		const c = checker(`ctx.broken("cannot reach the API.");`);
		const r = run(c, ["--notify", "--json"]);
		expect(r.status).toBe(0);
		const j = JSON.parse(r.stdout);
		expect(j.outcome).toBe("BROKEN");
		expect(j.exit).toBe(0);
	});

	/*
	 * node drops what is still buffered on a pipe at process.exit, so a large
	 * envelope written with console.log/process.stdout.write is truncated
	 * mid-string and reaches the reader as invalid JSON. 64 KiB is the pipe
	 * buffer; this clears it several times over.
	 */
	it("writes an envelope past the pipe buffer without truncating it", () => {
		const c = checker(
			`for (let i = 0; i < 4000; i++) ctx.fail("T", "finding number " + i + " with enough text to matter");
			 return { noun: "things" };`,
		);
		const r = run(c, ["--json"]);
		expect(r.stdout.length).toBeGreaterThan(200_000);
		const j = JSON.parse(r.stdout); // throws if truncated
		expect(j.findings).toHaveLength(4000);
	});
});

/*
 * --against <rev> (mantahostels#1801, mantahostels#1833).
 *
 * Proved here against a fake check. What the hook's own suite still owns is
 * that it CALLS this.
 *
 * The fixture reads its faults out of a `faults.txt` under --root, so index,
 * HEAD and worktree can each be given a different fault list and the reading
 * the gate actually took is readable from the verdict.
 */
/*
 * mantahostels#2264: carried a 20,000 ms override (mantahostels#1941's 880 ms quiet reading, ~7x
 * margin against the then-5,000 ms default). Removed as a raise made
 * redundant by mantahostels#2262's 90,000 ms repo default — the margin now comes from
 * the file's ceiling, not this block.
 */
describe("--against <rev>", () => {
	/** Every --root the re-exec passed, one per line, written outside both trees. */
	const rootLog = () => path.join(dir, "roots.log");

	/**
	 * A throwaway repo with the fixture checker in it, plus HEAD's fault list.
	 *
	 * Throwaway because the shared tree's index is repo-global (mantahostels#63): a test that
	 * staged into it would sweep a parallel session's files into their commit.
	 */
	const repo = (head: string) => {
		const root = fs.mkdtempSync(path.join(dir, "repo-"));
		const git = (...args: string[]) =>
			spawnSync("git", args, { cwd: root, encoding: "utf8" });
		git("init", "-q", ".");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		fs.writeFileSync(
			path.join(root, "fixture-check.js"),
			`const fs = require("node:fs");
const p = require("node:path");
const { runCheck } = require(${JSON.stringify(LIB)});
runCheck({
  name: "fixture",
  usage: "node fixture-check.js [--against <rev>]",
  valueFlags: ["--root"],
  against: { profile: "guard-test-isolation", materialise: "tree" },
  run(ctx) {
    const root = ctx.value("--root", process.cwd());
    fs.appendFileSync(${JSON.stringify(rootLog())}, root + "\\n");
    ctx.say("THE-CHECKER'S-OWN-REPORT");
    if (fs.existsSync(p.join(root, "broken.txt"))) ctx.broken("apparatus gone.");
    let text = "";
    try { text = fs.readFileSync(p.join(root, "faults.txt"), "utf8"); } catch {}
    for (const line of text.split("\\n").filter(Boolean))
      ctx.fail("F", line, { file: line });
    return { noun: "faults" };
  },
});
`,
		);
		fs.writeFileSync(path.join(root, "faults.txt"), head);
		git("add", "--", "faults.txt");
		git("commit", "-qm", "seed");
		return { root, git };
	};

	/** Stage `staged` and leave `worktree` unstaged, then run the gate. */
	const gate = (
		head: string,
		staged?: string,
		{
			worktree,
			args = ["--against", "HEAD"],
			env = {},
		}: {
			worktree?: string;
			args?: string[];
			env?: Record<string, string>;
		} = {},
	) => {
		fs.rmSync(rootLog(), { force: true });
		const { root, git } = repo(head);
		if (staged !== undefined) {
			fs.writeFileSync(path.join(root, "faults.txt"), staged);
			git("add", "--", "faults.txt");
		}
		if (worktree !== undefined)
			fs.writeFileSync(path.join(root, "faults.txt"), worktree);
		/* spawn-kept: a real fd — the re-exec streams the checker's own report
		 * to fd 2 through its inherited stderr, past run-in-process's capture. */
		const r = spawnSync(
			"node",
			[path.join(root, "fixture-check.js"), ...args],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, GITHUB_ACTIONS: "", ...env },
			},
		);
		return {
			root,
			git,
			status: r.status ?? -1,
			stdout: r.stdout ?? "",
			out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
			roots: fs.existsSync(rootLog())
				? fs.readFileSync(rootLog(), "utf8").trim().split("\n")
				: [],
		};
	};

	it("refuses a commit that ADDS a fault, naming it", () => {
		const r = gate("a\n", "a\nb\n");
		expect(r.status).toBe(1);
		expect(r.out).toContain("are NOT in HEAD");
		expect(r.out).toContain("findings: b");
		expect(r.out).not.toContain("findings: a");
	});

	it("passes a commit that INHERITS every fault, saying so", () => {
		const r = gate("a\n", "a\n");
		expect(r.status).toBe(0);
		expect(r.out).toContain("already in HEAD");
		expect(r.out).toContain("scheduled sweeps");
	});

	it("judges the INDEX, never the working tree a neighbour is editing", () => {
		// `b` exists only in the worktree copy — the residual this flag closes.
		const r = gate("a\n", "a\n", { worktree: "a\nb\n" });
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("findings: b");
	});

	it("honours GIT_INDEX_FILE, which `git commit -- <paths>` sets for its hooks", () => {
		const { root, git } = repo("a\n");
		// The fault is staged into the REAL index; `alt` is never written to.
		fs.writeFileSync(path.join(root, "faults.txt"), "a\nb\n");
		const alt = path.join(dir, "alt-index");
		git("add", "--", "faults.txt");
		spawnSync("git", ["write-tree"], { cwd: root, encoding: "utf8" });
		const r = runInProcess(
			path.join(root, "fixture-check.js"),
			["--against", "HEAD"],
			{
				cwd: root,
				env: { ...process.env, GITHUB_ACTIONS: "", GIT_INDEX_FILE: alt },
			},
		);
		// The alternate index is empty, so it stages no faults.txt at all.
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).not.toContain("findings: b");
	});

	describe("--index (#3687)", () => {
		const index = (head: string, staged?: string, worktree?: string) =>
			gate(head, staged, { worktree, args: ["--index"] });

		it("refuses a staged fault HEAD already carries, which --against would pass", () => {
			const r = index("a\n", "a\n");
			expect(r.status).toBe(1);
			expect(r.out).toContain("FAIL: 1 faults");
		});

		it("judges the staged bytes, never the working tree", () => {
			expect(index("", "", "b\n").status).toBe(0);
			const r = index("", "b\n", "");
			expect(r.status).toBe(1);
			expect(r.out).toContain("FAIL: 1 faults");
		});

		it("re-execs over a materialised tree, streaming the checker's own report", () => {
			const r = index("", "");
			expect(r.status).toBe(0);
			expect(r.roots).toHaveLength(1);
			expect(r.roots[0]).not.toBe(r.root);
			expect(r.out).toContain("THE-CHECKER'S-OWN-REPORT");
		});

		it("carries the index side's findings into its --json envelope", () => {
			const r = gate("", "a\n", { args: ["--index", "--json"] });
			expect(r.status).toBe(1);
			const envelope = JSON.parse(r.stdout);
			expect(envelope.count).toBe(1);
			expect(envelope.findings).toMatchObject([{ tag: "F", message: "a" }]);
		});

		it("judges the private index a pathspec commit hands its hooks", () => {
			const { root, git } = repo("");
			// A neighbour's fault, staged in the live index alone.
			fs.writeFileSync(path.join(root, "faults.txt"), "b\n");
			git("add", "--", "faults.txt");
			const r = runInProcess(path.join(root, "fixture-check.js"), ["--index"], {
				cwd: root,
				env: {
					...process.env,
					GITHUB_ACTIONS: "",
					GIT_INDEX_FILE: path.join(dir, "alt-index"),
				},
			});
			expect(r.status).toBe(0);
		});

		it("carries a BROKEN index side, naming the checker's reason", () => {
			const { root, git } = repo("");
			fs.writeFileSync(path.join(root, "broken.txt"), "");
			git("add", "--", "broken.txt");
			const r = runInProcess(path.join(root, "fixture-check.js"), ["--index"], {
				cwd: root,
				env: { ...process.env, GITHUB_ACTIONS: "" },
			});
			expect(r.status).toBe(2);
			expect(`${r.stdout}${r.stderr}`).toContain("BROKEN: apparatus gone.");
		});

		it("caps the index side's findings under --warn", () => {
			const r = gate("", "a\n", { args: ["--index", "--warn"] });
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN: 1 faults");
		});

		it("refuses --index on a checker that declares no materialisation", () => {
			const r = run(checker("return {};"), ["--index"]);
			expect(r.status).toBe(2);
			expect(r.out).toContain("takes no --index");
		});

		it("refuses --index together with --root or --against", () => {
			const c = checker("return {};", AGAINST_SPEC);
			for (const [extra, says] of [
				[["--root", dir], "cannot be combined with --root"],
				[["--against", "HEAD"], "--index judges the index alone"],
			] as const) {
				const r = run(c, ["--index", ...extra]);
				expect(r.status).toBe(2);
				expect(r.out).toContain(says);
			}
		});

		it("runs the spec's refuse() before reading the index", () => {
			const c = checker(
				"return {};",
				`against: { profile: "guard-test-isolation", materialise: "tree", refuse: (ctx) => ctx.usageError("NOT-WITH-THIS") },`,
			);
			const r = run(c, ["--index"]);
			expect(r.status).toBe(2);
			expect(r.out).toContain("NOT-WITH-THIS");
		});
	});

	it("reads the baseline only when the index has something to attribute", () => {
		const clean = gate("", "");
		expect(clean.status).toBe(0);
		expect(clean.roots).toHaveLength(1);

		const dirty = gate("a\n", "a\n");
		expect(dirty.roots).toHaveLength(2);
	});

	it("re-execs itself against materialised trees, never the live directory", () => {
		const r = gate("a\n", "a\n");
		for (const root of r.roots) expect(root).not.toBe(r.root);
		expect(fs.existsSync(r.roots[0])).toBe(false);
	});

	it("streams the checker's own report past, which is all a session reads", () => {
		expect(gate("", "").out).toContain("THE-CHECKER'S-OWN-REPORT");
	});

	/* The baseline is read lazily, so a typo'd rev is never resolved on a clean
	 * index — and would pass every commit in silence. */
	it("fails closed on an unresolvable rev even when the index is clean", () => {
		const r = gate("", "", { args: ["--against", "no-such-rev"] });
		expect(r.status).toBe(2);
		expect(r.out).not.toContain("OK:");
	});

	/* mantahostels#155's alphabet, and what the shell gate did before mantahostels#1833: the checker
	 * declining to run is not the repo's fault, and gating on it teaches a
	 * reader to ignore the gate. Only the BASELINE side fails closed. */
	it("passes an index side that SKIPs, rather than refusing the commit", () => {
		const c = checker(
			`ctx.skip("the corpus is absent.");`,
			`
  against: { profile: "guard-test-isolation", materialise: "tree" },`,
		);
		const { root, git } = repo("");
		fs.copyFileSync(c, path.join(root, "skip-check.js"));
		git("add", "--", "skip-check.js");
		git("commit", "-qm", "add");
		const r = runInProcess(
			path.join(root, "skip-check.js"),
			["--against", "HEAD"],
			{
				cwd: root,
				env: { ...process.env, GITHUB_ACTIONS: "" },
			},
		);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("the corpus is absent.");
	});

	it("fails closed when the rev cannot be resolved", () => {
		const r = gate("a\n", "a\n", { args: ["--against", "no-such-rev"] });
		expect(r.status).toBe(2);
		expect(r.out).not.toContain("already in");
	});

	it("fails closed when the BASELINE side is BROKEN, which cannot mean inherited", () => {
		const { root, git } = repo("a\n");
		fs.writeFileSync(path.join(root, "broken.txt"), "x\n");
		git("add", "--", "broken.txt");
		git("commit", "-qm", "break HEAD");
		fs.rmSync(path.join(root, "broken.txt"));
		git("rm", "-q", "--cached", "broken.txt");
		const r = runInProcess(
			path.join(root, "fixture-check.js"),
			["--against", "HEAD"],
			{
				cwd: root,
				env: { ...process.env, GITHUB_ACTIONS: "" },
			},
		);
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toContain("no readable HEAD baseline");
		expect(`${r.stdout}${r.stderr}`).not.toContain("already in HEAD");
	});

	it("fails closed when the index side is BROKEN, rather than reading it as inherited, naming the reason the checker gave", () => {
		// A BROKEN checker emits a VALID EMPTY envelope, so the comparison would
		// find nothing new and pass a commit it could not judge at all (mantahostels#1753).
		const c = checker(
			`ctx.broken("cannot read the corpus.");`,
			`
  against: { profile: "guard-test-isolation", materialise: "tree" },`,
		);
		const { root, git } = repo("");
		fs.copyFileSync(c, path.join(root, "broken-check.js"));
		git("add", "--", "broken-check.js");
		git("commit", "-qm", "add");
		const r = runInProcess(
			path.join(root, "broken-check.js"),
			["--against", "HEAD"],
			{
				cwd: root,
				env: { ...process.env, GITHUB_ACTIONS: "" },
			},
		);
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toContain("cannot read the corpus.");
	});

	/*
	 * The seven cases below pass `--against` through `run()` (the converted
	 * seam), not `gate()`/`gateBlobs()` (real spawns) — safe because every one
	 * refuses before `runAgainst`/`reread` ever runs, so the real-fd exemption
	 * (mantahostels#1993, mantahostels#1945) never applies to them. The seventh, "does not swallow the
	 * rev...", moved to a real spawn at mantahostels#2109 — it needs `reread` to run, so
	 * it's now in the set this exemption excludes.
	 */
	it("refuses --against on a checker that does not direction-gate", () => {
		const c = checker("return {};");
		const r = run(c, ["--against", "HEAD"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("does not direction-gate");
	});

	it("refuses --against together with --root, which answers the same question", () => {
		const c = checker(
			"return {};",
			`
  against: { profile: "guard-test-isolation", materialise: "tree" },`,
		);
		const r = run(c, ["--against", "HEAD", "--root", dir]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot be combined with --root");
	});

	it("refuses --head with no --against, whose judged side it names (#3074)", () => {
		const c = checker(
			"return {};",
			`
  against: { profile: "guard-test-isolation", materialise: "tree" },`,
		);
		const r = run(c, ["--head", "HEAD"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("--head names the judged side of --against");
	});

	it("refuses a profile lib/fault-profiles.js does not carry", () => {
		const c = checker(
			"return {};",
			`
  against: { profile: "no-such-profile", materialise: "tree" },`,
		);
		const r = run(c, ["--against", "HEAD"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("no-such-profile");
	});

	it("refuses a materialisation the library does not have, naming it and the ones it does have", () => {
		const c = checker(
			"return {};",
			`
  against: { profile: "guard-test-isolation", materialise: "photocopy" },`,
		);
		const r = run(c, ["--against", "HEAD"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("photocopy");
		// The refusal names what it WOULD have taken, or a typo is a guessing game.
		expect(r.out).toContain("tree");
		expect(r.out).toContain("blobs");
	});

	it("lets a spec refuse a flag pair of its own, with its own message", () => {
		const c = checker(
			"return {};",
			`
  flags: ["--review"],
  against: {
    profile: "guard-test-isolation",
    materialise: "tree",
    refuse: (ctx) => { if (ctx.has("--review")) ctx.usageError("no --review here."); },
  },`,
		);
		const r = run(c, ["--against", "HEAD", "--review"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("no --review here.");
	});

	it("does not swallow the rev into ctx.args as a positional", () => {
		const c = checker(
			`ctx.say("args=" + JSON.stringify(ctx.args)); return {};`,
		);
		const r = run(c, ["HEAD"]);
		expect(r.out).toContain('args=["HEAD"]');
		const bad = checker(
			`ctx.say("args=" + JSON.stringify(ctx.args)); return {};`,
			`
  valueFlags: ["--root"], // declared so reread()'s own "--root <dir>" doesn't land in ctx.args and mask the assertion below
  against: { profile: "guard-test-isolation", materialise: "tree" },`,
		);
		const { root, git } = repo("");
		fs.copyFileSync(bad, path.join(root, "against-check.js"));
		git("add", "--", "against-check.js");
		git("commit", "-qm", "add");
		/* spawn-kept: a real fd — the re-exec's ctx.say output reaches fd 2
		 * through its inherited stderr, past run-in-process's capture. */
		const r2 = spawnSync(
			"node",
			[path.join(root, "against-check.js"), "--against", "HEAD"],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, GITHUB_ACTIONS: "" },
			},
		);
		const out2 = `${r2.stdout ?? ""}${r2.stderr ?? ""}`;
		expect(r2.status).toBe(0);
		expect(out2).toContain("args=[]");
		expect(out2).not.toContain('"HEAD"');
	});
});
/*
 * The second materialisation (mantahostels#1834). `tree` extracts a whole revision for a
 * checker that discovers its own scan roots; `blobs` fetches exactly the paths
 * the spec's pathspecs() names, for one whose scope IS a pathspec. The
 * difference is cost, so what these pin is that the cheap path is the one
 * actually taken.
 */
/*
 * mantahostels#2264: carried a 20,000 ms override (mantahostels#1941's 0.42 s-a-side quiet reading).
 * Removed as a raise made redundant by mantahostels#2262's 90,000 ms repo default, the
 * same as the block above.
 */
describe("--against with the blobs materialisation", () => {
	/**
	 * A repo whose fixture checker LISTS everything under --root, so a test can
	 * read back exactly which paths the materialisation put there.
	 */
	const blobRepo = (spec: string) => {
		const root = fs.mkdtempSync(path.join(dir, "blobrepo-"));
		const git = (...args: string[]) =>
			spawnSync("git", args, { cwd: root, encoding: "utf8" });
		git("init", "-q", ".");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		fs.writeFileSync(
			path.join(root, "fixture-check.js"),
			`const fs = require("node:fs");
const p = require("node:path");
const { runCheck } = require(${JSON.stringify(LIB)});
const walk = (d, base) => {
  let out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const at = p.join(d, e.name);
    out = out.concat(e.isDirectory() ? walk(at, base) : [p.relative(base, at)]);
  }
  return out.sort();
};
runCheck({
  name: "fixture",
  usage: "node fixture-check.js [--against <rev>]",
  valueFlags: ["--root"],
  ${spec}
  run(ctx) {
    const root = ctx.value("--root", process.cwd());
    const seen = walk(root, root);
    ctx.say("SAW=" + JSON.stringify(seen));
    ctx.say("ARGS=" + JSON.stringify(ctx.args));
    for (const rel of seen) {
      const stat = fs.lstatSync(p.join(root, rel));
      if (stat.isSymbolicLink()) ctx.say("LINK=" + rel);
    }
    const bad = seen.filter((f) => f.startsWith("wanted/") &&
      fs.readFileSync(p.join(root, f), "utf8").includes("TELL"));
    for (const f of bad) ctx.fail("F", f, { file: f });
    return { noun: "faults", data: { seen } };
  },
});
`,
		);
		return { root, git };
	};

	const blobSpec = `
  against: {
    profile: "guard-test-isolation",
    materialise: "blobs",
    pathspecs: (ctx) => (ctx.args.length ? ctx.args : ["wanted"]),
  },`;

	const seed = (root: string, git: (...a: string[]) => unknown) => {
		fs.mkdirSync(path.join(root, "wanted"), { recursive: true });
		fs.mkdirSync(path.join(root, "elsewhere"), { recursive: true });
		fs.writeFileSync(path.join(root, "wanted", "a.txt"), "fine\n");
		fs.writeFileSync(
			path.join(root, "elsewhere", "huge.txt"),
			"x".repeat(4096),
		);
		git("add", "-A");
		git("commit", "-qm", "seed");
	};

	const gateBlobs = (root: string, args: string[] = ["--against", "HEAD"]) => {
		/* spawn-kept: a real fd — the re-exec's ctx.say output reaches fd 2
		 * through its inherited stderr, past run-in-process's capture. */
		const r = spawnSync(
			"node",
			[path.join(root, "fixture-check.js"), ...args],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, GITHUB_ACTIONS: "" },
			},
		);
		return {
			status: r.status ?? -1,
			out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		};
	};

	/*
	 * THE MUTATION THIS EXISTS FOR: swap `blobs` for `tree` in the spec and this
	 * fails, because the whole-tree extraction brings `elsewhere/` with it.
	 */
	it("fetches the pathspec's paths and nothing else", () => {
		const { root, git } = blobRepo(blobSpec);
		seed(root, git);
		const r = gateBlobs(root);
		expect(r.status).toBe(0);
		expect(r.out).toContain('SAW=["wanted/a.txt"]');
		expect(r.out).not.toContain("elsewhere");
	});

	/* A corrupt or partly-fetched object store (mantahostels#1834). Constructed with
	 * `mktree --missing`, porcelain refusing to build a tree over an object it
	 * does not hold. */
	it("is BROKEN when git lists a blob it will not then return", () => {
		const { root, git } = blobRepo(blobSpec);
		seed(root, git);
		const real = String(
			execFileSync("git", ["rev-parse", "HEAD:wanted/a.txt"], {
				cwd: root,
				encoding: "utf8",
			}),
		).trim();
		const sub = String(
			execFileSync("git", ["mktree", "--missing"], {
				cwd: root,
				encoding: "utf8",
				input:
					"100644 blob 0000000000000000000000000000000000000001\tghost.txt\n" +
					`100644 blob ${real}\ta.txt\n`,
			}),
		).trim();
		const top = String(
			execFileSync("git", ["mktree", "--missing"], {
				cwd: root,
				encoding: "utf8",
				input: `040000 tree ${sub}\twanted\n`,
			}),
		).trim();
		const commit = String(
			execFileSync("git", ["commit-tree", top, "-p", "HEAD", "-m", "ghost"], {
				cwd: root,
				encoding: "utf8",
			}),
		).trim();
		/* The baseline is lazy, so a clean staged side would never fetch it. */
		fs.writeFileSync(path.join(root, "wanted", "b.txt"), "TELL\n");
		git("add", "-A");
		const r = gateBlobs(root, ["--against", commit]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("wanted/ghost.txt");
	});

	it("refuses a commit that adds a fault inside the pathspec, naming the file", () => {
		const { root, git } = blobRepo(blobSpec);
		seed(root, git);
		fs.writeFileSync(path.join(root, "wanted", "b.txt"), "TELL\n");
		git("add", "-A");
		const r = gateBlobs(root);
		expect(r.status).toBe(1);
		expect(r.out).toContain("wanted/b.txt");
	});

	/* A symlink's blob is its TARGET PATH, so writing it as a file would make
	 * check-context-budget.js's own/vendored split read every vendored skill as
	 * an own one and charge its description to the capped pool. */
	it("writes a symlink back as a symlink, not as its target's text", () => {
		const { root, git } = blobRepo(blobSpec);
		fs.mkdirSync(path.join(root, "wanted"), { recursive: true });
		fs.writeFileSync(path.join(root, "wanted", "real.txt"), "fine\n");
		fs.symlinkSync("real.txt", path.join(root, "wanted", "link.txt"));
		git("add", "-A");
		git("commit", "-qm", "seed");
		const r = gateBlobs(root);
		expect(r.out).toContain("LINK=wanted/link.txt");
	});

	/* The re-exec drops the caller's flags but must keep the positionals, or both
	 * sides scan the default root instead of the one asked about. */
	it("carries the caller's positionals into the pathspec and the re-exec", () => {
		const { root, git } = blobRepo(blobSpec);
		seed(root, git);
		const r = gateBlobs(root, ["elsewhere", "--against", "HEAD"]);
		// The pathspec side: only what the positional named was materialised.
		expect(r.out).toContain("elsewhere/huge.txt");
		expect(r.out).not.toContain("wanted/a.txt");
		// The re-exec side, which a checker deriving its own scope from ctx.args
		// depends on and this fixture does not — check-website-copy.test.ts is
		// where that half refuses a commit.
		expect(r.out).toContain('ARGS=["elsewhere"]');
	});

	/* A gate about to go green over scope it never looked at is what BROKEN is
	 * for (check.js's header, the SKIP/BROKEN boundary). */
	it("is BROKEN when the spec names no pathspec at all", () => {
		const { root, git } = blobRepo(`
  against: {
    profile: "guard-test-isolation",
    materialise: "blobs",
    pathspecs: () => [],
  },`);
		seed(root, git);
		const r = gateBlobs(root);
		expect(r.status).toBe(2);
		expect(r.out).toContain("named no pathspec");
	});

	/*
	 * `baseline: "always"`. The lazy default reads <rev> only where the index
	 * already carries a gating fault, which silences a NON-gating direction
	 * finding on exactly the clean commits it exists for — check-context-budget.js's
	 * admissibility prompt. Affordable here only because this is a blob fetch.
	 */
	const noteSpec = `
  against: {
    profile: "context-budget",
    materialise: "blobs",
    baseline: "always",
    pathspecs: () => ["wanted"],
  },`;

	const noteRepo = () => {
		const root = fs.mkdtempSync(path.join(dir, "noterepo-"));
		const git = (...args: string[]) =>
			spawnSync("git", args, { cwd: root, encoding: "utf8" });
		git("init", "-q", ".");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		fs.writeFileSync(
			path.join(root, "fixture-check.js"),
			`const fs = require("node:fs");
const p = require("node:path");
const { runCheck } = require(${JSON.stringify(LIB)});
runCheck({
  name: "fixture",
  usage: "node fixture-check.js [--against <rev>]",
  valueFlags: ["--root"],
  ${noteSpec}
  run(ctx) {
    const root = ctx.value("--root", process.cwd());
    const bytes = fs.readFileSync(p.join(root, "wanted", "a.txt"), "utf8").length;
    return { noun: "x", data: { admissibility: [{ surface: "s", bytes,
      message: "GREW-NOTE" }] } };
  },
});
`,
		);
		fs.mkdirSync(path.join(root, "wanted"), { recursive: true });
		fs.writeFileSync(path.join(root, "wanted", "a.txt"), "aa");
		git("add", "-A");
		git("commit", "-qm", "seed");
		return { root, git };
	};

	const runNote = (root: string) =>
		runInProcess(path.join(root, "fixture-check.js"), ["--against", "HEAD"], {
			cwd: root,
			env: { ...process.env, GITHUB_ACTIONS: "" },
		});

	it("reads the baseline on a clean index and reports what grew, without gating", () => {
		const { root, git } = noteRepo();
		fs.writeFileSync(path.join(root, "wanted", "a.txt"), "aaaa");
		git("add", "-A");
		const r = runNote(root);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("GREW-NOTE");
	});

	it("says nothing where the same reading did not grow", () => {
		const { root, git } = noteRepo();
		fs.writeFileSync(path.join(root, "wanted", "a.txt"), "a");
		git("add", "-A");
		const r = runNote(root);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).not.toContain("GREW-NOTE");
	});
});

/*
 * A throw that lands OUTSIDE runCheck's own try (mantahostels#1899): a top-level require in
 * the checker, or CheckContext's argv parse. Node's own report goes to stderr
 * and a SessionStart hook injects stdout alone, so before this the checker was
 * simply silent.
 */
describe("a crash before runCheck can catch it", () => {
	/** A checker that throws while its own top-level requires are still running. */
	const crasher = () => {
		const file = path.join(dir, "crash-check.js");
		fs.writeFileSync(
			file,
			`require(${JSON.stringify(LIB)});
require("./no-such-module-at-all.js");
`,
		);
		return file;
	};

	it("reports BROKEN on stderr and exits 2", () => {
		const r = run(crasher());
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain("no-such-module-at-all");
	});

	/* --notify's reader is stdout, and it exits 0 so a session
	 * start is never blocked on a checker. */
	it("reports on STDOUT under --notify, and still exits 0", () => {
		const r = run(crasher(), ["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("BROKEN");
		expect(r.stderr).toBe("");
	});

	it("keeps stdout a single parseable envelope under --json", () => {
		const r = run(crasher(), ["--json"]);
		expect(r.status).toBe(2);
		expect(JSON.parse(r.stdout)).toMatchObject({ outcome: "BROKEN" });
	});

	/* CheckContext parses argv before the try begins, so a usage error raised
	 * there took the same silent path. */
	it("reports a throw from the argv parse too", () => {
		const file = path.join(dir, "argv-check.js");
		fs.writeFileSync(
			file,
			`const { runCheck } = require(${JSON.stringify(LIB)});
runCheck({
  name: "fixture",
  usage: "node argv-check.js",
  get valueFlags() { throw new Error("argv parse blew up"); },
  run() { return {}; },
});
`,
		);
		const r = run(file, ["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("argv parse blew up");
	});
});

/*
 * PERSIST MODE (mantahostels#1974). WFC_NOTIFY_PERSIST=1 sends the --notify report to a
 * file instead of stdout, so an `async` SessionStart hook — whose stdout the
 * harness discards — still reaches a reader (mantahostels#1949).
 *
 * Every test points CLAUDE_CONFIG_DIR and CLAUDE_PROJECT_DIR at throwaway
 * directories: without it the founder's real config dir collects a stray
 * notify-reports/ tree.
 */
describe("persist mode", () => {
	// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
	const notify: any = createRequire(__filename)("./notify-report.js");
	const savedEnv = { ...process.env };
	/** The env the async hook command would set, plus the sandboxing. */
	let persistEnv: Record<string, string>;

	beforeEach(() => {
		process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
		process.env.CLAUDE_PROJECT_DIR = path.join(dir, "repo");
		// configDirs()'s own test seams: an exported one here would put the reports
		// somewhere neither this test nor the run under it agrees on.
		delete process.env.WFC_CLAUDE_CONFIG_A;
		delete process.env.WFC_CLAUDE_CONFIG_B;
		delete process.env.WFC_CLAUDE_CONFIG_C;
		fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
		persistEnv = {
			WFC_NOTIFY_PERSIST: "1",
			CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
			CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
			WFC_CLAUDE_CONFIG_A: "",
			WFC_CLAUDE_CONFIG_B: "",
			WFC_CLAUDE_CONFIG_C: "",
		};
	});
	afterEach(() => {
		process.env = { ...savedEnv };
	});

	const readStateFiles = () => {
		try {
			return fs.readdirSync(notify.base()).sort();
		} catch {
			return [];
		}
	};

	it("writes the report to a file and nothing to stdout", () => {
		const c = checker(
			`ctx.say("detail line"); ctx.fail("T","x"); return { noun: "n" };`,
		);
		const r = run(c, ["--notify"], persistEnv);

		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
		const report = notify.readReport("fixture");
		expect(report.outcome).toBe("FAIL");
		expect(report.text).toBe("detail line\nFAIL: 1 n\n");
	});

	it("keeps an async checker's report when its main is awaited in-process", async () => {
		const file = path.join(dir, "fixture-check.js");
		fs.writeFileSync(
			file,
			`const { runCheck } = require(${JSON.stringify(LIB)});
const main = () => runCheck({
  name: "fixture",
  usage: "node fixture-check.js",
  async run(ctx) { ctx.fail("T", "x"); return { noun: "n" }; },
});
module.exports = { main };
if (require.main === module) main();
`,
		);
		const r = await runInProcessAsync(file, ["--notify"], {
			cwd: dir,
			env: { ...process.env, GITHUB_ACTIONS: "", ...persistEnv },
		});

		expect(r.status).toBe(0);
		const report = notify.readReport("fixture");
		expect(report.outcome).toBe("FAIL");
		expect(report.text).toBe("FAIL: 1 n\n");
	});

	/* The producer never stamps under persist mode, so the signature travels in
	 * the report instead (mantahostels#1975). */
	it("carries the checker's delivery stamp into the report", () => {
		const c = checker(
			`ctx.fail("T","x"); return { noun: "n", stamp: "sig-1" };`,
		);
		run(c, ["--notify"], persistEnv);

		expect(notify.readReport("fixture").stamp).toBe("sig-1");
	});

	it("stamps the report with the session it ran in", () => {
		const c = checker(`ctx.fail("T","x"); return { noun: "n" };`);
		run(c, ["--notify"], { ...persistEnv, CLAUDE_CODE_SESSION_ID: "s-own" });
		expect(notify.readReport("fixture").owner).toBe("s-own");
	});

	it("carries no stamp where the checker returned none", () => {
		run(
			checker(`ctx.fail("T","x"); return { noun: "n" };`),
			["--notify"],
			persistEnv,
		);

		expect(notify.readReport("fixture").stamp).toBeNull();
	});

	/* mantahostels#2277: a checker holding several stamps — check-hook-liveness.js's eight
	 * assertions, check-guard-errors.js's INERT warning — hands every one of
	 * them to the reader through `stamps`, beside the single `stamp` field. */
	it("carries the checker's whole stamps map into the report", () => {
		const c = checker(
			`ctx.fail("T","x"); return { noun: "n", stamps: { "fixture-a": "sig-a", "fixture-b": "sig-b" } };`,
		);
		run(c, ["--notify"], persistEnv);

		expect(notify.readReport("fixture").stamps).toEqual({
			"fixture-a": "sig-a",
			"fixture-b": "sig-b",
		});
	});

	it("carries an empty stamps map where the checker returned none", () => {
		run(
			checker(`ctx.fail("T","x"); return { noun: "n" };`),
			["--notify"],
			persistEnv,
		);

		expect(notify.readReport("fixture").stamps).toEqual({});
	});

	it("persists exactly what --notify would have printed", () => {
		const body = `ctx.say("first"); ctx.say(""); ctx.say("second"); ctx.warn("T","x"); return { noun: "n" };`;
		const printed = run(checker(body), ["--notify"]).stdout;
		// Or the comparison below holds for two empty strings.
		expect(printed).toBe("first\n\nsecond\nWARN: 1 n\n");
		run(checker(body), ["--notify"], persistEnv);
		expect(notify.readReport("fixture").text).toBe(printed);
	});

	/* The reader has to tell "ran and had nothing to say" from "never ran", and
	 * only a present file can say the first. */
	it("writes a file with empty text for an OK run", () => {
		run(checker(`return { okLine: "clean." };`), ["--notify"], persistEnv);
		const report = notify.readReport("fixture");
		expect(report.outcome).toBe("OK");
		expect(report.text).toBe("");
	});

	it("records the outcome of a SKIP and a BROKEN run too", () => {
		run(checker(`ctx.skip("no net");`), ["--notify"], persistEnv);
		expect(notify.readReport("fixture").outcome).toBe("SKIP");
		run(checker(`ctx.broken("bad usage");`), ["--notify"], persistEnv);
		const broken = notify.readReport("fixture");
		expect(broken.outcome).toBe("BROKEN");
		expect(broken.text).toBe("BROKEN: bad usage\n");
	});

	it("wraps the run in an open record and closes it at the end", () => {
		const c = checker(
			`const fs = require("node:fs");
       ctx.say("open while running: " + fs.existsSync(${JSON.stringify("RUNFILE")}));
       return { okLine: "clean." };`,
		);
		// The path is only knowable once the env above is in force, so it is
		// patched into the fixture rather than computed inside it.
		fs.writeFileSync(
			c,
			fs
				.readFileSync(c, "utf8")
				.replace('"RUNFILE"', JSON.stringify(runRecordFile("fixture"))),
		);

		run(c, ["--notify"], persistEnv);
		expect(notify.readReport("fixture").text).toContain(
			"open while running: true",
		);
		expect(notify.readRun("fixture")).toBeNull();
		expect(readStateFiles()).toEqual(["fixture.report.json"]);
	});

	/* The checker runs in this process, so it shares the fake clock and moves
	 * it on by a known 250 ms. A fixed WFC_NOW holds `now()` still, so a
	 * duration read off `now()` would be 0. */
	it("times the run, and records the elapsed time rather than a clock", () => {
		const fixtureGlobals = globalThis as {
			advanceClock?: (ms: number) => void;
		};
		vi.useFakeTimers({ toFake: ["Date", "performance"], now: 1_000_000 });
		fixtureGlobals.advanceClock = (ms) => vi.advanceTimersByTime(ms);
		try {
			run(
				checker(`advanceClock(250); return { okLine: "clean." };`),
				["--notify"],
				{ ...persistEnv, WFC_NOW: "2026-01-01T00:00:00Z" },
			);
		} finally {
			vi.useRealTimers();
			delete fixtureGlobals.advanceClock;
		}
		expect(notify.readReport("fixture").durationMs).toBe(250);
	});

	it("persists an async run's report through the same finish() (#1586)", () => {
		const c = checker(`ctx.fail("T","x"); return { noun: "n" };`, "", "async");
		const r = spawnRun(c, ["--notify"], persistEnv);

		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
		expect(notify.readReport("fixture").outcome).toBe("FAIL");
	});

	/* The last-resort reporter (mantahostels#1899) has to reach the file too: under an async
	 * hook its stdout is discarded. Keyed on the FILE's name, no spec having
	 * been read — `crash-check.js` => `crash-check`. */

	it("persists a crash that lands outside runCheck", () => {
		const file = path.join(dir, "crash-check.js");
		fs.writeFileSync(
			file,
			`require(${JSON.stringify(LIB)});
require("./no-such-module-at-all.js");
`,
		);
		const r = run(file, ["--notify"], persistEnv);

		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
		const report = notify.readReport("crash-check");
		expect(report.outcome).toBe("BROKEN");
		expect(report.text).toContain("no-such-module-at-all");
	});

	/* The three paths the variable must not reach, asserted on the file as well
	 * as the stream: a report nobody replays is still a behaviour change for a
	 * CI or pre-commit caller. */
	it("leaves --notify on stdout when the variable is absent", () => {
		const c = checker(`ctx.say("detail line"); ctx.fail("T","x"); return {};`);
		const { WFC_NOTIFY_PERSIST: _unset, ...withoutIt } = persistEnv;
		const r = run(c, ["--notify"], withoutIt);
		expect(r.stdout).toContain("detail line");
		expect(readStateFiles()).toEqual([]);
	});

	/* `=== "1"`, not truthiness: mantahostels#1924's cost of keying off mere presence. */
	it("ignores a value that is not exactly 1", () => {
		const c = checker(`ctx.say("detail line"); ctx.fail("T","x"); return {};`);
		for (const value of ["0", "true", "yes"]) {
			const r = run(c, ["--notify"], {
				...persistEnv,
				WFC_NOTIFY_PERSIST: value,
			});
			expect(r.stdout).toContain("detail line");
		}
		expect(readStateFiles()).toEqual([]);
	});

	it("leaves a hand run on stderr with the variable set", () => {
		const c = checker(`ctx.say("detail line"); ctx.fail("T","x"); return {};`);
		const r = run(c, [], persistEnv);
		expect(r.stderr).toContain("detail line");
		expect(r.stdout).toBe("");
		expect(r.status).toBe(1);
		expect(readStateFiles()).toEqual([]);
	});

	it("leaves the --json envelope and its exit code alone", () => {
		const c = checker(`ctx.say("detail line"); ctx.fail("T","x"); return {};`);
		const r = run(c, ["--json", "--notify"], persistEnv);
		const j = JSON.parse(r.stdout);
		expect(j.checker).toBe("fixture");
		expect(j.outcome).toBe("FAIL");
		expect(j.exit).toBe(0);
		expect(readStateFiles()).toEqual([]);
	});

	/* notify-report.js degrades to a no-op rather than throwing, so an
	 * unwritable state directory must not swallow the report. */
	it("falls back to stdout when the write cannot land", () => {
		const c = checker(`ctx.say("detail line"); ctx.fail("T","x"); return {};`);
		// A regular file where the config dirs' PARENT should be, so every
		// candidate base() sorts through is unmakeable rather than just the first.
		const blocked = path.join(dir, "blocked");
		fs.writeFileSync(blocked, "not a directory");
		const under = path.join(blocked, "claude");
		const r = run(c, ["--notify"], {
			...persistEnv,
			CLAUDE_CONFIG_DIR: under,
			WFC_CLAUDE_CONFIG_A: under,
			WFC_CLAUDE_CONFIG_B: under,
			WFC_CLAUDE_CONFIG_C: under,
		});
		expect(r.stdout).toContain("detail line");
		expect(r.status).toBe(0);
	});
});

/*
 * An adopter's product check imports this harness, and must not drag the
 * session-arbiter store in with it (#459).
 */
describe("the harness's import closure", () => {
	const arbiterOrNotify = /[/\\](?:arbiter-[^/\\]+|notify-report)\.js$/;

	/** Run a clean fixture check and return every module its process loaded. */
	const readLoadedModules = (
		args: string[],
		env: Record<string, string> = {},
	) => {
		const out = path.join(dir, "loaded.json");
		const file = path.join(dir, "closure-check.js");
		fs.writeFileSync(
			file,
			`process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(require.cache))));
const { runCheck } = require(${JSON.stringify(LIB)});
runCheck({ name: "closure", usage: "node closure-check.js", run() { return { okLine: "clean." }; } });
`,
		);
		const r = spawnSync(process.execPath, [file, ...args], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, GITHUB_ACTIONS: "", ...env },
		});
		expect(r.status).toBe(0);
		return JSON.parse(fs.readFileSync(out, "utf8")) as string[];
	};

	it("loads no arbiter module to import the harness and run a check", () => {
		const modules = readLoadedModules([]);
		expect(modules).toContain(LIB);
		expect(modules.filter((m) => arbiterOrNotify.test(m))).toEqual([]);
	});

	it("still reaches notify-report.js under persist mode", () => {
		const modules = readLoadedModules(["--notify"], {
			WFC_NOTIFY_PERSIST: "1",
			CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
			CLAUDE_PROJECT_DIR: dir,
			WFC_CLAUDE_CONFIG_A: "",
			WFC_CLAUDE_CONFIG_B: "",
			WFC_CLAUDE_CONFIG_C: "",
		});
		expect(modules).toContain(path.join(__dirname, "notify-report.js"));
	});

	/* The runtime tests above still pass with a literal require restored, the
	 * load being lazy either way; only this walk sees the literal edge. */
	it("has no literal require path to an arbiter module", () => {
		const seen = new Set<string>();
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			const src = fs.readFileSync(file, "utf8");
			for (const m of src.matchAll(/\brequire\(\s*["'](\.{1,2}\/[^"']+)["']/g))
				walk(createRequire(file).resolve(m[1]));
		};
		walk(LIB);
		expect(seen).toContain(path.join(__dirname, "persist-mode.js"));
		expect([...seen].filter((m) => arbiterOrNotify.test(m))).toEqual([]);
	});
});

/*
 * The `keys` set is what makes a delta-gated reader possible (mantahostels#2490): it is the
 * only field lib/key-delta.js's gate diffs, so a checker whose count
 * moved but whose findings are the same findings must produce the same set.
 */
describe("the --json envelope's per-finding keys", () => {
	it("uses each finding's explicit key", () => {
		const c = checker(
			`ctx.fail("T", "message that moves", {}, "T\\t#7"); return {};`,
		);
		expect(JSON.parse(run(c, ["--json"]).stdout).keys).toEqual(["T\t#7"]);
	});

	it("is unchanged when only the finding's message moves", () => {
		const before = JSON.parse(
			run(
				checker(`ctx.fail("T", "3 of 9 unticked", {}, "T\\t#7"); return {};`),
				["--json"],
			).stdout,
		).keys;
		const after = JSON.parse(
			run(
				checker(`ctx.fail("T", "2 of 9 unticked", {}, "T\\t#7"); return {};`),
				["--json"],
			).stdout,
		).keys;
		expect(after).toEqual(before);
	});

	it("falls back to tag and message where a checker keys nothing", () => {
		const c = checker(`ctx.warn("T", "a thing"); return {};`);
		expect(JSON.parse(run(c, ["--json"]).stdout).keys).toEqual(["T\ta thing"]);
	});

	it("sorts and deduplicates, so two runs of one finding set match byte for byte", () => {
		const c = checker(
			`ctx.fail("B","x",{},"k2"); ctx.fail("A","y",{},"k1"); ctx.warn("C","z",{},"k1"); return {};`,
		);
		expect(JSON.parse(run(c, ["--json"]).stdout).keys).toEqual(["k1", "k2"]);
	});

	/* A key from `data` must not become the identity: it is the checker's own
	 * payload and nothing promises it is stable. */
	it("prefers the explicit key argument over one in the finding's data", () => {
		const c = checker(
			`ctx.fail("T","x",{ key: "from-data" },"explicit"); return {};`,
		);
		expect(JSON.parse(run(c, ["--json"]).stdout).keys).toEqual(["explicit"]);
	});

	/* An incomplete run drew no conclusion, so its EMPTY set must not read as
	 * "everything drained" — the next complete run would then report every
	 * standing finding as newly added. */
	it("is empty on a SKIP, even where findings were raised first", () => {
		const c = checker(`ctx.fail("T","x",{},"k1"); ctx.skip("github is down");`);
		const j = JSON.parse(run(c, ["--json"]).stdout);
		expect(j.outcome).toBe("SKIP");
		expect(j.keys).toEqual([]);
		expect(j.findings).toHaveLength(1);
	});

	it("is empty on a BROKEN", () => {
		const c = checker(`ctx.fail("T","x",{},"k1"); ctx.broken("cannot run");`);
		const j = JSON.parse(run(c, ["--json"]).stdout);
		expect(j.outcome).toBe("BROKEN");
		expect(j.keys).toEqual([]);
	});
});
