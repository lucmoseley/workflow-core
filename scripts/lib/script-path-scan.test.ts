// @vitest-environment node
/*
 * The regression #343 exists for: a guard, lib, hook-wired or git-hook-run
 * script's message that tells a session to RUN a script by a bare path, read
 * over this repo's real scripts. It sits
 * apart from `script-path.test.ts` so that file's unit cases do not read the
 * scripts tree (#1900).
 *
 * Loosen a case and an adopter's session is handed a `scripts/x` that
 * resolves nowhere in its install.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_SHAPED, PLAIN_POINTER } from "./script-path-testkit";
import { isJsTestFile } from "./test-kind.js";

const SCRIPTS = path.join(__dirname, "..");
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|#)/;

const { isShipped } = require("./plugin-tree") as {
	isShipped: (root: string, rel: string) => boolean;
};

describe("messages a shipped script prints", () => {
	/* Data a test reads, never printed; the CI and push-check commands,
	 * which rewriteRuleCommands spells at the plugin root before printing; and
	 * the arbiter command claim-warning prints, and the
	 * bg-run.sh and watcher commands suite-background, agent-poll and
	 * wait-text say, and the issue-body fallback lead deny passes through,
	 * which ctx.corePaths spells there; the `byHand` commands guard-entry's
	 * refusal spells; and the status script npm runs from an adopter's root,
	 * where init and upgrade copy resolve-core.js (#4151); and the rule
	 * trigger generate-rule-fragments writes into the manifest (#4285). */
	const exempt = [
		/^\t\t"Every issue-body edit goes through node scripts\/issue-body\.js",$/,
		/remeasure: "node scripts\/measure-turn-band\.js"/,
		/: "node scripts\/check-ci-status\.js";$/,
		/push_check: pushCheck \?\? "node scripts\/push-check\.js",$/,
		/^\t"`node scripts\/session-arbiter\.js list`\.";$/,
		/^\t\t\t`\\n {2}… and \$\{dropped\} more — node scripts\/session-arbiter\.js list`$/,
		/^\t"This suite is DETACHED INSIDE THE SHELL — .*`scripts\/bg-run\.sh run <name>`/,
		/^const WATCH = "node scripts\/watch-artefact\.js <artefact> 120";$/,
		/^const READ_REASON = `Instead: a subagent, one backgrounded \\`\$\{WATCH\}\\`;/,
		/^\t"wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run\.sh job with `scripts\/bg-run\.sh wait <name>`/,
		/^\tbyHand: "`node scripts\/claim-issue\.js <n>` to claim an issue by hand",$/,
		/^\t"node scripts\/lib\/resolve-core\.js scripts\/status-report\.js";$/,
		/^\t\t"writing, amending or reading a spec, .*`node scripts\/promote-spec\.js <brief>`",$/,
	];

	const guardFiles = fs
		.readdirSync(SCRIPTS)
		.filter((f) => /^guard-.*\.(js|sh)$/.test(f) && !isJsTestFile(f))
		.map((f) => path.join(SCRIPTS, f));
	const libNames = fs
		.readdirSync(__dirname)
		.filter((f) => /\.(js|sh)$/.test(f));

	function readBareLines(file: string, shaped: (line: string) => boolean) {
		const found: string[] = [];
		fs.readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				if (COMMENT_LINE.test(line)) return;
				if (/require\(|execFileSync|spawnSync/.test(line)) return;
				if (exempt.some((re) => re.test(line))) return;
				if (shaped(line))
					found.push(
						`${path.relative(SCRIPTS, file)}:${i + 1}: ${line.trim()}`,
					);
			});
		return found;
	}

	it("name no script by a bare command-shaped path", () => {
		const files = [
			...guardFiles,
			...libNames.map((f) => path.join(__dirname, f)),
		];
		expect(
			files.flatMap((f) => readBareLines(f, (l) => COMMAND_SHAPED.test(l))),
		).toEqual([]);
	});

	/*
	 * #1110: every script a hook wires, read from the native and the plugin
	 * manifests. A file whose text leaves through a whole-text resolver is
	 * exempt — read lexically, as the doc sweep below reads it.
	 */
	const wired = [
		...new Set(
			["self-plugin/hooks/hooks.json", "hooks/hooks.json"].flatMap(
				(f) =>
					JSON.stringify(
						JSON.parse(fs.readFileSync(path.join(SCRIPTS, "..", f), "utf8"))
							.hooks,
					).match(/scripts\/[\w./-]+\.(?:js|sh|py)/g) ?? [],
			),
		),
	];
	/* A read that found nothing or stopped partway lists far fewer: each list
	 * held 54 or more at #4285. */
	const ScriptListFloor = 40;
	const resolvesWholeText =
		/require\("\.\/(?:lib\/)?hook-block(?:\.js)?"\)|\{[^}]*\bdeny(?:Text)?\b[^}]*\} = require\("\.\/guard-verdict\.js"\)|resolve_script_paths|resolveScriptPaths|\.corePaths\(/;

	function bareLinesPastResolver(
		rels: string[],
		shaped: (line: string) => boolean,
	) {
		return rels
			.map((rel) => path.join(SCRIPTS, "..", rel))
			.filter((f) => !resolvesWholeText.test(fs.readFileSync(f, "utf8")))
			.flatMap((f) => readBareLines(f, shaped));
	}

	it("reads the hook-wired scripts from both manifests", () => {
		expect(wired).toContain("scripts/session-arbiter.js");
		expect(wired.length).toBeGreaterThan(ScriptListFloor);
	});

	it("name no script bare in any hook-wired script printing past a resolver", () => {
		const shaped = (l: string) =>
			COMMAND_SHAPED.test(l) || PLAIN_POINTER.test(l);
		expect(bareLinesPastResolver(wired, shaped)).toEqual([]);
	});

	/*
	 * #4285: every top-level script a shipped git hook runs from the plugin
	 * root. A plain
	 * pointer stays unread here: these name source files to read, not run.
	 */
	const huskyDir = path.join(SCRIPTS, "..", ".husky");
	const gitHookRun = [
		...new Set(
			fs
				.readdirSync(huskyDir)
				.filter((f) => isShipped(path.join(SCRIPTS, ".."), `.husky/${f}`))
				.map((f) => path.join(huskyDir, f))
				.flatMap((file) => [
					...fs
						.readFileSync(file, "utf8")
						.matchAll(
							/WFC_PLUGIN_ROOT(?::-[^}]*)?\}?"?\/(scripts\/[\w.-]+\.(?:js|sh))/g,
						),
				])
				.map((m) => m[1] ?? ""),
		),
	];

	it("reads the scripts the shipped git hooks run", () => {
		expect(gitHookRun).toContain("scripts/report-new-shared-faults.js");
		expect(gitHookRun.length).toBeGreaterThan(ScriptListFloor);
	});

	it("name no script bare in any script a shipped git hook runs", () => {
		expect(
			bareLinesPastResolver(gitHookRun, (l) => COMMAND_SHAPED.test(l)),
		).toEqual([]);
	});

	/*
	 * #1010: a skill or a shipped doc named by its checkout path. A skill is
	 * named by its command, which resolves in any repo. A shipped doc's path
	 * (#1452) may stay bare where the file's text leaves through an emitter that
	 * resolves it — hook-block.js, the resolver
	 * called directly, or a Node core's injected `corePaths` port — read
	 * lexically, so a file holding the resolver but printing past it is unseen.
	 * A doc_path call exempts only its own line (#2096).
	 */
	const hookFiles = [
		...guardFiles,
		...libNames
			/* The release render, the doc-map classifier, the test read map, the
			 * primitives tables' file paths and the /implement carve-out list
			 * hold these paths as data, never as a
			 * pointer printed to a session; main-rewind.js's text reaches one
			 * only through branch-publish.js's and pull-form.js's corePaths. */
			.filter(
				(f) =>
					![
						"plugin-tree.js",
						"doc-map.js",
						"test-read-edges.js",
						"primitives-table.js",
						"implement-carveout.js",
						"main-rewind.js",
					].includes(f),
			)
			.map((f) => path.join(__dirname, f)),
		path.join(SCRIPTS, "place-new-issue.sh"),
		path.join(SCRIPTS, "inject-tracker-docs.sh"),
		path.join(SCRIPTS, "concision-backstop.sh"),
	];
	const resolvesLine = /\bdoc_?[pP]ath\b/;

	it("name no skill by its path, and no shipped doc unresolved", () => {
		const found: string[] = [];
		for (const file of hookFiles) {
			const text = fs.readFileSync(file, "utf8");
			const resolves = resolvesWholeText.test(text);
			text.split("\n").forEach((line, i) => {
				if (COMMENT_LINE.test(line)) return;
				const skill = /\.claude\/skills\/[\w-]+\/SKILL\.md/.test(line);
				const doc =
					!resolves &&
					!resolvesLine.test(line) &&
					[...line.matchAll(/(?<![\w./$}-])docs\/([\w./-]*\.[a-z]+)/g)].some(
						(m) =>
							isShipped(
								path.join(SCRIPTS, ".."),
								`docs/${(m[1] ?? "").replace(/\.+$/, "")}`,
							),
					);
				if (skill || doc)
					found.push(
						`${path.relative(SCRIPTS, file)}:${i + 1}: ${line.trim()}`,
					);
			});
		}
		expect(found).toEqual([]);
	});
});
