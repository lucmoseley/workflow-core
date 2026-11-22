// @vitest-environment node
// #5569

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
	cutPatch,
	fixture,
	IN_HOOK,
	PUSH,
	recordStaged,
	STUB,
} from "./lib/precommit-test-stamp-testkit";

it("runs the declared test once through commit-paths, before the lock, on exactly the named paths, and the hook stands down", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, "c.txt"), "theirs\n");
	f.git("add", "-f", "c.txt");
	f.edit("a.txt", "changed\n");
	f.edit("b.txt", "changed too\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,b.txt"]);
	expect(r.leftInGitDir).toEqual([]);
});

const readGateRunRecord = (root: string) => {
	const file = path.join(root, ".claude/tmp/markers/.gate-runs.jsonl");
	return fs.existsSync(file)
		? fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
};

it("runs the pre-lock and the in-lock test as commit gates, each one gate-run record line naming the tree its commit holds (#5274, #5448)", () => {
	const f = fixture();
	const headTree = () => String(f.git("rev-parse", "HEAD^{tree}")).trim();
	f.edit("a.txt", "changed\n");
	const pre = f.commitPaths();
	expect(pre.code, pre.out).toBe(0);
	expect(pre.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	const preTree = headTree();
	expect(readGateRunRecord(f.root)).toEqual([
		expect.objectContaining({
			command: "sh stub.sh",
			outcome: "pass",
			tree: preTree,
		}),
	]);
	f.stage("b.txt", "changed too\n");
	const inLock = f.commit();
	expect(inLock.code, inLock.out).toBe(0);
	expect(inLock.runs.at(-1)).toBe("lock=1 stamp=unset staged=b.txt");
	expect(readGateRunRecord(f.root)).toEqual([
		expect.objectContaining({ outcome: "pass", tree: preTree }),
		expect.objectContaining({
			command: "sh stub.sh",
			outcome: "pass",
			tree: headTree(),
		}),
	]);
});

it("runs the pre-lock suite on HEAD plus the named paths alone, so unsaved files outside the commit cannot refuse it, and the hook stands down (#1760)", () => {
	const f = fixture();
	unsavedDirt(f);
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).not.toContain(IN_HOOK);
	expect(fs.readFileSync(path.join(f.root, "b.txt"), "utf8")).toBe("broken\n");
	expect(r.otherWorktrees).toEqual([]);
	expect(r.leftInGitDir).toEqual([]);
});

it("runs the pre-lock suite on a named path as on disk, refusing the commit it breaks (#1760)", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	f.edit("b.txt", "broken\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.out).toContain("stub: b.txt is broken");
	expect(r.otherWorktrees).toEqual([]);
});

function needsGen(config: object) {
	const f = fixture({ config: JSON.stringify(config) });
	f.git("add", "-f", ".claude/workflow-core.json");
	f.git("commit", "-qm", "config", "--no-verify");
	fs.rmSync(path.join(f.root, "stub.log"), { force: true });
	fs.writeFileSync(path.join(f.root, "stub-needs-gen"), "");
	fs.writeFileSync(path.join(f.root, "gen.txt"), "generated\n");
	f.edit("a.txt", "changed\n");
	return f;
}

it("links each gitignored path worktreeLinks declares into the pre-lock worktree, skipping one the checkout lacks, so a suite reading it goes green (#1767)", () => {
	const f = needsGen({
		commands: { test: "sh stub.sh" },
		worktreeLinks: ["gen.txt", "absent/none.txt"],
	});
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(String(f.git("ls-files", "--", "gen.txt")).trim()).toBe("");
	expect(fs.readFileSync(path.join(f.root, "gen.txt"), "utf8")).toBe(
		"generated\n",
	);
	expect(r.otherWorktrees).toEqual([]);
});

it("refuses a pre-lock suite red on an undeclared gitignored file, naming worktreeLinks as the way round (#1767)", () => {
	const f = needsGen({ commands: { test: "sh stub.sh" } });
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.out).toContain("stub: gen.txt is missing");
	expect(r.out).toContain(
		"name it in `worktreeLinks` in .claude/workflow-core.json",
	);
});

