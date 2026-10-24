// @vitest-environment node
/*
 * Pins check-digest-render.js's verdict: a digest the generator wrote passes,
 * any hand-edit fails with its drift quoted, and a missing input is BROKEN
 * rather than a pass.
 *
 * check-digest-render.js runs the REAL gen-roadmap-digest.js over a small
 * fake roadmap, so these tests cover the integration the gate depends on —
 * a fake generator would pass while the real invocation was wrong.
 *
 * It is a hard gate in .husky/pre-commit: a false pass lands a hand-edited
 * digest (the mantahostels#2890 gap), and a false fail blocks every roadmap edit.
 *
 * The checker runs through `scripts/lib/run-in-process.js` (§X3), which is why
 * every case here is sequential — that seam patches process globals for the
 * duration of a call. The GENERATOR it invokes is still a real child process,
 * spawned by the checker itself; the seam reproduces argv, cwd and the exit
 * code around it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyRequireClosure } from "./lib/require-closure";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-digest-render.js");
const GEN = path.resolve(
	__dirname,
	"../.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js",
);
/** Where the checker looks for the generator when given no third argument. */
const GEN_DEFAULT = ".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js";
const HTML = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

let dir: string;
let priorProjectDir: string | undefined;

/* The three things gen-roadmap-digest.js reads out of the roadmap: the two
 * array literals, each closed with "\n];" as its extractor requires, and the
 * docmeta stamp. Everything else on the page is ignored. */
const roadmap = (title = "Seed the catalogue") =>
	[
		"<!doctype html>",
		'<p class="docmeta">v5.21 · updated 8 July 2026, 19:00</p>',
		"<script>",
		"const PHASES = [",
		'  { n: 0, title: "Foundations" }',
		"];",
		"const ITEMS = [",
		`  { id: "c1", state: "active", t: ${JSON.stringify(title)}, p: 0 },`,
		'  { id: "c2", state: "open", t: "Wire the search", p: 0, needs: ["c1"] }',
		"];",
		"</script>",
	].join("\n");

const write = (file: string, body: string) =>
	fs.writeFileSync(path.join(dir, file), body);
const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");

/** Write the digest the way the roadmap-edit loop does, via --out. */
const generate = () => {
	const r = spawnSync(
		process.execPath,
		[GEN, path.join(dir, HTML), "--out", path.join(dir, DIGEST)],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`generator failed: ${r.stderr}`);
};

