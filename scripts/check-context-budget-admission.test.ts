// @vitest-environment node
/*
 * The admission gate (#2033, #2056): `check-context-budget.js --against HEAD`
 * refuses a commit adding a top-level pool rule — a list item or a bold-led
 * paragraph — that docs/pool-admission-ledger.json does not admit, behind
 * `.claude/workflow-core.json`'s `admissionGate`, and looks ticket states up
 * on the index side alone.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import { textModuleSource, writeTextModule } from "./lib/tracker-text-fixture";

const SCRIPT = path.resolve(__dirname, "check-context-budget.js");
const LEDGER = "docs/pool-admission-ledger.json";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-admission-"));
	vi.stubEnv(
		"WFC_INJECTOR_FILE",
		writeTextModule(dir, textModuleSource("fixture")),
	);
	vi.stubEnv(
		"WFC_RULES_FALLBACK_DIR",
		fs.mkdtempSync(path.join(dir, "rules-")),
	);
	/* No ticket lookup reaches the real tracker. */
	vi.stubEnv("WFC_GH", stubGhScript(dir, "#!/bin/sh\nexit 1\n").gh);
	vi.stubEnv("CLAUDE_PROJECT_DIR", undefined);
	config(true);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function config(on: boolean | undefined) {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			tracker: "o/r",
			...(on === undefined ? {} : { admissionGate: on }),
		}),
	);
}

function write(rel: string, body: string) {
	fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
}

function claude(...items: string[]) {
	write("CLAUDE.md", `# Fixture\n\n${items.map((i) => `- ${i}`).join("\n")}\n`);
}

interface Entry {
	headline: string;
	route?: string;
	ticket?: number;
}
function ledger(...entries: Entry[]) {
	write(
		LEDGER,
		JSON.stringify({
			entries: entries.map(({ headline, route = "no-trigger", ticket }) => ({
				file: "CLAUDE.md",
				headline,
				claim: "A session does the wrong thing",
				route,
				...(ticket === undefined ? {} : { ticket }),
			})),
		}),
	);
}

function git(...args: string[]) {
	const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function baseline() {
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.invalid");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-q", "--no-verify", "-m", "baseline");
}

function stage(...rels: string[]) {
	git("add", "--", ...rels);
}

function spawnGate(...args: string[]) {
	// spawn-kept: a real fd — lib/check.js streams the index side's report to the OS fd through a grandchild.
	return spawnSync("node", [SCRIPT, "--against", "HEAD", ...args], {
		cwd: dir,
		encoding: "utf8",
	});
}

function gate() {
	const r = spawnGate("--json");
	return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) };
}

/* The report a session reads, which --json does not stream. */
function report() {
	const r = spawnGate();
	return { status: r.status, text: r.stdout + r.stderr };
}

const KEPT = "**Keep the tree on `main`.** It is shared.";
const ADDED = "**Never push a branch.** Land on `main`.";

