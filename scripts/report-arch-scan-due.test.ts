// @vitest-environment node
/*
 * report-arch-scan-due.test.ts — the architecture-scan counter (#1362, #1378,
 * spec #1348 Part 2). Break it and a scan fires on test or data churn, a
 * renamed file counts its whole body as growth, the close step resets a
 * threshold by the wrong factor, or the daily run files a second scan while
 * one is in flight, refiles a due issue closed without a scan, reads twice a
 * day, or fails a session start.
 *
 * Driven end to end through `runInProcess` (§X3) against a throwaway git repo
 * per case, its commits dated by hand, so the window each starting point opens
 * is exact. `gh` is a fake reached through WFC_GH, serving issue listings from
 * files and logging its argv, and the body writer one reached through
 * WFC_ISSUE_BODY, so every case reads what would have reached the tracker.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GH_FAILING_SCRIPT } from "./lib/gh-stub";
import { initGitRepo } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-arch-scan-due.js");
/* Inside the default window, which opens 2026-09-21T00:00Z. */
const IN = "2026-10-01T12:00:00Z";
/* The issue title and the stamp and lock names the script uses, restated so a
 * rename fails here rather than passing unseen. */
const TITLE = "Architecture scan due";
const STAMP = ".arch-scan-read";
const LOCK = ".arch-scan-read.lock";
const NOW = "2026-10-12T06:00:00Z";
const DAY = 24 * 3_600_000;

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

function repo(opts: { archScan?: unknown; record?: object[] } = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "arch-scan-"));
	temps.push(base);
	const root = path.join(base, "repo");
	const hooks = path.join(base, "hooks");
	fs.mkdirSync(hooks);
	initGitRepo(root, hooks);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "F",
			...(opts.archScan === undefined ? {} : { archScan: opts.archScan }),
		}),
	);
	if (opts.record) writeRecord(root, opts.record);
	const argvLog = path.join(base, "gh-argv.log");
	const ghStub = path.join(base, "gh");
	const issues = {
		open: path.join(base, "open.json"),
		closed: path.join(base, "closed.json"),
	};
	fs.writeFileSync(issues.open, "[]");
	fs.writeFileSync(issues.closed, "[]");
	fs.writeFileSync(
		ghStub,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
			'case "$1 $2" in',
			'  "issue list") case "$*" in',
			`    *"--state closed"*) cat ${JSON.stringify(issues.closed)} ;;`,
			`    *) cat ${JSON.stringify(issues.open)} ;;`,
			"  esac ;;",
			"  \"issue view\") echo 'an older body' ;;",
			'  "issue create") echo https://github.com/o/r/issues/999 ;;',
			"esac",
		].join("\n"),
	);
	fs.chmodSync(ghStub, 0o755);
	const bodyLog = path.join(base, "issue-body-argv.log");
	const bodyScript = path.join(base, "issue-body.js");
	fs.writeFileSync(
		bodyScript,
		`require("node:fs").appendFileSync(${JSON.stringify(bodyLog)}, process.argv.slice(2).join(" ") + "\\n");`,
	);
	return {
		base,
		root,
		ghStub,
		argvLog,
		issues,
		bodyScript,
		bodyLog,
		config: path.join(base, "config"),
	};
}
type Repo = ReturnType<typeof repo>;

function writeRecord(root: string, rows: object[]) {
	fs.mkdirSync(path.join(root, "docs", "data"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "docs", "data", "arch-scan-runs.jsonl"),
		rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
	);
}

const git = (root: string, args: string[], date = IN) =>
	execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
	}).trim();

const lines = (n: number, tag = "x") =>
	Array.from({ length: n }, (_, i) => `${tag}${i}\n`).join("");

/** Appends `add` lines to each file, creating it where absent; returns the sha. */
function commit(r: Repo, add: Record<string, number>, date = IN): string {
	for (const [p, n] of Object.entries(add)) {
		const file = path.join(r.root, p);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, lines(n, `${p}:${Date.now()}:`));
		git(r.root, ["add", "--", p]);
	}
	git(r.root, ["commit", "-qm", "c"], date);
	return git(r.root, ["rev-parse", "HEAD"]);
}

