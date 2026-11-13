// @vitest-environment node
/*
 * The pre-commit dispatcher through the real hook line (#5172): the
 * `node …/precommit-dispatch.js "$@" || exit "$?"` line of .husky/pre-commit,
 * under hook-bound.sh's wrapper as the hook runs it, over a throwaway repo
 * whose every registry row is a stub checker (WFC_SCRIPT_ROOT). It proves
 * what only the process can: the code the hook exits with, the `--gates=`
 * pass-through, a row's report reaching the hook's own streams, and a
 * dispatcher that cannot start refusing the commit.
 *
 * The core's policy over stub rows is scripts/lib/precommit-dispatch.test.ts.
 *
 * spawn-kept: the hook line is a real `sh` running a real Node process.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import {
	coreCall,
	HOOK,
	HOOK_BOUND_LIB,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";

const temps = registerTempCleanup();

const LINE = `${coreCall("node", "scripts/precommit-dispatch.js")} "$@" || exit "$?"`;

/*
 * One stub per row, a checker and a program at once: it logs its load, then acts as STUB_ACT names it —
 * `fail` FAILs where the commit stages `red`, `broken` is BROKEN, `throw`
 * will not load, `signal` kills the process — else passes.
 */
const STUB = `const fs = require("node:fs");
const path = require("node:path");
const check = require(${JSON.stringify(path.join(ROOT, "scripts", "lib", "check.js"))});
const id = path.basename(__filename, ".js");
const act = (process.env.STUB_ACT ?? "").split(",").find((a) => a.startsWith(id + ":"))?.split(":")[1];
if (!process.env.WFC_CHECK_SIDE) fs.appendFileSync(process.env.STUB_LOG, id + "\\n");
if (act === "throw") throw new Error(id + " will not load");
if (act === "signal") process.kill(process.pid, "SIGTERM");
const SPEC = {
	name: id,
	usage: id,
	flags: ${JSON.stringify([...new Set(GATES.flatMap((g) => g.args.filter((a) => a.startsWith("--") && a !== "--against" && a !== "--index")))])},
	against: { profile: "jsonl-reads", materialise: "tree" },
	run(ctx) {
		if (act === "broken") ctx.broken(id + " is broken");
		if (act === "fail" && fs.existsSync(path.join(ctx.value("--root") ?? ".", "red")))
			ctx.fail("STUB", id + " fault");
		return { okLine: id + " ok" };
	},
};
const PROGRAM = ({ cwd }) => {
	if (act === "broken") return { exit: 2, stdout: "", stderr: id + " is broken\\n" };
	if (act === "fail" && fs.existsSync(path.join(cwd, "red")))
		return { exit: 1, stdout: "", stderr: id + " fault\\n" };
	return { exit: 0, stdout: "", stderr: "" };
};
module.exports = { SPEC, PROGRAM };
if (require.main === module) check.runCheck(SPEC);
`;

/** A core holding a stub for every row, and a repo staging `staged`. */
function fixture(staged: Record<string, string>) {
	const { root } = stagedRepo("precommit-dispatch-", temps, {}, {});
	const core = path.join(root, ".stub-core");
	for (const g of GATES) {
		fs.mkdirSync(path.dirname(path.join(core, g.script)), { recursive: true });
		fs.writeFileSync(path.join(core, g.script), STUB);
	}
	fs.writeFileSync(
		path.join(root, ".git", "info", "exclude"),
		".stub-core/\nload.log\n",
	);
	for (const [rel, body] of Object.entries(staged)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), body);
		spawnSync("git", ["add", "--", rel], { cwd: root });
	}
	return { root, core };
}

function hook(
	staged: Record<string, string>,
	opts: {
		args?: string[];
		act?: string;
		pluginRoot?: string;
		config?: object;
	} = {},
) {
	const { root, core } = fixture(staged);
	if (opts.config) {
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify(opts.config),
		);
	}
	const log = path.join(root, "load.log");
	/* The suite pins the pool through WFC_ALWAYS_LOADED; a case declaring its
	 * own config drops it, so the config is what the dispatcher reads. */
	const { WFC_ALWAYS_LOADED: _pool, ...inherited } = process.env;
	const r = spawnSync(
		"sh",
		["-ec", `${HOOK_BOUND_LIB}\n${LINE}`, "pre-commit", ...(opts.args ?? [])],
		{
			cwd: root,
			encoding: "utf8",
			env: {
				...(opts.config ? inherited : process.env),
				GITHUB_ACTIONS: "",
				WFC_PLUGIN_ROOT: opts.pluginRoot ?? ROOT,
				WFC_SCRIPT_ROOT: core,
				CLAUDE_PROJECT_DIR: root,
				STUB_ACT: opts.act ?? "",
				STUB_LOG: log,
			},
		},
	);
	const loaded = fs.existsSync(log)
		? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
		: [];
	return { code: r.status, out: r.stdout, err: r.stderr, loaded };
}

