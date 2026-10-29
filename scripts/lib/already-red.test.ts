// @vitest-environment node
/*
 * Whether a red run's failures were already red on its base (#3624), judged
 * off the red store, the certificate store and the lander's heartbeat seeded
 * in a throwaway repository, against its real git. Loosen a case and a
 * session reads its own breakage as a neighbour's, or reruns a suite to
 * attribute a red the record already attributes.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
	classifyFailures,
	readAlreadyRedLines,
	readRedEvidence,
} = require("./already-red.js");
const { EDGES_FILE, record, recordFailure } = require("./test-pass-marker.js");
const { landerFiles } = require("./lander.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const TEST = "scripts/a.test.ts";

/** A repository whose one test reads `a.js`, and its base. */
function repo() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ared-")));
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	fs.mkdirSync(path.join(dir, "scripts"));
	fs.mkdirSync(path.join(dir, "docs"));
	fs.writeFileSync(path.join(dir, ".gitignore"), ".claude/\n");
	for (const f of [TEST, "a.js", "b.js", "package.json"])
		fs.writeFileSync(path.join(dir, f), `${f} v0\n`);
	fs.writeFileSync(path.join(dir, EDGES_FILE), JSON.stringify({ edges: {} }));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return { dir, base: git(dir, "rev-parse", "HEAD") };
}

/** A commit changing `file`, its sha and tree. */
function commit(dir: string, file: string) {
	fs.appendFileSync(path.join(dir, file), "changed\n");
	git(dir, "commit", "-q", "-am", `change ${file}`);
	const sha = git(dir, "rev-parse", "HEAD");
	return { sha, tree: git(dir, "rev-parse", `${sha}^{tree}`) };
}

/** A per-test run of TEST, red where `failed`, reading `tree`. */
const run = (o: {
	dir: string;
	sha: string;
	at: string;
	tree: string;
	failed: boolean;
	base?: string;
}) => ({
	sha: o.sha,
	at: o.at,
	treeAtEnd: o.tree,
	...(o.base ? { base: o.base } : {}),
	scope: {
		modulesRun: 1,
		modulesTotal: 9,
		tests: 1,
		skipped: 0,
		...(o.failed
			? {
					failures: [
						{
							file: path.join(o.dir, ".claude/worktrees/isolated-1", TEST),
							tests: ["t"],
						},
					],
				}
			: {}),
	},
	closure: [TEST, "a.js", "package.json"],
	selected: [TEST],
	imports: { [TEST]: ["a.js"] },
	roots: ["package.json"],
});

/** The red run, its failing file recorded under the repository. */
const failingHere = (dir: string, mine: ReturnType<typeof run>) => ({
	...mine,
	scope: {
		...mine.scope,
		failures: [{ file: path.join(dir, TEST), tests: ["t"] }],
	},
});

const linesFor = (dir: string, mine: ReturnType<typeof run>) =>
	readAlreadyRedLines(failingHere(dir, mine), dir).join("\n");

/** The red run's classing, the answer the unasked-rerun guard reads (#3633). */
const classingOf = (dir: string, mine: ReturnType<typeof run>) =>
	classifyFailures(failingHere(dir, mine), readRedEvidence(dir), { root: dir });