/** `dir` is where the run starts. */
function run(r: Repo, args: string[], at = NOW, dir = r.root) {
	const out = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: {
			...process.env,
			WFC_GH: r.ghStub,
			WFC_ISSUE_BODY: r.bodyScript,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CONFIG_DIR: r.config,
			WFC_CLAUDE_CONFIG_A: r.config,
			WFC_CLAUDE_CONFIG_B: r.config,
			WFC_CLAUDE_CONFIG_C: r.config,
			WFC_NOW: at,
		},
	});
	return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

const read = (f: string) =>
	fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
const ghCalls = (r: Repo) => read(r.argvLog);
/** Each `gh issue create` call whole, its multi-line body included. */
const readCreates = (r: Repo) =>
	ghCalls(r)
		.split(/\n(?=issue (?:list|view|create|edit) )/)
		.filter((l) => l.startsWith("issue create"));

/** The dry run's hot-file rows, as `commits net path`. */
const hotRows = (stdout: string) =>
	[...stdout.matchAll(/^ +(\d+) commits +([+-]\d+) {2}(.+)$/gm)].map(
		(m) => `${m[1]} ${m[2]} ${m[3]}`,
	);
const growth = (stdout: string) => /^Growth: (-?\d+)/m.exec(stdout)?.[1];

describe("--dry-run, the growth against the threshold", () => {
	it.each([
		[31, "Under the threshold"],
		[30, "At or over the threshold"],
		[29, "At or over the threshold"],
	])(
		"reads 30 lines of growth against a threshold of %i as: %s",
		(threshold, verdict) => {
			const r = repo({ archScan: { threshold } });
			commit(r, { "a.js": 10 });
			commit(r, { "a.js": 20 });

			const { code, stdout } = run(r, ["--dry-run"]);
			expect(code).toBe(0);
			expect(growth(stdout)).toBe("30");
			expect(stdout).toContain(`Threshold: ${threshold} (override:`);
			expect(stdout).toContain(verdict);
		},
	);

	it("files nothing and touches gh not at all, even over the threshold", () => {
		const r = repo({ archScan: { threshold: 1 } });
		commit(r, { "a.js": 50 });

		const { code, stdout } = run(r, ["--dry-run"]);
		expect(code).toBe(0);
		expect(stdout).toContain("At or over the threshold");
		expect(stdout).toContain("Dry run: nothing filed.");
		expect(fs.existsSync(r.argvLog)).toBe(false);
	});
	it("says a filing run would file nothing while a scan is in flight", () => {
		const r = repo({ archScan: { threshold: 1 } });
		const head = commit(r, { "a.js": 5 });
		commit(r, { "a.js": 5 });
		writeRecord(r.root, [{ date: "d", mode: "scan", head, map: "o/r#7" }]);

		const { code, stdout } = run(r, ["--dry-run"]);
		expect(code).toBe(0);
		expect(stdout).toContain(
			"The scan filed as o/r#7 is in flight: a filing run would file nothing.",
		);
	});
});

