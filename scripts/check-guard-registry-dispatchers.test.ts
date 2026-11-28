// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, region, removeTemps, run } from "./lib/guard-registry-testkit";
import { copyLibs, readProgramLibs } from "./lib-closure-fixture";

afterEach(removeTemps);

type Rows = { script: unknown }[];

const dispatcher = (hook: string, name: string, rows: Rows) => ({
	hook,
	name,
	rows,
	libs: readProgramLibs(name),
});

const DISPATCHERS = [
	dispatcher(
		".husky/pre-commit",
		"precommit-dispatch.js",
		require(path.join(__dirname, "lib", "precommit-gates.js")).GATES,
	),
	dispatcher(
		".husky/commit-msg",
		"commit-msg-dispatch.js",
		require(path.join(__dirname, "lib", "commit-msg-rows.js")).ROWS,
	),
	dispatcher(
		".husky/prepare-commit-msg",
		"prepare-commit-msg-dispatch.js",
		require(path.join(__dirname, "lib", "prepare-commit-msg-rows.js")).ROWS,
	),
	dispatcher(
		".husky/post-commit",
		"post-commit-dispatch.js",
		require(path.join(__dirname, "lib", "post-commit-rows.js")).ROWS,
	),
];

describe.each(DISPATCHERS)(
	"$name's registry rows (#5219)",
	({ hook, name, rows, libs }) => {
		const scripts = [...new Set(rows.map((r) => r.script))] as string[];

		it("gives every row a script", () => {
			expect(rows.filter((r) => typeof r.script !== "string")).toEqual([]);
		});

		const runFixture = (wired: boolean) => {
			const root = build({
				claude: region(
					...scripts.map(
						(s, i) => `- Rule ${i}. **Enforced** (#5219): \`${s}\` runs it.`,
					),
				),
				files: {
					[hook]: wired ? `node scripts/${name}\n` : "exit 0\n",
				},
			});
			copyLibs(path.join(root, "scripts", "lib"), libs);
			for (const s of scripts) {
				const abs = path.join(root, s);
				if (fs.existsSync(abs)) continue;
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, "// stub\n");
			}
			const r = run(root);
			const unwired = r.json.findings.filter((f) => f.kind === "UNWIRED");
			return {
				r,
				unwired,
				unwiredScripts: scripts.filter((s) =>
					unwired.some((f) => f.detail.startsWith(`\`${s}\` `)),
				),
			};
		};

		it("reads every row script wired through the hook that runs the dispatcher", () => {
			expect(runFixture(true).unwired).toEqual([]);
		});

		it("reads each row script unwired where no hook runs the dispatcher", () => {
			const { r, unwired, unwiredScripts } = runFixture(false);
			expect(r.code).toBe(1);
			expect(unwiredScripts).toEqual(
				scripts.filter((s) => !s.startsWith(".husky/")),
			);
			for (const f of unwired)
				expect(f.detail).toContain("nothing triggers it");
		});
	},
);
