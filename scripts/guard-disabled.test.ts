// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, emptyRepoTemplate } from "./lib/git-fixture";

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

const emptyRepo = defineTemplate(emptyRepoTemplate);

let host: string;
let home: string;
let shim: string;
let readMark: string;

beforeEach(() => {
	host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "disabled-")));
	home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "disabled-home-")),
	);
	emptyRepo.instantiate(host);
	readMark = path.join(home, "stdin-read");
	shim = path.join(home, "stdin-shim.cjs");
	fs.writeFileSync(
		shim,
		`const fs = require("node:fs");
for (const name of ["readFileSync", "readSync"]) {
	const read = fs[name];
	fs[name] = function (f, ...rest) {
		if (f === 0) fs.writeFileSync(${JSON.stringify(readMark)}, "");
		return read.call(fs, f, ...rest);
	};
}
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
	delete env.WFC_REPO_ROOT;
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
		expect(GUARDS.length).toBeGreaterThanOrEqual(13);
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
