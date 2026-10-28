// @vitest-environment node
/*
 * gen-roadmap-digest.js is the only thing that writes docs/roadmap-digest.md. Its
 * dangerous failure was writing nothing while exiting 0, so most of what follows
 * pins down when it is allowed to produce no file.
 *
 * No ticket found for the destination rule: its first commit names none. The
 * claim cases follow mantahostels#103's ruling that the script abort on a held
 * digest.
 *
 * Spawned through roadmap-fixture's `run` over a fake roadmap in a temp
 * directory, so the real roadmap is never read and the real digest never
 * written.
 *
 * The generator runs in the roadmap-edit loop and inside .husky/pre-commit's
 * digest-render gate: loosen a case and a run that writes nothing can exit 0,
 * leaving the roadmap paired with a stale digest.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withHostConfig } from "../../../../scripts/lib/config-testkit";
import { card, roadmapHtml, run, SCRIPTS_DIR } from "./roadmap-fixture";

const SCRIPT = "gen-roadmap-digest.js";

const hostRoot = withHostConfig({ name: "Fixture" });

let dir: string;
let fixture: string;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-test-"));
	fixture = path.join(dir, "roadmap.html");
	fs.writeFileSync(
		fixture,
		roadmapHtml([
			card({ id: "alpha", t: "Alpha <b>card</b>" }),
			card({
				id: "beta",
				p: 1,
				needs: ["alpha"],
				m: "max",
				mn: "Research run — sources",
			}),
		]),
	);
});
afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("output destination", () => {
	// Regression: a stdout default lets a forgotten --out print 26k of digest,
	// exit 0 and write nothing — leaving the roadmap HTML paired with a stale
	// digest that only CI would catch.
	it("refuses to run with no destination rather than printing", () => {
		const r = run(SCRIPT, [fixture]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no output destination");
		expect(r.stdout).toBe("");
	});

	it("rejects --out with no path after it", () => {
		const r = run(SCRIPT, [fixture, "--out"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("--out was given without a path");
	});

	it("rejects --out and --stdout together", () => {
		const r = run(SCRIPT, [
			fixture,
			"--out",
			path.join(dir, "d.md"),
			"--stdout",
		]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("mutually exclusive");
	});

	it("rejects a flag in the roadmap-file slot with usage, not an ENOENT crash", () => {
		const r = run(SCRIPT, ["--out", path.join(dir, "d.md")]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("first argument must be the roadmap file path");
		expect(r.stderr).not.toContain("ENOENT");
	});

	it("prints to stdout only when asked explicitly", () => {
		const r = run(SCRIPT, [fixture, "--stdout"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("# Fixture roadmap — digest (map only)");
	});

	it("titles the digest with the host root's directory name when the config declares no name", () => {
		const config = path.join(hostRoot(), ".claude", "workflow-core.json");
		fs.writeFileSync(config, "{}");
		try {
			const r = run(SCRIPT, [fixture, "--stdout"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				`# ${path.basename(hostRoot())} roadmap — digest (map only)`,
			);
		} finally {
			fs.writeFileSync(config, JSON.stringify({ name: "Fixture" }));
		}
	});
});

describe("--out", () => {
	it("writes the digest and reports what it wrote", () => {
		const out = path.join(dir, "digest.md");
		const r = run(SCRIPT, [fixture, "--out", out]);
		expect(r.status).toBe(0);
		expect(fs.existsSync(out)).toBe(true);
		expect(r.stderr).toContain(`wrote ${out}`);
		expect(r.stderr).toContain("2 cards");
	});

	it("emits one line per card, grouped by phase, with needs, effort and mn", () => {
		const out = path.join(dir, "digest2.md");
		run(SCRIPT, [fixture, "--out", out]);
		const md = fs.readFileSync(out, "utf8");
		expect(md).toContain("v5.0 · updated 1 July 2026, 10:00 · 2 cards");
		expect(md).toContain("## Phase 0 — Phase zero");
		expect(md).toContain("## Phase 1 — Phase one");
		// alpha carries no m — the Opus 5.5 · medium default — so no code prints
		expect(md).toContain("- `alpha` [open] Alpha card · needs: —");
		expect(md).not.toContain("- `alpha` [open] Alpha card · needs: — ·");
		expect(md).toContain(
			"- `beta` [open] card beta · needs: alpha · max · mn: Research run",
		);
		// card bodies are deliberately absent — the digest is a map, not the territory
		expect(md).not.toContain("Done when");
		// inline HTML is stripped, not passed through
		expect(md).not.toContain("<b>");
	});

	// Regression (#676).
	it("names the effort guide as the core's copy, not a host-relative path", () => {
		const r = run(SCRIPT, [fixture, "--stdout"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"default (the workflow-core plugin's `docs/effort-guide.md`)",
		);
		expect(r.stdout).not.toContain("(docs/effort-guide.md)");
	});

	it("renders a leg-scoped m as step:tier pairs joined by +", () => {
		const legFixture = path.join(dir, "leg.html");
		fs.writeFileSync(
			legFixture,
			roadmapHtml([
				card({
					id: "gamma",
					m: [
						["design", "max"],
						["build", "max"],
					],
				}),
			]),
		);
		const out = path.join(dir, "leg.md");
		run(SCRIPT, [legFixture, "--out", out]);
		const md = fs.readFileSync(out, "utf8");
		expect(md).toContain(
			"`gamma` [open] card gamma · needs: — · design:max+build:max",
		);
	});

	it("writes the same bytes for the same input (deterministic)", () => {
		const a = path.join(dir, "a.md");
		const b = path.join(dir, "b.md");
		run(SCRIPT, [fixture, "--out", a]);
		run(SCRIPT, [fixture, "--out", b]);
		expect(fs.readFileSync(a, "utf8")).toBe(fs.readFileSync(b, "utf8"));
	});
});

describe("large roadmap compaction", () => {
	it("stays well under the 40k context threshold the digest exists to respect", () => {
		const cardCount = 180;
		const bigCards = Array.from({ length: cardCount }, (_, i) => {
			const id = `card-${i}`;
			const phase = i % 2;
			const needs = i > 0 ? [`card-${i - 1}`] : [];
			return card({
				id,
				p: phase,
				t: `Realistic roadmap card title ${i}`,
				b: `<p>${"Prose describing what this card does and why it matters. ".repeat(6)}</p>`,
				needs,
				m: i % 3 === 0 ? "max" : undefined,
				mn: i % 5 === 0 ? "Research run — sources and rationale" : undefined,
			});
		});
		const big = path.join(dir, "big.html");
		fs.writeFileSync(big, roadmapHtml(bigCards));

		const out = path.join(dir, "big.md");
		const r = run(SCRIPT, [big, "--out", out]);
		expect(r.status).toBe(0);
		expect(fs.statSync(out).size).toBeLessThan(40_000);
	});
});

describe("the file claim a script takes for itself (mantahostels#99's signal 3)", () => {
	// This script is invisible to the PreToolUse guard, which only sees
	// Write/Edit/NotebookEdit, so it takes the claim itself. mantahostels#103 ruled it must
	// ABORT on a held file rather than record and carry on.
	const arbiterScript = path.resolve(
		SCRIPTS_DIR,
		"../../../../scripts/session-arbiter.js",
	);

	it("aborts without writing when another live session holds the digest, naming the holder", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "digest-claim-"));
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "digest-repo-"));
		fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.mkdirSync(path.join(repo, ".claude"));
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({ name: "Fixture" }),
		);
		const out = path.join(repo, "docs/roadmap-digest.md");
		const env = {
			...process.env,
			CLAUDE_CONFIG_DIR: home,
			CLAUDE_PROJECT_DIR: repo,
		};

		// The holder is this test process, which is by definition alive.
		const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
		fs.writeFileSync(
			path.join(home, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId: "holder",
				procStart: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19],
			}),
		);
		const claimed = spawnSync("node", [arbiterScript, "claim", out, "holder"], {
			encoding: "utf8",
			env,
			cwd: repo,
		});
		expect(claimed.status).toBe(0);

		const r = spawnSync(
			"node",
			[path.join(SCRIPTS_DIR, SCRIPT), fixture, "--out", out],
			{ encoding: "utf8", env, cwd: repo },
		);
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain("holder");
		expect(fs.existsSync(out)).toBe(false);

		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(repo, { recursive: true, force: true });
	});
});
