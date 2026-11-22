// @vitest-environment node

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
