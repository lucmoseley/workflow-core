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
 * Breaking it costs the hook's own contract: a dispatcher whose exit the
 * hook drops lets every red gate's commit through.
 *
 * spawn-kept: the hook line is a real `sh` running a real Node process.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { STOPPED_LINE } from "./lib/precommit-dispatch.js";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import {
	coreCall,
	type GateRow,
	HOOK,
	HOOK_BOUND_LIB,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";
import { isDead } from "./lib/process-fixture";
import { escapeRe } from "./lib/regex-group.js";

const temps = registerTempCleanup();

const LINE = `${coreCall("node", "scripts/precommit-dispatch.js")} "$@" || exit "$?"`;

/*
 * One stub per row, a checker and a program at once: it logs its load, then acts as STUB_ACT names it —
 * `fail` FAILs where the commit stages `red`, `broken` is BROKEN, `throw`
 * will not load, `signal` signals the dispatcher, `hang` signals it twice and
 * never returns, `scratch` makes a scratch directory and waits on a child
 * that writes the dispatcher's pid to `ready` before it sleeps, removing the
 * directory in a `finally` — else passes.
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
	if (act === "hang") {
		process.kill(process.pid, "SIGTERM");
		return new Promise(() => {
			setInterval(() => {}, 1000);
			setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
		});
	}
	if (act === "scratch") {
		const scratch = path.join(cwd, "scratch-" + id);
		fs.mkdirSync(scratch);
		try {
			require("node:child_process").spawnSync("sh", [
				"-c",
				'echo "$1" > "$2"; exec sleep 30',
				"sh",
				String(process.pid),
				path.join(cwd, "ready"),
			]);
		} finally {
			fs.rmSync(scratch, { recursive: true });
		}
	}
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
		".stub-core/\nload.log\nready\nscratch-*/\n",
	);
	for (const [rel, body] of Object.entries(staged)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), body);
		spawnSync("git", ["add", "--", rel], { cwd: root });
	}
	return { root, core };
}

interface HookOpts {
	args?: string[];
	act?: string;
	pluginRoot?: string;
	config?: object;
	env?: Record<string, string>;
}

/** The hook line's command over a fresh fixture, and where it logs. */
function hookCall(staged: Record<string, string>, opts: HookOpts) {
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
	return {
		root,
		log,
		args: [
			"-ec",
			`${HOOK_BOUND_LIB}\n${LINE}`,
			"pre-commit",
			...(opts.args ?? []),
		],
		options: {
			cwd: root,
			env: {
				...(opts.config ? inherited : process.env),
				GITHUB_ACTIONS: "",
				WFC_PLUGIN_ROOT: opts.pluginRoot ?? ROOT,
				WFC_SCRIPT_ROOT: core,
				CLAUDE_PROJECT_DIR: root,
				STUB_ACT: opts.act ?? "",
				STUB_LOG: log,
				...opts.env,
			},
		},
	};
}

/** What the fixture holds once the hook is done: scratch left, rows loaded. */
function left(root: string, log: string) {
	const scratch = fs.readdirSync(root).filter((n) => n.startsWith("scratch-"));
	const loaded = fs.existsSync(log)
		? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
		: [];
	return { loaded, scratch };
}

function hook(staged: Record<string, string>, opts: HookOpts = {}) {
	const { root, log, args, options } = hookCall(staged, opts);
	const r = spawnSync("sh", args, { ...options, encoding: "utf8" });
	return {
		code: r.status,
		out: r.stdout,
		err: r.stderr,
		...left(root, log),
	};
}

/**
 * The hook, its process group sent `signal` once the stub row `id` holds its
 * scratch, as a Ctrl-C reaches every process in the terminal's foreground
 * group; answered once the dispatcher, in a group of its own, has exited.
 */
/* Every row before the signalled one runs first, each a Node load; a first
 * guess at a loaded machine's worst, unmeasured. */
const READY_MS = 20_000;

