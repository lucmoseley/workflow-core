// @vitest-environment node

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process";

const { readLabelRows, recordedScores, report } = createRequire(__filename)(
	"./lib/fix-or-file-rates.js",
);

const pct = (cell: string) =>
	cell === "n/a" ? null : Number(cell.slice(0, -1));

function rowAt(rows: unknown[], threshold: number) {
	const line = (report(rows) as string[]).find((l) =>
		l.trim().startsWith(threshold.toFixed(1)),
	);
	const [, tpr, tnr, fires, tp, fp, unjudged, effectiveFp] = (line ?? "")
		.trim()
		.split(/\s+/);
	return {
		tpr: pct(tpr),
		tnr: pct(tnr),
		fires: Number(fires),
		tp: Number(tp),
		fp: Number(fp),
		unjudged: Number(unjudged),
		effectiveFp: pct(effectiveFp),
	};
}

const ROOT = path.resolve(__dirname, "..");
const LABELS = path.join(
	ROOT,
	"docs/data/fix-or-file-labels-2026-11-28/labels.jsonl",
);
const NATURAL = path.join(
	ROOT,
	"docs/data/fix-or-file-labels-2026-11-28/natural.jsonl",
);

const PRIVATE_REPOS = ["mantahostels", "health-and-fitness", "fantasy-books"];

// #5814
const PER_LABEL = { min: 30, max: 50 };

const scored = [
	{ id: "a", label: true, kind: "lost", p: 0.9 },
	{ id: "b", label: true, kind: "lost", p: 0.4 },
	{ id: "c", label: false, kind: "handled", p: 0.6 },
	{ id: "d", label: false, kind: "none", p: 0.1 },
	{ id: "e", label: null, kind: "natural", p: 0.7 },
	{ id: "f", label: null, kind: "natural", p: 0.2 },
];

describe("the fix-or-file scorer's rates (#5827)", () => {
	it("counts a reply at the threshold as a fire", () => {
		expect(rowAt(scored, 0.6)).toMatchObject({ fires: 3, tp: 1, fp: 1 });
	});

	it("reads TPR and TNR over judged replies only", () => {
		const r = rowAt(scored, 0.5);
		expect(r.tpr).toBe(50);
		expect(r.tnr).toBe(50);
	});

	it("leaves an unjudged fire out of the effective false-positive rate", () => {
		const r = rowAt(scored, 0.5);
		expect(r.unjudged).toBe(1);
		expect(r.effectiveFp).toBe(50);
	});

	it("reports no rate where nothing judged fired", () => {
		const low = scored.map((r) => ({ ...r, p: Math.min(r.p, 0.2) }));
		expect(rowAt(low, 0.9)).toMatchObject({
			fires: 0,
			tpr: 0,
			effectiveFp: null,
		});
	});

	it("says how many replies of each label it scored", () => {
		expect(report(scored)[0]).toBe(
			"6 replies scored: 2 positive, 2 negative, 2 unjudged.",
		);
	});
});

describe("the committed fix-or-file data (#5827)", () => {
	it.each([LABELS, NATURAL])(
		"%s carries no reply text from a private repo",
		(file) => {
			const leaked = readLabelRows(file).filter(
				(r: { repo: string; text?: string }) =>
					PRIVATE_REPOS.includes(r.repo) && r.text !== undefined,
			);
			expect(leaked).toEqual([]);
		},
	);

	it("holds 30 to 50 examples of each label", () => {
		const labels = readLabelRows(LABELS).map(
			(r: { label: boolean | null }) => r.label,
		);
		for (const want of [true, false]) {
			const n = labels.filter((l: boolean | null) => l === want).length;
			expect(n).toBeGreaterThanOrEqual(PER_LABEL.min);
			expect(n).toBeLessThanOrEqual(PER_LABEL.max);
		}
	});

	it("reproduces the labelled set's published TNR from its recorded scores", () => {
		const s = recordedScores(readLabelRows(LABELS));
		expect(s).toHaveLength(93);
		expect(rowAt(s, 0.5).tnr).toBe(82);
		expect(rowAt(s, 0.7).tnr).toBe(96);
	});

	it("reproduces the natural sample's published effective false positives", () => {
		const s = recordedScores(readLabelRows(NATURAL));
		expect(s).toHaveLength(131);
		expect([0.5, 0.6, 0.7].map((t) => rowAt(s, t).effectiveFp)).toEqual([
			58, 56, 25,
		]);
	});
});

const { rehydrate, transcriptIndex } = createRequire(__filename)(
	"./lib/fix-or-file-rehydrate.js",
);

const textHash = (text: string) =>
	crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
const { claudeArgs, claudePrompt, parseClaudeVerdict } = createRequire(
	__filename,
)("./lib/fix-or-file-claude.js");

