// @vitest-environment node
/*
 * The regression #343 exists for: a guard or lib message that tells a session
 * to RUN a script by a bare path, read over this repo's real scripts. It sits
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

const SCRIPTS = path.join(__dirname, "..");
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|#)/;

const { isShipped } = require("./plugin-tree") as {
	isShipped: (root: string, rel: string) => boolean;
};

describe("guard and lib messages", () => {
	/* Data a test reads, never printed; and the CI and push-check commands,
	 * which rewriteRuleCommands spells at the plugin root before printing. */
	const exempt = [
		/remeasure: "node scripts\/measure-turn-band\.js"/,
		/: "node scripts\/check-ci-status\.js";$/,
		/push_check: pushCheck \?\? "node scripts\/push-check\.js",$/,
	];

	const guardFiles = fs
		.readdirSync(SCRIPTS)
		.filter((f) => /^guard-.*\.(js|sh)$/.test(f) && !f.includes(".test."))
		.map((f) => path.join(SCRIPTS, f));
	const libNames = fs
		.readdirSync(__dirname)
		.filter((f) => /\.(js|sh)$/.test(f));

	function bareLines(file: string, shaped: (line: string) => boolean) {
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
			files.flatMap((f) => bareLines(f, (l) => COMMAND_SHAPED.test(l))),
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
	const resolvesWholeText =
		/lib\/guard-parse\.sh|require\("\.\/(?:lib\/)?hook-block(?:\.js)?"\)|resolve_script_paths|resolveScriptPaths/;

	/* The floor catches a manifest read that found nothing. */
	it("reads the hook-wired scripts from both manifests", () => {
		expect(wired).toContain("scripts/session-arbiter.js");
		expect(wired.length).toBeGreaterThan(70);
	});

	it("name no script bare in any hook-wired script printing past a resolver", () => {
		const files = wired
			.map((rel) => path.join(SCRIPTS, "..", rel))
			.filter((f) => !resolvesWholeText.test(fs.readFileSync(f, "utf8")));
		const shaped = (l: string) =>
			COMMAND_SHAPED.test(l) || PLAIN_POINTER.test(l);
		expect(files.flatMap((f) => bareLines(f, shaped))).toEqual([]);
	});

	/*
	 * #1010: a skill or a shipped doc named by its checkout path. A skill is
	 * named by its command, which resolves in any repo. A shipped doc's path
	 * (#1452) may stay bare where the file's text leaves through an emitter that
	 * resolves it — guard-parse.sh's envelopes, hook-block.js, or the
	 * resolver called directly — read lexically, so a file holding the
	 * resolver but printing past it is unseen. A doc_path call exempts only
	 * its own line (#2096).
	 */
	const hookFiles = [
		...guardFiles,
		...libNames
			/* The release render, the doc-map classifier, the test read map and
			 * the /implement carve-out list hold these paths as data, never as a
			 * pointer printed to a session. */
			.filter(
				(f) =>
					![
						"plugin-tree.js",
						"doc-map.js",
						"test-read-edges.js",
						"implement-carveout.js",
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