describe("--dry-run, which files are hot", () => {
	it("takes the ten code files with the most commits, leaving out test kind and its support, vendored, generated, excluded and non-code paths", () => {
		const r = repo({ archScan: { exclude: ["data/**"] } });
		const ignored = [
			"scripts/a.test.ts",
			"app/b.test.tsx",
			"c.test.js",
			"c2.test.mjs",
			"c3.test.cjs",
			"test/helper.js",
			"tests/helper.js",
			"lib/fixtures/probe.js",
			"lib/thing-testkit.js",
			"lib/fake-gh.js",
			"py/test_d.py",
			"py/e_test.py",
			"py/conftest.py",
			".agents/skills/v.js",
			"types/g.d.ts",
			"public/h.min.js",
			"data/deep/i.js",
			"notes.md",
		];
		for (let i = 0; i < 6; i++)
			commit(r, Object.fromEntries(ignored.map((p) => [p, 1])));
		/* Eleven code files, the nth committed n times, so file 1 is cut. */
		const code = [
			"k1.js",
			"k2.mjs",
			"k3.cjs",
			"k4.ts",
			"k5.tsx",
			"k6.sh",
			"k7.py",
			".husky/pre-commit",
			"lib/k9.js",
			"scripts/k10.js",
			"scripts/k11.js",
		];
		for (let n = 1; n <= code.length; n++)
			commit(r, Object.fromEntries(code.slice(n - 1).map((p) => [p, 1])));

		const { code: status, stdout } = run(r, ["--dry-run"]);
		expect(status).toBe(0);
		expect(hotRows(stdout)).toEqual([
			"11 +11 scripts/k11.js",
			"10 +10 scripts/k10.js",
			"9 +9 lib/k9.js",
			"8 +8 .husky/pre-commit",
			"7 +7 k7.py",
			"6 +6 k6.sh",
			"5 +5 k5.tsx",
			"4 +4 k4.ts",
			"3 +3 k3.cjs",
			"2 +2 k2.mjs",
		]);
		expect(growth(stdout)).toBe("65");
	});

	it("counts a renamed file by its line change, under its new name", () => {
		const r = repo({
			record: [{ date: "x", mode: "seed", since: "2026-09-21T00:00Z" }],
		});
		commit(r, { "old.js": 20 }, "2026-09-10T00:00:00Z");
		commit(r, { "old.js": 3 });
		git(r.root, ["mv", "old.js", "new.js"]);
		commit(r, { "new.js": 2 });

		const { stdout } = run(r, ["--dry-run"]);
		expect(hotRows(stdout)).toEqual(["2 +5 new.js"]);
	});

	it("counts a file moved out of an excluded path by its line change, not its whole body", () => {
		const r = repo({ archScan: { exclude: ["data/**"] } });
		commit(r, { "data/big.js": 40 }, "2026-09-10T00:00:00Z");
		git(r.root, ["mv", "data/big.js", "big.js"]);
		commit(r, { "big.js": 2 });

		expect(hotRows(run(r, ["--dry-run"]).stdout)).toEqual(["1 +2 big.js"]);
	});

	it("leaves out a file deleted by the window's end", () => {
		const r = repo();
		commit(r, { "gone.js": 5, "kept.js": 1 });
		git(r.root, ["rm", "-q", "gone.js"]);
		git(r.root, ["commit", "-qm", "rm"]);

		expect(hotRows(run(r, ["--dry-run"]).stdout)).toEqual(["1 +1 kept.js"]);
	});
});

describe("--dry-run, where the window starts and ends", () => {
	/* +1 before every start, +2 after the seed's, +4 after the default's,
	 * +8 after the scan's head. */
	function history(record?: object[]) {
		const r = repo({ record });
		commit(r, { "a.js": 1 }, "2026-09-10T00:00:00Z");
		commit(r, { "a.js": 2 }, "2026-09-18T00:00:00Z");
		const scanned = commit(r, { "a.js": 4 }, "2026-09-25T00:00:00Z");
		commit(r, { "a.js": 8 }, "2026-10-01T00:00:00Z");
		return { r, scanned };
	}

	it("starts at the default date with no scan or seed line", () => {
		const { r } = history();
		const { stdout } = run(r, ["--dry-run"]);
		expect(stdout).toContain("since 2026-09-21T00:00Z (default start)");
		expect(growth(stdout)).toBe("12");
	});

	it("starts at the newest seed line's since", () => {
		const { r } = history([
			{ date: "d", mode: "seed", since: "2026-09-26T00:00Z" },
			{ date: "d", mode: "seed", since: "2026-09-15T00:00Z" },
		]);
		const { stdout } = run(r, ["--dry-run"]);
		expect(stdout).toContain("since 2026-09-15T00:00Z (seed line)");
		expect(growth(stdout)).toBe("14");
	});

	it("starts at the newest scan line's head, over any seed line", () => {
		const { r, scanned } = history();
		writeRecord(r.root, [
			{ date: "d", mode: "scan", head: scanned },
			{ date: "d", mode: "seed", since: "2026-09-15T00:00Z" },
		]);
		const { stdout } = run(r, ["--dry-run"]);
		expect(stdout).toContain(`since ${scanned} (newest scan line)`);
		expect(growth(stdout)).toBe("8");
	});

	it("ends at origin's HEAD where the clone knows one, not the checked-out HEAD", () => {
		const { r, scanned } = history();
		git(r.root, ["update-ref", "refs/remotes/origin/HEAD", scanned]);
		const { stdout } = run(r, ["--dry-run"]);
		expect(stdout).toContain(`to ${scanned} (refs/remotes/origin/HEAD)`);
		expect(growth(stdout)).toBe("4");
	});
});