describe("rehydrating a private row from its local transcript (#5833)", () => {
	const Reply = "The scan reads main's config, and I left it.";
	let home: string;

	beforeAll(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "fix-or-file-home-"));
		const dir = path.join(home, ".claude3", "projects", "-repo");
		fs.mkdirSync(dir, { recursive: true });
		const turn = (text: string) =>
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text }] },
			});
		fs.writeFileSync(
			path.join(dir, "e3fd2f2c-0000-0000-0000-000000000000.jsonl"),
			`${turn("Another reply.")}\n${turn(Reply)}\n`,
		);
	});

	afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

	const row = (transcript: string, hash = textHash(Reply)) => ({
		id: "r",
		transcript,
		textHash: hash,
	});

	it.each(["e3fd2f2c", "claude3__e3fd2f2c", "mh__claude3__e3fd2f2c"])(
		"finds the reply whose hash the row carries, named %s",
		(transcript) => {
			const { rows, unresolved } = rehydrate(
				[row(transcript)],
				transcriptIndex(home),
			);
			expect(rows[0].text).toBe(Reply);
			expect(unresolved).toEqual([]);
		},
	);

	it("reports a row no transcript reply matches, and leaves it textless", () => {
		const { rows, unresolved } = rehydrate(
			[row("claude3__e3fd2f2c", "0000000000000000"), row("claude3__ffffffff")],
			transcriptIndex(home),
		);
		expect(rows.map((r: { text?: string }) => r.text)).toEqual([
			undefined,
			undefined,
		]);
		expect(unresolved).toEqual(["r", "r"]);
	});

	it.each([LABELS, NATURAL])(
		"%s names a transcript and a hash on every textless row",
		(file) => {
			const orphans = readLabelRows(file).filter(
				(r: { text?: string; transcript?: string; textHash?: string }) =>
					r.text === undefined && !(r.transcript && r.textHash),
			);
			expect(orphans).toEqual([]);
		},
	);

	it("matches the committed rows' hashes", () => {
		const withText = readLabelRows(NATURAL).find(
			(r: { text?: string; textHash?: string }) => r.text && r.textHash,
		);
		expect(textHash(withText.text)).toBe(withText.textHash);
	});
});

describe("the Claude-model route (#5833)", () => {
	const Q = {
		type: "boolean",
		instructions: "Does it leave a defect?",
		criteria: { true: "it leaves one", false: "it leaves none" },
	};

	it("runs with no hooks and no tools", () => {
		const args = claudeArgs({ model: "haiku" });
		expect(args[args.indexOf("--settings") + 1]).toBe(
			JSON.stringify({ disableAllHooks: true }),
		);
		expect(args[args.indexOf("--tools") + 1]).toBe("");
	});

	it("puts the question, both criteria and the message", () => {
		const prompt = claudePrompt(Q, "the reply");
		for (const part of [
			Q.instructions,
			Q.criteria.true,
			Q.criteria.false,
			"the reply",
		])
			expect(prompt).toContain(part);
	});

	it("reads a probability that ends a reasoned answer", () => {
		expect(
			parseClaudeVerdict(JSON.stringify({ result: "It leaves one.\n\n0.96" }))
				.p,
		).toBe(0.96);
	});

	it("reads the probability and the call's cost", () => {
		expect(
			parseClaudeVerdict(
				JSON.stringify({ result: " 0.7\n", total_cost_usd: 0.001 }),
			),
		).toEqual({ p: 0.7, costUsd: 0.001 });
	});

	it.each([
		["an error result", { is_error: true, result: "Not logged in" }],
		["a word", { result: "yes" }],
		["a number above 1", { result: "70" }],
		["a number inside prose", { result: "About 0.7, I think." }],
	])("refuses %s", (_name, out) => {
		expect(() => parseClaudeVerdict(JSON.stringify(out))).toThrow();
	});
});

describe("the fix-or-file scorer as a program (#5833)", () => {
	const Scorer = path.join(__dirname, "score-fix-or-file.js");
	let dir: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-or-file-run-"));
	});

	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	const env = (extra: NodeJS.ProcessEnv = {}) => {
		const base: NodeJS.ProcessEnv = {
			...process.env,
			WFC_SECRETS_FILE: path.join(dir, "absent.env"),
			HOME: dir,
		};
		delete base.AI_GATEWAY_API_KEY;
		return { ...base, ...extra };
	};

	it("refuses a route it does not know, exit 2", async () => {
		const res = await runInProcessAsync(Scorer, ["--route", "bard"], {
			env: env(),
		});
		expect(res.status).toBe(2);
	});

	it("refuses to score on jev with no gateway key, exit 2", async () => {
		const res = await runInProcessAsync(Scorer, ["--labels", LABELS], {
			env: env(),
		});
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("nothing can be scored");
	});

	it("reports from the recorded scores with no call, exit 0", async () => {
		const res = await runInProcessAsync(
			Scorer,
			["--recorded", "--labels", LABELS],
			{
				env: env(),
			},
		);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("replies scored");
	});

	it("skips a reply its model fails on and scores the rest, with their cost", async () => {
		const labels = path.join(dir, "rows.jsonl");
		fs.writeFileSync(
			labels,
			`${[
				{
					id: "good",
					repo: "r",
					label: true,
					kind: "lost",
					text: "a good reply",
				},
				{
					id: "bad",
					repo: "r",
					label: false,
					kind: "none",
					text: "a failing reply",
				},
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		const stub = path.join(dir, "claude-stub.sh");
		fs.writeFileSync(
			stub,
			'#!/bin/sh\nif grep -q good; then echo \'{"result":"0.9","total_cost_usd":0.002}\'; else exit 1; fi\n',
			{ mode: 0o755 },
		);
		const res = await runInProcessAsync(
			Scorer,
			["--labels", labels, "--route", "claude"],
			{ env: env({ WFC_CLAUDE_BIN: stub }) },
		);
		expect(res.stderr).toContain("bad: not scored");
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("1 replies scored");
		expect(res.stdout).toContain("cost: $0.0020 over 1 replies");
	});
});
