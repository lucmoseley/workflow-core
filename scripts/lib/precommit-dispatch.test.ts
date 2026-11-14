// @vitest-environment node
/*
 * The git-hook dispatcher's core (#5172), seam 1 of #5171: arming, order,
 * stop-on-first-red, the exit alphabet, the warn policy, crash and load-fault
 * refusal, a caught signal's stop (#5188), and the lander sets, over stub
 * rows and the staged entries real git reads in the test's temp directory.
 *
 * It is the hook's gate stack: loosen a case and a commit a gate refuses
 * lands, or a gate runs on a commit it was never armed for.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import {
	dispatch,
	gateSetOf,
	type Ports,
	STOPPED_LINE,
} from "./precommit-dispatch.js";
import { readStaged } from "./precommit-dispatch-ports.js";
import { buildRepoPorts } from "./precommit-gate-testkit";

type Arm =
	| { always: true }
	| { pattern: RegExp; live?: boolean; computed?: string }
	| { computed: string };
interface StubRow {
	id: string;
	lander?: "every" | "merge" | "batch" | "none";
	arm: Arm;
	when?: {
		routes?: string[];
		unlessRoutes?: string[];
		facts?: string[];
		unlessFacts?: string[];
	};
	policy: "gate" | "warn";
	quietPass?: boolean;
	/** What the stub's runner answers, or how it fails. */
	result?: { exit: number; stdout?: string; stderr?: string };
	throws?: "load" | "run";
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** One seed commit, built once for the file and copied per repo. */
const SEEDED = defineTemplate((dir) => {
	git(dir, "init", "-q", ".");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "test");
	fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
	git(dir, "add", "--", "seed.txt");
	git(dir, "commit", "-qm", "init");
});

