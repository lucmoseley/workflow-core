// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyRequireClosure } from "./lib/require-closure-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-digest-render.js");
const GEN = path.resolve(
	__dirname,
	"../.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js",
);
const GEN_DEFAULT = ".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js";
const HTML = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

let dir: string;

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

const generate = () => {
	const r = runInProcess(GEN, [
		path.join(dir, HTML),
		"--out",
		path.join(dir, DIGEST),
	]);
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
	fs.mkdirSync(path.join(dir, ".claude"));
	write(".claude/workflow-core.json", JSON.stringify({ name: "Test" }));
	vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-digest-render", () => {
	it("passes on a digest the generator itself wrote", () => {
		generate();
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("passes with the generator copied away from the scripts tree, as pre-commit runs it", () => {
		generate();
		fs.copyFileSync(GEN, path.join(dir, "gen-roadmap-digest.js"));
		const r = run(HTML, DIGEST, "gen-roadmap-digest.js");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("fails on a hand-edit that preserves the version line, quoting both sides and offering --out as the way out", () => {
		generate();
		const edited = read(DIGEST).replace(
			"Seed the catalogue",
			"Seed the catalogue (revised by hand)",
		);
		write(DIGEST, edited);
		expect(edited).toContain("v5.21 · updated 8 July 2026, 19:00");
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toContain("differs from what");
		expect(r.out).toContain("revised by hand");
		expect(r.out).toContain("in file:");
		expect(r.out).toContain("rendered:");
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

	it("caps the quoted lines and says how many more there are", () => {
		generate();
		write(DIGEST, Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
		const r = run(HTML, DIGEST, GEN);
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/… and \d+ more\./);
		expect((r.out.match(/^ {2}line \d+:$/gm) ?? []).length).toBe(5);
	});

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

	it("defaults to the roadmap, digest and generator paths, all three", () => {
		const genAt = path.join(dir, GEN_DEFAULT);
		fs.mkdirSync(path.dirname(genAt), { recursive: true });
		fs.copyFileSync(GEN, genAt);
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
