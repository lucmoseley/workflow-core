// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-context-budget.js");
const { materialisePathspecs } = require("./lib/context-budget-pathspecs") as {
	materialisePathspecs: (ctx: object, rev: string) => string[];
};
const REPO = path.resolve(__dirname, "..");

function extractHead(dir: string) {
	const tar = path.join(dir, "tree.tar");
	execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], {
		cwd: REPO,
	});
	execFileSync("tar", ["-xf", tar, "-C", dir]);
	fs.rmSync(tar);
}

function copyListed(whole: string, dir: string, pathspecs: string[]) {
	const listing = execFileSync(
		"git",
		["ls-tree", "-r", "-z", "HEAD", "--", ...pathspecs],
		{ cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	for (const record of listing.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab === -1 || record.startsWith("160000")) continue;
		const rel = record.slice(tab + 1);
		const [from, to] = [path.join(whole, rel), path.join(dir, rel)];
		fs.mkdirSync(path.dirname(to), { recursive: true });
		if (record.startsWith("120000")) fs.symlinkSync(fs.readlinkSync(from), to);
		else fs.copyFileSync(from, to);
	}
}

function figures(root: string) {
	const r = runInProcess(SCRIPT, ["--root", root, "--json"], {
		env: {
			...process.env,
			WFC_MODULES: undefined,
			WFC_TRACKER_TEXT_FILE: path.join(root, "no-such-text-module.js"),
			WFC_GH: path.join(root, "no-such-gh"),
		},
	});
	const j = JSON.parse(r.stdout);
	return {
		outcome: j.outcome,
		findings: j.findings.map((f: { tag: string }) => f.tag),
		pool: j.total,
		injection: j.injection.total,
		session: Object.fromEntries(
			Object.entries(j.session.tools).map(([tool, g]) => [
				tool,
				(g as { bytes: number }).bytes,
			]),
		),
		fragments: j.session.fragmentBytes,
		ratchet: j.session.ratchet.total,
		direct: j.session.direct.total,
		plugins: j.plugins.tokens,
		descriptions: [j.descriptions.ownBytes, j.descriptions.vendoredBytes],
		rules: j.rules.count,
		unadmitted: j.unadmitted.length,
	};
}

describe("--against's materialised trees", () => {
	it("measure HEAD as the plain run over HEAD's whole tree does", () => {
		const work = fs.mkdtempSync(
			path.join(os.tmpdir(), "ctxbudget-materialise-"),
		);
		onTestFinished(() => fs.rmSync(work, { recursive: true, force: true }));
		const whole = fs.mkdtempSync(path.join(work, "whole-"));
		const fetched = fs.mkdtempSync(path.join(work, "fetched-"));
		extractHead(whole);
		const ctx = {
			broken: (m: string) => {
				throw new Error(m);
			},
		};
		vi.stubEnv("CLAUDE_PROJECT_DIR", REPO);
		copyListed(whole, fetched, materialisePathspecs(ctx, "HEAD"));

		const plain = figures(whole);
		expect(plain.outcome, "the plain run must measure something").not.toBe(
			"BROKEN",
		);
		expect(
			figures(fetched),
			"a file the plain run reads is missing from the checker's pathspecs",
		).toEqual(plain);
	});
});