describe("--hot-files, a saved dry run read back for the scan line (#1490)", () => {
	it("prints the files and figures the dry run computed, in its order", () => {
		const r = repo();
		commit(r, { "a.js": 10, "dir with space/b.js": 4 });
		commit(r, { "a.js": 3 });
		fs.writeFileSync(path.join(r.root, "a.js"), "one\n");
		git(r.root, ["commit", "-qam", "shrink"]);
		const dry = run(r, ["--dry-run"]).stdout;
		const saved = path.join(r.base, "count.txt");
		fs.writeFileSync(saved, dry);

		const { code, stdout } = run(r, ["--hot-files", saved]);
		expect(code).toBe(0);
		expect(stdout.trimEnd().split("\n")).toHaveLength(1);
		const hot = JSON.parse(stdout);
		expect(hot).toEqual([
			{ path: "a.js", commits: 3, net: 1 },
			{ path: "dir with space/b.js", commits: 1, net: 4 },
		]);
		expect(
			hot.map(
				(f: { path: string; commits: number; net: number }) =>
					`${f.commits} ${f.net >= 0 ? "+" : ""}${f.net} ${f.path}`,
			),
		).toEqual(hotRows(dry));
	});

	it("reads a negative net as a negative number", () => {
		const r = repo();
		commit(r, { "a.js": 10 }, "2026-09-01T00:00:00Z");
		fs.writeFileSync(path.join(r.root, "a.js"), "one\n");
		git(r.root, ["commit", "-qam", "shrink"]);
		const saved = path.join(r.base, "count.txt");
		fs.writeFileSync(saved, run(r, ["--dry-run"]).stdout);
		expect(JSON.parse(run(r, ["--hot-files", saved]).stdout)).toEqual([
			{ path: "a.js", commits: 1, net: -9 },
		]);
	});

	it("is BROKEN, not an empty array, on a dry run that names no hot file", () => {
		const r = repo();
		commit(r, { "notes.md": 5 });
		const saved = path.join(r.base, "count.txt");
		fs.writeFileSync(saved, run(r, ["--dry-run"]).stdout);
		const { code, stdout, stderr } = run(r, ["--hot-files", saved]);
		expect([code, stdout]).toEqual([2, ""]);
		expect(stderr).toContain(
			`BROKEN: ${saved} holds no hot-file row of a --dry-run output — save one with: node scripts/report-arch-scan-due.js --dry-run > ${saved}`,
		);
	});

	it("is BROKEN on a file that does not exist, naming it and how to save one", () => {
		const r = repo();
		const missing = path.join(r.base, "nope");
		const { code, stderr } = run(r, ["--hot-files", missing]);
		expect(code).toBe(2);
		expect(stderr).toContain(
			`BROKEN: ${missing} does not exist — save one with: node scripts/report-arch-scan-due.js --dry-run > ${missing}`,
		);
	});
});

