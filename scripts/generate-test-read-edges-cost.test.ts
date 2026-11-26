// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callCost } from "./lib/call-cost-harness.js";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";
import { gitIn, writeIn } from "./lib/tree-write-testkit";

const SCRIPT = path.join(__dirname, "generate-test-read-edges.js");
const DOC = ["docs", "thing.md"].join("/");
const PATCH = ["docs", "fix.patch"].join("/");

const staged = defineTemplate((root) => {
	gitIn(root, "init", "-q");
	writeIn(root, DOC, "a tracked document\n");
	writeIn(root, PATCH, `--- a/${DOC}\n+++ b/${DOC}\n`);
	writeIn(
		root,
		"scripts/a.test.ts",
		`process.cwd(); read("${DOC}"); read("${PATCH}");`,
	);
	writeIn(root, "scripts/b.test.ts", `process.cwd(); read("${PATCH}");`);
	gitIn(root, "add", "-A");
	const r = runInProcess(SCRIPT, ["--root", root], { cwd: root });
	if (r.status !== 0) throw new Error(r.stderr);
	gitIn(root, "add", "-A");
});

let dir: string;

beforeEach(() => {
	dir = staged.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "read-edges-cost-")),
	);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("generate-test-read-edges.js --check's per-call cost (#5746)", () => {
	it("costs a fresh staged manifest these modules and starts, two tests' shared patch fetched once (#5745)", () => {
		const r = callCost(SCRIPT, ["--check"], { cwd: dir });
		// #1497
		expect(r.modules).toEqual([
			"generate-test-read-edges.js",
			"lib/by-code-unit.js",
			"lib/caught.js",
			"lib/check-sink.js",
			"lib/child-buffer.js",
			"lib/cli-args.js",
			"lib/code-edges-pragmas.js",
			"lib/cut-at.js",
			"lib/deny-capable.js",
			"lib/deref.js",
			"lib/exempt-markers.js",
			"lib/file-read.js",
			"lib/gh-binary.js",
			"lib/git-file.js",
			"lib/git-mode.js",
			"lib/git-objects.js",
			"lib/git-read-memo.js",
			"lib/git.js",
			"lib/guard-cores.js",
			"lib/guard-reach.js",
			"lib/hook-deadline.js",
			"lib/host-root.js",
			"lib/if-clause.js",
			"lib/is-under.js",
			"lib/js-lex.js",
			"lib/line-scan.js",
			"lib/main-checkout.js",
			"lib/outcome-error.js",
			"lib/qualify-citations.js",
			"lib/read-edges-render.js",
			"lib/regex-group.js",
			"lib/repo-path.js",
			"lib/rule-emission-calls.js",
			"lib/rule-text.js",
			"lib/script-path.js",
			"lib/sh-quote.js",
			"lib/shell-operands.js",
			"lib/sleep-sync.js",
			"lib/strip-comments.js",
			"lib/test-kind.js",
			"lib/test-read-edges.js",
			"lib/trim-run.js",
			"lib/workflow-core-config.js",
			"lib/write-fd.js",
		]);
		expect(r.children).toEqual([
			"git ls-files",
			"git diff",
			"git rev-parse",
			"git ls-files",
			"git cat-file",
			"git cat-file",
			"git rev-parse",
			"git ls-files",
			"git cat-file",
		]);
	});
});
