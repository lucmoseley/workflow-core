// @vitest-environment node
/*
 * wfc-mods-copies.test.ts — the two mods carry their own copies of the same
 * helpers, which cannot be shared (#944), so this test holds the copies to one
 * text: each helper is declared in both mods' hooks modules, and every
 * declaration of it reads the same, liveness's per-hook `debug` closures among
 * them (#1049). Without it, a fix to one mod's floor reaches adopters while
 * the other runs the old rule. A helper copied later is held only once it
 * joins COPIED. Liveness's switch is its own: delivery has none (#1467).
 *
 * Compared as TypeScript declarations, name through initializer, with any
 * JSDoc above: a plain comment there may cite each mod's own ticket.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const MODULES = [
	".claude/skills/wfc-delivery/hooks/register.ts",
	".claude/skills/wfc-liveness/hooks/register.tsx",
];

const COPIED = ["versionFloor", "isAtFloor", "messageOf", "debug"];

/** Every declaration of each COPIED name in `source`, as written. */
const declarationsOf = (file: string, source: string) => {
	const found = new Map<string, string[]>(COPIED.map((name) => [name, []]));
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
			found
				.get(node.name.text)
				?.push(
					[...ts.getJSDocCommentsAndTags(node), node]
						.map((n) => n.getText())
						.join("\n"),
				);
		ts.forEachChild(node, visit);
	};
	visit(
		ts.createSourceFile(
			file,
			source,
			ts.ScriptTarget.Latest,
			true,
			file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		),
	);
	return found;
};

/** One line per COPIED name missing from a module or read two ways. */
const driftOf = (sources: Record<string, string>) => {
	const texts = new Map<string, Set<string>>(
		COPIED.map((name) => [name, new Set()]),
	);
	const drift: string[] = [];
	for (const [file, source] of Object.entries(sources))
		for (const [name, declared] of declarationsOf(file, source)) {
			if (declared.length === 0) drift.push(`${name}: not declared in ${file}`);
			for (const text of declared) texts.get(name)?.add(text);
		}
	for (const [name, seen] of texts)
		if (seen.size > 1) drift.push(`${name}: ${seen.size} different texts`);
	return drift;
};

const readModules = () =>
	Object.fromEntries(
		MODULES.map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]),
	);

describe("the helpers both mods copy", () => {
	it("read the same in both hooks modules, naming each that differs or is missing", () => {
		expect(driftOf(readModules())).toEqual([]);
	});

	it("are caught where one copy changes or is renamed, naming the helper", () => {
		const sources = readModules();
		const [delivery, liveness] = MODULES as [string, string];
		sources[liveness] = (sources[liveness] as string).replace(
			"an unparseable one is below",
			"an unparseable one is under",
		);
		expect(driftOf(sources)).toEqual(["isAtFloor: 2 different texts"]);
		sources[delivery] = (sources[delivery] as string).replace(
			"const messageOf",
			"const errorText",
		);
		expect(driftOf(sources)).toEqual([
			`messageOf: not declared in ${delivery}`,
			"isAtFloor: 2 different texts",
		]);
	});
});