describe("--partners, each hot file's change-coupling partners over a saved dry run (#1743)", () => {
	const save = (r: Repo) => {
		const file = path.join(r.base, "count.txt");
		fs.writeFileSync(file, run(r, ["--dry-run"]).stdout);
		return file;
	};
	const partnersOut = (r: Repo, file: string) => {
		const { code, stdout, stderr } = run(r, ["--partners", file]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		return JSON.parse(stdout) as Array<{
			path: string;
			partners: Array<{ path: string; commits: number }>;
		}>;
	};

	it("names the three code files most often in the hot file's commits, never test kind, vendored, generated or excluded paths", () => {
		const r = repo({ archScan: { exclude: ["data/**"] } });
		const neverPartners = {
			"hot.test.ts": 1,
			"tests/h.js": 1,
			"lib/fixtures/f.js": 1,
			"lib/hot-testkit.js": 1,
			".agents/v.js": 1,
			"types/g.d.ts": 1,
			"data/x.js": 1,
			"notes.md": 1,
		};
		for (let i = 0; i < 4; i++) commit(r, { "hot.js": 1, ...neverPartners });
		for (let i = 0; i < 3; i++) commit(r, { "hot.js": 1, "p1.js": 1 });
		for (let i = 0; i < 2; i++) commit(r, { "hot.js": 1, "p2.sh": 1 });
		commit(r, { "hot.js": 1, "p3.py": 1, "p4.ts": 1 });
		commit(r, { "p1.js": 1, "p2.sh": 1 });

		const hot = partnersOut(r, save(r)).find((f) => f.path === "hot.js");
		expect(hot?.partners).toEqual([
			{ path: "p1.js", commits: 3 },
			{ path: "p2.sh", commits: 2 },
			{ path: "p3.py", commits: 1 },
		]);
	});

	it("counts over the saved run's window, not commits landed since, and follows a renamed hot file back through its old name", () => {
		const r = repo();
		commit(r, { "old.js": 1, "p.js": 1 });
		git(r.root, ["mv", "old.js", "hot.js"]);
		commit(r, { "hot.js": 1, "q.js": 1 });
		const file = save(r);
		commit(r, { "hot.js": 1, "late.js": 1 });

		const hot = partnersOut(r, file).find((f) => f.path === "hot.js");
		expect(hot?.partners).toEqual([
			{ path: "p.js", commits: 1 },
			{ path: "q.js", commits: 1 },
		]);
	});

	it("starts at a saved scan-line head, so commits before the scan name no partner", () => {
		const r = repo();
		commit(r, { "hot.js": 1, "before.js": 1 }, "2026-09-25T00:00:00Z");
		const scanned = commit(r, { "a.js": 1 }, "2026-09-26T00:00:00Z");
		writeRecord(r.root, [{ mode: "scan", map: "#1", head: scanned }]);
		commit(r, { "hot.js": 1, "after.js": 1 });

		const file = save(r);
		expect(read(file)).toContain(`since ${scanned} (newest scan line)`);
		const hot = partnersOut(r, file).find((f) => f.path === "hot.js");
		expect(hot?.partners).toEqual([{ path: "after.js", commits: 1 }]);
	});

	it("is BROKEN on a saved file with hot-file rows but no Window line, naming how to save one", () => {
		const r = repo();
		const file = path.join(r.base, "count.txt");
		fs.writeFileSync(file, "      2 commits       +4  a.js\n");

		const { code, stderr } = run(r, ["--partners", file]);
		expect(code).toBe(2);
		expect(stderr).toContain("BROKEN:");
		expect(stderr).toContain("no Window line");
		expect(stderr).toContain("--dry-run >");
	});
});

describe("the threshold in force and its source", () => {
	const close = (nextThreshold: number) => ({
		date: "d",
		mode: "close",
		map: "o/r#1",
		yield: 2,
		declined: 0,
		threshold: 8750,
		nextThreshold,
	});

	it("is the start value with no close line and no override", () => {
		const r = repo();
		expect(run(r, ["--dry-run"]).stdout).toContain(
			"Threshold: 8750 (default: the start value)",
		);
	});

	it("is the newest close line's nextThreshold", () => {
		const r = repo({ record: [close(12_000), close(5000)] });
		expect(run(r, ["--dry-run"]).stdout).toContain("Threshold: 5000 (log:");
	});

	it("is archScan.threshold, outright, over a close line", () => {
		const r = repo({ archScan: { threshold: 123 }, record: [close(5000)] });
		expect(run(r, ["--dry-run"]).stdout).toContain(
			"Threshold: 123 (override: archScan.threshold in",
		);
	});

	it.each([
		[undefined, 7, 6125],
		[undefined, 6, 6125],
		[undefined, 5, 8750],
		[undefined, 3, 8750],
		[undefined, 2, 13_125],
		[undefined, 1, 13_125],
		[undefined, 0, 17_500],
		[5000, 6, 4000],
		[30_000, 0, 40_000],
		[8751, 6, 6126],
	])(
		"--next-threshold from a close line's %s at yield %i prints the threshold in force and %i as nextThreshold",
		(from, y, want) => {
			const r = repo({ record: from === undefined ? [] : [close(from)] });
			const { code, stdout } = run(r, ["--next-threshold", String(y)]);
			expect([code, stdout]).toEqual([
				0,
				`${JSON.stringify({ threshold: from ?? 8750, nextThreshold: want })}\n`,
			]);
		},
	);

	it("--next-threshold recalibrates from the learned threshold, never an override in force, so removing the override resumes the learned one", () => {
		const r = repo({ archScan: { threshold: 10_000 }, record: [close(5000)] });
		expect(JSON.parse(run(r, ["--next-threshold", "1"]).stdout)).toEqual({
			threshold: 10_000,
			nextThreshold: 7500,
		});
		fs.writeFileSync(
			path.join(r.root, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, founder: "F" }),
		);
		expect(JSON.parse(run(r, ["--next-threshold", "1"]).stdout)).toEqual({
			threshold: 5000,
			nextThreshold: 7500,
		});
	});
});

