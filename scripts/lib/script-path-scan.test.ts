// @vitest-environment node

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
	const exempt = [
		/^\t"`node scripts\/session-arbiter\.js list`\.";$/,
		/^\tconst overflow = `\\n {2}… and \$\{dropped\} more — node scripts\/session-arbiter\.js list`;$/,
		/^\t"`node scripts\/in-flight-runs\.js wait` in the foreground with `timeout: 600000`";$/,
		/^const SUBAGENT_WAIT = `wait inside the turn — what you wait on in the foreground with \\`timeout: 600000\\`, a bg-run\.sh job with \\`scripts\/bg-run\.sh wait <name>\\`/,
		/^\tbyHand: "`node scripts\/claim-issue\.js <n>` to claim an issue by hand",$/,
		/^\t"node scripts\/lib\/resolve-core\.js scripts\/status-report\.js";$/,
		/^\t\t\? "node scripts\/upgrade\.js"$/,
		/^\t\t: "node scripts\/lib\/resolve-core\.js scripts\/upgrade\.js";$/,
		/^\t\t\t\trecordedBy: "node scripts\/record-headless-run\.js",$/,
		/^const RECORDED_BY = "node scripts\/record-claude-responses\.js";$/,
		/^const RECORDED_BY = "node scripts\/record-claude-plugin\.js";$/,
		/^\t\t"writing, amending or reading a spec, .*`node scripts\/promote-spec\.js <brief>`",$/,
	];

	const guardFiles = fs
		.readdirSync(SCRIPTS)
		.filter((f) => /^guard-.*\.(js|sh)$/.test(f) && !isJsTestFile(f))
		.map((f) => path.join(SCRIPTS, f));
	const libNames = fs
		.readdirSync(__dirname)
		.filter((f) => /\.(js|sh)$/.test(f));

	const PrintsDoc = /__doc__(?!\.splitlines\(\)\[0\])/;
	function docstringLines(lines: string[]) {
		const inside = new Set<number>();
		let open = false;
		lines.forEach((line, i) => {
			const toggles = (line.split('"""').length - 1) % 2 === 1;
			if (!open && !/^\s*r?"""/.test(line)) return;
			inside.add(i);
			if (toggles) open = !open;
		});
		return inside;
	}

	function readBareLines(file: string, shaped: (line: string) => boolean) {
		const found: string[] = [];
		const text = fs.readFileSync(file, "utf8");
		const lines = text.split("\n");
		const docstring =
			file.endsWith(".py") && !PrintsDoc.test(text)
				? docstringLines(lines)
				: new Set();
		lines.forEach((line, i) => {
			if (docstring.has(i)) return;
			if (COMMENT_LINE.test(line)) return;
			if (/require\(|execFileSync|spawnSync/.test(line)) return;
			if (exempt.some((re) => re.test(line))) return;
			if (shaped(line))
				found.push(`${path.relative(SCRIPTS, file)}:${i + 1}: ${line.trim()}`);
		});
		return found;
	}

	const resolvesWholeText =
		/(?:const hookBlock|\{(?!\s*repoRoot\s*\})[^}]*\}) = require\("\.\/(?:lib\/)?hook-block(?:\.js)?"\)|\{[^}]*\bdeny(?:Text)?\b[^}]*\} = require\("\.\/guard-verdict\.js"\)|resolve_script_paths|resolveScriptPaths|\.corePaths\(/;

	const EmittedThrough: Record<string, string> = {
		"tracker-inject-text.js": "inject-tracker-docs.js",
	};
	const resolvedByEmitter = (file: string) => {
		const emitter = EmittedThrough[path.basename(file)];
		return (
			emitter !== undefined &&
			resolvesWholeText.test(
				fs.readFileSync(path.join(path.dirname(file), emitter), "utf8"),
			)
		);
	};
	const isSelfResolving = (
		file: string,
		text = fs.readFileSync(file, "utf8"),
	) => resolvesWholeText.test(text) || resolvedByEmitter(file);

	it("name no script by a bare command-shaped path", () => {
		const files = [
			...guardFiles,
			...libNames
				.map((f) => path.join(__dirname, f))
				.filter((f) => !isSelfResolving(f)),
		];
		expect(
			files.flatMap((f) => readBareLines(f, (l) => COMMAND_SHAPED.test(l))),
		).toEqual([]);
	});

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
	// #4285 measured 54 or more per list
	const ScriptListFloor = 40;

	function bareLinesPastResolver(
		rels: string[],
		shaped: (line: string) => boolean,
	) {
		return rels
			.map((rel) => path.join(SCRIPTS, "..", rel))
			.filter((f) => !isSelfResolving(f))
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

	const shippedTopLevel = fs
		.readdirSync(SCRIPTS)
		.filter(
			(f) =>
				/\.(js|sh|py)$/.test(f) &&
				fs.statSync(path.join(SCRIPTS, f)).isFile() &&
				isShipped(path.join(SCRIPTS, ".."), `scripts/${f}`),
		)
		.map((f) => `scripts/${f}`);

	it("reads every shipped top-level script", () => {
		expect(shippedTopLevel).toContain("scripts/report-new-shared-faults.js");
		expect(shippedTopLevel).toContain("scripts/claim-issue.js");
		expect(shippedTopLevel.length).toBeGreaterThan(ScriptListFloor);
	});

	it("name no script bare in any shipped top-level script", () => {
		expect(
			bareLinesPastResolver(shippedTopLevel, (l) => COMMAND_SHAPED.test(l)),
		).toEqual([]);
	});

	const hookFiles = [
		...guardFiles,
		...libNames
			.filter(
				(f) =>
					![
						"plugin-tree.js",
						"doc-map.js",
						"test-read-edges.js",
						"primitives-table.js",
						"implement-carveout.js",
						"main-rewind.js",
						"precommit-gates.js",
					].includes(f),
			)
			.map((f) => path.join(__dirname, f)),
		path.join(SCRIPTS, "place-new-issue.sh"),
		path.join(SCRIPTS, "inject-tracker-docs.js"),
		path.join(SCRIPTS, "concision-backstop.sh"),
	];
	const resolvesLine = /\bdoc_?[pP]ath\b/;

	it("name no skill by its path, and no shipped doc unresolved", () => {
		const found: string[] = [];
		for (const file of hookFiles) {
			const text = fs.readFileSync(file, "utf8");
			const resolves = isSelfResolving(file, text);
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
