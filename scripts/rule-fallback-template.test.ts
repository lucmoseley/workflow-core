// @vitest-environment node
/*
 * The line a guard says in place of a rule fragment its store cannot give
 * (#3018): every one, Node core or bash guard, keeps one template —
 * `<lead>; the rule could not be read from docs/agents/rules/<id>.txt. Read
 * that file …` — names a fragment that exists, and says the same words
 * wherever two guards fall back for the same id. A drifted one can send the
 * refused session to a fragment that does not exist.
 *
 * Held by a test rather than built by one helper: the bash guards cannot call
 * a Node builder, and a lead passed to one is no longer a literal that
 * check-guard-registry.js's deny-text reader sees.
 *
 * full-sweep-only: it reads every guard and library under scripts/, found by
 * listing the directories, so no literal path names what it reads.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const sources = [
	...fs
		.readdirSync(path.join(ROOT, "scripts"))
		.filter((f) => /^guard-.*\.(?:js|sh)$/.test(f))
		.map((f) => `scripts/${f}`),
	...fs
		.readdirSync(path.join(ROOT, "scripts", "lib"))
		.filter((f) => /\.(?:js|sh)$/.test(f))
		.map((f) => `scripts/lib/${f}`),
];

/* A shell double-quoted string's escapes read, so a bash copy compares with
 * a Node one. */
const shellRead = (line: string, file: string) =>
	file.endsWith(".sh") ? line.replace(/\\([`$"\\])/g, "$1") : line;

/* The path a fallback names: literal, or spelt for an install by docPath. */
const RULE_FILE = String.raw`(?:docs/|\$\{(?:ctx\.)?docPath\(["\`])agents/rules/(\$\{id\}|[a-z0-9-]+)\.txt(?:["\`]\)\})?`;
const TEMPLATE = new RegExp(
	String.raw`\S; the rule could not be read from ${RULE_FILE}\. Read that file\b`,
);

const fallbacks = sources.flatMap((file) =>
	fs
		.readFileSync(path.join(ROOT, file), "utf8")
		.split("\n")
		.map((line) => shellRead(line, file))
		.filter(
			(line) =>
				/could not be read from/.test(line) && /agents\/rules\//.test(line),
		)
		.map((line) => ({ file, line })),
);

describe("a guard's rule fallback (#3018)", () => {
	/* 46 were found at #3018; the floor fails a scan that lost a directory or
	 * a match, not one guard's removal. */
	it("is found at all, so the scan below is not vacuous", () => {
		expect(fallbacks.length).toBeGreaterThan(15);
	});

	it.each(fallbacks)("keeps the one template: $file", ({ line }) => {
		expect(line).toMatch(TEMPLATE);
	});

	it.each(
		fallbacks.flatMap(({ file, line }) => {
			const id = TEMPLATE.exec(line)?.[1];
			return id && !id.startsWith("$") ? [{ file, id }] : [];
		}),
	)("names a fragment that exists: $id in $file", ({ id }) => {
		expect(
			fs.existsSync(path.join(ROOT, "docs", "agents", "rules", `${id}.txt`)),
		).toBe(true);
	});

	it("says the same words wherever two guards fall back for one id", () => {
		const byId = new Map<string, Set<string>>();
		for (const { line } of fallbacks) {
			const m =
				/"([^"]*; the rule could not be read from docs\/agents\/rules\/([a-z0-9-]+)\.txt\.[^"]*)"/.exec(
					line,
				);
			if (!m) continue;
			const texts = byId.get(m[2]) ?? new Set<string>();
			texts.add(m[1]);
			byId.set(m[2], texts);
		}
		const drifted = [...byId].filter(([, texts]) => texts.size > 1);
		expect(drifted).toEqual([]);
	});
});