describe("refusals", () => {
	it.each([
		[
			"both modes",
			["--dry-run", "--next-threshold", "1"],
			"Name one mode at most",
		],
		[
			"a dry run named with --hot-files",
			["--dry-run", "--hot-files", "count.txt"],
			"Name one mode at most",
		],
		[
			"a yield that is not a whole number",
			["--next-threshold", "-1"],
			'a whole number of accepted candidates; got "-1"',
		],
		[
			"a fractional yield",
			["--next-threshold", "1.5"],
			'a whole number of accepted candidates; got "1.5"',
		],
	])("exits 2 on %s, naming the fault and the usage", (_, args, why) => {
		const r = repo();
		const { code, stdout, stderr } = run(r, args);
		expect([code, stdout]).toEqual([2, ""]);
		expect(stderr).toContain(why);
		expect(stderr).toContain(
			"usage: node scripts/report-arch-scan-due.js [--dry-run | --next-threshold <yield> | --hot-files <file> | --partners <file>]",
		);
	});

	it("is BROKEN on a malformed archScan value, naming the file and key, rather than reading it as unset", () => {
		const r = repo({ archScan: { threshold: "9000" } });
		const { code, stderr } = run(r, ["--dry-run"]);
		expect(code).toBe(2);
		expect(stderr).toContain(
			'BROKEN: .claude/workflow-core.json: "archScan.threshold" is not a positive integer',
		);
	});

	it("warns on an unknown archScan key, quoting it, and still reads", () => {
		const r = repo({ archScan: { treshold: 10 } });
		const { code, stderr } = run(r, ["--dry-run"]);
		expect(code).toBe(0);
		expect(stderr).toContain('unknown key "archScan.treshold"');
	});

	it("is BROKEN on a run log line that is not JSON, naming its file and line, rather than reading it as never scanned", () => {
		const r = repo();
		fs.mkdirSync(path.join(r.root, "docs", "data"), { recursive: true });
		fs.writeFileSync(
			path.join(r.root, "docs", "data", "arch-scan-runs.jsonl"),
			"{not json\n",
		);
		const { code, stderr } = run(r, ["--dry-run"]);
		expect(code).toBe(2);
		expect(stderr).toContain(
			"BROKEN: docs/data/arch-scan-runs.jsonl:1 is not JSON",
		);
	});
});

