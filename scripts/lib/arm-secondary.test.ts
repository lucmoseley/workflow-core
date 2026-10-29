// @vitest-environment node
/*
 * The before/after test's three lexical secondary measures (#2175), over two
 * transcripts recorded from the #2046 main run and trimmed to the records the
 * measures read. A break here misreports warns ignored, commits refused or the
 * final message's form in every arm of the report, and a gate refusal reworded
 * past the table moves its refusals to another gate or to none, unseen (#2298),
 * as does a gate added to .husky/pre-commit with no row (#2448).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { secondaryOf, summariseSecondary } = require("./arm-secondary.js");
const { readRegisteredGuardSubjects } = require("./guard-fires.js");

const ROOT = path.resolve(__dirname, "..", "..");
const subjects = readRegisteredGuardSubjects(ROOT);
/** A recorded run that commits through a refusing gate, then lands. */
const REFUSED = fs.readFileSync(
	path.join(
		ROOT,
		"scripts",
		"fixtures",
		"arm-secondary",
		"recorded-69f9fc0f.jsonl",
	),
	"utf8",
);
/** A recorded run ending on a priced round. */
const ROUND = fs.readFileSync(
	path.join(
		ROOT,
		"scripts",
		"fixtures",
		"arm-secondary",
		"recorded-753cc586.jsonl",
	),
	"utf8",
);
const refusedRun = secondaryOf(REFUSED, subjects);
const roundRun = secondaryOf(ROUND, subjects);
/** The `git add` call the guard warned in REFUSED. */
const WARNED_CALL = "toolu_01XSfYVxvmqLzPmaY2SS8cJV";

const lines = (text: string) =>
	text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
