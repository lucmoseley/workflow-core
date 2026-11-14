/*
 * The machinery the check-in-process equivalence contract (#5172) shares
 * across its files (#5191): a checker run in-process through lib/check.js's
 * checkInProcess() gives the same exit code, stdout and stderr as the same
 * checker spawned as `node <checker> <args>`, over the same fixture tree.
 *
 * FOR TESTS ONLY.
 *
 * spawn-kept: the `spawned` helper is the real process every row is held to.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkInProcess } from "./check";
import { type Files, ROW_FIXTURES } from "./check-in-process-row-fixtures";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { armed } from "./precommit-dispatch.js";
import type { GATES } from "./precommit-gates.js";

type GateRow = (typeof GATES)[number];

export const SCRIPTS = path.resolve(__dirname, "..");

export interface Tree {
	name: string;
	build: (repo: string) => void;
}

export const git = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

export const stage = (repo: string, file: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
	git(repo, "add", file);
};

/** An empty repo with its identity set, built once per file and copied per tree. */
const EMPTY = defineTemplate((dir) => {
	git(dir, "init", "-q", ".");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "test");
});

const dirs: string[] = [];
export const fixture = (tree: Tree) => {
	const parent = mkScratchDir("check-in-process-");
	dirs.push(parent);
	const repo = fs.realpathSync(EMPTY.instantiate(path.join(parent, "repo")));
	tree.build(repo);
	return repo;
};
/** Each file's `afterEach`: removes the trees its cases built. */
export const removeFixtures = () => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
};

/* The fixture is also the run's host (CLAUDE_PROJECT_DIR), as the hook's
 * repo is its own: vitest.setup.ts points the host at an empty non-repo. */
export const spawned = (script: string, args: string[], repo: string) => {
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
	});
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

/* The fixture is the run's working directory, as the hook's is; chdir is the
 * test's, around the call, never the checker's. */
const inRepo = async <T>(repo: string, run: () => T | Promise<T>) => {
	const was = process.cwd();
	process.chdir(repo);
	vi.stubEnv("CLAUDE_PROJECT_DIR", repo);
	try {
		return await run();
	} finally {
		process.chdir(was);
	}
};

export const inProcess = (
	script: string,
	args: string[],
	repo: string,
	sides: "spawn" | "in-process" = "in-process",
) => {
	const { SPEC } = require(script);
	return inRepo(repo, () => checkInProcess(SPEC, args, { script, sides }));
};

/* A run with what differs between any two runs taken out: the random name of
 * each materialised tree, and a BROKEN's stack frames. */
const settled = (r: {
	exit: number | null;
	stdout: string;
	stderr: string;
}) => {
	const settle = (t: string) =>
		t
			.replace(/check-against-[\w-]+?-\w{6}\/tree-\w{6}/g, "<tree>")
			.replace(/^[ \t]+at .*\n/gm, "");
	return { exit: r.exit, stdout: settle(r.stdout), stderr: settle(r.stderr) };
};

/** Whether a row compares an `--against` or `--index` side with its own. */
export const sideOf = (row: GateRow) => {
	if (row.args.includes("--against")) return "against";
	if (row.args.includes("--index")) return "index";
	return null;
};

/** The row's fixture path: its own `staged`, else its ROW_FIXTURES entry's. */
const pathOf = (row: GateRow) => {
	const own = "staged" in row ? row.staged : undefined;
	const fx = ROW_FIXTURES[row.id];
	if (!fx)
		throw new Error(
			`${row.id} has no ROW_FIXTURES entry in check-in-process-row-fixtures.ts`,
		);
	if (own && fx.path) throw new Error(`${row.id} names its fixture path twice`);
	const at = own ?? fx.path;
	if (!at) throw new Error(`${row.id} has no fixture path`);
	return at;
};

