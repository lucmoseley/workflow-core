// @vitest-environment node
/*
 * The scheduled roadmap-ceiling census (mantahostels#3334, landing mantahostels#3188's ruling (C)
 * first limb) — a standing report of every non-done card carrying a field
 * over its word ceiling, on `report-doc-map-budget.js`'s test harness. The two
 * reporters' empty states differ: this one files nothing once every row is
 * capOk-exempt, the budget one files under `takes:wayfinder` (mantahostels#3352).
 *
 * `main` runs through `runInProcess` (§X3).
 * `gh` is stubbed as a real executable injected at WFC_GH (`scripts/lib/gh.js`).
 *
 * The script runs in the daily repo-checks run
 * and files rather than fails: loosen a case here and an over-ceiling card
 * goes unreported, an exempt-only census files noise, or a second issue opens
 * beside the standing one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	card,
	roadmapHtml,
} from "../.claude/skills/roadmap-edit/scripts/roadmap-fixture";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-roadmap-ceilings.js");
const {
	overCeilingRows,
	verdict,
	TITLE,
	LABEL,
	payable,
} = require("./report-roadmap-ceilings.js");
const {
	BODY_WORD_CEILING,
	FIELD_WORD_CEILINGS,
} = require("../.claude/skills/roadmap-edit/scripts/validate.js");

const ceiling = (field: string): number =>
	field === "b"
		? BODY_WORD_CEILING
		: FIELD_WORD_CEILINGS.find((f: { field: string }) => f.field === field)
				.ceiling;

const words = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("overCeilingRows", () => {
	it("skips done cards", () => {
		const items = [
			card({ id: "done-card", state: "done", b: words(ceiling("b") + 10) }),
		];
		expect(overCeilingRows(items)).toEqual([]);
	});

	it("finds a card over the body ceiling", () => {
		const items = [card({ id: "over", b: words(ceiling("b") + 5) })];
		const rows = overCeilingRows(items);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "over",
			field: "b",
			ceiling: ceiling("b"),
			excess: 5,
			capOk: null,
		});
	});

	it("finds all four other ceilinged fields, not only b", () => {
		const items = [
			card({
				id: "multi",
				mn: words(ceiling("mn") + 1),
				log: words(ceiling("log") + 2),
				dw: words(ceiling("dw") + 3),
				c: { type: "info", k: "k", x: words(ceiling("c.x") + 4) },
			}),
		];
		const rows = overCeilingRows(items);
		expect(rows.map((r: { field: string }) => r.field).sort()).toEqual([
			"c.x",
			"dw",
			"log",
			"mn",
		]);
	});

	it("sorts by excess descending", () => {
		const items = [
			card({ id: "small", b: words(ceiling("b") + 2) }),
			card({ id: "big", b: words(ceiling("b") + 20) }),
			card({ id: "mid", b: words(ceiling("b") + 10) }),
		];
		expect(overCeilingRows(items).map((r: { id: string }) => r.id)).toEqual([
			"big",
			"mid",
			"small",
		]);
	});

	it("annotates a capOk exemption without dropping the row (mantahostels#3189)", () => {
		const items = [
			card({
				id: "exempt",
				b: words(ceiling("b") + 5),
				capOk: { b: 1234 },
			}),
		];
		const rows = overCeilingRows(items);
		expect(rows).toHaveLength(1);
		expect(rows[0].capOk).toBe(1234);
	});
});

describe("verdict", () => {
	it("reports nothing over as empty", () => {
		expect(verdict([])).toBe(
			"No non-done card is over any field's word ceiling.",
		);
	});

	it("counts distinct cards separately from field rows", () => {
		const rows = [
			{
				id: "a",
				field: "b",
				excess: 5,
				words: 1,
				ceiling: 1,
				p: 0,
				capOk: null,
			},
			{
				id: "a",
				field: "mn",
				excess: 3,
				words: 1,
				ceiling: 1,
				p: 0,
				capOk: null,
			},
			{
				id: "b",
				field: "b",
				excess: 2,
				words: 1,
				ceiling: 1,
				p: 1,
				capOk: null,
			},
		];
		const v = verdict(rows);
		expect(v).toContain("2 non-done card(s)");
		expect(v).toContain("3 field(s) total");
		expect(v).toContain("10 words of total excess");
	});
});

const temps: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

function fixture(opts: {
	cards: Parameters<typeof card>[0][];
	ghIssueList?: unknown;
	/** The issue's body before the run; absent, an empty one. */
	existingBody?: string;
}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-ceilings-"));
	temps.push(root);

	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "docs", "reference-roadmap.html"),
		roadmapHtml(opts.cards.map((c) => card(c))),
	);

	const issueBody = fakeIssueBody(root, opts.existingBody);

	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const argvLog = path.join(root, "gh-argv.log");
	const ghStub = path.join(bin, "gh");
	fs.writeFileSync(
		ghStub,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
			`  cat ${JSON.stringify(path.join(root, "issues.json"))}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
			`  cat ${JSON.stringify(issueBody.bodyFile)}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
			"  echo https://github.com/o/r/issues/999",
			'elif [ "$1" = "issue" ] && [ "$2" = "edit" ]; then',
			"  exit 0",
			"fi",
			"exit 0",
		].join("\n"),
	);
	fs.chmodSync(ghStub, 0o755);
	fs.writeFileSync(
		path.join(root, "issues.json"),
		JSON.stringify(opts.ghIssueList ?? []),
	);

	return { root, ghStub, argvLog, issueBody };
}