describe("a red run's failures judged against its base (#3624)", () => {
	it("marks a failure already red where an earlier red holds at the base", () => {
		const { dir, base } = repo();
		const elsewhere = commit(dir, "b.js");
		recordFailure(run({ dir, ...elsewhere, at: "1", failed: true }), {
			root: dir,
		});

		expect(
			linesFor(dir, run({ dir, ...elsewhere, at: "2", failed: true, base })),
		).toBe(
			[
				`  ALREADY RED on the base ${base.slice(0, 12)} (#3624):`,
				`    ${TEST} — by the red store's run at ${elsewhere.sha.slice(0, 12)}, 1`,
				"  Every failure here was already red on the base, so no rerun is owed to attribute them — evidence, not a licence: a red's failing set repeats only about half the time between runs (mantahostels#2195).",
			].join("\n"),
		);
	});

	it("marks it new where the earlier red read an import the base differs in", () => {
		const { dir, base } = repo();
		const edited = commit(dir, "a.js");
		recordFailure(run({ dir, ...edited, at: "1", failed: true }), {
			root: dir,
		});

		expect(
			linesFor(dir, run({ dir, ...edited, at: "2", failed: true, base })),
		).toBe(`  NEW — no record shows these red on the base:\n    ${TEST}`);
	});

	it("marks it new where the earlier red is stamped at the base but read uncommitted edits", () => {
		const { dir, base } = repo();
		const dirty = commit(dir, "a.js");
		recordFailure(
			run({ dir, sha: base, tree: dirty.tree, at: "1", failed: true }),
			{
				root: dir,
			},
		);

		expect(
			linesFor(
				dir,
				run({ dir, ...dirty, sha: base, at: "2", failed: true, base }),
			),
		).toContain("NEW");
	});

	it("lets a newer certificate at the base's content supersede a red", () => {
		const { dir, base } = repo();
		const elsewhere = commit(dir, "b.js");
		recordFailure(run({ dir, ...elsewhere, at: "1", failed: true }), {
			root: dir,
		});
		record(run({ dir, ...elsewhere, at: "2", failed: false }), { root: dir });

		expect(
			linesFor(dir, run({ dir, ...elsewhere, at: "3", failed: true, base })),
		).toContain("NEW");
	});

	it("reads no record written after the run", () => {
		const { dir, base } = repo();
		const elsewhere = commit(dir, "b.js");
		recordFailure(run({ dir, ...elsewhere, at: "2", failed: true }), {
			root: dir,
		});

		expect(
			linesFor(dir, run({ dir, ...elsewhere, at: "1", failed: true, base })),
		).toContain("NEW");
	});

	it("takes the lander's red base check at that sha where no store holds", () => {
		const { dir, base } = repo();
		const elsewhere = commit(dir, "b.js");
		fs.writeFileSync(
			landerFiles(dir).heartbeat,
			JSON.stringify({
				pid: 1,
				at: "9",
				batch: null,
				red: { base, onMain: { kind: "red", files: [TEST] } },
			}),
		);

		expect(
			linesFor(dir, run({ dir, ...elsewhere, at: "2", failed: true, base })),
		).toContain(`${TEST} — by the lander's run at ${base.slice(0, 12)}`);
	});

	it("says a run with no base could not be checked", () => {
		const { dir } = repo();
		const elsewhere = commit(dir, "b.js");

		expect(
			linesFor(dir, run({ dir, ...elsewhere, at: "1", failed: true })),
		).toBe(
			"  This run recorded no base, so no failure could be checked against one (#3624).",
		);
	});
});

describe("a red run's classing, one answer for the summary and the guard (#3633)", () => {
	it("answers all-already-red with each file's evidence where all were already red", () => {
		const { dir, base } = repo();
		const elsewhere = commit(dir, "b.js");
		recordFailure(run({ dir, ...elsewhere, at: "1", failed: true }), {
			root: dir,
		});

		expect(
			classingOf(dir, run({ dir, ...elsewhere, at: "2", failed: true, base })),
		).toEqual({
			base,
			allAlreadyRed: true,
			files: [
				{
					file: TEST,
					red: { sha: elsewhere.sha, at: "1", by: "red store" },
				},
			],
		});
	});

	it("answers not all-already-red where a failure is new", () => {
		const { dir, base } = repo();
		const edited = commit(dir, "a.js");
		recordFailure(run({ dir, ...edited, at: "1", failed: true }), {
			root: dir,
		});

		expect(
			classingOf(dir, run({ dir, ...edited, at: "2", failed: true, base })),
		).toMatchObject({
			allAlreadyRed: false,
			files: [{ file: TEST, red: null }],
		});
	});

	it("answers not all-already-red where the run recorded no base", () => {
		const { dir } = repo();
		const elsewhere = commit(dir, "b.js");
		recordFailure(run({ dir, ...elsewhere, at: "1", failed: true }), {
			root: dir,
		});

		expect(
			classingOf(dir, run({ dir, ...elsewhere, at: "2", failed: true })),
		).toEqual({ base: null, files: [], allAlreadyRed: false });
	});
});