/** Staged `p` arms these rows, by each row's own arm. */
const SCRIPT = { "scripts/a.js": "x\n" };
const armedBy = (p: string, sets: string[]) =>
	GATES.filter(
		(g) =>
			sets.includes(g.lander) &&
			("always" in g.arm || ("pattern" in g.arm && g.arm.pattern.test(p))),
	).map((g) => path.basename(g.script, ".js"));
const ALL = armedBy("scripts/a.js", ["every", "merge", "batch", "none"]);

describe("the hook's dispatcher line", () => {
	it("is in .husky/pre-commit, once", () => {
		expect(HOOK.split("\n").filter((l) => l === LINE)).toHaveLength(1);
	});

	it("exits 0 where every armed row passes, loading them in registry order", () => {
		const r = hook(SCRIPT);
		expect(r.code).toBe(0);
		expect(ALL.length).toBeGreaterThan(3);
		expect(r.loaded).toEqual(ALL);
	});

	it("loads only the always rows where no path arms one", () => {
		const r = hook({ "lib/page.tsx": "x\n" });
		expect(r.code).toBe(0);
		expect(r.loaded).toEqual(
			armedBy("lib/page.tsx", ["every", "merge", "batch", "none"]),
		);
		expect(r.loaded.length).toBeGreaterThan(0);
	});

	it("arms a computed row on the pool the host config declares", () => {
		const pooled = GATES.filter((g) => "computed" in g.arm).map((g) =>
			path.basename(g.script, ".js"),
		);
		const r = hook(
			{ "STYLE.md": "x\n" },
			{ config: { alwaysLoaded: ["STYLE.md"] } },
		);
		expect(pooled.length).toBeGreaterThan(0);
		expect(r.code).toBe(0);
		expect(r.loaded).toEqual([
			...armedBy("STYLE.md", ["every", "merge", "batch", "none"]),
			...pooled,
		]);
	});

	it("exits 1 on a member's FAIL, its report on stderr, and loads nothing after", () => {
		/* An --against row, whose report names each fault the commit adds. */
		const at = ALL.findIndex((id) =>
			GATES.some(
				(g) => g.script === `scripts/${id}.js` && g.args[0] === "--against",
			),
		);
		const red = ALL[at] ?? "";
		const r = hook({ ...SCRIPT, red: "x\n" }, { act: `${red}:fail` });
		expect(at).toBeGreaterThan(0);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`${red} fault`);
		expect(r.loaded).toEqual(ALL.slice(0, at + 1));
	});

	it("exits with a program row's own code, its report on stderr", () => {
		const program = GATES.find((g) => g.kind === "program");
		const id = path.basename(program?.script ?? "", ".js");
		const r = hook({ ...SCRIPT, red: "x\n" }, { act: `${id}:fail` });
		expect(r.code).toBe(1);
		expect(r.err).toContain(`${id} fault`);
		expect(r.loaded).toEqual(ALL.slice(0, ALL.indexOf(id) + 1));
	});

	it("exits 2 on a member's BROKEN", () => {
		const r = hook(SCRIPT, { act: `${ALL[1]}:broken` });
		expect(r.code).toBe(2);
		expect(r.err).toContain(`${ALL[1]} is broken`);
	});

	it("exits 0 past a warn row's BROKEN, its report on stderr, loading every row after", () => {
		const warn = GATES.find((g) => g.policy === "warn");
		const id = path.basename(warn?.script ?? "", ".js");
		const r = hook(SCRIPT, { act: `${id}:broken` });
		expect(ALL).toContain(id);
		expect(r.code).toBe(0);
		expect(r.err).toContain(`${id} is broken`);
		expect(r.loaded).toEqual(ALL);
	});

	it("exits 2 on a member that will not load, naming its row", () => {
		const id = ALL[0] ?? "";
		const row = GATES.find((g) => g.script === `scripts/${id}.js`);
		const r = hook(SCRIPT, { act: `${id}:throw` });
		expect(r.code).toBe(2);
		expect(r.err).toContain(
			`pre-commit: the ${row?.id} gate could not load: ${id} will not load`,
		);
	});

	it("exits 128 + n where a member's signal kills the dispatcher", () => {
		const r = hook(SCRIPT, { act: `${ALL[0]}:signal` });
		expect(r.code).toBe(128 + 15);
	});

	it.each([
		["--gates=merge", ["every", "merge"]],
		["--gates=batch", ["every", "batch"]],
	])("passes %s through, running that lander set", (arg, sets) => {
		const r = hook(SCRIPT, { args: [arg] });
		expect(r.code).toBe(0);
		expect(r.loaded).toEqual(armedBy("scripts/a.js", sets));
	});

	it("refuses the commit where the dispatcher cannot start", () => {
		const empty = path.join(fixture({}).root, "no-plugin");
		fs.mkdirSync(empty);
		const r = hook(SCRIPT, { pluginRoot: empty });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("precommit-dispatch.js");
	});
});
