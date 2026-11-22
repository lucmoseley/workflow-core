// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { caught } from "./lib/caught.js";
import { isJsTestFile } from "./lib/test-kind.js";

const ROOT = path.resolve(__dirname, "..");

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

function isComment(line: string, file: string): boolean {
	const t = line.trim();
	if (t.startsWith("#") || t.startsWith("//") || t.startsWith("/*"))
		return true;
	return t.startsWith("*") && /\.(js|mjs|cjs|ts)$/.test(file);
}

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
	for (const d of probes.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

describe("no check reaches its binary by bare npx name", () => {
	it("finds no bare-name invocation on any executable surface", () => {
		expect(
			readBareNpxHits(),
			"Call the binary by path (node_modules/.bin/<tool>) or by scoped package " +
				"name (npx @biomejs/biome). A bare `npx <tool>` resolves against the " +
				"public registry when node_modules is absent, and `npx biome` is an " +
				"unrelated package that exits 0 having checked nothing (#1538).",
		).toEqual([]);
	});

	it("catches every name it claims to cover", () => {
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
		const surfaces = readExecutableSurfaces();
		expect(surfaces).toContain(".github/workflows/ci.yml");
		expect(surfaces).toContain("scripts/bisect-step.sh");
		expect(surfaces).toContain("package.json");
		expect(surfaces.some((f) => f.startsWith(".husky/"))).toBe(true);
		expect(surfaces.some((f) => f.endsWith(".js"))).toBe(true);
	});

	it("still calls Biome at both of the sites this rule was written for", () => {
		const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
		expect(read(".github/workflows/ci.yml")).toContain(
			"node_modules/.bin/biome ci . --error-on-warnings",
		);
		expect(read("scripts/bisect-step.sh")).toContain(
			"run_check node_modules/.bin/biome ci .",
		);
	});

	it("clears the two spellings that are allowed, and both comment forms", () => {
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