function run(fx: ReturnType<typeof fixture>, ...args: string[]) {
	const r = runInProcess(SCRIPT, args, {
		cwd: fx.root,
		env: {
			...process.env,
			WFC_GH: fx.ghStub,
			WFC_ISSUE_BODY: fx.issueBody.script,
		},
	});
	return { code: r.status, output: r.stdout + r.stderr };
}

const USAGE =
	"usage: node report-roadmap-ceilings.js [<roadmap.html>] [--dry-run]";

const ghCalls = (fx: ReturnType<typeof fixture>): string =>
	fs.existsSync(fx.argvLog) ? fs.readFileSync(fx.argvLog, "utf8") : "";

describe("main", () => {
	it("under nothing-over, exits 0 and touches gh not at all", () => {
		const fx = fixture({ cards: [{ id: "fine", state: "done" }] });
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.code).toBe(0);
		expect(r.output).toContain("Nothing over — nothing to file.");
		expect(ghCalls(fx)).toBe("");
	});

	it("--dry-run prints the verdict and files nothing", () => {
		const fx = fixture({
			cards: [{ id: "over", b: words(ceiling("b") + 5) }],
		});
		const r = run(fx, "docs/reference-roadmap.html", "--dry-run");
		expect(r.code).toBe(0);
		expect(r.output).toContain("1 non-done card(s)");
		expect(r.output).toContain("--dry-run: no issue filed or refreshed.");
		expect(ghCalls(fx)).toBe("");
	});

	it("files a fresh issue with the queue and the takes:implement label", () => {
		const fx = fixture({
			cards: [{ id: "over", b: words(ceiling("b") + 5) }],
		});
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.code).toBe(0);
		expect(r.output).toContain("Filed https://github.com/o/r/issues/999");
		const calls = ghCalls(fx);
		expect(calls).toContain(`issue create --title ${TITLE}`);
		expect(calls).toContain(LABEL);
		expect(calls).toContain("takes:implement");
	});

	// mantahostels#3352: a capOk row is a ratified floor, not work, so a fully-exempt census
	// files nothing and never carries takes:human.
	it("files nothing and touches gh not at all when every over-ceiling row is capOk-exempt", () => {
		const fx = fixture({
			cards: [
				{
					id: "over",
					b: words(ceiling("b") + 5),
					capOk: { b: 3352 },
				},
			],
		});
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.code).toBe(0);
		expect(r.output).toContain("1 of the 1 carry a capOk exemption");
		expect(r.output).toContain(
			"Every over-ceiling row carries a capOk exemption — nothing to file.",
		);
		expect(ghCalls(fx)).toBe("");
	});

	it("files under takes:implement on a mixed census — one unexempted row is enough", () => {
		const fx = fixture({
			cards: [
				{ id: "floor", b: words(ceiling("b") + 5), capOk: { b: 3368 } },
				{ id: "over", b: words(ceiling("b") + 5) },
			],
		});
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.code).toBe(0);
		const calls = ghCalls(fx);
		expect(calls).toContain("--label takes:implement");
		expect(calls).not.toContain("takes:human");
	});

	it("refreshes the existing open issue rather than creating a second", () => {
		const fx = fixture({
			cards: [{ id: "over", b: words(ceiling("b") + 5) }],
			ghIssueList: [{ number: 42, title: TITLE, labels: [{ name: LABEL }] }],
		});
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.code).toBe(0);
		expect(r.output).toContain("Refreshed #42");
		expect(ghCalls(fx)).not.toContain("issue create");
	});

	it("prints no phase line when nothing is over", () => {
		const fx = fixture({ cards: [{ id: "fine" }] });
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.output).not.toContain("By phase");
	});

	it("sums excess per phase actually present, in phase order", () => {
		const fx = fixture({
			cards: [
				{ id: "a", p: 1, b: words(ceiling("b") + 5) },
				{ id: "b", p: 0, b: words(ceiling("b") + 3) },
				{ id: "c", p: 1, b: words(ceiling("b") + 2) },
			],
		});
		const r = run(fx, "docs/reference-roadmap.html", "--dry-run");
		expect(r.output).toContain("By phase: P0 3 / P1 7.");
	});

	it("files a body listing a queue row and a capOk annotation for an exempted row", () => {
		const fx = fixture({
			cards: [
				{ id: "c1", b: words(ceiling("b") + 5) },
				{ id: "c2", mn: words(ceiling("mn") + 1), capOk: { mn: 999 } },
			],
			ghIssueList: [{ number: 42, title: TITLE, labels: [{ name: LABEL }] }],
		});
		expect(run(fx, "docs/reference-roadmap.html").code).toBe(0);
		const b = fx.issueBody.body();
		expect(b).toContain(
			`§c1 \`b\`: ${ceiling("b") + 5} words, 5 over the ${ceiling("b")}-word ceiling`,
		);
		expect(b).toContain(
			`§c2 \`mn\`: ${ceiling("mn") + 1} words, 1 over the ${ceiling("mn")}-word ceiling`,
		);
		expect(b).toContain("capOk` exemption (#999)");
		expect(b).toContain(
			"a ratified floor, listed for the record (mantahostels#3189)",
		);
		expect(b).toContain("1 of the 2 carry a capOk exemption");
		expect(b).toContain("Close this issue once no unexempted row remains");
		expect(b).not.toContain("takes:human");
	});

	it("exits 2 on an unreadable roadmap", () => {
		const fx = fixture({ cards: [{ id: "fine", state: "done" }] });
		const r = run(fx, "docs/does-not-exist.html");
		expect(r.code).toBe(2);
		expect(r.output).toContain("cannot read roadmap");
	});

	it("exits 2 on a roadmap that does not parse", () => {
		const fx = fixture({ cards: [{ id: "fine", state: "done" }] });
		fs.writeFileSync(
			path.join(fx.root, "docs", "reference-roadmap.html"),
			"<!doctype html><html><body>not a roadmap</body></html>",
		);
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.code).toBe(2);
		expect(r.output).toContain("cannot parse");
	});

	// A card over its ceiling with no issue open, so a fall-through would file (#1062).
	const overFixture = () =>
		fixture({ cards: [{ id: "over", b: words(ceiling("b") + 5) }] });

	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const fx = overFixture();
			const r = run(fx, flag);
			expect(r.code).toBe(0);
			expect(r.output).toContain(USAGE);
			expect(ghCalls(fx)).toBe("");
		}
	});

	it("never reads -h as the roadmap path, even where a file of that name exists", () => {
		const fx = overFixture();
		fs.copyFileSync(
			path.join(fx.root, "docs", "reference-roadmap.html"),
			path.join(fx.root, "-h"),
		);
		const r = run(fx, "-h");
		expect(r.code).toBe(0);
		expect(r.output).toContain(USAGE);
		expect(ghCalls(fx)).toBe("");
	});

	it("answers --help before the module gate, so roadmap off still prints usage", () => {
		const fx = overFixture();
		vi.stubEnv("WFC_MODULES", "");
		const r = run(fx, "--help");
		expect(r.code).toBe(0);
		expect(r.output).toContain(USAGE);
		expect(r.output).not.toContain("SKIP");
	});

	it("refuses an unknown flag, naming it and the usage, exits non-zero, and calls gh not at all", () => {
		const fx = overFixture();
		const r = run(fx, "--dryrun");
		expect(r.code).toBe(2);
		expect(r.output).toContain("unknown flag: --dryrun");
		expect(r.output).toContain(USAGE);
		expect(ghCalls(fx)).toBe("");
	});

	it("refuses a second roadmap path, naming it, exits non-zero, and calls gh not at all", () => {
		const fx = overFixture();
		const r = run(
			fx,
			"docs/reference-roadmap.html",
			"docs/reference-roadmap.html",
		);
		expect(r.code).toBe(2);
		expect(r.output).toContain(
			"unexpected argument: docs/reference-roadmap.html",
		);
		expect(ghCalls(fx)).toBe("");
	});

	it("exits 2 when gh refuses to list issues, saying it could not file or refresh", () => {
		const fx = fixture({
			cards: [{ id: "over", b: words(ceiling("b") + 5) }],
		});
		fs.writeFileSync(
			fx.ghStub,
			["#!/bin/sh", "echo gh refused >&2", "exit 1"].join("\n"),
		);
		fs.chmodSync(fx.ghStub, 0o755);
		const r = run(fx, "docs/reference-roadmap.html");
		expect(r.code).toBe(2);
		expect(r.output).toContain("could not file or refresh");
	});
});

describe("payable", () => {
	it("keeps only the rows no capOk ruling covers", () => {
		expect(
			payable([{ capOk: 3352 }, { capOk: null }, { capOk: 3368 }]),
		).toEqual([{ capOk: null }]);
	});

	it("is empty when every row is exempt, and when nothing is over at all", () => {
		expect(payable([{ capOk: 3352 }, { capOk: 3368 }])).toEqual([]);
		expect(payable([])).toEqual([]);
	});
});