it("keeps a stamp variable commit-paths inherited from its caller out of its pre-lock run", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths({
		inherited: path.join(f.gitDir, "a-caller.test-stamp"),
	});
	expect(r.code, r.out).toBe(0);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
});

it("keeps an inherited stamp out of the commit where the pre-lock run defers to the hook, though it matches what lands", () => {
	const f = fixture();
	f.edit("a.txt", "edited mid-run\n");
	f.git("add", "a.txt");
	const inherited = f.stamp(path.join(f.gitDir, "a-caller.test-stamp"));
	f.git("reset", "-q", "--", "a.txt");
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		"printf 'edited mid-run\\n' > a.txt\n",
	);
	const r = f.commitPaths({ inherited });
	expect(r.code, r.out).toBe(0);
	expect(r.runs).toEqual([
		"lock=0 stamp=unset staged=a.txt",
		"lock=1 stamp=unset staged=a.txt",
	]);
});

function unsavedDirt(f: ReturnType<typeof fixture>) {
	fs.writeFileSync(path.join(f.root, "b.txt"), "broken\n");
	fs.writeFileSync(path.join(f.root, "stray.txt"), "theirs\n");
}

it("runs the in-lock suite on HEAD plus the commit's staged paths alone, so unsaved files outside the commit cannot refuse a plain git commit (#1766)", () => {
	const f = fixture();
	unsavedDirt(f);
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(fs.readFileSync(path.join(f.root, "b.txt"), "utf8")).toBe("broken\n");
	expect(r.otherWorktrees).toEqual([]);
});

it("refuses an in-lock red on the commit's own paths, blaming no file outside them (#1766)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	f.stage("b.txt", "broken\n");
	const r = f.commit();
	expect(r.code).toBe(1);
	expect(r.landed).toBe(false);
	expect(r.out).toContain("stub: b.txt is broken");
	expect(r.out).toContain(
		"pre-commit: the declared test command is RED — 'sh stub.sh' — so this commit is refused.",
	);
	expect(r.out).toContain(
		"It ran on HEAD plus this commit's own changes, so no unsaved edit outside them reached it (#1766)",
	);
	expect(r.out).not.toContain("mantahostels#273");
	expect(r.otherWorktrees).toEqual([]);
});

it("runs the in-lock suite in the checkout where no worktree can be made, saying so, and its red names mantahostels#273 (#1766)", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, ".claude/worktrees"), "");
	unsavedDirt(f);
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code).toBe(1);
	expect(r.landed).toBe(false);
	expect(r.out).toContain(
		"no worktree holds this commit's tree alone, so 'sh stub.sh' runs in this checkout.",
	);
	expect(r.out).toContain("stub: b.txt is broken");
	expect(r.out).toContain("mantahostels#273");
});

it("refuses a red pre-lock run with exit 3, the suite's output and the hook's three lines, before the lock and with the index untouched", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, "stub-red"), "");
	f.edit("a.txt", "changed\n");
	f.edit("new.txt", "new\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,new.txt"]);
	expect(r.out).toContain("stub: the widget is broken");
	expect(r.out).toContain(
		"the declared test command is RED — 'sh stub.sh' — so this commit is refused.",
	);
	expect(r.out).toContain(
		"It ran on HEAD plus this commit's own paths, so no unsaved edit outside them reached it (#1760)",
	);
	expect(r.out).not.toContain("It ran in this checkout");
	expect(r.out).toContain("Fix the failing test and commit again.");
	expect(r.leftInGitDir).toEqual([]);
	expect(r.otherWorktrees).toEqual([]);
});

it("runs nothing before the lock where the test is gated at push", () => {
	const f = fixture({
		config: PUSH,
	});
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual([]);
	expect(r.out).not.toContain("before the commit takes the index lock");
});

it("runs nothing before the lock where no test command is declared", () => {
	const f = fixture({ config: JSON.stringify({ commands: {} }) });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.out).not.toContain("before the commit takes the index lock");
});

it("runs nothing before the lock on an unreadable config, leaving the hook's refusal the only one", () => {
	const f = fixture({ config: "{ not json" });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.runs).toEqual([]);
	expect(r.out).not.toContain("before the commit takes the index lock");
	expect(r.out.match(/BROKEN/g)).toHaveLength(1);
	expect(r.out).toContain("husky - pre-commit script failed");
});

