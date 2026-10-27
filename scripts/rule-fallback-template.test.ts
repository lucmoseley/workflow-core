// @vitest-environment node
/*
 * The line a guard says in place of a rule fragment its store cannot give
 * (#3018): every one, Node core or bash guard, keeps one template —
 * `<lead>; the rule could not be read from docs/agents/rules/<id>.txt. Read
 * that file …` — names a fragment that exists, and says the same words
 * wherever two guards fall back for the same id. A drifted one can send the
 * refused session to a fragment that does not exist.
 *
 * Held by a test as well as built by one helper: the bash guards cannot call
 * a Node builder, so each spells the line itself.
 *
 * readRuleTextOr, and a kit core's ruleOrFallback, build the same line from a
 * lead their caller passes, so each literal call is read as the line it
 * answers (#3136, #3146).
 *
 * full-sweep-only: it reads every script and library under scripts/, found by
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

/* Every checker and library that may build the line from a lead. */
const callers = [
	...fs
		.readdirSync(path.join(ROOT, "scripts"))
		.filter((f) => f.endsWith(".js"))
		.map((f) => `scripts/${f}`),
	...fs
		.readdirSync(path.join(ROOT, "scripts", "lib"))
		.filter(
			(f) =>
				f.endsWith(".js") && f !== "rule-text.js" && f !== "guard-verdict.js",
		)
		.map((f) => `scripts/lib/${f}`),
];

const LEAD_CALL =
	/\b(?:readRuleTextOr\(|ruleOrFallback\(\s*[\w.]+\s*,)\s*"([a-z0-9-]+)",\s*"((?:[^"\\]|\\.)*)"/g;

/* Each lead-building call as the line it answers, or, for a call whose id or
 * lead is no literal, null in their place. */
const leadCalls = callers.flatMap((file) => {
	const text = fs.readFileSync(path.join(ROOT, file), "utf8");
	const calls =
		text.match(/\b(?:readRuleTextOr|ruleOrFallback)\(/g)?.length ?? 0;
	const literal = [...text.matchAll(LEAD_CALL)].map(([, id, lead]) => ({
		file,
		id,
		lead,
		line: `${lead}; the rule could not be read from docs/agents/rules/${id}.txt. Read that file before doing anything else.`,
	}));
	return [
		...literal,
		...Array.from({ length: calls - literal.length }, () => ({
			file,
			id: null,
			lead: null,
			line: null,
		})),
	];
});

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
	/* The Node cores build theirs through the two builders (#3146), so the
	 * scan finds at least those; a scan that lost a directory finds neither. */
	it("is found at all, so the scan below is not vacuous", () => {
		expect(fallbacks.map(({ file }) => file)).toEqual(
			expect.arrayContaining([
				"scripts/lib/guard-verdict.js",
				"scripts/lib/rule-text.js",
			]),
		);
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

	/* A checker under scripts/ and a kit core under scripts/lib/, so a
	 * listing that lost either directory fails here (#3146). */
	it("is found at the lead-building calls too, so that scan is not vacuous", () => {
		expect(leadCalls.map(({ file }) => file)).toEqual(
			expect.arrayContaining([
				"scripts/check-lockfile-sync.js",
				"scripts/lib/pull-form.js",
			]),
		);
	});

	it.each(leadCalls)(
		"builds the line from a literal id and a lead with no closing stop: $file",
		({ id, lead }) => {
			expect(id).not.toBeNull();
			expect(lead).not.toMatch(/[.;:]$/);
			expect(
				fs.existsSync(path.join(ROOT, "docs", "agents", "rules", `${id}.txt`)),
			).toBe(true);
		},
	);

	it("says the same words wherever two guards fall back for one id", () => {
		const byId = new Map<string, Set<string>>();
		for (const { id, line } of leadCalls) {
			if (!id || !line) continue;
			const texts = byId.get(id) ?? new Set<string>();
			texts.add(line);
			byId.set(id, texts);
		}
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
