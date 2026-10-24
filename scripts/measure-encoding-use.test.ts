// @vitest-environment node
/*
 * Two guarantees about the REPORT rather than the counting:
 *
 *  1. THE INVENTORY COMES FROM DISK, NOT A HAND-LIST. A skill added to
 *     `.claude/skills/` or `.agents/skills/`, or a name added to
 *     package.json's `scripts`, must appear here without anyone editing this
 *     script — or it arrives uncounted, which reads as neither used nor unused.
 *
 *  2. A ZERO IS REPORTED AS A ZERO. The whole finding this scan exists for is
 *     the never-invoked row (mantahostels#1241), so a never-used name must be listed by
 *     name, never dropped.
 *
 * Transcripts are synthetic, written to a temp dir per test, but the inventory
 * is compared against this repo's real skill folders and package.json, since
 * guarantee 1 is about what is on disk.
 *
 * Built end to end (#1369, §G6: nothing is exported only for its tests): every
 * case runs the program in-process through lib/run-in-process.js on
 * `--dir <temp dir>`, and reads its `--json` envelope or its printed report —
 * the two things a reader of the scan ever sees.
 *
 * The scan is hand-run on no trigger (mantahostels#1243). Breaking either guarantee
 * hides a skill or npm script nobody invokes, so the retirement call it exists
 * to prompt is never made.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { buildBashCall } from "./lib/transcript-testkit";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "measure-encoding-use.js");
const BAR = ["--min-count", "1", "--min-sessions", "1", "--top", "10"];

let dir: string;

/** One transcript, from records given as objects. */
function transcript(name: string, records: Record<string, unknown>[]) {
	fs.writeFileSync(
		path.join(dir, `${name}.jsonl`),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
}

const bash = (command: string, id: string) =>
	buildBashCall(command, id, {
		uuid: id,
		timestamp: "2026-08-20T09:00:00.000Z",
	});

/* The host root pinned to this checkout, so the inventory read is this
 * checkout's whatever CLAUDE_PROJECT_DIR the suite inherited. */
const run = (...args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd: ROOT,
		env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
	});

interface Row {
	name: string;
	total: number;
	sessions: number;
	last: string;
}

/** The `--json` report over the temp corpus. */
const report = (...args: string[]) => {
	const { status, stdout, stderr } = run("--dir", dir, "--json", ...args);
	expect(stderr).toBe("");
	expect(status).toBe(0);
	return JSON.parse(stdout);
};

/** The printed report over the temp corpus. */
const printed = (...args: string[]) => {
	const { status, stdout } = run("--dir", dir, ...args);
	expect(status).toBe(0);
	return stdout;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "encoding-use-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the inventory is derived, not listed", () => {
	it("carries a row for every skill directory under both roots", () => {
		transcript("a", []);
		const reported = new Set(report(...BAR).skills.map((r: Row) => r.name));
		const onDisk = new Set<string>();
		for (const root of [
			path.join(ROOT, ".claude", "skills"),
			path.join(ROOT, ".agents", "skills"),
		])
			for (const entry of fs.readdirSync(root))
				if (fs.existsSync(path.join(root, entry, "SKILL.md")))
					onDisk.add(entry);
		expect(onDisk.size).toBeGreaterThan(0);
		expect([...onDisk].filter((s) => !reported.has(s))).toEqual([]);
	});

	it("carries a row for every name in package.json's scripts", () => {
		transcript("a", []);
		const reported = new Set(report(...BAR).npm.map((r: Row) => r.name));
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		expect(Object.keys(pkg.scripts).filter((n) => !reported.has(n))).toEqual(
			[],
		);
	});

	it("reports an uninvoked name as zero rather than omitting it", () => {
		transcript("a", [bash("npm run typecheck", "t1")]);
		const data = report(...BAR);
		const typecheck = data.npm.find((r: Row) => r.name === "typecheck");
		expect(typecheck.total).toBe(1);
		const zeros = data.npm.filter((r: Row) => r.total === 0);
		expect(zeros.length).toBe(data.npm.length - 1);
		const text = printed(...BAR);
		expect(text).toContain(
			`NEVER USED (${zeros.length} of ${data.npm.length})`,
		);
		expect(text).toContain(`  0  ${zeros[0].name}`);
	});
});

