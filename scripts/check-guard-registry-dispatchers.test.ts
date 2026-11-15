// @vitest-environment node
/*
 * Pins check-guard-registry.js's DISPATCHERS list (#5219): a claim citing a
 * row script of a git-hook dispatcher's registry reads as wired through the
 * hook that runs that dispatcher. Each fixture carries the real registry,
 * copied with its require closure, so a DISPATCHERS row or a row's `script`
 * field deleted reads that row's script UNWIRED.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, region, removeTemps, run } from "./lib/guard-registry-testkit";
import { copyLibs, readProgramLibs } from "./lib-closure-fixture";

afterEach(removeTemps);

/* Spelled out, not imported: an imported list would drop a deleted row from the test too. */
const DISPATCHERS = [
	{
		hook: ".husky/pre-commit",
		entry: "precommit-dispatch.js",
		registry: "precommit-gates.js",
		rows: "GATES",
	},
	{
		hook: ".husky/commit-msg",
		entry: "commit-msg-dispatch.js",
		registry: "commit-msg-rows.js",
		rows: "ROWS",
	},
	{
		hook: ".husky/prepare-commit-msg",
		entry: "prepare-commit-msg-dispatch.js",
		registry: "prepare-commit-msg-rows.js",
		rows: "ROWS",
	},
	{
		hook: ".husky/post-commit",
		entry: "post-commit-dispatch.js",
		registry: "post-commit-rows.js",
		rows: "ROWS",
	},
];

/** The UNWIRED findings' cited paths. */
const unwired = (root: string, scripts: string[]) => {
	const r = run(root);
	return scripts.filter((s) =>
		r.json.findings.some((f) => f.kind === "UNWIRED" && f.detail.includes(s)),
	);
};

describe.each(DISPATCHERS)(
	"$entry's registry rows (#5219)",
	({ hook, entry, registry, rows }) => {
		const rowList = (
			require(`./lib/${registry}`) as Record<string, { script: unknown }[]>
		)[rows];
		const scripts = [...new Set(rowList.map((r) => r.script))] as string[];

		/* A row without its `script` would vanish from `scripts` unseen. */
		it("gives every row a script", () => {
			expect(rowList.filter((r) => typeof r.script !== "string")).toEqual([]);
		});

		/** A fixture whose `hook` runs the dispatcher, or not, and claims every row script Enforced. */
		const fixture = (wired: boolean) => {
			const root = build({
				claude: region(
					...scripts.map(
						(s, i) => `- Rule ${i}. **Enforced** (#5219): \`${s}\` runs it.`,
					),
				),
				files: {
					[hook]: wired ? `node scripts/${entry}\n` : "exit 0\n",
				},
			});
			copyLibs(path.join(root, "scripts", "lib"), readProgramLibs(entry));
			for (const s of scripts) {
				const abs = path.join(root, s);
				if (fs.existsSync(abs)) continue;
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, "// stub\n");
			}
			return root;
		};

		it("reads every row script wired through the hook that runs the dispatcher", () => {
			expect(unwired(fixture(true), scripts)).toEqual([]);
		});

		it("reads each row script unwired where no hook runs the dispatcher", () => {
			/* A .husky/ row is wired by its own existence: git runs every hook file. */
			expect(unwired(fixture(false), scripts)).toEqual(
				scripts.filter((s) => !s.startsWith(".husky/")),
			);
		});
	},
);
