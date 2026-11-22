import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkInProcess } from "./check";
import { type Files, ROW_FIXTURES } from "./check-in-process-row-fixtures";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { keptSpawn } from "./kept-spawn.js";
import { armed } from "./precommit-arm.js";
import { computed } from "./precommit-dispatch-ports.js";
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
export const removeFixtures = () => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
};

export const spawned = (script: string, args: string[], repo: string) => {
	const r = keptSpawn("boundary").spawnSync(
		process.execPath,
		[script, ...args],
		{
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
		},
	);
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

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

export const sideOf = (row: GateRow) => {
	if (row.args.includes("--against")) return "against";
	if (row.args.includes("--index")) return "index";
	return null;
};

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

interface RowTree extends Tree {
	verdict?: { exit: number; says: RegExp; names: string[] };
}

const treesOf = (row: GateRow): RowTree[] => {
	const at = pathOf(row);
	const base = (r: string, held: Files) => {
		writeAll(r, held);
		stage(r, at, versionOf(at, 1));
		git(r, "commit", "-qm", "init");
	};
	const change: RowTree = {
		name: `a change to ${at}`,
		build: (r) => {
			base(r, {});
			stage(r, at, versionOf(at, 2));
		},
	};
	const fault = ROW_FIXTURES[row.id]?.fault;
	if (!fault) return [change];
	const against = sideOf(row) === "against";
	return [
		change,
		{
			name: "a fault the commit holds, the index changing the path alone",
			build: (r) => {
				base(r, fault.inherited);
				stage(r, at, versionOf(at, 2));
			},
			verdict: against
				? {
						exit: 0,
						says: fault.scoped
							? /no gating fault in the index/
							: /is already in /,
						names: [],
					}
				: { exit: 1, says: /FAIL/, names: [] },
		},
		{
			name: "a fault the commit holds, the index adding a second",
			build: (r) => {
				base(r, fault.inherited);
				writeAll(r, fault.added);
			},
			verdict: {
				exit: 1,
				says: against ? / adds them:/ : /FAIL/,
				names: fault.names ?? Object.keys(fault.added),
			},
		},
	];
};

const listOf = (row: GateRow) =>
	"computed" in row.arm && row.arm.computed !== undefined
		? computed(row.arm.computed)
		: [];

const dispatcherRowCase = async (row: GateRow, tree: RowTree) => {
	const at = pathOf(row);
	const list = listOf(row);
	if ("computed" in row.arm) expect(list).toContain(at);
	expect(
		armed(row.arm, [{ status: "M", path: at }], list, () => true),
		`${row.id}'s fixture path ${at} does not arm it`,
	).toBe(true);
	expect(
		Boolean(ROW_FIXTURES[row.id]?.fault),
		sideOf(row)
			? `${row.id} compares a side, so it owes a fault`
			: `${row.id} compares no side, so a fault proves nothing`,
	).toBe(sideOf(row) !== null);
	const repo = fixture(tree);
	const file = path.join(SCRIPTS, path.relative("scripts", row.script));
	const own = spawned(file, row.args, repo);
	if (row.kind === "program") {
		const { PROGRAM } = require(file);
		await inRepo(repo, () =>
			expect(PROGRAM({ cwd: repo, env: process.env })).toEqual(own),
		);
		return;
	}
	if (tree.verdict) {
		const out = own.stdout + own.stderr;
		expect(own.exit).toBe(tree.verdict.exit);
		expect(out).toMatch(tree.verdict.says);
		if (tree.verdict.names.length > 0)
			expect(
				tree.verdict.names.some((name) => out.includes(name)),
				"the added fault is among the findings",
			).toBe(true);
	}
	expect(
		settled(
			await inProcess(file, row.args, repo, row.side ? "spawn" : "in-process"),
		),
	).toEqual(settled(own));
};

export const describeRowFixtures = (rows: GateRow[]) =>
	it("keys every row fixture by a dispatcher row's id", () =>
		expect(
			Object.keys(ROW_FIXTURES).filter(
				(id) => !rows.some((row) => row.id === id),
			),
		).toEqual([]));

export const describeDispatcherRows = (rows: GateRow[]) =>
	describe.each(rows)("the $id dispatcher row", (row) => {
		it.each(treesOf(row))(
			"runs in-process exactly as spawned over $name",
			(tree) => dispatcherRowCase(row, tree),
		);
	});