const joined = (records: object[]) =>
	`${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
interface Block {
	type: string;
	id?: string;
	text?: string;
	input?: object;
}
interface LogRecord {
	type: string;
	message?: { id?: string; content?: Block[] };
	attachment?: { toolUseID: string };
}
const toolUseOf = (r: LogRecord) =>
	(r.message?.content ?? []).find((b) => b.type === "tool_use");
const finalOf = (text: string) =>
	secondaryOf(
		joined([
			{
				type: "assistant",
				isSidechain: false,
				message: {
					id: "m1",
					role: "assistant",
					content: [{ type: "text", text }],
				},
			},
		]),
		subjects,
	).finalMessage;
let calls = 0;
const result = (output: string, tool = "Bash") => {
	const id = `toolu_${++calls}`;
	return [
		{
			type: "assistant",
			isSidechain: false,
			message: {
				id: `msg_${id}`,
				role: "assistant",
				content: [{ type: "tool_use", id, name: tool, input: {} }],
			},
		},
		{
			type: "user",
			isSidechain: false,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: id, content: output }],
			},
		},
	];
};
/**
 * REFUSED with a call inserted straight after the warned one: a clone of it,
 * in its own message unless `sameMessage`, with `command` in place of the
 * warned one's where given, and the warn's record cloned onto it if `warned`.
 */
const withNextCall = ({
	command,
	warned = false,
	sameMessage = false,
}: {
	command?: string;
	warned?: boolean;
	sameMessage?: boolean;
}) => {
	const records: LogRecord[] = lines(REFUSED);
	const at = records.findIndex((r) => toolUseOf(r)?.id === WARNED_CALL);
	const call = structuredClone(records[at]);
	const use = call && toolUseOf(call);
	const warn = records.find((r) => r.attachment?.toolUseID === WARNED_CALL);
	if (!call?.message || !use || !warn)
		throw new Error(`${WARNED_CALL} or its warn is not in the fixture`);
	use.id = "toolu_next";
	if (command !== undefined) use.input = { command };
	if (!sameMessage) call.message.id = "msg_next";
	const added: LogRecord[] = [call];
	if (warned) {
		const again = structuredClone(warn);
		if (again.attachment) again.attachment.toolUseID = "toolu_next";
		added.push(again);
	}
	records.splice(at + 1, 0, ...added);
	return secondaryOf(joined(records), subjects).warnsActedAgainst;
};
/** Husky's line, as it closes a refused commit's output. */
const HUSKY = "husky - pre-commit script failed (code 1)";

describe("warns acted against", () => {
	it("counts each warned call once, though the transcript writes every call twice, and none acted against", () => {
		expect(refusedRun.warnsActedAgainst).toEqual({
			warnedCalls: 2,
			actedAgainst: 0,
			repeated: 0,
			rewarned: 0,
		});
	});

	it("counts a warned call whose next call repeats its command", () => {
		expect(withNextCall({})).toMatchObject({
			warnedCalls: 2,
			actedAgainst: 1,
			repeated: 1,
		});
	});

	it("counts a warned call whose next call draws the same warn", () => {
		expect(withNextCall({ command: "git add b.js", warned: true })).toEqual({
			warnedCalls: 3,
			actedAgainst: 1,
			repeated: 0,
			rewarned: 1,
		});
	});

	it("skips a sibling issued in the warned call's own message, before the warn was seen", () => {
		expect(withNextCall({ sameMessage: true })).toMatchObject({
			actedAgainst: 0,
		});
	});

	it("leaves a warn on a call no needle of kind warn names uncounted", () => {
		expect(secondaryOf(REFUSED, []).warnsActedAgainst.warnedCalls).toBe(0);
	});
});

describe("commit-gate refusals", () => {
	it("attributes the recorded refusal to the gate whose own line it carries", () => {
		expect(refusedRun.commitGateRefusals).toEqual({
			total: 1,
			byGate: { "citation-tracker": 1 },
		});
		expect(roundRun.commitGateRefusals).toEqual({
			total: 0,
			byGate: {},
		});
	});

	it("gives a Bash refusal to the gate matched last before husky's line, one with no gate's line to none, and a Read quoting one to nobody", () => {
		const biome = "  × Some errors were emitted while running checks.";
		const citation = "FAIL: 1 mis-tracked citation";
		const edges =
			"docs/test-read-edges.json is stale — 1 file(s) changed their reader set:";
		const transcript = joined([
			...result(`output cut off\n${HUSKY}`),
			...result(`${biome}\n${citation}\n${HUSKY}\n${edges}\n${HUSKY}`),
			...result(biome),
			...result(`${citation}\n${HUSKY}`, "Read"),
		]);
		expect(secondaryOf(transcript, subjects).commitGateRefusals).toEqual({
			total: 3,
			byGate: { unattributed: 1, "citation-tracker": 1, "test-read-edges": 1 },
		});
	});
});

type GateLine =
	| string
	| { text: string; sites?: number; from?: string; via?: string };
const { gates } = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "scripts", "commit-gate-refusals.json"),
		"utf8",
	),
) as { gates: { id: string; tool?: string; lines: GateLine[] }[] };
/**
 * The files each in-repo gate prints its refusal lines from, spelt here as
 * literals rather than in the JSON so a change to a gate's source selects this
 * test (base §X10).
 */
const GATE_SOURCES: Record<string, string[]> = {
	branch: [".husky/pre-commit"],
	"check-staged-biome": ["scripts/lib/infer-commands.js"],
	"stale-write-back": ["scripts/stale-write-back-gate.sh"],
	"review-hold": ["scripts/review-hold-gate.sh"],
	"roadmap-pair": ["scripts/check-roadmap-pair.js"],
	"roadmap-valid": ["scripts/check-roadmap-valid.js"],
	"citation-tracker": ["scripts/check-citation-tracker.js"],
	"gate-switches": ["scripts/check-gate-switches.js"],
	"lockfile-sync": ["scripts/check-lockfile-sync.js"],
	"research-added": ["scripts/check-research-added.js"],
	"digest-version": [
		"scripts/check-digest-version.js",
		"scripts/lib/precommit-gate.sh",
	],
	"digest-render": [".husky/pre-commit", "scripts/lib/precommit-gate.sh"],
	"vendored-skills": ["scripts/check-vendored-skills.js"],
	"upstream-record": [
		"scripts/check-vendored-skills.js",
		"scripts/lib/precommit-gate.sh",
	],
	"guard-registry": ["scripts/check-guard-registry.js"],
	"hook-liveness": ["scripts/check-hook-liveness.js"],
	"plugin-hooks": ["scripts/generate-plugin-hooks.js"],
	"guard-test-isolation": ["scripts/check-guard-test-isolation.js"],
	"host-root-test-isolation": ["scripts/check-host-root-test-isolation.js"],
	"git-fixture-identity": ["scripts/check-git-fixture-identity.js"],
	"host-root": ["scripts/check-host-root.js"],
	"test-read-edges": ["scripts/generate-test-read-edges.js"],
	"rule-fragments": ["scripts/generate-rule-fragments.js", ".husky/pre-commit"],
	"website-copy": ["scripts/check-website-copy.js"],
	"skill-body-size": ["scripts/check-skill-body-size.js"],
	"skill-frontmatter": ["scripts/check-skill-frontmatter.js"],
	registrations: ["scripts/lib/registrations.js"],
	"workflow-permissions": ["scripts/check-workflow-permissions.js"],
	"cli-args": ["scripts/check-cli-args.js"],
	"jsonl-reads": ["scripts/check-jsonl-reads.js"],
	"gh-route": ["scripts/check-gh-route.js"],
	"clock-copies": ["scripts/check-clock-copies.js"],
	"report-programs": ["scripts/check-report-programs.js"],
	primitives: ["scripts/check-primitives.js"],
	"test-spawn": ["scripts/check-test-spawn.js"],
	"doc-map": [".husky/pre-commit", "scripts/lib/precommit-gate.sh"],
	"context-budget": ["scripts/check-context-budget.js"],
	"injector-margin": ["scripts/check-injector-margin.sh"],
	"superseded-needle": [".husky/pre-commit", "scripts/lib/precommit-gate.sh"],
	eslint: [".husky/pre-commit"],
	shellcheck: [".husky/pre-commit", "scripts/lib/precommit-gate.sh"],
	actionlint: [".husky/pre-commit"],
	ruff: [".husky/pre-commit"],
	"swallowed-errors": [".husky/pre-commit"],
	format: [".husky/pre-commit"],
	test: [".husky/pre-commit"],
	"mutation-hold": ["scripts/mutation-hold-gate.js"],
	"pre-commit-local": [".husky/pre-commit"],
	"staged-paths": ["scripts/lib/precommit-gate.sh"],
};
/** Each source's text, with a JS template literal's escaped backticks read as printed. */
const sourceAsPrinted = new Map(
	[...new Set(Object.values(GATE_SOURCES).flat())].map((rel) => [
		rel,
		fs.readFileSync(path.join(ROOT, rel), "utf8").replaceAll("\\`", "`"),
	]),
);
const PRE_COMMIT = sourceAsPrinted.get(".husky/pre-commit") ?? "";
const occurrences = (text: string, needle: string) =>
	text.split(needle).length - 1;
/** A table line as its source spells it. */
const speltAs = (line: GateLine) =>
	typeof line === "string" ? line : (line.from ?? line.text);

describe("the commit-gate refusal table against the gates it copies (#2298)", () => {
	it.each(gates.filter((g) => !g.tool).map((g) => [g.id, g] as const))(
		"finds each of %s's lines in its own source, at every site it prints",
		(id, g) => {
			const sources = (GATE_SOURCES[id] ?? []).map(
				(rel) => sourceAsPrinted.get(rel) ?? "",
			);
			expect(sources.length, `no GATE_SOURCES row for ${id}`).toBeGreaterThan(
				0,
			);
			for (const line of g.lines) {
				const row = typeof line === "string" ? { text: line } : line;
				const spelt = speltAs(line);
				const found = sources.reduce((n, s) => n + occurrences(s, spelt), 0);
				expect(found, `${spelt} in ${GATE_SOURCES[id]}`).toBe(row.sites ?? 1);
				if (!row.from) continue;
				expect(row.from.replace(/\$\w+/, id)).toBe(row.text);
				expect(PRE_COMMIT).toMatch(
					new RegExp(`^\\s*${row.via} ${id}(\\s|$)`, "m"),
				);
			}
		},
	);

	it("names each gate once, a source for each in-repo one, and leaves only a third-party tool's lines unchecked", () => {
		expect(new Set(gates.map((g) => g.id)).size).toBe(gates.length);
		expect(gates.filter((g) => g.tool).map((g) => g.id)).toEqual([
			"biome",
			"gitleaks",
		]);
		expect(Object.keys(GATE_SOURCES).sort()).toEqual(
			gates
				.filter((g) => !g.tool)
				.map((g) => g.id)
				.sort(),
		);
	});
});

/**
 * The hook's script calls no gate lists as a source, each script's calls in
 * hook order: the gate whose line that call refuses through, or null for one
 * that prints no gate's refusal line, whose BROKEN run still refuses
 * unattributed.
 */
const HOOK_CALLS: Record<string, (string | null)[]> = {
	"scripts/lib/workflow-core-config.js": [null, null, null],
	"scripts/check-digest-render.js": ["digest-render"],
	"scripts/check-doc-map.js": ["doc-map", "doc-map", "doc-map"],
	"scripts/checker-new-faults.js": ["doc-map"],
	"scripts/check-registrations.js": ["registrations"],
	"scripts/check-user-settings-drift.js": [null],
	"scripts/check-code-standards.js": [null],
	"scripts/lib/always-loaded-pool.js": [null],
	"scripts/check-superseded-values.js": ["superseded-needle"],
	"scripts/lib/formatters.js": ["ruff", null, null],
	"scripts/check-ruff-introduced.js": ["ruff"],
	"scripts/check-swallowed-errors.js": ["swallowed-errors"],
	"scripts/check-format-staged.js": ["format"],
	"scripts/lib/test-gate.js": [null],
	"scripts/lib/commit-key.js": [null, null],
	"scripts/lib/isolated-worktree.js": ["test"],
	"scripts/lib/serialised.sh": ["shellcheck"],
	"scripts/generate-rule-fragments.js": [null, "rule-fragments"],
};
/** The hook's inline `pre-commit:` heads that refuse nothing. */
const HOOK_NOTICES = [
	"left as they are, the $dm_noun above reach the scheduled sweeps as DEAD",
	"is RED — reporting only, this commit is NOT blocked.",
	"skipped, not waited for, as this commit holds .git/index.lock",
	"in the lock — no pre-lock green stands it down",
	"no worktree holds this commit's tree alone",
];

/**
 * The hook's gate calls, comments dropped: each script call, each gate helper's
 * label, and each inline `pre-commit:` head sent to stderr.
 * Residual: a head opened on a continuation line or built in a variable, a
 * quoted or variable label, and a script reached other than by `node`, `bash`,
 * `sh` or `python3` pass unread.
 */
function hookCalls(hook: string) {
	const code = hook
		.split("\n")
		.filter((l) => !/^\s*#/.test(l))
		.join("\n");
	const read = (re: RegExp) => [...code.matchAll(re)].map((m) => m[1]);
	return {
		scripts: read(
			/\b(?:node|bash|sh|python3)\s+(?:"\$\{WFC_PLUGIN_ROOT:-\.\}"\/)?(scripts\/[\w./-]+\.(?:js|sh|py))\b/g,
		),
		labels: read(
			/\b(?:staged_gate|tool_gate|gate_[a-z_]+)[ \t]+([a-z][\w-]*)/g,
		),
		heads: read(
			/^(?=[^\n]*>&2)\s*(?:echo|printf)\b[^\n]*?"(pre-commit: [^"\n]*)"/gm,
		),
	};
}

/**
 * The hook's gate calls that map to no table gate: a script called more times
 * than its declared calls or the gates listing it, a label no gate is, and a
 * head carrying no table line or notice.
 */
function unmappedGates(hook: string) {
	const { scripts, labels, heads } = hookCalls(hook);
	const ids = new Set(gates.map((g) => g.id));
	const spellings = gates.flatMap((g) => g.lines.map(speltAs));
	const seen = new Map<string, number>();
	return [
		...scripts.filter((s) => {
			const nth = seen.get(s) ?? 0;
			seen.set(s, nth + 1);
			if (!Object.hasOwn(HOOK_CALLS, s))
				return (
					nth >=
					Object.values(GATE_SOURCES).filter((rels) => rels.includes(s)).length
				);
			const gate = HOOK_CALLS[s][nth];
			return gate === undefined || (gate !== null && !ids.has(gate));
		}),
		...labels.filter((l) => !ids.has(l)),
		...heads.filter(
			(h) => ![...spellings, ...HOOK_NOTICES].some((s) => h.includes(s)),
		),
	];
}

describe("the commit-gate refusal table against the gates .husky/pre-commit runs (#2448)", () => {
	it("maps each of the hook's script calls, gate labels and inline refusals to a table gate", () => {
		expect(unmappedGates(PRE_COMMIT)).toEqual([]);
	});

	it("names a gate added to the hook with no table row, a further call to a gate's own script among them", () => {
		const added = PRE_COMMIT.replace(
			"\nnode ",
			[
				"\nnode scripts/check-new-gate.js || exit 1",
				"node scripts/check-vendored-skills.js --other-mode || exit 1",
				"staged_gate new-label live status '' 'true' \"\"",
				'echo >&2 "pre-commit: the new gate refused this commit."',
				"node ",
			].join("\n"),
		);
		expect(unmappedGates(added)).toEqual([
			"scripts/check-new-gate.js",
			"scripts/check-vendored-skills.js",
			"new-label",
			"pre-commit: the new gate refused this commit.",
		]);
	});

	it("declares as many calls of each script as the hook makes, and only notices it still prints", () => {
		const { scripts, heads } = hookCalls(PRE_COMMIT);
		for (const [call, gatesOf] of Object.entries(HOOK_CALLS))
			expect(scripts.filter((s) => s === call).length, call).toBe(
				gatesOf.length,
			);
		for (const notice of HOOK_NOTICES)
			expect(
				heads.some((h) => h.includes(notice)),
				notice,
			).toBe(true);
	});
});

describe("final-message checks", () => {
	it("reads a recorded round's banded figures and glossed citation, and no priced form outside it", () => {
		expect(roundRun.finalMessage).toEqual({
			pricedOutsideRound: false,
			bandedFigures: 3,
			unbandedConfidence: 0,
			identifiers: 1,
			glossed: 1,
		});
	});

	it("counts the citation outside code spans, so a quoted #1650 is no identifier", () => {
		expect(refusedRun.finalMessage).toEqual({
			pricedOutsideRound: false,
			bandedFigures: 0,
			unbandedConfidence: 0,
			identifiers: 1,
			glossed: 1,
		});
	});

	it("flags the lettered priced form once the round's marker is gone, and a Confidence line with no band", () => {
		const final = lines(ROUND)
			.flatMap((r: LogRecord) =>
				r.type === "assistant" ? (r.message?.content ?? []) : [],
			)
			.filter((b: Block) => b.type === "text" && b.text !== "(trimmed)")
			.map((b: Block) => b.text)
			.join("\n");
		const unmarked = final
			.replace(/^❓ \*\*Q1\*\*/m, "Q1")
			.replace("Confidence: 60% (50% - 70%)", "Confidence: 60%");
		expect(finalOf(unmarked)).toMatchObject({
			pricedOutsideRound: true,
			bandedFigures: 2,
			unbandedConfidence: 1,
		});
	});

	it("counts a bare citation as unglossed", () => {
		expect(
			finalOf("Fixed #12 (the retry ticket); see #13 and §N2."),
		).toMatchObject({ identifiers: 3, glossed: 1 });
	});

	it("reads no final message where the session wrote no text", () => {
		expect(secondaryOf("", subjects).finalMessage).toBeNull();
	});
});

describe("an arm's summary", () => {
	it("sums the counts and splits refusals by gate across runs", () => {
		const s = summariseSecondary([refusedRun, roundRun]);
		expect(s.warnsActedAgainst).toMatchObject({
			actedAgainst: 0,
			warnedCalls: 5,
		});
		expect(s.commitGateRefusals.byGate).toEqual({ "citation-tracker": 1 });
		expect(s.commitGateRefusals.perRun.mean).toBe(0.5);
		expect(s.finalMessage).toMatchObject({
			read: 2,
			pricedOutsideRound: 0,
			identifiers: 2,
			glossed: 2,
		});
		expect(s.finalMessage.bandedFigures.mean).toBe(1.5);
	});
});
