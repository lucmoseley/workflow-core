// @vitest-environment node
/*
 * The `disabled` switch (#2): every guard `self-plugin/hooks/hooks.json` wires stands
 * down — exit 0, nothing on stdout, nothing read — where the host's
 * `.claude/workflow-core.json` lists its file name under "disabled" — or, for
 * an entry over a dispatcher core, that core's row name in
 * lib/guard-cores.json, which silences both routes at once — and runs where
 * the list names only some other guard.
 *
 * "Ran" means got past the switch to its payload read — not that it judged —
 * read off a trace the guard leaves when fed an unparseable payload:
 * a shell guard's fail-open record under CLAUDE_CONFIG_DIR, and for a JS guard
 * a preload that marks stdin being read. Spawned rather than run in-process
 * (scripts/lib/run-in-process.js): the shell guards need a real process, and
 * the JS preload needs a real fd 0.
 *
 * The switch is the one way a host turns off a guard the plugin ships it
 * (`hooks/hooks.json`) short of forking the core: break it and a disabled guard
 * keeps refusing that host's tool calls, or a guard the host still wants stands
 * down with nothing said.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const { CONTRACT } = require("./lib/workflow-core-config.js");

const GUARDS = [
	...new Set(
		fs
			.readFileSync(path.join(REPO, "self-plugin/hooks/hooks.json"), "utf8")
			.match(/scripts\/guard-[a-z0-9-]+\.(?:sh|js)/g) ?? [],
	),
].sort();

const ROWS = new Set(
	(
		Object.values(require("./lib/guard-cores.json")).flat() as {
			name: string;
		}[]
	).map((r) => r.name),
);
const disabledName = (guard: string) => {
	const row = path.basename(guard, ".js");
	return ROWS.has(row) ? row : path.basename(guard);
};

let host: string;
let home: string;
let shim: string;
let readMark: string;

beforeEach(() => {
	host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "disabled-")));
	home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "disabled-home-")),
	);
	execFileSync("git", ["init", "-q", host]);
	readMark = path.join(home, "stdin-read");
	shim = path.join(home, "stdin-shim.cjs");
	fs.writeFileSync(
		shim,
		`const fs = require("node:fs");
const read = fs.readFileSync;
fs.readFileSync = function (f, ...rest) {
	if (f === 0) fs.writeFileSync(${JSON.stringify(readMark)}, "");
	return read.call(fs, f, ...rest);
};
`,
	);
});

afterEach(() => {
	fs.rmSync(host, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
});

function run(guard: string, disabled: string[], contract = CONTRACT) {
	fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(host, ".claude/workflow-core.json"),
		JSON.stringify({ contract, disabled }),
	);
	const file = path.join(REPO, guard);
	const js = guard.endsWith(".js");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_PROJECT_DIR: host,
		CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
		HOME: home,
	};
	delete env.CLAUDE_CODE_SESSION_ID;
	const r = spawnSync(js ? "node" : file, js ? ["--require", shim, file] : [], {
		cwd: host,
		input: "not json",
		encoding: "utf8",
		env,
		timeout: 30_000,
	});
	const logs = path.join(home, ".claude/projects");
	const ran = js ? fs.existsSync(readMark) : fs.existsSync(logs);
	return { status: r.status, stdout: r.stdout, ran };
}

describe("the disabled switch", () => {
	it("finds the wired guards", () => {
		// 25 JS guards wired once #3224 and #3225 moved batches 1 and 2,
		// six each, into guard-dispatch.js's cores.
		expect(GUARDS.length).toBeGreaterThanOrEqual(25);
	});

	describe.each(GUARDS)("%s", (guard) => {
		const base = disabledName(guard);

		it("stands down where the host disables it", () => {
			expect(run(guard, [base])).toEqual({ status: 0, stdout: "", ran: false });
		});

		it("runs where the host disables another guard", () => {
			expect(run(guard, ["guard-none.sh"]).ran).toBe(true);
		});

		it("runs where the config declares a contract this core does not read", () => {
			expect(run(guard, [base], CONTRACT + 1).ran).toBe(true);
		});
	});
});