it.each([
	["gated at push", PUSH, false],
	["with no test command", JSON.stringify({ commands: {} }), false],
	["gated at commit", undefined, true],
] as const)(
	"starts the sweeper on a plain commit %s only where a pre-lock run is due (#1639 story 14)",
	async (_kind, config, swept) => {
		const f = fixture(config === undefined ? {} : { config });
		f.edit("a.txt", "changed\n");
		const preload = path.join(f.root, "stub-spawn.js");
		fs.writeFileSync(
			preload,
			`const cp = require("node:child_process");
const real = cp.spawn;
cp.spawn = (cmd, args, opts) => {
	if (cmd === "sh" && String(args[1]).startsWith("trap")) process.stderr.write("sweeper started\\n");
	return real(cmd, args, opts);
};
`,
		);
		const run = f.spawnCommitPaths({ nodeArgs: ["--require", preload] });
		const out = await run.closed;
		expect(await run.exited, out).toEqual({ code: 0, signal: null });
		expect(out.includes("sweeper started"), out).toBe(swept);
	},
);

it("stands down after a green pre-lock run on a commit naming a new file", () => {
	const f = fixture();
	f.edit("new.txt", "new\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=new.txt"]);
});

it("stands down after a green pre-lock run on a commit naming a deletion", () => {
	const f = fixture();
	f.edit("b.txt", null);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=b.txt"]);
});

it("stands down after a green pre-lock run on an unborn branch's first commit, which holds the suite it runs", () => {
	const f = fixture({ born: false });
	f.edit("a.txt", "first\n");
	f.edit("stub.sh", STUB);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,stub.sh"]);
	expect(r.otherWorktrees).toEqual([]);
});

it("prints the pre-lock run's start and green lines, and logs its seconds", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths({ stepMs: 1300 });
	expect(r.code, r.out).toBe(0);
	expect(r.out).toContain(
		"commit-paths: running 'sh stub.sh' before the commit takes the index lock.",
	);
	expect(r.out).toContain("commit-paths: 'sh stub.sh' is green (1.3s)");
	const [, outcome, preLock] = r.outcome ?? [];
	expect(outcome).toBe("committed");
	expect(preLock).toBe("1.3");
});

it("runs the declared test once under --patch, before the commit, on the patch's private index alone, and the hook stands down", () => {
	const f = fixture();
	const patch = cutPatch(f);
	const readStaged = recordStaged(f);
	const r = f.commitPaths({ patch });
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).not.toContain(IN_HOOK);
	expect(readStaged()).toBe("mine\na.txt\nmine\na.txt\n");
	expect(String(f.git("show", "HEAD:a.txt"))).toBe("mine\na.txt\n");
	expect(r.leftInGitDir).toEqual([]);
});

it("refuses a red pre-lock run under --patch with exit 3, writing neither the commit nor the index", () => {
	const f = fixture();
	const patch = cutPatch(f);
	fs.writeFileSync(path.join(f.root, "stub-red"), "");
	const r = f.commitPaths({ patch });
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(fs.readFileSync(path.join(f.root, "a.txt"), "utf8")).toBe(
		"mine\na.txt\ntheirs\n",
	);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).not.toContain(IN_HOOK);
	expect(r.out).toContain(
		"the declared test command is RED — 'sh stub.sh' — so this commit is refused.",
	);
	expect(r.out).toContain("Fix the failing test and commit again.");
	expect(r.leftInGitDir).toEqual([]);
	expect(r.otherWorktrees).toEqual([]);
});

it("refuses a red pre-lock gate under --patch with exit 3, starting no suite and writing neither the commit nor the index (#1763)", () => {
	const f = fixture();
	const patch = cutPatch(f);
	fs.writeFileSync(path.join(f.root, "stub-gate-red"), "");
	const r = f.commitPaths({ patch });
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(fs.readFileSync(path.join(f.root, "a.txt"), "utf8")).toBe(
		"mine\na.txt\ntheirs\n",
	);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt"]);
	expect(r.runs).toEqual([]);
	expect(r.out).toContain("gate: a lint finding in a.txt");
	expect(r.leftInGitDir).toEqual([]);
});
