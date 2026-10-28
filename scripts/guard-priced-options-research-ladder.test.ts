// @vitest-environment node
/*
 * guard-priced-options-research-ladder.test.ts — the research-ladder limb
 * (#2006): a question the close-rivals limb refused, re-sent still caught
 * by its close or low-top test (#2328), is refused while any rung — past rulings, the web, a fresh subagent —
 * lacks a qualifying tool call since that refusal.
 *
 * The guard runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a call shape and a still-caught question reaches
 * the founder on research he would have asked for; tighten one and a session
 * that climbed the ladder is refused for ever, until the cap.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LADDER, sessionCounters } from "./lib/priced-options-testkit";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import {
	buildToolCall,
	LATER,
	researchCalls,
	transcriptRecords,
	writeTranscript,
} from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");
const { CLOSE_CHECK_LOG, RESEARCH_LADDER_PREFIX, limbOf } = createRequire(
	__filename,
)("./lib/priced-options-limbs.js");
const { logPath } = createRequire(__filename)("./lib/refusal-log.js");
const { readJsonl } = createRequire(__filename)("./lib/jev-log.js");
const { markersDir } = createRequire(__filename)("./lib/marker-root.js");

const { reset, founder } = transcriptRecords("2026-09-27T10:00:00Z");

const CORPUS = ["acme/core", "acme/inherited"];
const CLOSE = "so the recommendation could flip";
const RUNG = {
	rulings: "rung 1, past rulings",
	web: "rung 2, web or vendor docs",
	subagent: "rung 3, a fresh subagent",
};
type Rung = keyof typeof RUNG;

let dir: string;
let file: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-ladder-"));
	file = path.join(dir, "transcript.jsonl");
	sid = `research-ladder-${Math.random().toString(36).slice(2)}`;
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "F", corpus: CORPUS }),
	);
	reset();
	/* Past the under-researched-round limb's floor, which this file does not test. */
	writeTranscript(
		file,
		founder(),
		...researchCalls().map((c) => JSON.stringify(c)),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const stop = (message: string) =>
	readStopGuardReason(GUARD, {
		dir,
		sid,
		message,
		job: false,
		transcript: file,
	});

const CLOSE_ROUND =
	"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
	"(A) option A\nConfidence: 55% (45% - 65%). why\n\n" +
	"(B) option B\nConfidence: 45% (35% - 55%). why\n\n➡ (A).";
const CLEAR_ROUND =
	"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
	"(A) option A\nConfidence: 85% (80% - 90%). a fact found\n\n" +
	"(B) option B\nConfidence: 15% (10% - 20%). why\n\n➡ (A).";

/* Stamped after the wall-clock time the refusal record carries. */
let seq = 0;
const call = (name: string, input: Record<string, unknown>) => {
	seq++;
	return JSON.stringify(
		buildToolCall(name, input, `c${seq}`, {
			timestamp: new Date(Date.now() + LATER + seq).toISOString(),
		}),
	);
};
const bash = (command: string) => call("Bash", { command });
const append = (...lines: string[]) =>
	fs.appendFileSync(file, `${lines.join("\n")}\n`);

const QUALIFYING: Record<Rung, string> = {
	rulings: bash('gh search issues --repo acme/core "retry limit"'),
	web: call("WebSearch", { query: "retry limit" }),
	subagent: call("Agent", { prompt: "find the fact", description: "x" }),
};

/** Refuse Q1 on first sight, as the close-rivals limb does. */
const refuseOnce = () => expect(stop(CLOSE_ROUND)).toContain(CLOSE);

const closeLog = () => readJsonl(logPath(dir, CLOSE_CHECK_LOG))?.lines ?? [];
const { counter, seed } = sessionCounters(() => ({ dir, sid }));

describe("which rungs are missing", () => {
	const rungs: Rung[] = ["rulings", "web", "subagent"];
	/* Every proper subset of rungs tried. */
	const tried = [
		[],
		["rulings"],
		["web"],
		["subagent"],
		["rulings", "web"],
		["rulings", "subagent"],
		["web", "subagent"],
	] as Rung[][];

	it.each(tried.map((t) => [t.join("+") || "none", t]))(
		"refuses a still-close re-send with %s tried, naming only the rest",
		(_name, t) => {
			refuseOnce();
			append(...(t as Rung[]).map((r) => QUALIFYING[r]));
			const reason = stop(CLOSE_ROUND);
			expect(reason).toContain(LADDER);
			for (const r of rungs)
				if ((t as Rung[]).includes(r)) expect(reason).not.toContain(RUNG[r]);
				else expect(reason).toContain(RUNG[r]);
		},
	);

	it("passes a still-close re-send once every rung shows a call", () => {
		refuseOnce();
		append(QUALIFYING.rulings, QUALIFYING.web, QUALIFYING.subagent);
		expect(stop(CLOSE_ROUND)).toBe("");
	});

	it("counts no call made before the first refusal", () => {
		const stampedEarly = (line: string) => {
			const rec = JSON.parse(line);
			rec.timestamp = "2026-09-27T10:00:30Z";
			return JSON.stringify(rec);
		};
		append(
			stampedEarly(QUALIFYING.rulings),
			stampedEarly(QUALIFYING.web),
			stampedEarly(QUALIFYING.subagent),
		);
		refuseOnce();
		expect(stop(CLOSE_ROUND)).toContain(LADDER);
	});

	it("gives the method in order, the budgets, the subagent prompt and the delegated line", () => {
		refuseOnce();
		const reason = stop(CLOSE_ROUND);
		const pos = (s: string) => reason.indexOf(s);
		expect(pos(RUNG.rulings)).toBeLessThan(pos(RUNG.web));
		expect(pos(RUNG.web)).toBeLessThan(pos(RUNG.subagent));
		expect(reason).toContain("`acme/core`, `acme/inherited`");
		expect(reason).toContain("Up to 5 calls");
		expect(reason).toContain("Up to 10 calls");
		expect(reason).toContain("at most 15 tool calls");
		expect(reason).toContain(
			"find the single fact that makes the runner-up win, and cite the tool result",
		);
		expect(reason.trimEnd()).toMatch(
			/record it with `node scripts\/record-delegated-decision\.js <n> …`, its rungs and what each found\.$/,
		);
	});
});

describe("qualifying calls", () => {
	/* Each case's other two rungs tried, so the call under test decides. */
	const others = (rung: Rung) =>
		(Object.keys(QUALIFYING) as Rung[])
			.filter((r) => r !== rung)
			.map((r) => QUALIFYING[r]);

	it.each([
		[
			"gh search issues on a corpus tracker",
			"rulings",
			'gh search issues --repo acme/core "x"',
		],
		[
			"gh search issues naming no repo",
			"rulings",
			"gh search issues retry limit",
		],
		[
			"gh search issues by repo: qualifier",
			"rulings",
			'gh search issues "repo:acme/inherited x"',
		],
		[
			"gh search issues by --owner",
			"rulings",
			"gh search issues --owner acme x",
		],
		[
			"gh search issues --state closed",
			"rulings",
			"gh search issues --state closed x",
		],
		[
			"gh issue list --state all --search",
			"rulings",
			'gh issue list --state all --search "x"',
		],
		[
			"gh issue list -s closed -S",
			"rulings",
			"gh issue list -s closed -S x --repo acme/core",
		],
		[
			"gh issue list --state=all --search=",
			"rulings",
			"gh issue list --state=all --search=x",
		],
		["a search after cd &&", "rulings", 'cd /x && gh search issues "y" | head'],
		["a search behind timeout", "rulings", "timeout 30 gh search issues x"],
		["a search behind watch", "rulings", "watch -n 2 gh search issues x"],
		[
			"a search inside $(…)",
			"rulings",
			'hits=$(gh issue list --state all --search "x") && echo "$hits"',
		],
		[
			"a search inside a quoted $(…)",
			"rulings",
			'hits="$(gh issue list --state all --search "x")" && echo "$hits"',
		],
		[
			"a search inside backticks",
			"rulings",
			'hits=`gh search issues x` && echo "$hits"',
		],
		[
			"gh's own -R before the command word",
			"rulings",
			"gh -R acme/core issue list --state all -S x",
		],
		[
			"gh's own -R before search issues",
			"rulings",
			"gh -R acme/core search issues x",
		],
	])("counts %s", (_name, rung, command) => {
		refuseOnce();
		append(...others(rung as Rung), bash(command));
		expect(stop(CLOSE_ROUND)).toBe("");
	});

	it.each([
		["WebFetch", "web", call("WebFetch", { url: "https://x.test" })],
		[
			"Task, the subagent tool's older name",
			"subagent",
			call("Task", { prompt: "p" }),
		],
	])("counts %s", (_name, rung, line) => {
		refuseOnce();
		append(...others(rung as Rung), line);
		expect(stop(CLOSE_ROUND)).toBe("");
	});

	it.each([
		["gh issue list --search, open by default", "gh issue list --search x"],
		["gh issue list --state open", "gh issue list --state open --search x"],
		["gh issue list with no search", "gh issue list --state all"],
		["gh search issues --state open", "gh search issues --state open x"],
		["gh search issues is:open", 'gh search issues "is:open x"'],
		["gh search issues off the corpus", "gh search issues --repo other/repo x"],
		[
			"gh issue list off the corpus",
			"gh issue list --state all -S x -R other/repo",
		],
		["gh issue view", "gh issue view 12"],
		["a search quoted in an echo", "echo 'gh search issues x'"],
		["a search as an unquoted echo's words", "echo gh search issues x"],
		["a search in a heredoc body", "cat <<'EOF'\ngh search issues x\nEOF"],
		[
			"gh's own -R off the corpus",
			"gh -R other/repo issue list --state all -S x",
		],
	])("does not count %s for past rulings", (_name, command) => {
		refuseOnce();
		append(...others("rulings"), bash(command));
		expect(stop(CLOSE_ROUND)).toContain(RUNG.rulings);
	});

	it("does not count a local read of vendor code for the web", () => {
		refuseOnce();
		append(
			...others("web"),
			call("Read", { file_path: "/x/node_modules/vitest/README.md" }),
			bash("cat node_modules/vitest/dist/index.js"),
		);
		expect(stop(CLOSE_ROUND)).toContain(RUNG.web);
	});
});

describe("re-sends the ladder does not judge", () => {
	it("passes a re-send no longer close, with no rung tried", () => {
		refuseOnce();
		append(bash("ls"));
		expect(stop(CLEAR_ROUND)).toBe("");
		expect(counter(RESEARCH_LADDER_PREFIX)).toBe(0);
	});
});

describe("a low-top question re-sent (#2328)", () => {
	const lowTop = (figures: [number, number, number]) =>
		"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
		figures
			.map(
				(f, i) =>
					`(${"ABC"[i]}) option ${"ABC"[i]}\nConfidence: ${f}% (${f - 5}% - ${f + 5}%). why`,
			)
			.join("\n\n") +
		"\n\n➡ (A).";
	/* Top two 40 points apart, bands apart: caught by the low-top test alone. */
	const lowTopRound = lowTop([65, 25, 10]);
	const refuseLowTop = () =>
		expect(stop(lowTopRound)).toContain("so none is likely right");

	it("holds a re-send still at 65 or less on its missing rungs, naming them", () => {
		refuseLowTop();
		append(QUALIFYING.web);
		const reason = stop(lowTop([63, 27, 10]));
		expect(reason).toContain(LADDER);
		expect(reason).toContain("Q1: still caught");
		expect(reason).toContain(RUNG.rulings);
		expect(reason).toContain(RUNG.subagent);
		expect(reason).not.toContain(RUNG.web);
		expect(closeLog().at(-1)).toMatchObject({
			kind: "refused-ladder",
			missing: ["rulings", "subagent"],
		});
	});

	it("passes a re-send lifted to 70 and not close, with no rung tried", () => {
		refuseLowTop();
		append(bash("ls"));
		expect(stop(lowTop([70, 20, 10]))).toBe("");
		expect(counter(RESEARCH_LADDER_PREFIX)).toBe(0);
		expect(closeLog().at(-1)).toMatchObject({
			kind: "passed-after-refusal",
			stillClose: false,
		});
	});

	it("refuses a re-price with no tool call since the refusal", () => {
		refuseLowTop();
		const reason = stop(lowTop([70, 20, 10]));
		expect(reason).toContain(
			"re-priced from (A) 65% (60% - 70%), (B) 25% (20% - 30%), (C) 10% (5% - 15%)",
		);
		expect(reason).not.toContain(LADDER);
		expect(closeLog().at(-1)).toMatchObject({ kind: "refused-reprice" });
	});

	it("logs stillClose true on a laddered re-send the low-top test alone still catches", () => {
		refuseLowTop();
		append(QUALIFYING.rulings, QUALIFYING.web, QUALIFYING.subagent);
		expect(stop(lowTopRound)).toBe("");
		expect(closeLog().at(-1)).toMatchObject({
			kind: "passed-after-refusal",
			stillClose: true,
		});
		expect(closeLog().at(-1)).not.toHaveProperty("missing");
	});
});

describe("its cap", () => {
	it("refuses three times, then lets the re-send through, logged with its rungs missing", () => {
		refuseOnce();
		append(QUALIFYING.web);
		for (let i = 0; i < 3; i++) expect(stop(CLOSE_ROUND)).toContain(LADDER);
		expect(counter(RESEARCH_LADDER_PREFIX)).toBe(
			limbOf(RESEARCH_LADDER_PREFIX).cap,
		);
		expect(stop(CLOSE_ROUND)).toBe("");
		const kinds = closeLog().map((e: { kind: string }) => e.kind);
		expect(kinds).toEqual([
			"refused",
			"refused-ladder",
			"refused-ladder",
			"refused-ladder",
			"passed-after-refusal",
		]);
		expect(closeLog().at(1)).toMatchObject({
			missing: ["rulings", "subagent"],
			slot: 1,
		});
		expect(closeLog().at(-1)).toMatchObject({
			round: "1",
			stillClose: true,
			missing: ["rulings", "subagent"],
		});
	});

	it("says on its last refusal that it will not refuse the re-send", () => {
		refuseOnce();
		seed(RESEARCH_LADDER_PREFIX, limbOf(RESEARCH_LADDER_PREFIX).cap - 1);
		expect(stop(CLOSE_ROUND)).toContain(
			"This is this check's last refusal this session",
		);
	});

	it("logs a laddered pass with no rungs missing", () => {
		refuseOnce();
		append(QUALIFYING.rulings, QUALIFYING.web, QUALIFYING.subagent);
		expect(stop(CLOSE_ROUND)).toBe("");
		expect(closeLog().at(-1)).not.toHaveProperty("missing");
	});
});

describe("what a passed re-send logs for the reading (#2010)", () => {
	const clearRound = (top: "A" | "B", why = "a fact found") =>
		"❓ **Q1** — Which?\n\nRelation: rivals for one slot\n\n" +
		`(A) option A\nConfidence: ${top === "A" ? 85 : 15}% (${top === "A" ? "80% - 90%" : "10% - 20%"}). ${why}\n\n` +
		`(B) option B\nConfidence: ${top === "B" ? 85 : 15}% (${top === "B" ? "80% - 90%" : "10% - 20%"}). ${why}\n\n➡ (${top}).`;
	const passed = () => closeLog().at(-1);

	it("logs each rung's qualifying calls, the top letter kept and no new citation", () => {
		refuseOnce();
		append(
			QUALIFYING.rulings,
			bash('gh issue list --state all --search "retry"'),
			QUALIFYING.web,
			QUALIFYING.subagent,
		);
		expect(stop(CLOSE_ROUND)).toBe("");
		expect(passed()).toMatchObject({
			kind: "passed-after-refusal",
			rungs: { rulings: 2, web: 1, subagent: 1 },
			flipped: false,
			citesNewFact: false,
		});
	});

	it.each([
		"https://docs.example.com/retry",
		"#1894",
		"mantahostels#12",
		"acme/core#7",
		"scripts/lib/retry.js:12",
		"scripts/lib/retry.js:12:5",
		"bin/launch:40",
	])("logs a flip and a new citation where the re-send cites %s", (cite) => {
		refuseOnce();
		append(bash("ls"));
		expect(stop(clearRound("B", `per ${cite}`))).toBe("");
		expect(passed()).toMatchObject({
			rungs: { rulings: 0, web: 0, subagent: 0 },
			flipped: true,
			citesNewFact: true,
		});
	});

	it.each(["a 10:30 call", "50% of C# users", "odds of 3.5:1", "v1.2:3"])(
		"reads no citation in %s",
		(why) => {
			refuseOnce();
			append(bash("ls"));
			expect(stop(clearRound("A", why))).toBe("");
			expect(passed()).toMatchObject({ citesNewFact: false });
		},
	);

	it("counts a URL once whatever punctuation ends its sentence", () => {
		const cited = CLOSE_ROUND.replaceAll(". why", ". per https://x.com/a,");
		expect(stop(cited)).toContain(CLOSE);
		append(bash("ls"));
		expect(stop(clearRound("A", "per https://x.com/a."))).toBe("");
		expect(passed()).toMatchObject({ citesNewFact: false });
	});

	it("does not count a citation the refused send already carried", () => {
		const cited = CLOSE_ROUND.replaceAll(". why", ". per #1894");
		expect(stop(cited)).toContain(CLOSE);
		append(bash("ls"));
		expect(stop(clearRound("A", "per #1894"))).toBe("");
		expect(passed()).toMatchObject({ citesNewFact: false });
	});

	it("logs null for a new citation on a question refused before #2010", () => {
		refuseOnce();
		const record = path.join(markersDir(dir), `.close-rivals-record-${sid}`);
		const written = JSON.parse(fs.readFileSync(record, "utf8"));
		for (const q of written.questions) delete q.cites;
		fs.writeFileSync(record, JSON.stringify(written));
		append(bash("ls"));
		expect(stop(clearRound("A", "per #1894"))).toBe("");
		expect(passed()).toMatchObject({ flipped: false, citesNewFact: null });
	});

	it("logs null rungs where the transcript cannot say", () => {
		refuseOnce();
		fs.rmSync(file);
		expect(stop(CLEAR_ROUND)).toBe("");
		expect(passed()).toMatchObject({ rungs: null, toolCalls: null });
	});
});
