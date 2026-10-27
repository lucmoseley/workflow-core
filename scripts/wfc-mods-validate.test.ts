// @vitest-environment node
/*
 * Each mod hooks exactly the events its spec allows and nothing else: no
 * `tool.call`, `classic.*`, `session.append` or `prompt.*` hook, so none can
 * skip a guard or rewrite a row (#849 §Guard safety, #854; #863 §Guard safety
 * and failure, #865, which also bars `agent.*`). Read off
 * `claude plugin validate`, which reports what a module hooks as the engine
 * would load it. Skipped where no `claude` binary is installed, as on CI.
 *
 * The release tree, rendered as an adopter installs it, loads both through
 * one entry module and must list the same hooks, in import order (#946).
 *
 * Loosen a case and a mod hooking a forbidden event — one that could skip a
 * guard or rewrite a transcript row — ships to every adopter with the plugin.
 */

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
	// The matcher matches every cwd, so one module may hook it twice (#944).
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
/** Each module's hook line, `❯ ./register.ts hooks: …`; never the
 * `Validating hooks: <path>` header above it. */
const hooked = (stdout: string) =>
	[...stdout.matchAll(/\.tsx? hooks: (.+)$/gm)].map((m) => m[1]);

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
				// The shipped contract, renamed to the host, as the engine reads it.
				expect(stdout).toContain(
					"declares state: workflow-core.records, workflow-core.rows",
				);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		});
	},
);