describe("counting across the corpus", () => {
	it("counts sessions apart from invocations", () => {
		transcript("a", [bash("npm run test", "t1"), bash("npm run test", "t2")]);
		transcript("b", [bash("npm run test", "t3")]);
		const row = report(...BAR).npm.find((r: Row) => r.name === "test");
		expect(row.total).toBe(3);
		expect(row.sessions).toBe(2);
		expect(row.last).toBe("2026-08-20T09:00:00.000Z");
	});

	it("counts one tool call once, however many records carry it", () => {
		// One assistant turn writes one record PER CONTENT BLOCK (mantahostels#1141).
		transcript("a", [bash("npm run test", "t1"), bash("npm run test", "t1")]);
		expect(report(...BAR).npm.find((r: Row) => r.name === "test").total).toBe(
			1,
		);
	});

	it("names a transcript it could not read rather than counting it as empty", () => {
		transcript("a", [bash("npm run test", "t1")]);
		/* A subagent transcript is listed by name alone, so one whose target is
		 * gone reaches the scan and fails to open there. */
		const subagents = path.join(dir, "a", "subagents");
		fs.mkdirSync(subagents, { recursive: true });
		const missing = path.join(subagents, "gone.jsonl");
		fs.symlinkSync(path.join(dir, "nowhere.jsonl"), missing);
		const data = report(...BAR);
		expect(data.corpus.unreadable).toEqual([missing]);
		expect(data.npm.find((r: Row) => r.name === "test").total).toBe(1);
		expect(printed(...BAR)).toContain(
			"1 transcript(s) could not be read, so every count below is a floor",
		);
	});
});

describe("section 2 — what is still done by hand", () => {
	it("prints nothing where nothing clears the bar", () => {
		transcript("a", [bash("gh issue view 1299", "t1")]);
		const bar = ["--min-count", "5", "--min-sessions", "2", "--top", "10"];
		expect(report(...bar).hand).toEqual([]);
		expect(printed(...bar)).toContain("Nothing clears the bar.");
	});

	it("reports a frequent shape that no script, skill or npm name covers", () => {
		transcript("a", [
			bash("gh issue view 1", "t1"),
			bash("gh issue view 2", "t2"),
		]);
		transcript("b", [bash("gh issue view 3", "t3")]);
		const bar = ["--min-count", "3", "--min-sessions", "2", "--top", "10"];
		expect(report(...bar).hand).toEqual([
			expect.objectContaining({
				shape: "gh issue view",
				total: 3,
				sessions: 2,
			}),
		]);
	});

	it("excludes a shape that already runs a repo script or an npm name", () => {
		transcript("a", [
			bash("npm run check:sh", "t1"),
			bash("node scripts/pick-next.js", "t2"),
		]);
		expect(report(...BAR).hand).toEqual([]);
	});
});

describe("the CLI boundary — argv, exit codes and what the message names", () => {
	it("reports a corpus and exits 0", () => {
		transcript("a", [bash("npm run test", "t1")]);
		const { status, stdout } = run("--dir", dir);
		expect(status).toBe(0);
		expect(stdout).toContain("SKILLS — USED");
		expect(stdout).toContain("NPM RUN NAMES — NEVER USED");
		expect(stdout).toContain("STILL DONE BY HAND");
	});

	it("emits parseable JSON under --json, carrying the corpus it read", () => {
		transcript("a", [bash("npm run test", "t1")]);
		const { status, stdout } = run("--dir", dir, "--json");
		expect(status).toBe(0);
		const data = JSON.parse(stdout);
		expect(data.corpus).toEqual(
			expect.objectContaining({ dir, transcripts: 1, unreadable: [] }),
		);
	});

	it("takes a number flag, and falls back to its default without one", () => {
		transcript("a", []);
		expect(report("--top", "5").bar.top).toBe(5);
		expect(report().bar.top).toBe(25);
	});

	it("refuses a corpus directory it cannot read, naming the directory", () => {
		const missing = path.join(dir, "nope");
		const { status, stderr } = run("--dir", missing);
		// BROKEN, never 0: nothing was measured, and a zero would read as a
		// corpus in which nothing was ever invoked.
		expect(status).toBe(2);
		expect(stderr).toContain(missing);
	});

	it("refuses --dir with nothing after it, naming the flag and what it needs", () => {
		const { status, stderr } = run("--dir");
		expect(status).toBe(2);
		expect(stderr).toContain("--dir needs a value");
	});

	it("refuses a number flag with nothing after it, or a negative one", () => {
		const bare = run("--dir", dir, "--top");
		expect(bare.status).toBe(2);
		expect(bare.stderr).toContain("--top needs a value");
		const negative = run("--dir", dir, "--top", "-3");
		expect(negative.status).toBe(2);
		expect(negative.stderr).toContain("--top needs a non-negative number");
	});

	it("refuses an unknown flag, naming it, and answers --help with usage before reading any transcript (#920)", () => {
		const unknown = run("--dir", dir, "--jsno");
		expect(unknown.status).toBe(2);
		expect(unknown.stderr).toContain("unknown flag: --jsno");
		const help = run("--help");
		expect(help.status).toBe(0);
		expect(help.stdout).toContain(
			"usage: node scripts/measure-encoding-use.js",
		);
	});

	it("names the flag AS TYPED when its value is not a number (mantahostels#1299)", () => {
		// The review at mantahostels#1299 found this printing `--minCount`, a flag that does
		// not exist, because the message was built from the field name.
		const bad = run("--dir", dir, "--min-count", "banana");
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain("--min-count needs a non-negative number");
		expect(bad.stderr).not.toContain("minCount needs");
		transcript("a", [bash("npm run test", "t1")]);
		expect(run("--dir", dir, "--min-count", "3").status).toBe(0);
	});
});