describe("the daily filing run", () => {
	const scanLine = (head: string, date = "2026-10-03") => ({
		date,
		mode: "scan",
		head,
		map: "o/r#7",
	});
	const closeLine = {
		date: "d",
		mode: "close",
		map: "o/r#7",
		nextThreshold: 5000,
	};
	/** A closed due issue, #100. */
	function closedDue(r: Repo, createdAt: string, closedAt: string) {
		fs.writeFileSync(
			r.issues.closed,
			JSON.stringify([
				{ number: 100, title: TITLE, labels: [], closedAt, createdAt },
			]),
		);
	}

	it("files the due issue at or over the threshold, with the window, the hot files, the total and the instruction", () => {
		const r = repo({ archScan: { threshold: 30 } });
		commit(r, { "a.js": 10 });
		const head = commit(r, { "a.js": 20 });

		const { code, stdout } = run(r, []);
		expect(code).toBe(0);
		expect(stdout).toContain("Filed https://github.com/o/r/issues/999");
		const [create] = readCreates(r);
		expect(readCreates(r)).toHaveLength(1);
		expect(create).toContain(`--title ${TITLE}`);
		expect(create).toContain("--label takes:implement");
		expect(create).toContain(
			`Window: since 2026-09-21T00:00Z (default start) to ${head}.`,
		);
		expect(create).toContain("| 2 | +30 | `a.js` |");
		expect(create).toContain(
			"**Growth: 30 lines** net over these files, against a threshold of 30 (override: archScan.threshold in",
		);
		expect(create).toContain("run the `architecture-scan` skill");
		expect(create).toContain("`scan <this issue>`");
	});

	it("files nothing under the threshold", () => {
		const r = repo({ archScan: { threshold: 31 } });
		commit(r, { "a.js": 30 });

		const { code, stdout } = run(r, []);
		expect(code).toBe(0);
		expect(stdout).toContain("under the threshold, nothing filed");
		expect(readCreates(r)).toEqual([]);
	});

	it("refreshes the open due issue's body and files nothing new", () => {
		const r = repo({ archScan: { threshold: 1 } });
		commit(r, { "a.js": 5 });
		const row = { number: 5, title: TITLE, labels: [], closedAt: null };
		fs.writeFileSync(r.issues.open, JSON.stringify([row]));

		const { code, stdout } = run(r, []);
		expect(code).toBe(0);
		expect(stdout).toContain("Refreshed #5.");
		expect(readCreates(r)).toEqual([]);
		expect(read(r.bodyLog)).toMatch(/^replace 5 --file /);
	});

	it("files nothing while the newest scan line has no close line for its map, and files once it has", () => {
		const r = repo({ archScan: { threshold: 1 } });
		const head = commit(r, { "a.js": 5 });
		commit(r, { "a.js": 5 });
		writeRecord(r.root, [scanLine(head)]);

		const held = run(r, []);
		expect(held.code).toBe(0);
		expect(held.stdout).toContain("The scan filed as o/r#7 is in flight");
		expect(ghCalls(r)).toBe("");

		writeRecord(r.root, [scanLine(head), closeLine]);
		expect(run(r, [], "2026-10-13T06:00:00Z").stdout).toContain(
			"Filed https://github.com/o/r/issues/999",
		);
	});

	it("counts from the close of a due issue no scan followed, so growth it already saw cannot refile it", () => {
		const r = repo({ archScan: { threshold: 6 } });
		commit(r, { "a.js": 50 });
		commit(r, { "a.js": 5 }, "2026-10-08T00:00:00Z");
		closedDue(r, "2026-10-02T09:00:00Z", "2026-10-05T00:00:00Z");

		const under = run(r, []);
		expect(under.stdout).toContain(
			"since 2026-10-05T00:00:00Z (the close of #100, which no scan followed): under the threshold",
		);
		expect(readCreates(r)).toEqual([]);

		commit(r, { "a.js": 1 }, "2026-10-09T00:00:00Z");
		const over = run(r, [], "2026-10-13T06:00:00Z");
		expect(over.stdout).toContain("Filed https://github.com/o/r/issues/999");
		expect(readCreates(r)[0]).toContain("| 2 | +6 | `a.js` |");
	});

	it("keeps counting from that close while the issue refiled from it is open", () => {
		const r = repo({ archScan: { threshold: 6 } });
		commit(r, { "a.js": 50 });
		commit(r, { "a.js": 6 }, "2026-10-08T00:00:00Z");
		closedDue(r, "2026-10-02T09:00:00Z", "2026-10-05T00:00:00Z");
		const refiled = { number: 101, title: TITLE, labels: [], closedAt: null };
		fs.writeFileSync(r.issues.open, JSON.stringify([refiled]));

		const { stdout } = run(r, []);
		expect(stdout).toContain(
			"since 2026-10-05T00:00:00Z (the close of #100, which no scan followed). Refreshed #101.",
		);
		expect(read(r.bodyLog)).toMatch(/^replace 101 --file /);
	});

	it("counts from the scan's head, not the close, where a scan line follows the due issue's creation", () => {
		const r = repo({ archScan: { threshold: 1 } });
		const head = commit(r, { "a.js": 50 });
		commit(r, { "a.js": 2 }, "2026-10-04T00:00:00Z");
		writeRecord(r.root, [scanLine(head, "2026-10-02"), closeLine]);
		closedDue(r, "2026-10-02T09:00:00Z", "2026-10-06T00:00:00Z");

		const { stdout } = run(r, []);
		expect(stdout).toContain(`since ${head} (newest scan line)`);
		expect(readCreates(r)[0]).toContain("| 1 | +2 | `a.js` |");
	});

	it("reads at most once a day", () => {
		const r = repo({ archScan: { threshold: 1 } });
		commit(r, { "a.js": 5 });

		run(r, []);
		expect(fs.existsSync(path.join(r.root, ".git", STAMP))).toBe(true);
		const calls = ghCalls(r);
		const again = run(
			r,
			[],
			new Date(Date.parse(NOW) + DAY - 60_000).toISOString(),
		);
		expect(again.stdout).toContain("under a day ago; nothing read");
		expect(ghCalls(r)).toBe(calls);

		run(r, [], new Date(Date.parse(NOW) + DAY).toISOString());
		expect(readCreates(r)).toHaveLength(2);
	});

	it("keeps its stamp in the git common directory, which a worktree shares", () => {
		const r = repo({ archScan: { threshold: 1 } });
		commit(r, { "a.js": 5 });
		const tree = path.join(r.base, "tree");
		git(r.root, ["worktree", "add", "-q", "--detach", tree]);

		run(r, [], NOW, tree);
		expect(fs.existsSync(path.join(r.root, ".git", STAMP))).toBe(true);
		expect(run(r, []).stdout).toContain("under a day ago; nothing read");
	});

	it("reads nothing while another run holds a live lock", () => {
		const r = repo({ archScan: { threshold: 1 } });
		commit(r, { "a.js": 5 });
		fs.writeFileSync(path.join(r.root, ".git", LOCK), "1");

		const { code, stdout } = run(r, []);
		expect(code).toBe(0);
		expect(stdout).toContain("Another run is reading; nothing read.");
		expect(ghCalls(r)).toBe("");
	});

	it.each([
		[
			"a malformed archScan key",
			(r: Repo) =>
				fs.writeFileSync(
					path.join(r.root, ".claude", "workflow-core.json"),
					JSON.stringify({
						contract: 1,
						founder: "F",
						archScan: { threshold: "9" },
					}),
				),
			'"archScan.threshold" is not a positive integer',
		],
		[
			"a run log line that is not JSON",
			(r: Repo) => {
				fs.mkdirSync(path.join(r.root, "docs", "data"), { recursive: true });
				fs.writeFileSync(
					path.join(r.root, "docs", "data", "arch-scan-runs.jsonl"),
					"{not json\n",
				);
			},
			"docs/data/arch-scan-runs.jsonl:1 is not JSON",
		],
		[
			"a gh failure",
			(r: Repo) => fs.writeFileSync(r.ghStub, GH_FAILING_SCRIPT),
			"gh auth login",
		],
		[
			"a git failure",
			(r: Repo) =>
				fs.rmSync(path.join(r.root, ".git"), { recursive: true, force: true }),
			"not a git repository",
		],
	])(
		"fails open on %s: one line in the error log, exit 0",
		(_, breakIt, why) => {
			const r = repo({ archScan: { threshold: 1 } });
			commit(r, { "a.js": 5 });
			breakIt(r);

			const { code, stderr } = run(r, []);
			expect(code).toBe(0);
			expect(stderr).toContain("FAILED OPEN: ");
			expect(stderr).toContain(why);
			expect(stderr).toContain("the next day's reading retries");
			expect(readGuardErrorsLog(r.config)).toContain("report-arch-scan-due");
			expect(readCreates(r)).toEqual([]);
		},
	);
});
