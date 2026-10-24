// @vitest-environment node
/*
 * Pins typecheck-mods.js (#1960), run end to end on a fixture tree: the newest
 * unpacked plugin-authoring skill's declarations reach each mod, a mod's
 * newer copy is kept, each pass type-checks against the copy and fails on a
 * type error, and with no skill unpacked every pass is skipped, warned, exit
 * 0. Loosen a case and the typecheck either runs a pass against stale engine
 * types or fails on a machine — CI's — that simply has no skill unpacked.
 *
 * The passes spawn the real tsc, whose verdict is what the program reports, so
 * the file runs five tsc processes and exceeds §X8's 10 s budget under load:
 * a stubbed tsc would leave the copy unproven as something tsc reads.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "typecheck-mods.js");
const DELIVERY = ".claude/skills/wfc-delivery";
const LIVENESS = ".claude/skills/wfc-liveness";
const ENGINE = ".claude-plugin/types/claude-code/index.d.ts";

let dir: string;
let repo: string;
let tmp: string;

const write = (file: string, body: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
};

const declarations = (version: string) =>
	`// Written by Claude Code ${version}.\ndeclare const ENGINE: number;\n`;

function unpack(version: string) {
	write(
		path.join(
			tmp,
			`claude-${os.userInfo().uid}`,
			"bundled-skills",
			version,
			"abc",
			"plugin-authoring/types/claude-code.d.ts",
		),
		declarations(version),
	);
}

function project(folder: string, types: string, source = "ENGINE") {
	write(
		path.join(repo, folder, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { noEmit: true, types: [], strict: true },
			include: [types, "a.ts"],
		}),
	);
	write(
		path.join(repo, folder, "a.ts"),
		`export const n: number = ${source};\n`,
	);
}

const copied = (mod: string) =>
	fs.readFileSync(path.join(repo, mod, ENGINE), "utf8").split("\n")[0];

const run = () =>
	runInProcess(SCRIPT, [], {
		cwd: repo,
		env: { ...process.env, CLAUDE_CODE_TMPDIR: tmp },
	});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "typecheck-mods-"));
	repo = path.join(dir, "repo");
	tmp = path.join(dir, "tmp");
	for (const mod of [DELIVERY, LIVENESS]) project(mod, ".claude-plugin/types");
	project("hooks", "../.claude/skills/wfc-liveness/.claude-plugin/types");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("typecheck-mods", () => {
	it("copies the newest unpacked skill into a mod holding none or an older copy, keeps a newer one, and type-checks every pass", () => {
		unpack("2.1.289");
		unpack("2.1.296");
		// A newer build that never unpacked the skill holds no declarations.
		fs.mkdirSync(
			path.join(
				tmp,
				`claude-${os.userInfo().uid}`,
				"bundled-skills",
				"2.1.300",
				"def",
			),
			{ recursive: true },
		);
		write(path.join(repo, DELIVERY, ENGINE), declarations("2.1.302"));
		const r = run();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(copied(DELIVERY)).toBe("// Written by Claude Code 2.1.302.");
		expect(copied(LIVENESS)).toBe("// Written by Claude Code 2.1.296.");
	});

	it("fails where a pass has a type error, skipping a mod with no copy and running the rest", () => {
		write(path.join(repo, LIVENESS, ENGINE), declarations("2.1.296"));
		project(
			"hooks",
			"../.claude/skills/wfc-liveness/.claude-plugin/types",
			'"text"',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("hooks/a.ts");
		expect(r.stderr).toBe(
			`typecheck-mods: SKIPPED ${DELIVERY} — no ${DELIVERY}/${ENGINE} and no unpacked plugin-authoring skill to copy it from (#1960)\n`,
		);
	});

	it("with no skill unpacked and no copy, skips every pass with a warning and exits 0", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr.match(/^typecheck-mods: SKIPPED /gm)).toHaveLength(3);
		expect(fs.existsSync(path.join(repo, DELIVERY, ENGINE))).toBe(false);
	});
});
