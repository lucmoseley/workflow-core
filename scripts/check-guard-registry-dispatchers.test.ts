// @vitest-environment node
/*
 * Pins check-guard-registry.js's DISPATCHERS list (#5219): a claim citing a
 * row script of a git-hook dispatcher's registry reads as wired through the
 * hook that runs that dispatcher. Each fixture carries the real registry,
 * copied with its require closure, so a DISPATCHERS row deleted reads that
 * dispatcher's row scripts UNWIRED.
 *
 * The checker is a hard gate in .husky/pre-commit: loosen a case and a rule
 * citing a dispatcher-run script can claim **Enforced** while nothing runs it,
 * or read UNWIRED while its hook plainly does.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, region, removeTemps, run } from "./lib/guard-registry-testkit";
import { copyLibs, readProgramLibs } from "./lib-closure-fixture";

afterEach(removeTemps);

type Rows = { script: unknown }[];

/* Spelled out, not imported: an imported list would drop a deleted row from the test too.
 * Each path is __dirname-anchored so the read-edge selector ties it to this test (§X10). */
const DISPATCHERS = [
	{
		hook: ".husky/pre-commit",
		entry: path.join(__dirname, "precommit-dispatch.js"),
		rows: require(path.join(__dirname, "lib", "precommit-gates.js"))
			.GATES as Rows,
	},
	{
		hook: ".husky/commit-msg",
		entry: path.join(__dirname, "commit-msg-dispatch.js"),
		rows: require(path.join(__dirname, "lib", "commit-msg-rows.js"))
			.ROWS as Rows,
	},
	{
		hook: ".husky/prepare-commit-msg",
		entry: path.join(__dirname, "prepare-commit-msg-dispatch.js"),
		rows: require(path.join(__dirname, "lib", "prepare-commit-msg-rows.js"))
			.ROWS as Rows,
	},
	{
		hook: ".husky/post-commit",
		entry: path.join(__dirname, "post-commit-dispatch.js"),
		rows: require(path.join(__dirname, "lib", "post-commit-rows.js"))
			.ROWS as Rows,
	},
].map((d) => ({ ...d, name: path.basename(d.entry) }));

describe.each(DISPATCHERS)(
	"$name's registry rows (#5219)",
	({ hook, name, rows }) => {
		const scripts = [...new Set(rows.map((r) => r.script))] as string[];

		/* A row whose `script` is gone drops its path from `scripts`, so no wiring case notices. */
		it("gives every row a script", () => {
			expect(rows.filter((r) => typeof r.script !== "string")).toEqual([]);
		});

		/** A fixture whose `hook` runs the dispatcher, or not, and claims every row script Enforced. */
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
			copyLibs(path.join(root, "scripts", "lib"), readProgramLibs(name));
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
			/* No exit code: the fixture's bare hook and copied libs raise unrelated
			 * UNANNOTATED, UNANCHORED and EMITTED-MISSING findings. */
			expect(runFixture(true).unwired).toEqual([]);
		});

		it("reads each row script unwired where no hook runs the dispatcher", () => {
			const { r, unwired, unwiredScripts } = runFixture(false);
			expect(r.code).toBe(1);
			/* A .husky/ row is wired by its own existence: git runs every hook file. */
			expect(unwiredScripts).toEqual(
				scripts.filter((s) => !s.startsWith(".husky/")),
			);
			for (const f of unwired)
				expect(f.detail).toContain("nothing triggers it");
		});
	},
);
