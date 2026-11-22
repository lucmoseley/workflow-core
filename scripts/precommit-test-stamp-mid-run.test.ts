// @vitest-environment node
// #5569

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { ignoreFailure } from "./lib/caught.js";
import {
	buildOtherCommit,
	cutPatch,
	fixture,
	reason,
	STUB,
} from "./lib/precommit-test-stamp-testkit";

it("writes no stamp where a named file is edited while the pre-lock run goes, saying so, and the hook runs the test in the lock", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		"printf 'edited mid-run\\n' > a.txt\n",
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.out).toMatch(
		/commit-paths: no pre-lock green for 'sh stub\.sh' — it was green \(\d+\.\ds\), but the commit's own changes moved while it ran\. The commit's hook runs it in the lock instead\./,
	);
	expect(r.out).toContain(reason("no stamp named"));
	expect(r.runs).toEqual([
		"lock=0 stamp=unset staged=a.txt",
		"lock=1 stamp=unset staged=a.txt",
	]);
	expect(r.leftInGitDir).toEqual([]);
});

it("stands down where another commit to a path this commit does not name lands while the pre-lock run goes", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("c.txt", "theirs\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(String(f.git("log", "-1", "--format=%s", "HEAD~1")).trim()).toBe(
		"other",
	);
	expect(r.leftInGitDir).toEqual([]);
});

it("stands down where another commit gives an unborn branch its first commit, to a path this commit does not name, while the pre-lock run goes", () => {
	const f = fixture({ born: false });
	f.edit("a.txt", "first\n");
	f.edit("stub.sh", STUB);
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("c.txt", "theirs\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,stub.sh"]);
	expect(String(f.git("log", "-1", "--format=%s", "HEAD~1")).trim()).toBe(
		"other",
	);
});

it("writes no stamp where another commit to a named path changes what this commit adds, and the hook runs the test in the lock", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	f.edit("b.txt", "changed too\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("a.txt", "changed\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.out).toContain("but the commit's own changes moved while it ran");
	expect(r.out).toContain(reason("no stamp named"));
	expect(r.runs).toEqual([
		"lock=0 stamp=unset staged=a.txt,b.txt",
		"lock=1 stamp=unset staged=b.txt",
	]);
});

it("stands down where another commit to a named path lands while the pre-lock run goes, leaving what this commit adds unchanged", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("a.txt", "theirs\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(String(f.git("show", "HEAD:a.txt"))).toBe("changed\n");
	expect(r.leftInGitDir).toEqual([]);
});

function readProcessTree(pid: number): number[] {
	const parentOf = new Map<number, number>();
	for (const d of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)))
		ignoreFailure(() => {
			const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
			parentOf.set(
				Number(d),
				Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
			);
		});
	const tree = [pid];
	for (let i = 0; i < tree.length; i++)
		for (const [child, ppid] of parentOf)
			if (ppid === tree[i]) tree.push(child);
	return tree;
}

function signalIfAlive(pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(pid, signal);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
	}
}

const UNTIL_MS = 5000; // guess: a bound on a hold starting and its leftovers clearing, never reached on a green run (#5574)
async function until(ok: () => boolean, ms = UNTIL_MS) {
	for (const end = Date.now() + ms; !ok() && Date.now() < end; )
		await new Promise((r) => setTimeout(r, 20));
}

it.each([
	["SIGINT", "group", "the pre-lock suite", "stub-mid.sh"],
	["SIGTERM", "process", "the pre-lock suite", "stub-mid.sh"],
	["SIGINT", "process", "git commit", "stub-in-hook.sh"],
	["SIGTERM", "group", "git commit", "stub-in-hook.sh"],
	["SIGTERM", "process tree", "git commit", "stub-in-hook.sh"],
	["SIGKILL", "group", "git commit", "stub-in-hook.sh"],
] as const)(
	"leaves no file of its own in the git directory where %s reaches its %s during %s, and dies of it (#1680)",
	async (signal, to, _during, hold) => {
		const f = fixture();
		f.edit("a.txt", "changed\n");
		fs.writeFileSync(
			path.join(f.root, hold),
			`touch held\nsleep ${(2 * UNTIL_MS) / 1000}\n`,
		);
		const run = f.spawnCommitPaths();
		try {
			await until(() => fs.existsSync(path.join(f.root, "held")));
			const mine = `commit-paths-${run.pid}`;
			expect(f.readLeftInGitDir()).toEqual(
				hold === "stub-in-hook.sh"
					? [`${mine}.index`, `${mine}.test-stamp`]
					: [`${mine}.index`],
			);
			if (to === "group") process.kill(-run.pid, signal);
			else if (to === "process") process.kill(run.pid, signal);
			else for (const p of readProcessTree(run.pid)) signalIfAlive(p, signal);
			expect(await run.exited).toEqual({ code: null, signal });
			await until(() => f.readLeftInGitDir().length === 0);
			expect(f.readLeftInGitDir()).toEqual([]);
		} finally {
			ignoreFailure(() => process.kill(-run.pid, "SIGKILL"));
		}
	},
);

it.each([
	["a plain commit", false],
	["a --patch commit", true],
] as const)(
	"leaves no file of its own in the git directory where %s throws after writing its stamp (#1680)",
	async (_kind, underPatch) => {
		const f = fixture();
		const patch = underPatch ? cutPatch(f) : undefined;
		if (!underPatch) f.edit("a.txt", "changed\n");
		const preload = path.join(f.root, "stub-throw.js");
		fs.writeFileSync(
			preload,
			`const cp = require("node:child_process");
const fs = require("node:fs");
const real = cp.spawnSync;
let stamp;
cp.spawnSync = (cmd, args, opts) => {
	const r = real(cmd, args, opts);
	stamp = opts?.env?.WFC_TEST_STAMP ?? stamp;
	if (cmd === "git" && (args[0] === "commit" || args[0] === "update-ref")) {
		throw new Error(\`thrown after the commit, its stamp \${stamp && fs.existsSync(stamp) ? "written" : "missing"}\`);
	}
	return r;
};
`,
		);
		const run = f.spawnCommitPaths({ nodeArgs: ["--require", preload], patch });
		const out = await run.closed;
		expect(await run.exited, out).toEqual({ code: 1, signal: null });
		expect(out).toContain("thrown after the commit, its stamp written");
		await until(() => f.readLeftInGitDir().length === 0);
		expect(f.readLeftInGitDir()).toEqual([]);
	},
);
