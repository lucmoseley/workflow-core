// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTree } from "./lib/plugin-tree.js";

const CLAUDE = process.env.WFC_CLAUDE_BIN || "claude";
const hasClaude =
	spawnSync(CLAUDE, ["--version"], { encoding: "utf8" }).status === 0;

const MODS = [
	{
		mod: "wfc-delivery",
		hooks:
			'session.start{cwd=/"."/}, turn.start{turnId=/"."/}, turn.complete{turnId=/"."/}',
	},
	{
		mod: "wfc-liveness",
		hooks:
			'session.start{cwd=/"."/}, turn.step, turn.complete, ui.render{component=Pane, requestId=liveness}, command.run{command=liveness}',
	},
];

const validate = (dir: string) => {
	const ran = spawnSync(CLAUDE, ["plugin", "validate", dir], {
		encoding: "utf8",
	});
	expect(ran.status, ran.stderr).toBe(0);
	return ran.stdout;
};
const hooked = (stdout: string) =>
	[...stdout.matchAll(/\.tsx? hooks: (.+)$/gm)].map((m) =>
		m[1].replaceAll(/ \(default matcher key: [^)]*\)/g, ""),
	);

describe.skipIf(!hasClaude).each(MODS)(
	"$mod under claude plugin validate",
	({ mod, hooks }) => {
		it(`lists exactly ${hooks}`, () => {
			expect(
				hooked(validate(path.resolve(__dirname, "../.claude/skills", mod))),
			).toEqual([hooks]);
		});
	},
);

describe.skipIf(!hasClaude)(
	"the release tree under claude plugin validate",
	() => {
		it("passes, its entry module listing exactly both mods' hooks", () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-mods-release-"));
			try {
				const out = path.join(tmp, "out");
				buildTree(path.resolve(__dirname, ".."), out);
				const stdout = validate(out);
				expect(hooked(stdout)).toEqual([MODS.map((m) => m.hooks).join(", ")]);
				expect(stdout).toContain(
					"declares state: workflow-core.isTurnRunning, workflow-core.records, workflow-core.rows",
				);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		});
	},
);