const BODIES = { 1: "one\n", 2: "two\n" };
const versionOf = (at: string, n: 1 | 2) =>
	at.endsWith(".json") ? `{ "v": ${n} }\n` : BODIES[n];

const writeAll = (repo: string, files: Files) => {
	for (const [file, text] of Object.entries(files)) stage(repo, file, text);
};

/* The trees a row is judged on. Every row: one commit holding its fixture
 * path, the index changing it. A row with a side also: that commit holding a
 * fault besides, the index changing the path alone (the fault inherited) or
 * adding a second fault (one inherited, one added). */
const treesOf = (row: GateRow): Tree[] => {
	const at = pathOf(row);
	const base = (r: string, held: Files) => {
		writeAll(r, held);
		stage(r, at, versionOf(at, 1));
		git(r, "commit", "-qm", "init");
	};
	const change: Tree = {
		name: `a change to ${at}`,
		build: (r) => {
			base(r, {});
			stage(r, at, versionOf(at, 2));
		},
	};
	const fault = ROW_FIXTURES[row.id]?.fault;
	if (!fault) return [change];
	return [
		change,
		{
			name: "a fault the commit holds, the index changing the path alone",
			build: (r) => {
				base(r, fault.inherited);
				stage(r, at, versionOf(at, 2));
			},
		},
		{
			name: "a fault the commit holds, the index adding a second",
			build: (r) => {
				base(r, fault.inherited);
				writeAll(r, fault.added);
			},
		},
	];
};

/* What makes a fault tree hold the faults it names: an `--against` row passes
 * an inherited fault over and refuses an added one; an `--index` row refuses
 * both, it having no baseline. Asserted on the spawned run alone, the
 * in-process one being held equal to it. */
const holdsItsFault = (
	row: GateRow,
	tree: number,
	r: { exit: number | null; stderr: string },
) => {
	if (tree === 0) return;
	if (sideOf(row) === "index") {
		expect(r.exit).toBe(1);
		return;
	}
	if (tree === 1) {
		expect(r.exit).toBe(0);
		expect(r.stderr).toMatch(/is already in /);
	} else {
		expect(r.exit).toBe(1);
		expect(r.stderr).toMatch(/ adds them:/);
	}
};

/* Every dispatcher row as the dispatcher runs it (#5172): its args, its sides
 * spawned where the row keeps a `side`, over each tree treesOf builds. */
const dispatcherRowCase = async (row: GateRow, tree: number) => {
	const at = pathOf(row);
	expect(
		armed(row.arm, [{ status: "M", path: at }], [], () => true),
		`${row.id}'s fixture path ${at} does not arm it`,
	).toBe(true);
	expect(
		Boolean(ROW_FIXTURES[row.id]?.fault),
		sideOf(row)
			? `${row.id} compares a side, so it owes a fault`
			: `${row.id} compares no side, so a fault proves nothing`,
	).toBe(sideOf(row) !== null);
	const repo = fixture(treesOf(row)[tree] as Tree);
	const file = path.join(SCRIPTS, path.relative("scripts", row.script));
	const own = spawned(file, row.args, repo);
	/* A program row: its PROGRAM against its own process shell, in the
	 * fixture as the dispatcher runs it in the hook's repo. */
	if (row.kind === "program") {
		const { PROGRAM } = require(file);
		await inRepo(repo, () =>
			expect(PROGRAM({ cwd: repo, env: process.env })).toEqual(own),
		);
		return;
	}
	holdsItsFault(row, tree, own);
	expect(
		settled(
			await inProcess(file, row.args, repo, row.side ? "spawn" : "in-process"),
		),
	).toEqual(settled(own));
};

export const describeDispatcherRows = (rows: GateRow[]) =>
	describe.each(rows)("the $id dispatcher row", (row) => {
		it.each(treesOf(row).map((t, i) => ({ name: t.name, i })))(
			"runs in-process exactly as spawned over $name",
			({ i }) => dispatcherRowCase(row, i),
		);
	});