const check = (
	cwd: string,
	args: string[] = [],
	env: NodeJS.ProcessEnv = process.env,
) => {
	const r = runInProcess(SCRIPT, args, { cwd, env });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const run = (...args: string[]) => check(dir, args);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-render-test-"));
	fs.mkdirSync(path.join(dir, "docs"));
	write(HTML, roadmap());
	// The generator reads the adopter config from the host root; the fixture is
	// that root, for the generator this file spawns and the one the checker does.
	fs.mkdirSync(path.join(dir, ".claude"));
	write(".claude/workflow-core.json", JSON.stringify({ name: "Test" }));
	priorProjectDir = process.env.CLAUDE_PROJECT_DIR;
	process.env.CLAUDE_PROJECT_DIR = dir;
});
afterEach(() => {
	if (priorProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
	else process.env.CLAUDE_PROJECT_DIR = priorProjectDir;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-digest-render", () => {
	it("passes on a digest the generator itself wrote", () => {
		generate();
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	/* Pre-commit runs a staged COPY of the generator from a temp dir, where its
	 * relative require of the config reader resolves to nothing (#3). */
	it("passes with the generator copied away from the scripts tree, as pre-commit runs it", () => {
		generate();
		fs.copyFileSync(GEN, path.join(dir, "gen-roadmap-digest.js"));
		const r = run(HTML, DIGEST, "gen-roadmap-digest.js");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	/* The gap mantahostels#2890 names: an edit that leaves the version stamp untouched, so
	 * check-digest-version.js and check-roadmap-pair.js both pass it. */
	it("fails on a hand-edit that preserves the version line, quoting both sides and offering --out as the way out", () => {
		generate();
		const edited = read(DIGEST).replace(
			"Seed the catalogue",
			"Seed the catalogue (revised by hand)",
		);
		write(DIGEST, edited);
		// the stamp really is intact, or this test is not the one it claims
		expect(edited).toContain("v5.21 · updated 8 July 2026, 19:00");
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toContain("differs from what");
		// both sides quoted, or the reader cannot see what changed
		expect(r.out).toContain("revised by hand");
		expect(r.out).toContain("in file:");
		expect(r.out).toContain("rendered:");
		// the failure has to carry the way out
		expect(r.out).toContain("--out");
	});

	it("names the line number of the drift", () => {
		generate();
		const lines = read(DIGEST).split("\n");
		const i = lines.findIndex((l) => l.includes("Seed the catalogue"));
		expect(i).toBeGreaterThan(-1);
		lines[i] = `${lines[i]} · smuggled`;
		write(DIGEST, lines.join("\n"));
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toContain(`line ${i + 1}:`);
	});

	it("fails on an appended line and shows the file has more lines", () => {
		generate();
		write(
			DIGEST,
			`${read(DIGEST)}- \`c3\` [open] A card nobody rendered · needs: —\n`,
		);
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toContain("A card nobody rendered");
		expect(r.out).toContain("(no such line)");
	});

	it("fails on a deleted line, quoting it", () => {
		generate();
		const lines = read(DIGEST).split("\n");
		write(
			DIGEST,
			lines.filter((l) => !l.includes("Wire the search")).join("\n"),
		);
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toContain("Wire the search");
	});

	/* Byte-exactness is the checker's whole premise, and a comparison softened
	 * to `.trim()` passes every case above. Trailing whitespace is the cheapest
	 * hand-edit there is, and no generator emits it. */
	it("fails on a trailing newline the generator did not write", () => {
		generate();
		write(DIGEST, `${read(DIGEST)}\n`);
		expect(run(HTML, DIGEST, GEN).status).toBe(1);
	});

	it("fails on trailing whitespace added to a card line, counting the one line that differs", () => {
		generate();
		write(DIGEST, read(DIGEST).replace("Wire the search", "Wire the search "));
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 line(s)");
	});

	/* A whole-file rewrite differs on every line; quoting all of them buries the
	 * fault. The cap has to hold and has to say what it dropped. */
	it("caps the quoted lines and says how many more there are", () => {
		generate();
		write(DIGEST, Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/… and \d+ more\./);
		expect((r.out.match(/^ {2}line \d+:$/gm) ?? []).length).toBe(5);
	});

	/* Exactly at the cap: all five are quoted and nothing is said to be
	 * dropped. Without this a `>` softened to `>=` reports "and 0 more". */
	it("quotes all five and claims no remainder at exactly the cap", () => {
		generate();
		const lines = read(DIGEST).split("\n");
		for (let i = 0; i < 5; i++) lines[i] = `${lines[i]} · smuggled`;
		write(DIGEST, lines.join("\n"));
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect((r.out.match(/^ {2}line \d+:$/gm) ?? []).length).toBe(5);
		expect(r.out).not.toContain("more.");
	});

	/* Apparatus missing is BROKEN (2), not a finding (1): nothing was rendered,
	 * so there is no verdict about the digest either way (mantahostels#155 decision 6). */
	it("is BROKEN when the generator is absent, naming the path", () => {
		generate();
		const r = run(HTML, DIGEST, path.join(dir, "no-such-generator.js"));
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot find the digest generator");
		expect(r.out).toContain("no-such-generator.js");
	});

	it("is BROKEN when the digest is absent, naming the path", () => {
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot read digest");
		expect(r.out).toContain(DIGEST);
	});

	/* The generator throws on a roadmap it cannot parse. That is the generator's
	 * verdict, not a digest finding, and its message has to survive. */
	it("is BROKEN when the generator cannot parse the roadmap, quoting it", () => {
		generate();
		write(HTML, "<p>not a roadmap</p>");
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(2);
		expect(r.out).toContain("exited");
		expect(r.out).toContain("const ITEMS = [");
	});

	it("is BROKEN when the roadmap is absent", () => {
		generate();
		fs.rmSync(path.join(dir, HTML));
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(2);
	});

	/* The npm alias and the pre-commit gate's own fallback both invoke this
	 * bare, so all three defaults are part of the contract.
	 *
	 * Against a FIXTURE laid out at those default paths, never the shared
	 * working tree: a neighbour who has saved the roadmap HTML and not yet
	 * regenerated the digest would redden this case for everyone. */
	it("defaults to the roadmap, digest and generator paths, all three", () => {
		const genAt = path.join(dir, GEN_DEFAULT);
		fs.mkdirSync(path.dirname(genAt), { recursive: true });
		fs.copyFileSync(GEN, genAt);
		// The generator requires the config reader by relative path.
		copyRequireClosure(dir, path.resolve(__dirname, ".."), [
			"scripts/lib/workflow-core-config.js",
			"scripts/lib/host-root.js",
			"scripts/lib/caught.js",
		]);
		generate();

		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(DIGEST);
		expect(r.out).toContain(HTML);
		expect(r.out).toContain(GEN_DEFAULT);
	});

	/* WFC_SCRIPT_ROOT stands in for the core's location: an install has no
	 * package.json, a source checkout has one. */
	describe.each([
		["in an install", false],
		["from a source checkout run against another repo (#1549)", true],
	])("%s", (_, checkout) => {
		let core: string;
		const coreGen = () => path.join(core, GEN_DEFAULT);
		const runFromCore = () =>
			check(dir, [], { ...process.env, WFC_SCRIPT_ROOT: core });
		const place = (at: string) => {
			fs.mkdirSync(path.dirname(at), { recursive: true });
			fs.copyFileSync(GEN, at);
		};
		beforeEach(() => {
			core = fs.mkdtempSync(path.join(os.tmpdir(), "digest-core-"));
			if (checkout) fs.writeFileSync(path.join(core, "package.json"), "{}");
			generate();
		});
		afterEach(() => fs.rmSync(core, { recursive: true, force: true }));

		it("reads the core's generator when the host holds none", () => {
			place(coreGen());
			const r = runFromCore();
			expect(r.status).toBe(0);
			expect(r.out).toContain(coreGen());
		});

		it("prefers a host copy over the core's", () => {
			place(coreGen());
			place(path.join(dir, GEN_DEFAULT));
			const r = runFromCore();
			expect(r.status).toBe(0);
			expect(r.out).not.toContain(coreGen());
		});

		it("is BROKEN naming the core's path when neither copy exists", () => {
			const r = runFromCore();
			expect(r.status).toBe(2);
			expect(r.out).toContain(coreGen());
		});
	});

	it("is BROKEN in the core's own checkout when its generator is missing, naming the path it expected", () => {
		generate();
		const r = check(dir, [], { ...process.env, WFC_SCRIPT_ROOT: dir });
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot find the digest generator");
		expect(r.out).toContain(path.join(dir, GEN_DEFAULT));
	});
});
