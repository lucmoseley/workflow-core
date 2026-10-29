// @vitest-environment node
/*
 * Pins that no executable surface in this repo reaches a toolchain binary by
 * bare `npx` name. `npx <bare-name>` is how a check in this repo can go green
 * having checked nothing (mantahostels#1538).
 *
 * It scans this repo's real tracked files rather than a fixture, because the
 * hazard is one line anywhere on a surface that runs a check, and a fixture
 * holds only the lines someone thought of; fixtures prove each covered name is
 * caught. Loosen it and a hook, workflow or script can call the registry
 * impostor, and that check passes in a worktree having run nothing.
 *
 * npx resolves a bare name against the local `node_modules/.bin` first and the
 * public registry second, so the same command means different things depending
 * on whether `node_modules` happens to exist — and a throwaway worktree has
 * none. On the registry `biome` is an unrelated package that accepts `ci .`,
 * prints nothing and EXITS 0; the other names below fail loudly or serve the
 * genuine tool at an unpinned version (mantahostels#1538 carries the measurement, 26 August
 * 2026). Re-check one with `npm view <name> version description`.
 *
 * Which names have an impostor is the registry's decision, not ours — a name
 * with no publisher today can gain one tomorrow — so the whole toolchain is
 * held to the rule rather than biome alone.
 *
 * The rule: a check invokes its binary by path (`node_modules/.bin/biome`) or
 * by its scoped package name (`npx @biomejs/biome`), never by bare name. Both
 * of those resolve to one thing only.
 *
 * `--no-install` is NOT an escape: running `npx biome` once writes the impostor
 * into `~/.npm/_npx/<hash>/`, after which `npx --no biome` resolves it silently
 * and offline.
 *
 * Mutations are listed at the foot of this file.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { caught } from "./lib/caught.js";
import { isJsTestFile } from "./lib/test-kind.js";

const ROOT = path.resolve(__dirname, "..");

/* Bin names, not package names: this is what gets typed after `npx`. Every one
 * is covered by a fixture in "catches every name it claims to cover" below —
 * without that, deleting an entry here would leave the suite green, which is
 * this ticket's own failure mode. */
const TOOLCHAIN = [
	"biome",
	"eslint",
	"tsc",
	"vitest",
	"next",
	"ruff",
	"actionlint",
	"shellcheck",
];

/* The surfaces that can actually RUN a check. Deliberately not every tracked
 * file: `CLAUDE.md` and `docs/` have to state the hazard in order to warn about
 * it, and a JS or TS test or spec file carries the offending string as a
 * fixture or a comment (scripts/lib/encoding-use.test.ts parses "npx vitest
 * run …" as input; scripts/lib/post-write.test.ts names `npx biome` in a
 * comment).
 *
 * `.claude/skills/` is excluded for both reasons at once: 24 of its 46 tracked
 * entries are symlinks to directories under `.agents/skills/`, and the rest are
 * SKILL.md prose that may need to state the hazard. A fix to a vendored body is
 * reverted by the next re-pull unless it is declared in
 * `.agents/vendored-skill-edits.json` (mantahostels#1826), which is a cost, not the
 * impossibility this once claimed. Left as a residual on mantahostels#1538. */
function readExecutableSurfaces(root = ROOT): string[] {
	const tracked = execFileSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	})
		.split("\0")
		.filter(Boolean);

	return tracked.filter((f) => {
		if (isJsTestFile(f)) return false;
		if (f.startsWith(".github/workflows/")) return true;
		if (f.startsWith(".husky/")) return true;
		if (f === "package.json") return true;
		return f.startsWith("scripts/") && /\.(sh|js|mjs|cjs|ts|ps1|vbs)$/.test(f);
	});
}

/* A line that only TALKS about the hazard is not one that runs it.
 *
 * `*` is a comment continuation in JS/TS block comments and a `case` arm in
 * shell — and this corpus writes those with the command inline (`*) exit 0 ;;`),
 * so treating it as a comment everywhere would blind the detector to
 * `*) npx biome ci . ;;`. It is honoured only where block comments exist. */
function isComment(line: string, file: string): boolean {
	const t = line.trim();
	if (t.startsWith("#") || t.startsWith("//") || t.startsWith("/*"))
		return true;
	return t.startsWith("*") && /\.(js|mjs|cjs|ts)$/.test(file);
}

/* `npx`, any run of flags, then the bare name — `npx --yes biome`, `npx -y tsc`.
 * A scoped name (`npx @biomejs/biome`) does not match: the `@` is consumed by
 * the flag-or-name boundary, and the assertion below re-proves that. */
function readBareNpxHits(root = ROOT): string[] {
	const re = new RegExp(
		String.raw`\bnpx\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(${TOOLCHAIN.join("|")})\b`,
		"g",
	);
	const hits: string[] = [];

	for (const file of readExecutableSurfaces(root)) {
		let body: string;
		try {
			body = fs.readFileSync(path.join(root, file), "utf8");
		} catch (e) {
			// A path staged for deletion by a parallel session is genuinely gone.
			// Anything else is a scan that failed to read what it claims to cover,
			// so it is raised rather than swallowed into a green.
			if (caught(e).code === "ENOENT") continue;
			throw e;
		}
		body.split("\n").forEach((line, i) => {
			if (isComment(line, file)) return;
			for (const m of line.matchAll(re))
				hits.push(`${file}:${i + 1}: npx ${m[1]}`);
		});
	}
	return hits.sort();
}

