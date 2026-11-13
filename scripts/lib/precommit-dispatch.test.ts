// @vitest-environment node
/*
 * The pre-commit dispatcher's core (#5172), seam 1 of #5171: arming, order,
 * stop-on-first-red, the exit alphabet, the warn policy, crash and load-fault
 * refusal, and the lander sets, over stub rows and the staged entries real
 * git reads in the test's temp directory.
 *
 * It is the hook's gate stack: loosen a case and a commit a gate refuses
 * lands, or a gate runs on a commit it was never armed for.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	dispatch,
	existsUnder,
	gateSetOf,
	readStaged,
} from "./precommit-dispatch.js";

type Arm =
	| { always: true }
	| { pattern: RegExp; live?: boolean }
	| { computed: string };
interface StubRow {
	id: string;
	lander: "every" | "merge" | "batch" | "none";
	arm: Arm;
	policy: "gate" | "warn";
	/** What the stub's runner answers, or how it fails. */
	result?: { exit: number; stdout?: string; stderr?: string };
	throws?: "load" | "run";
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/** A repo with `committed` in HEAD and `staged` added to the index. */
function repo(
	committed: Record<string, string>,
	staged: Record<string, string | null>,
): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "precommit-dispatch-")),
	);
	dirs.push(dir);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	const write = (files: Record<string, string | null>) => {
		for (const [rel, body] of Object.entries(files)) {
			const abs = path.join(dir, rel);
			if (body === null) {
				git("rm", "-q", "--", rel);
				continue;
			}
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
			git("add", "--", rel);
		}
	};
	write({ "seed.txt": "seed\n", ...committed });
	git("commit", "-qm", "init");
	write(staged);
	return dir;
}

const row = (id: string, more: Partial<StubRow> = {}): StubRow => ({
	id,
	lander: "batch",
	arm: { always: true },
	policy: "gate",
	result: { exit: 0, stdout: `${id} out\n`, stderr: `${id} err\n` },
	...more,
});

/** The core over stub rows: what it exits, writes and ran. */
async function run(
	rows: StubRow[],
	opts: {
		dir?: string;
		gates?: "all" | "merge" | "batch";
		computed?: Record<string, string[]>;
	} = {},
) {
	const dir = opts.dir ?? repo({}, { "a.txt": "a\n" });
	const ran: string[] = [];
	let out = "";
	let err = "";
	const exit = await dispatch({
		rows,
		gates: opts.gates ?? "all",
		ports: {
			staged: () => readStaged(dir),
			computed: (name: string) => opts.computed?.[name] ?? [],
			exists: existsUnder(dir),
			load: (r: StubRow) => {
				if (r.throws === "load") throw new Error(`${r.id} will not load`);
				return () => {
					ran.push(r.id);
					if (r.throws === "run") throw new Error(`${r.id} blew up`);
					return {
						exit: r.result?.exit ?? 0,
						stdout: r.result?.stdout ?? "",
						stderr: r.result?.stderr ?? "",
					};
				};
			},
			write: (fd: number, text: string) => {
				if (fd === 1) out += text;
				else err += text;
			},
		},
	});
	return { exit, ran, out, err };
}

