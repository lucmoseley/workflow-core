// @vitest-environment node
/*
 * No dispatcher core, nor any file its relative requires reach, holds a run
 * of RUN_WORDS words copied from a generated rule fragment (#4155). A refusal
 * printing such a copy keeps the old words when the source document's region
 * is reworded; the core reads the fragment instead (docs/agents/rules/README.md).
 *
 * Comments count: a rule restated in a comment drifts the same way.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireClosure } from "./require-closure";

const require = createRequire(import.meta.url);
const { readDispatchedCores } = require("./guard-cores.js");

const ROOT = path.resolve(__dirname, "..", "..");
/* #4129's scan threshold, untraced: below it the hits were paraphrases. */
const RUN_WORDS = 10;

const words = (text: string) =>
	text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];

/** Every RUN_WORDS-word run in `text`, joined by single spaces. */
function runsOf(text: string): string[] {
	const w = words(text);
	const runs = [];
	for (let i = 0; i + RUN_WORDS <= w.length; i++)
		runs.push(w.slice(i, i + RUN_WORDS).join(" "));
	return runs;
}

const manifest: { rules: Record<string, unknown> } = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "docs", "agents", "rules", "manifest.json"),
		"utf8",
	),
);

/** run → the generated fragment holding it */
const generated = new Map<string, string>();
for (const id of Object.keys(manifest.rules))
	for (const run of runsOf(
		fs.readFileSync(
			path.join(ROOT, "docs", "agents", "rules", `${id}.txt`),
			"utf8",
		),
	))
		generated.set(run, id);

const closure: string[] = requireClosure(ROOT, readDispatchedCores());

describe("generated rule fragments", () => {
	it("walks the dispatcher cores' closure, all of it under scripts/", () => {
		expect(closure).toEqual(expect.arrayContaining(readDispatchedCores()));
		expect(closure.length).toBeGreaterThan(readDispatchedCores().length);
		for (const rel of closure) expect(rel.startsWith("scripts/")).toBe(true);
	});

	it(`are copied into no dispatcher core's closure as a run of ${RUN_WORDS} words`, () => {
		const copies = closure.flatMap((rel) => {
			const text = fs.readFileSync(
				path.join(ROOT, "scripts", `${rel.slice("scripts/".length)}`),
				"utf8",
			);
			return [
				...new Set(
					runsOf(text)
						.filter((run) => generated.has(run))
						.map((run) => `${rel} ← ${generated.get(run)}: ${run}`),
				),
			];
		});
		expect(copies).toEqual([]);
	});

	it("finds a copy where one is planted", () => {
		const [run, id] = [...generated][0] ?? [];
		expect(id).toBeDefined();
		expect(runsOf(`/* ${run} */`).some((r) => generated.has(r))).toBe(true);
	});
});