describe("the admission gate at --against HEAD", () => {
	it("refuses an added pool rule that no ledger entry admits", () => {
		claude(KEPT);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		claude(KEPT, ADDED);
		stage("CLAUDE.md");
		const r = gate();
		expect(r.status).not.toBe(0);
		expect(r.json.added).toEqual([
			expect.stringMatching(
				/^unadmitted: CLAUDE\.md:4 adds the pool rule "Never push a branch\.", which docs\/pool-admission-ledger\.json does not admit\./,
			),
		]);
	});

	it("passes the same rule when the commit stages its entry", () => {
		claude(KEPT);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		claude(KEPT, ADDED);
		ledger(
			{ headline: "Keep the tree on `main`." },
			{ headline: "Never push a branch." },
		);
		stage("CLAUDE.md", LEDGER);
		const r = gate();
		expect(r.json.added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("passes a reworded headline whose entry moved with it, and refuses one whose entry did not", () => {
		claude(KEPT);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		claude("**Keep the shared tree on `main`.** It is shared.");
		stage("CLAUDE.md");
		expect(gate().status).not.toBe(0);

		ledger({ headline: "Keep the shared tree on `main`." });
		stage(LEDGER);
		const r = gate();
		expect(r.json.added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("matches a headline's core command at any plugin root, seat or version, and still refuses a reworded one (#5140)", () => {
		const cache = "plugins/cache/workflow-core/workflow-core";
		const wait = (root: string) =>
			`Wait with \`node ${root}scripts/landing-status.js --wait\`.`;
		const rendered = wait(`/home/u/.claude/${cache}/2.3.0/`);
		claude(KEPT);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		claude(KEPT, `**${rendered}** Then land.`);
		stage("CLAUDE.md");
		for (const root of [
			`/home/u/.claude2/${cache}/2.2.0/`,
			`${shellQuote("/home/u/my seat/plugins")}/`,
			`${shellQuote("/home/u/it's/plugins")}/`,
			"",
		]) {
			ledger(
				{ headline: "Keep the tree on `main`." },
				{ headline: wait(root) },
			);
			stage(LEDGER);
			const r = gate();
			expect(r.json.added, root).toEqual([]);
			expect(r.status, root).toBe(0);
		}

		ledger(
			{ headline: "Keep the tree on `main`." },
			{ headline: rendered.replace("Wait with", "Block on") },
		);
		stage(LEDGER);
		const refused = gate();
		expect(refused.status).toBe(1);
		expect(refused.json.added).toEqual([
			expect.stringMatching(
				/^unadmitted: CLAUDE\.md:4 adds the pool rule "Wait with /,
			),
		]);
	});

	it("reads a rule unadmitted at <rev> as inherited where only its plugin root moved (#5140)", () => {
		const rule = (version: string) =>
			`**Wait with \`node /home/u/.claude/plugins/cache/workflow-core/workflow-core/${version}/scripts/landing-status.js --wait\`.** Then land.`;
		claude(KEPT, rule("2.2.0"));
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		claude(KEPT, rule("2.3.0"));
		stage("CLAUDE.md");
		const r = gate();
		expect(r.json.added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("passes everything with the switch off, and with it absent", () => {
		claude(KEPT);
		baseline();
		claude(KEPT, ADDED);
		stage("CLAUDE.md");
		config(false);
		expect(gate().status).toBe(0);
		config(undefined);
		expect(gate().status).toBe(0);
	});

	it("needs nothing for a removed rule", () => {
		claude(KEPT, ADDED);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		claude(KEPT);
		stage("CLAUDE.md");
		const r = gate();
		expect(r.json.added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("passes over a rule the pool held before the ledger did, without reporting it inherited", () => {
		claude(KEPT, ADDED);
		baseline();
		claude(KEPT, `${ADDED} Reworded body.`);
		stage("CLAUDE.md");
		const r = gate();
		expect(r.status).toBe(0);
		expect(r.json.inherited).toEqual([]);
		expect(report().text).not.toContain("INHERITED-FAULT");
	});

	it("refuses an added bold-led paragraph that no ledger entry admits, and passes it with its entry", () => {
		claude(KEPT);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		write(
			"CLAUDE.md",
			"# Fixture\n\n- " +
				KEPT +
				"\n\n**Never push a branch.** Land on `main`.\n",
		);
		stage("CLAUDE.md");
		const r = gate();
		expect(r.status).not.toBe(0);
		expect(r.json.added).toEqual([
			expect.stringMatching(
				/^unadmitted: CLAUDE\.md:5 adds the pool rule "Never push a branch\."/,
			),
		]);

		ledger(
			{ headline: "Keep the tree on `main`." },
			{ headline: "Never push a branch." },
		);
		stage(LEDGER);
		expect(gate().status).toBe(0);
	});

	it("counts no bold line that opens no top-level paragraph: one continuing a paragraph or an item, indented, fenced, or in an HTML comment", () => {
		claude(KEPT);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		write(
			"CLAUDE.md",
			[
				"# Fixture",
				"",
				`- ${KEPT}`,
				"**Lazy continuation.** Joins the item.",
				"",
				"A plain paragraph.",
				"**Mid-paragraph.** Not a rule.",
				"",
				"  **Indented.** Not top level.",
				"",
				"```",
				"**Fenced.** Not a rule.",
				"```",
				"",
				"<!--",
				"**Commented.** Not a rule.",
				"-->",
				"<!-- one line -->",
				"",
			].join("\n"),
		);
		stage("CLAUDE.md");
		const r = gate();
		expect(r.json.added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("looks the ticket states up on the index side alone, so an --against run makes one GraphQL call", () => {
		const calls = path.join(dir, "gh-calls");
		vi.stubEnv(
			"WFC_GH",
			stubGhScript(
				dir,
				`#!/bin/sh\necho x >> ${shellQuote(calls)}\necho '{"data":{"repository":{"i2013":{"state":"CLOSED"}}}}'\n`,
			).gh,
		);
		claude(KEPT);
		ledger({
			headline: "Keep the tree on `main`.",
			route: "trigger",
			ticket: 2013,
		});
		baseline();
		claude(KEPT, ADDED);
		ledger(
			{ headline: "Keep the tree on `main`.", route: "trigger", ticket: 2013 },
			{ headline: "Never push a branch." },
		);
		stage("CLAUDE.md", LEDGER);
		const r = report();
		expect(r.status).toBe(0);
		expect(fs.readFileSync(calls, "utf8")).toBe("x\n");
		expect(r.text).toContain(
			'#2013 closed, its rule still in CLAUDE.md: "Keep the tree on `main`."',
		);
		expect(r.text).not.toContain("NEW-NOTE");
	});

	it("refuses a staged ledger entry that routes by trigger and names no ticket", () => {
		claude(KEPT);
		ledger({ headline: "Keep the tree on `main`." });
		baseline();
		ledger({ headline: "Keep the tree on `main`.", route: "trigger" });
		stage(LEDGER);
		const r = gate();
		expect(r.status).not.toBe(0);
		expect(r.json.summary).toMatch(/routes by "trigger" and names no "ticket"/);
	});

	it("prints the rule count, and reports a trigger entry whose ticket has closed while its rule is still in the pool, never refusing on it", () => {
		vi.stubEnv(
			"WFC_GH",
			stubGhScript(
				dir,
				`#!/bin/sh\necho '{"data":{"repository":{"i2013":{"state":"CLOSED"},"i2015":{"state":"OPEN"}}}}'\n`,
			).gh,
		);
		claude(KEPT, ADDED);
		ledger(
			{ headline: "Keep the tree on `main`.", route: "trigger", ticket: 2013 },
			{ headline: "Never push a branch.", route: "trigger", ticket: 2015 },
		);
		baseline();
		claude(KEPT, `${ADDED} Reworded body.`);
		stage("CLAUDE.md");
		const r = report();
		expect(r.status).toBe(0);
		expect(r.text).toMatch(
			/POOL RULES — 2 top-level list items and bold-led paragraphs, rule or not/,
		);
		expect(r.text).toContain(
			'#2013 closed, its rule still in CLAUDE.md: "Keep the tree on `main`."',
		);
		expect(r.text).not.toContain("#2015 closed");

		const plain = runInProcess(SCRIPT, ["--root", dir, "--json"], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
		});
		const closed = JSON.parse(plain.stdout).findings.filter(
			(f: { tag: string }) => f.tag === "CLOSED-TRIGGER",
		);
		expect(closed).toEqual([
			expect.objectContaining({
				severity: "WARN",
				message: expect.stringMatching(/^#2013 has closed/),
			}),
		]);
	});
});
