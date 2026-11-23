// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, emptyRepoTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "generate-core-docs.js");

const DOC_MAP = `# map

## Authority classes

| Class |
|---|

## Section A — document register

How to register.

### Repo-root contracts

| row |

## Section B — load-bearing figure registry

How to write an entry.

### B1 · An entry

Its body.

## Section C — question routes

None registered.

## The propagation pass

Walk it.

## Capture and placement — where a settled fact goes

### 1. File it

Now.

### 5. Sheds paid — the ledger

- a shed
`;

let root: string;

const emptyRepo = defineTemplate(emptyRepoTemplate);

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "core-docs-"));
	emptyRepo.instantiate(root);
	write(".claude-plugin/plugin.json", "{}\n");
	write("GLOSSARY.md", "# terms\n");
	write("docs/doc-map.md", DOC_MAP);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("generate-core-docs", () => {
	it("renders the glossary whole and the doc map's method sections alone", () => {
		expect(run().status).toBe(0);
		expect(read(".claude/workflow-core.glossary.md")).toMatch(
			/^<!-- CORE-OWNED\. [^\n]*-->\n\n# terms\n$/,
		);
		const method = read(".claude/workflow-core.doc-map.md");
		for (const kept of [
			"## Authority classes",
			"How to register.",
			"How to write an entry.",
			"Walk it.",
			"### 1. File it",
		])
			expect(method).toContain(kept);
		for (const dropped of [
			"Repo-root contracts",
			"### B1",
			"Section C",
			"Sheds paid",
		])
			expect(method).not.toContain(dropped);
	});

	it("passes --check once rendered, and fails it on a source edited after", () => {
		run();
		expect(run("--check").status).toBe(0);
		write("GLOSSARY.md", "# terms, changed\n");
		const r = run("--check");
		expect(r.status).toBe(1);
		expect(r.out).toContain(".claude/workflow-core.glossary.md");
	});

	it("exits 2 on a doc map missing a method section", () => {
		write(
			"docs/doc-map.md",
			DOC_MAP.replace("## The propagation pass", "## Gone"),
		);
		const r = run("--check");
		expect(r.status).toBe(2);
		expect(r.out).toContain("## The propagation pass");
	});

	it("SKIPs a repo shipping no plugin, writing nothing", () => {
		fs.rmSync(path.join(root, ".claude-plugin"), { recursive: true });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(
			fs.existsSync(path.join(root, ".claude/workflow-core.glossary.md")),
		).toBe(false);
	});
});