async function hookSignalled(id: string, signal: NodeJS.Signals) {
	const { root, log, args, options } = hookCall(SCRIPT, {
		act: `${id}:scratch`,
	});
	// spawn-kept: a signal, sent to the hook's process group mid-row
	const sh = spawn("sh", args, {
		...options,
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let err = "";
	sh.stderr.on("data", (d) => {
		err += d;
	});
	/* Closed once every holder is gone, the dispatcher outliving the shell. */
	const closed = new Promise((resolve) => sh.stderr.on("close", resolve));
	const ended = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => sh.on("exit", (code, sig) => resolve({ code, signal: sig })),
	);
	const ready = path.join(root, "ready");
	await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), {
		timeout: READY_MS,
		interval: 50,
	});
	const dispatcher = Number(fs.readFileSync(ready, "utf8"));
	process.kill(-(sh.pid ?? 0), signal);
	const shell = await ended;
	/* The first guess at a slow machine's exit, unmeasured; a dispatcher that
	 * waits out its row's 30 s sleep is far past it. */
	await vi.waitFor(() => expect(isDead(dispatcher)).toBe(true), {
		timeout: 10_000,
		interval: 50,
	});
	await closed;
	return { shell, err, ...left(root, log) };
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

	/* A row's check called from the hook as well, with the row's own
	 * arguments, runs twice, its second process paying the startup the
	 * dispatcher exists to share (#5194). Another mode of the same script,
	 * such as check-vendored-skills.js --covered, is a different check. */
	/* The non-comment lines of `text` calling `row`'s script with exactly its
	 * args: a further argument word makes another mode, anything else (an
	 * operator, a redirection, a closing quote, the line's end) does not. */
	const callsOfRow = (row: GateRow, text: string) => {
		const call = new RegExp(
			`${escapeRe([row.script, ...row.args].join(" "))}(?![\\w./-]|\\s+[^\\s|&;<>)\\\\])`,
		);
		return text
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#") && call.test(l));
	};

	it("is the hook's only caller of a row's check", () => {
		for (const g of GATES) expect(callsOfRow(g, HOOK), g.id).toEqual([]);
	});

	it("finds a row's own call however it ends, and not another mode", () => {
		const margin = GATES.find((g) => g.id === "injector-margin");
		const skills = GATES.find(
			(g) => g.script === "scripts/check-vendored-skills.js",
		);
		if (!margin || !skills) throw new Error("a row this case reads is gone");
		const at = (tail: string) =>
			callsOfRow(
				margin,
				`node scripts/check-injector-margin.js --index${tail}`,
			);
		for (const tail of [
			' || exit "$?"',
			" && :",
			" | cat",
			" >log",
			")",
			" \\",
			"",
		])
			expect(at(tail), tail).toHaveLength(1);
		expect(at(" --json")).toEqual([]);
		expect(at("x")).toEqual([]);
		expect(
			callsOfRow(
				skills,
				`'node scripts/check-vendored-skills.js --covered "$sg_dir"' ""`,
			),
		).toEqual([]);
		expect(
			callsOfRow(margin, "# node scripts/check-injector-margin.js --index"),
		).toEqual([]);
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
		const pooled = GATES.filter(
			(g) => "computed" in g.arm && g.arm.computed === "always-loaded-pool",
		).map((g) => path.basename(g.script, ".js"));
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

	it("arms the rule-fragments row on a source its generator scans", () => {
		const source = "docs/agents/issue-tracker.md";
		const r = hook({ [source]: "x\n" });
		expect(r.code).toBe(0);
		expect(r.loaded).toContain("generate-rule-fragments");
		expect(armedBy(source, ["every", "merge", "batch", "none"])).not.toContain(
			"generate-rule-fragments",
		);
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
		const id =
			ALL.find((n) =>
				GATES.some(
					(g) => g.kind === "program" && g.script === `scripts/${n}.js`,
				),
			) ?? "";
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

	it("exits 128 + n where a member signals the dispatcher, loading no row after it (#5188)", () => {
		const r = hook(SCRIPT, { act: `${ALL[0]}:signal` });
		expect(r.code).toBe(128 + 15);
		expect(r.loaded).toEqual([ALL[0]]);
		expect(r.err).toContain(STOPPED_LINE);
	});

	it("lets the row a group signal lands in clean its scratch, runs no row after, and exits 128 + n (#5188)", async () => {
		const at = ALL.findIndex((n) =>
			GATES.some((g) => g.kind === "program" && g.script === `scripts/${n}.js`),
		);
		const r = await hookSignalled(ALL[at] ?? "", "SIGINT");
		expect(at).toBeGreaterThan(-1);
		/* The shell takes the group's SIGINT itself, so its own death is the
		 * hook's code; the dispatcher's 128 + n is the case above's. */
		expect(r.shell.signal ?? r.shell.code).toBe(
			r.shell.signal ? "SIGINT" : 128 + 2,
		);
		expect(r.scratch).toEqual([]);
		expect(r.loaded).toEqual(ALL.slice(0, at + 1));
		expect(r.err).toContain(STOPPED_LINE);
	});

	it("exits 128 + n at once on a second signal to a row that never returns (#5188)", () => {
		const at = ALL.findIndex((n) =>
			GATES.some((g) => g.kind === "program" && g.script === `scripts/${n}.js`),
		);
		const r = hook(SCRIPT, { act: `${ALL[at]}:hang` });
		expect(r.code).toBe(128 + 15);
		expect(r.loaded).toEqual(ALL.slice(0, at + 1));
	});

	it("exits 128 + n where a signal kills git as it names the staged paths (#5188)", () => {
		const { root } = fixture({});
		const git = path.join(root, "git-signals-parent");
		fs.writeFileSync(git, "#!/bin/sh\nkill -TERM $PPID\nkill -TERM $$\n", {
			mode: 0o755,
		});
		const r = hook(SCRIPT, { env: { WFC_GIT: git } });
		expect(r.code).toBe(128 + 15);
		expect(r.loaded).toEqual([]);
		expect(r.err).toContain(STOPPED_LINE);
	});

	it.each([
		["exits non-zero", "exit 1", "could not read this commit's staged paths"],
		[
			"breaks its list off mid-entry",
			"printf 'M\\000a.txt\\000D'",
			"git's staged path list broke off mid-entry",
		],
	])(
		"refuses with exit 1, running no row, where git %s naming the staged paths",
		(_, body, says) => {
			const { root } = fixture({});
			const git = path.join(root, "git-will-not-list");
			fs.writeFileSync(git, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
			const r = hook(SCRIPT, { env: { WFC_GIT: git } });
			expect(r.code).toBe(1);
			expect(r.loaded).toEqual([]);
			expect(r.err).toContain(`pre-commit: ${says}`);
		},
	);

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