/** A repo with `committed` in HEAD and `staged` added to the index. */
function repo(
	committed: Record<string, string>,
	staged: Record<string, string | null>,
): string {
	const parent = mkScratchDir("precommit-dispatch-");
	dirs.push(parent);
	const dir = fs.realpathSync(SEEDED.instantiate(path.join(parent, "repo")));
	const write = (files: Record<string, string | null>) => {
		for (const [rel, body] of Object.entries(files)) {
			const abs = path.join(dir, rel);
			if (body === null) {
				git(dir, "rm", "-q", "--", rel);
				continue;
			}
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
			git(dir, "add", "--", rel);
		}
	};
	if (Object.keys(committed).length > 0) {
		write(committed);
		git(dir, "commit", "-qm", "committed");
	}
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
		computed?: Record<string, string[] | Error>;
		signalIn?: string;
		/** Git will not name the staged paths, killed by a signal where "signal". */
		stagedFails?: "git" | "signal";
		/** The commit route the route port answers; an Error throws. */
		route?: string | null | Error;
		facts?: string[];
		voice?: { hook: string; noun: string };
	} = {},
) {
	let stagedReads = 0;
	const dir = opts.dir ?? repo({}, { "a.txt": "a\n" });
	const ran: string[] = [];
	let caught: number | null = opts.stagedFails === "signal" ? 128 + 15 : null;
	let out = "";
	let err = "";
	const exit = await dispatch({
		rows,
		gates: opts.gates ?? "all",
		...(opts.voice && { voice: opts.voice }),
		ports: buildRepoPorts(dir, {
			staged: () => {
				stagedReads++;
				if (opts.stagedFails) throw new Error("git will not list them");
				return readStaged(dir);
			},
			...("route" in opts && {
				route: () => {
					if (opts.route instanceof Error) throw opts.route;
					return opts.route ?? null;
				},
			}),
			fact: (name: string) => opts.facts?.includes(name) ?? false,
			computed: (name: string) => {
				const list = opts.computed?.[name] ?? [];
				if (list instanceof Error) throw list;
				return list;
			},
			load: (r: StubRow) => {
				if (r.throws === "load") throw new Error(`${r.id} will not load`);
				return () => {
					ran.push(r.id);
					if (r.id === opts.signalIn) caught = 128 + 15;
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
			interrupted: async () => caught,
		}),
	});
	return { exit, ran, out, err, stagedReads };
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

	it("runs a pattern row on its computed list too, where no path matches the pattern", async () => {
		const rows = [
			row("budget", { arm: { pattern: /^docs\//, computed: "pool" } }),
		];
		const dir = repo({}, { "STYLE.md": "x\n" });
		expect(
			(await run(rows, { dir, computed: { pool: ["STYLE.md"] } })).ran,
		).toEqual(["budget"]);
		expect((await run(rows, { dir })).ran).toEqual([]);
		const docs = repo({}, { "docs/a.md": "x\n" });
		expect((await run(rows, { dir: docs })).ran).toEqual(["budget"]);
	});

	it("refuses as the row's BROKEN where its computed list cannot be read, so no row arms on a guess", async () => {
		const r = await run(
			[row("lister", { arm: { computed: "gone" } }), row("after")],
			{ computed: { gone: new Error("the lister is gone") } },
		);
		expect(r.exit).toBe(2);
		expect(r.err).toBe(
			"pre-commit: the lister gate could not load: the lister is gone\n",
		);
		expect(r.ran).toEqual([]);
	});

	it("goes on past a warn row whose computed list cannot be read, naming it", async () => {
		const r = await run(
			[
				row("lister", { arm: { computed: "gone" }, policy: "warn" }),
				row("after"),
			],
			{ computed: { gone: new Error("the lister is gone") } },
		);
		expect(r.exit).toBe(0);
		expect(r.err).toContain(
			"pre-commit: the lister gate could not load: the lister is gone\n",
		);
		expect(r.ran).toEqual(["after"]);
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

describe("a caught signal (#5188)", () => {
	it("lets the row it lands in finish, writing its output, and runs no row after", async () => {
		const r = await run([row("one"), row("hit"), row("after")], {
			signalIn: "hit",
		});
		expect(r.exit).toBe(128 + 15);
		expect(r.ran).toEqual(["one", "hit"]);
		expect(r.err).toBe(`one err\nhit err\n${STOPPED_LINE}`);
	});

	it("exits 128 + n where it lands in the last row, which passed", async () => {
		const r = await run([row("one"), row("last")], { signalIn: "last" });
		expect(r.exit).toBe(128 + 15);
		expect(r.ran).toEqual(["one", "last"]);
	});

	it("outranks the red of the row it lands in, and of a warn row", async () => {
		const red = await run([row("hit", { result: { exit: 1 } }), row("after")], {
			signalIn: "hit",
		});
		expect(red.exit).toBe(128 + 15);
		const warn = await run(
			[row("hit", { policy: "warn", result: { exit: 2 } }), row("after")],
			{ signalIn: "hit" },
		);
		expect(warn.exit).toBe(128 + 15);
		expect(warn.ran).toEqual(["hit"]);
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

	it.each([
		["drops a quiet row's pass", { exit: 0, stdout: "OK: 12 B\n" }, 0, ""],
		[
			"prints a quiet row's pass that WARNs",
			{ exit: 0, stdout: "OK: 12 B\n", stderr: "WARN: over cap\n" },
			0,
			"OK: 12 B\nWARN: over cap\n",
		],
		[
			"prints a quiet row's FAIL and refuses with its code",
			{ exit: 1, stderr: "FAIL: over cap\n" },
			1,
			"FAIL: over cap\n",
		],
		[
			"prints a quiet row's BROKEN and refuses with its code",
			{ exit: 2, stderr: "BROKEN: no git\n" },
			2,
			"BROKEN: no git\n",
		],
	])("%s", async (_name, result, exit, printed) => {
		const r = await run([row("budget", { quietPass: true, result })]);
		expect(r.exit).toBe(exit);
		expect(r.out + r.err).toBe(printed);
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

describe("a staged list git will not name", () => {
	const onPaths = row("a", { arm: { pattern: /./ } });

	it("refuses with exit 1 and the staged port's message, running no row", async () => {
		const r = await run([row("always"), onPaths], { stagedFails: "git" });
		expect(r.exit).toBe(1);
		expect(r.ran).toEqual([]);
		expect(r.err).toBe("pre-commit: git will not list them\n");
	});

	it("exits 128 + n, saying a signal stopped it, where one killed git", async () => {
		const r = await run([onPaths], { stagedFails: "signal" });
		expect(r.exit).toBe(128 + 15);
		expect(r.ran).toEqual([]);
		expect(r.err).toBe(STOPPED_LINE);
	});
});

/*
 * A hook other than pre-commit (#5207).
 */
describe("the staged port, read only where a row arms on a path", () => {
	it("never reads it where every row arms always", async () => {
		const r = await run([row("a"), row("b")], { stagedFails: "git" });
		expect(r.exit).toBe(0);
		expect(r.ran).toEqual(["a", "b"]);
		expect(r.stagedReads).toBe(0);
	});

	it("reads it once, before any row, where one row arms on a path", async () => {
		const r = await run([row("a"), row("docs", { arm: { pattern: /^d/ } })]);
		expect(r.ran).toEqual(["a"]);
		expect(r.stagedReads).toBe(1);
	});

	async function postCommit(
		rows: StubRow[],
		paths: Partial<Pick<Ports<StubRow>, "staged" | "computed" | "exists">> = {},
	) {
		const ran: string[] = [];
		let err = "";
		const exit = await dispatch({
			rows,
			gates: "all",
			voice: { hook: "post-commit", noun: "step" },
			ports: {
				...paths,
				load: (r: StubRow) => () => {
					ran.push(r.id);
					return { exit: 0, stdout: "", stderr: "" };
				},
				write: (fd: number, text: string) => {
					if (fd === 2) err += text;
				},
				interrupted: async () => null,
			},
		});
		return { exit, ran, err };
	}

	it("runs every always row where the hook passes no path port", async () => {
		expect(await postCommit([row("a"), row("b")])).toEqual({
			exit: 0,
			ran: ["a", "b"],
			err: "",
		});
	});

	it("refuses with exit 1, running no row, where a row arms on a path and the hook passes no staged port", async () => {
		expect(
			await postCommit([row("a"), row("docs", { arm: { pattern: /^d/ } })]),
		).toEqual({
			exit: 1,
			ran: [],
			err: "post-commit: a row arms on a path, and this hook passes no staged port\n",
		});
	});

	it("refuses with exit 1, running no row, where a row arms on a path and the hook passes no computed port", async () => {
		expect(
			await postCommit([row("a"), row("docs", { arm: { pattern: /^d/ } })], {
				staged: () => [],
				exists: () => true,
			}),
		).toEqual({
			exit: 1,
			ran: [],
			err: "post-commit: a row arms on a path, and this hook passes no computed port\n",
		});
	});
});

describe("route arming", () => {
	const rows = [
		row("unless-replay", { when: { unlessRoutes: ["replay"] } }),
		row("unless-replay-or-merge", {
			when: { unlessRoutes: ["replay", "merge"] },
		}),
		row("cherry-pick-only", { when: { routes: ["cherry-pick"] } }),
		row("any-route"),
	];

	it.each([
		["commit", ["unless-replay", "unless-replay-or-merge", "any-route"]],
		["merge", ["unless-replay", "any-route"]],
		["rebase", ["any-route"]],
		["cherry-pick", ["cherry-pick-only", "any-route"]],
	])("on a %s runs %j", async (route, ran) => {
		expect((await run(rows, { route })).ran).toEqual(ran);
	});

	it("stands every route-narrowed row down where the route will not read", async () => {
		expect((await run(rows, { route: null })).ran).toEqual(["any-route"]);
		expect((await run(rows, { route: new Error("no git dir") })).ran).toEqual([
			"any-route",
		]);
	});

	it("reads the post-commit stand-down set by name", async () => {
		const gated = [
			row("gated", { when: { unlessRoutes: ["post-commit-stand-down"] } }),
		];
		expect((await run(gated, { route: "bisect" })).ran).toEqual([]);
		expect((await run(gated, { route: "commit" })).ran).toEqual(["gated"]);
	});
});

describe("hook-fact arming", () => {
	const rows = [
		row("message", { when: { facts: ["message-given"] } }),
		row("no-stamp", { when: { unlessFacts: ["stamp-matches"] } }),
		row("both", {
			when: { facts: ["message-given"], unlessFacts: ["stamp-matches"] },
		}),
	];

	it.each([
		[[], ["no-stamp"]],
		[["message-given"], ["message", "no-stamp", "both"]],
		[["message-given", "stamp-matches"], ["message"]],
		[["stamp-matches"], []],
	])("with facts %j runs %j", async (facts, ran) => {
		expect((await run(rows, { facts })).ran).toEqual(ran);
	});

	it("names the hook and its noun in a crash line", async () => {
		const r = await run(
			[row("report", { policy: "warn", throws: "run" }), row("next")],
			{ voice: { hook: "post-commit", noun: "step" } },
		);
		expect(r.exit).toBe(0);
		expect(r.ran).toEqual(["report", "next"]);
		expect(r.err).toContain(
			"post-commit: the report step threw: report blew up\n",
		);
	});
});