describe("arming", () => {
	it("runs an always row on any commit", async () => {
		expect((await run([row("a")])).ran).toEqual(["a"]);
	});

	it("runs a pattern row only where a staged path matches", async () => {
		const rows = [
			row("docs", { arm: { pattern: /^docs\// } }),
			row("app", { arm: { pattern: /^app\// } }),
		];
		const dir = repo({}, { "docs/a.md": "a\n" });
		expect((await run(rows, { dir })).ran).toEqual(["docs"]);
	});

	it("arms on a rename's old path, as staged_names' --no-renames does (#1483)", async () => {
		const dir = repo({ "docs/a.md": "a\n" }, {});
		execFileSync("git", ["mv", "docs/a.md", "b.md"], { cwd: dir });
		const r = await run([row("docs", { arm: { pattern: /^docs\// } })], {
			dir,
		});
		expect(r.ran).toEqual(["docs"]);
	});

	it("runs a computed row where a member of its list is staged, and not otherwise", async () => {
		const rows = [row("pool", { arm: { computed: "pool" } })];
		const dir = repo({}, { "CLAUDE.md": "x\n" });
		expect(
			(await run(rows, { dir, computed: { pool: ["CLAUDE.md"] } })).ran,
		).toEqual(["pool"]);
		expect(
			(await run(rows, { dir, computed: { pool: ["AGENTS.md"] } })).ran,
		).toEqual([]);
	});

	it("narrows a live row to added or modified paths still on disk, as armed_live does", async () => {
		const live = [row("wf", { arm: { pattern: /^wf\//, live: true } })];
		const added = repo({}, { "wf/a.yml": "a\n" });
		expect((await run(live, { dir: added })).ran).toEqual(["wf"]);

		const deleted = repo({ "wf/a.yml": "a\n" }, { "wf/a.yml": null });
		expect((await run(live, { dir: deleted })).ran).toEqual([]);

		const gone = repo({}, { "wf/a.yml": "a\n" });
		fs.rmSync(path.join(gone, "wf/a.yml"));
		expect((await run(live, { dir: gone })).ran).toEqual([]);
	});
});

describe("order and output", () => {
	it("runs rows in registry order, each one's output written as it finishes", async () => {
		const r = await run([row("one"), row("two"), row("three")]);
		expect(r.ran).toEqual(["one", "two", "three"]);
		expect(r.out).toBe("one out\ntwo out\nthree out\n");
		expect(r.err).toBe("one err\ntwo err\nthree err\n");
	});

	it("stops at the first gating red, running nothing after it", async () => {
		const r = await run([
			row("one"),
			row("red", { result: { exit: 1, stderr: "FAIL: 1 finding(s)\n" } }),
			row("after"),
		]);
		expect(r.exit).toBe(1);
		expect(r.ran).toEqual(["one", "red"]);
		expect(r.err).toBe("one err\nFAIL: 1 finding(s)\n");
	});

	it("passes when every armed row passes", async () => {
		expect((await run([row("one"), row("two")])).exit).toBe(0);
	});
});

describe("the exit alphabet", () => {
	it.each([
		[1, "FAIL"],
		[2, "BROKEN"],
		[7, "a program's own code"],
		[130, "128 + SIGINT"],
	])("exits %i on a row exiting it (%s)", async (code) => {
		const r = await run([row("red", { result: { exit: code } }), row("x")]);
		expect(r.exit).toBe(code);
		expect(r.ran).toEqual(["red"]);
	});
});

describe("the failure policy", () => {
	it("refuses BROKEN on a gate row that throws, naming it, and runs nothing after", async () => {
		const r = await run([row("crash", { throws: "run" }), row("after")]);
		expect(r.exit).toBe(2);
		expect(r.err).toBe("pre-commit: the crash gate threw: crash blew up\n");
		expect(r.ran).toEqual(["crash"]);
	});

	it("refuses BROKEN on a gate row whose module will not load, naming it", async () => {
		const r = await run([row("gone", { throws: "load" }), row("after")]);
		expect(r.exit).toBe(2);
		expect(r.err).toBe(
			"pre-commit: the gone gate could not load: gone will not load\n",
		);
		expect(r.ran).toEqual([]);
	});

	it("prints a warn row's red and goes on, never refusing", async () => {
		const r = await run([
			row("drift", {
				policy: "warn",
				result: { exit: 2, stderr: "BROKEN: drift\n" },
			}),
			row("after"),
		]);
		expect(r.exit).toBe(0);
		expect(r.err).toBe("BROKEN: drift\nafter err\n");
		expect(r.ran).toEqual(["drift", "after"]);
	});

	it.each(["load", "run"] as const)(
		"prints one line for a warn row that throws at %s and goes on",
		async (at) => {
			const r = await run([
				row("drift", { policy: "warn", throws: at }),
				row("after"),
			]);
			expect(r.exit).toBe(0);
			expect(r.err.split("\n")[0]).toMatch(/^pre-commit: the drift gate /);
			expect(r.ran).toContain("after");
		},
	);
});

describe("the lander sets (#4545)", () => {
	const rows = [
		row("every", { lander: "every" }),
		row("merge", { lander: "merge" }),
		row("batch", { lander: "batch" }),
		row("none", { lander: "none" }),
	];

	it.each([
		["all", ["every", "merge", "batch", "none"]],
		["merge", ["every", "merge"]],
		["batch", ["every", "batch"]],
	] as const)("--gates=%s runs %j", async (gates, expected) => {
		expect((await run(rows, { gates })).ran).toEqual(expected);
	});

	it.each([
		[undefined, "all"],
		["merge", "merge"],
		["batch", "batch"],
		["other", "all"],
	] as const)("reads --gates=%s as the %s set", (value, set) => {
		expect(gateSetOf(value)).toBe(set);
	});
});