/* A throwaway git repo holding whatever lines the caller wants scanned. */
const probes: string[] = [];
function probeRepo(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npx-bare-"));
	probes.push(dir);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	for (const [name, body] of Object.entries(files)) {
		fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), body);
	}
	execFileSync("git", ["add", "-A"], { cwd: dir });
	return dir;
}

afterEach(() => {
	// In afterEach, not inline after the assertion: a failing expect is exactly
	// when the test is doing its job, and would otherwise leak the directory.
	for (const d of probes.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

describe("no check reaches its binary by bare npx name", () => {
	it("finds no bare-name invocation on any executable surface", () => {
		// toEqual([]) rather than a length assertion: the failure message then
		// names every offender at once, which is what makes it fixable in one
		// pass (mantahostels#1266's shape). The rule is restated here because this message is
		// where a session that has read no rule actually meets it.
		expect(
			readBareNpxHits(),
			"Call the binary by path (node_modules/.bin/<tool>) or by scoped package " +
				"name (npx @biomejs/biome). A bare `npx <tool>` resolves against the " +
				"public registry when node_modules is absent, and `npx biome` is an " +
				"unrelated package that exits 0 having checked nothing (#1538).",
		).toEqual([]);
	});

	it("catches every name it claims to cover", () => {
		// `covered` is written out rather than derived from TOOLCHAIN: a fixture
		// generated from the list under test moves with it, so deleting a name
		// would delete its own probe and stay green — an eight-name rule resting
		// on a one-name test, which is this ticket's failure mode again.
		const covered = [
			"actionlint",
			"biome",
			"eslint",
			"next",
			"ruff",
			"shellcheck",
			"tsc",
			"vitest",
		];
		const files = Object.fromEntries(
			covered.map((n) => [`scripts/${n}-probe.sh`, `npx ${n} --version\n`]),
		);
		expect(readBareNpxHits(probeRepo(files))).toEqual(
			covered.map((n) => `scripts/${n}-probe.sh:1: npx ${n}`).sort(),
		);
	});

	it("scans every surface arm it claims to scan", () => {
		// A regression guard on the glob itself: a readExecutableSurfaces() that
		// silently stopped matching would make the assertion above pass
		// vacuously — the exact failure this whole ticket is about.
		const surfaces = readExecutableSurfaces();
		expect(surfaces).toContain(".github/workflows/ci.yml");
		expect(surfaces).toContain("scripts/bisect-step.sh");
		expect(surfaces).toContain("package.json");
		expect(surfaces.some((f) => f.startsWith(".husky/"))).toBe(true);
		expect(surfaces.some((f) => f.endsWith(".js"))).toBe(true);
	});

	it("still calls Biome at both of the sites this rule was written for", () => {
		// The rule is satisfiable by deleting the check, so pin that it is not
		// what happened: both call sites must still run Biome, by path.
		const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
		expect(read(".github/workflows/ci.yml")).toContain(
			"node_modules/.bin/biome ci . --error-on-warnings",
		);
		expect(read("scripts/bisect-step.sh")).toContain(
			"run_check node_modules/.bin/biome ci .",
		);
	});

	it("clears the two spellings that are allowed, and both comment forms", () => {
		// The detector, exercised directly — the assertion above is only worth
		// what this is.
		const dir = probeRepo({
			"scripts/bad.sh": "npx biome ci .\n",
			"scripts/flagged.sh": "npx --yes biome ci .\n",
			"scripts/case-arm.sh": "case $x in\n*) npx biome ci . ;;\nesac\n",
			"scripts/scoped.sh": "npx @biomejs/biome ci .\n",
			"scripts/bypath.sh": "node_modules/.bin/biome ci .\n",
			"scripts/hashed.sh": "# never npx biome here\n",
			"scripts/blocked.js": "/*\n * never npx biome here\n */\n",
			"docs/prose.md": "npx biome is the hazard\n",
		});
		expect(readBareNpxHits(dir)).toEqual([
			"scripts/bad.sh:1: npx biome",
			"scripts/case-arm.sh:2: npx biome",
			"scripts/flagged.sh:1: npx biome",
		]);
	});
});

/*
 * Eight mutations run against this file, each confirmed to fail the named test
 * and then reversed with the inverse targeted edit. A ninth, against the same
 * fix, lives in scripts/bisect-step.test.ts: the absent-binary guard removed,
 * which returns 127 and so marks a commit bad.
 *
 * 1. ci.yml's `node_modules/.bin/biome` → `npx biome`
 *      → "finds no bare-name invocation" fails, naming .github/workflows/ci.yml.
 * 2. bisect-step.sh's `node_modules/.bin/biome` → `npx biome`
 *      → same test fails, naming scripts/bisect-step.sh.
 * 3. ci.yml's Biome step gutted to `run: echo skipped`
 *      → "still calls Biome at both of the sites" fails.
 * 4. readExecutableSurfaces()'s `.github/workflows/` arm removed
 *      → "scans every surface arm it claims to scan" fails.
 * 5. isComment() made to return true unconditionally
 *      → "clears the two spellings that are allowed" fails.
 * 6. The regex's flag-run group removed, so `npx --yes biome` stops matching
 *      → same test fails on the flagged.sh fixture.
 * 7. isComment()'s `*` arm applied to every extension, not just JS/TS
 *      → same test fails: the shell `case` arm goes unseen.
 * 8. `"vitest"` deleted from TOOLCHAIN
 *      → "catches every name it claims to cover" fails. Stands for all eight.
 *
 * Plus one CONTROL: with the workflow arm removed AND ci.yml reverted to
 * `npx biome`, the bare-name assertion PASSES. That arm is the only thing
 * standing between mutation 1 and a green.
 */
