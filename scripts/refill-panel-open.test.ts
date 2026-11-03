// @vitest-environment node
/*
 * The panel's launcher (#3886): the config key decides whether an alias's call opens
 * anything, and a failed route falls through to the next, then to the printed command.
 * Broken, a view opens no panel, or a repo that never asked for one gets a pane.
 *
 * Most cases inject `run` and `detach`, so no test opens a pane in the terminal it runs
 * in; three cross the real spawn and PATH search, against a stub `tmux`. Every case injects
 * `wait`, so none takes the hold's real 5 seconds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellQuote } from "./lib/sh-quote.js";
import { main } from "./refill-panel-open.js";

interface Route {
	name: string;
	file: string;
	args: string[];
}

interface OpenOptions {
	env?: Record<string, string>;
	why?: (route: Route) => string | null;
	isAlive?: () => boolean;
	viewColumns?: number | null;
}

describe("refill-panel-open.js", () => {
	let root = "";
	let stdout = "";
	let stderr = "";
	let logged = "";
	let viewEnv: Record<string, string> = {};
	let detachStarts = true;
	const ran: Route[] = [];
	const detached: { routes: Route[]; pid: number }[] = [];
	const waits: number[] = [];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-open-"));
		fs.mkdirSync(path.join(root, ".claude"));
		ran.length = 0;
		detached.length = 0;
		waits.length = 0;
		stdout = "";
		stderr = "";
		logged = "";
		viewEnv = {};
		detachStarts = true;
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const setKey = (config: Record<string, unknown>) =>
		fs.writeFileSync(
			path.join(root, ".claude/workflow-core.json"),
			JSON.stringify({ contract: 1, ...config }),
		);

	const open = (
		argv: string[],
		{
			env = { TMUX: "/t" },
			why = () => null,
			isAlive = () => true,
			viewColumns = 156,
		}: OpenOptions = {},
	) =>
		main(argv, env, {
			root,
			isAlive,
			isOnPath: () => true,
			readViewEnv: () => viewEnv,
			readViewColumns: () => viewColumns,
			run: (route: Route) => {
				ran.push(route);
				return why(route);
			},
			detach: (routes: Route[], pid: number) => {
				detached.push({ routes, pid });
				return detachStarts;
			},
			appendLog: (text: string) => {
				logged += text;
			},
			wait: (ms: number) => {
				waits.push(ms);
			},
			out: (text: string) => {
				stdout += text;
			},
			err: (text: string) => {
				stderr += text;
			},
		});

	it.each([
		["absent", {}],
		["false", { refillPanel: false }],
	])("with --if-enabled and the key %s, opens nothing", (_name, config) => {
		setKey(config);
		expect(open(["--if-enabled", "42"])).toBe(0);
		expect(ran).toEqual([]);
		expect(stdout).toBe("");
		expect(waits).toEqual([]);
	});

	it("with --if-enabled and the key true, hands the routes on and runs none itself: #4080 (keys typed while the view waited were lost)", () => {
		setKey({ refillPanel: true });
		expect(open(["--if-enabled", "42"])).toBe(0);
		expect(ran).toEqual([]);
		expect(detached).toHaveLength(1);
		expect(detached[0]?.pid).toBe(42);
		expect(detached[0]?.routes.map((route) => route.name)).toEqual(["tmux"]);
	});

	it("by hand, opens the panel whatever the key says", () => {
		setKey({ refillPanel: false });
		expect(open(["42"])).toBe(0);
		expect(ran).toHaveLength(1);
	});

	it("takes the next route where the first fails, and names the failure", () => {
		const code = open(["42"], {
			env: { WSL_INTEROP: "/run/x", TMUX: "/t" },
			why: (route) => (route.file === "cmd.exe" ? "exit 1" : null),
		});
		expect(code).toBe(0);
		expect(ran.map((route) => route.file)).toEqual(["cmd.exe", "tmux"]);
		expect(stderr).toContain("the windows-terminal route failed: exit 1");
		expect(stdout).toBe("");
	});

	it("by hand with no route, prints the command and returns at once", () => {
		expect(open(["42"], { env: {} })).toBe(0);
		expect(ran).toEqual([]);
		expect(stdout).toContain("refill-panel.js");
		expect(stdout).toMatch(/ 42\n$/);
		expect(stderr).toBe("");
		expect(waits).toEqual([]);
	});

	it("by hand with every route failing, prints the command and returns at once", () => {
		expect(open(["42"], { why: () => "exit 1" })).toBe(0);
		expect(stdout).toMatch(/ 42\n$/);
		expect(waits).toEqual([]);
	});

	it("from a view start with no route, says why and holds the command on screen: #4066 (the view covered the printed command)", () => {
		setKey({ refillPanel: true });
		expect(open(["--if-enabled", "42"], { env: {} })).toBe(0);
		expect(stderr).toContain("no refill panel opened");
		expect(stderr).toContain("Windows Terminal under WSL");
		expect(stderr).toContain("cmd.exe and wt.exe on PATH");
		expect(stderr).toContain("or tmux");
		expect(stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(stdout).toMatch(/refill-panel\.js.* 42\n$/);
		expect(waits).toEqual([5000]);
	});

	it("from a view start where the detached copy will not start, runs the routes itself, then says why and holds", () => {
		setKey({ refillPanel: true });
		detachStarts = false;
		expect(open(["--if-enabled", "42"], { why: () => "exit 1" })).toBe(0);
		expect(ran.map((route) => route.name)).toEqual(["tmux"]);
		expect(stderr).toContain("the tmux route failed: exit 1");
		expect(stderr).toContain("no refill panel opened");
		expect(waits).toEqual([5000]);
	});

	it("the detached run takes the next route where the first fails, and logs the failure with its time", () => {
		const routes = [
			{ name: "windows-terminal", file: "cmd.exe", args: [] },
			{ name: "tmux", file: "tmux", args: [] },
		];
		const code = open(["--run-routes", JSON.stringify(routes), "42"], {
			why: (route) => (route.file === "cmd.exe" ? "exit 1" : null),
		});
		expect(code).toBe(0);
		expect(ran.map((route) => route.file)).toEqual(["cmd.exe", "tmux"]);
		expect(logged).toMatch(
			/^\d{4}-\d\d-\d\dT\S+ refill-panel-open: the windows-terminal route failed: exit 1\n$/,
		);
		expect(stderr).toBe("");
		expect(stdout).toBe("");
		expect(waits).toEqual([]);
	});

	it("the detached run with every route failing logs the command, and holds nothing", () => {
		const routes = [{ name: "tmux", file: "tmux", args: [] }];
		const code = open(["--run-routes", JSON.stringify(routes), "42"], {
			why: () => "exit 1",
		});
		expect(code).toBe(0);
		expect(logged).toContain("the tmux route failed: exit 1");
		expect(logged).toMatch(
			/no refill panel opened; run: .*refill-panel\.js.* 42\n$/,
		);
		expect(stderr).toBe("");
		expect(stdout).toBe("");
		expect(waits).toEqual([]);
	});

	it("from a view start with a route to try, neither waits nor says more", () => {
		setKey({ refillPanel: true });
		expect(open(["--if-enabled", "42"])).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toBe("");
		expect(waits).toEqual([]);
	});

	it("from a view start with the pid gone, neither waits nor says anything", () => {
		setKey({ refillPanel: true });
		expect(open(["--if-enabled", "42"], { isAlive: () => false })).toBe(0);
		expect(stderr).toBe("");
		expect(waits).toEqual([]);
	});

	it("opens nothing for a pid already gone", () => {
		expect(open(["42"], { isAlive: () => false })).toBe(0);
		expect(ran).toEqual([]);
		expect(stdout).toBe("");
	});

	it("takes its routes from the view's environment, not the caller's", () => {
		viewEnv = { TMUX: "/view", TMUX_PANE: "%3" };
		expect(open(["42"], { env: {} })).toBe(0);
		expect(ran[0]?.args.slice(0, 3)).toEqual(["split-window", "-t", "%3"]);
	});

	it("with the key off, stays quiet whatever pid it is given", () => {
		setKey({});
		expect(open(["--if-enabled", ""])).toBe(0);
		expect(stderr).toBe("");
	});

	it("refuses a malformed pid", () => {
		expect(open(["abc"])).toBe(2);
		expect(stderr).toContain("not a pid: abc");
		expect(ran).toEqual([]);
	});

	it("crosses the real spawn and PATH search to a stub tmux", () => {
		const bin = path.join(root, "bin");
		const seen = path.join(root, "seen");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "tmux"),
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(seen)}\n`,
			{ mode: 0o755 },
		);
		const code = main(
			[String(process.pid)],
			{ TMUX: "/t", PATH: `${bin}${path.delimiter}${process.env.PATH}` },
			{ readViewEnv: () => ({}), readViewColumns: () => 156 },
		);
		expect(code).toBe(0);
		const words = fs.readFileSync(seen, "utf8").trim().split("\n");
		expect(words.slice(0, 2)).toEqual(["split-window", "-h"]);
		expect(words.slice(-2)).toEqual([String(process.pid), "tmux"]);
	});

	it("from a view start, returns before a real route finishes, and that route's failure reaches only the log: #4080 (keys typed while the view waited were lost)", async () => {
		setKey({ refillPanel: true });
		const bin = path.join(root, "bin");
		const release = path.join(root, "release");
		const seen = path.join(root, "seen");
		const log = path.join(root, ".refill-loop.log");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "tmux"),
			`#!/bin/sh\nwhile [ ! -e ${shellQuote(release)} ]; do sleep 0.05; done\n: > ${shellQuote(seen)}\nexit 7\n`,
			{ mode: 0o755 },
		);
		/* A guess, generous for a loaded machine: it bounds only a failure's wait. */
		const logTimeoutMs = 15_000;
		const code = main(
			["--if-enabled", String(process.pid)],
			{
				TMUX: "/t",
				WFC_REFILL_DIR: root,
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
			},
			{
				root,
				readViewEnv: () => ({}),
				readViewColumns: () => 156,
				out: (text: string) => {
					stdout += text;
				},
				err: (text: string) => {
					stderr += text;
				},
			},
		);
		expect(code).toBe(0);
		expect(fs.existsSync(seen)).toBe(false);
		fs.writeFileSync(release, "");
		await expect
			.poll(() => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""), {
				timeout: logTimeoutMs,
			})
			.toContain("no refill panel opened; run: ");
		expect(fs.existsSync(seen)).toBe(true);
		expect(fs.readFileSync(log, "utf8")).toContain(
			"the tmux route failed: exit 7",
		);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("from a view start with a log that will not open, still runs the route", async () => {
		setKey({ refillPanel: true });
		const bin = path.join(root, "bin");
		const seen = path.join(root, "seen");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "tmux"),
			`#!/bin/sh\n: > ${shellQuote(seen)}\n`,
			{ mode: 0o755 },
		);
		const unopenable = path.join(root, "seen-parent-is-a-file");
		fs.writeFileSync(unopenable, "");
		const code = main(
			["--if-enabled", String(process.pid)],
			{
				TMUX: "/t",
				WFC_REFILL_DIR: path.join(unopenable, "x"),
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
			},
			{ root, readViewEnv: () => ({}), readViewColumns: () => 156 },
		);
		expect(code).toBe(0);
		await expect
			.poll(() => fs.existsSync(seen), { timeout: 15_000 })
			.toBe(true);
	});

	it("sizes the split from the view's width, and says where that will not read", () => {
		const sizeOfRun = () => {
			const { args } = ran.at(-1) as Route;
			return args[args.indexOf("--size") + 1];
		};
		const env = { WSL_INTEROP: "/run/x" };
		expect(open(["42"], { env, viewColumns: 206 })).toBe(0);
		expect(sizeOfRun()).toBe("0.2");
		expect(stderr).toBe("");
		expect(open(["42"], { env, viewColumns: null })).toBe(0);
		expect(sizeOfRun()).toBe("0.2625");
		expect(stderr).toContain("the view's width did not read");
	});
});
