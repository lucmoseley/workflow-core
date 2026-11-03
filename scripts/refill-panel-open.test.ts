// @vitest-environment node
/*
 * The panel's launcher (#3886): the config key decides whether an alias's call opens
 * anything, and a failed route falls through to the next, then to the printed command.
 * Broken, a view opens no panel, or a repo that never asked for one gets a pane.
 *
 * Most cases inject `run`, so no test opens a pane in the terminal it runs in; one
 * crosses the real spawn and PATH search, against a stub `tmux`.
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
	let viewEnv: Record<string, string> = {};
	const ran: Route[] = [];
	const waits: number[] = [];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-open-"));
		fs.mkdirSync(path.join(root, ".claude"));
		ran.length = 0;
		waits.length = 0;
		stdout = "";
		stderr = "";
		viewEnv = {};
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

	it("with --if-enabled and the key true, opens the panel", () => {
		setKey({ refillPanel: true });
		expect(open(["--if-enabled", "42"])).toBe(0);
		expect(ran.map((route) => route.name)).toEqual(["tmux"]);
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

	it("from a view start with no route, says why and holds the command on screen", () => {
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

	it("from a view start with every route failing, says why after each failure", () => {
		setKey({ refillPanel: true });
		expect(open(["--if-enabled", "42"], { why: () => "exit 1" })).toBe(0);
		expect(stderr.indexOf("the tmux route failed: exit 1")).toBeGreaterThan(-1);
		expect(stderr.indexOf("no refill panel opened")).toBeGreaterThan(
			stderr.indexOf("the tmux route failed"),
		);
		expect(stdout).toMatch(/ 42\n$/);
		expect(waits).toEqual([5000]);
	});

	it("from a view start with a route that opens, neither waits nor says more", () => {
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
