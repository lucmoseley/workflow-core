// @vitest-environment node
/*
 * Pins that check-context-budget.js's `--against` pathspec list, which
 * lib/context-budget-pathspecs.js builds, misses no file the plain run reads.
 *
 * check-context-budget.js's `--against` measures blob-fetched trees built from
 * its own pathspec list, and a file the plain run reads that the list leaves
 * out under-counts BOTH sides alike, so a commit crossing a cap passes the
 * pre-commit gate unrefused (#1014, mantahostels#1786). Asserted here as one
 * equality instead of one fixture per input: the figures over HEAD's
 * materialised pathspecs are the figures over HEAD's whole tree (#1120).
 *
 * THIS REPO'S REAL HEAD, NOT A FIXTURE: an input nobody thought of is one no
 * fixture carries. HEAD, never the working tree, so a neighbour's dirty file
 * cannot flake it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-context-budget.js");
const { materialisePathspecs } =
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module, as its own test loads it
	require("./lib/context-budget-pathspecs") as any;
const REPO = path.resolve(__dirname, "..");

/** HEAD's whole tree, extracted as lib/check.js's `tree` materialiser does. */
function extractHead(dir: string) {
	const tar = path.join(dir, "tree.tar");
	execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], {
		cwd: REPO,
	});
	execFileSync("tar", ["-xf", tar, "-C", dir]);
	fs.rmSync(tar);
}

/**
 * The paths `blobs` fetches for `pathspecs` — what `git ls-tree` lists under
 * them, gitlinks aside — copied out of `whole`, symlinks kept as symlinks. The
 * fetch itself is pinned end to end in lib/check.test.ts's `--against with the
 * blobs materialisation`; this case is about which paths the list names.
 */
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

/* What each cap is judged on, without the rows' paths. */
function figures(root: string) {
	const r = runInProcess(SCRIPT, ["--root", root, "--json"], {
		env: {
			...process.env,
			/* vitest.setup.ts's every-module default would stand in for a missing
			 * `.claude/workflow-core.json`, which is #1014's fault. */
			WFC_MODULES: undefined,
			/* The live-core fallback would stand in for a missing injector, read
			 * off the working tree. */
			WFC_INJECTOR_FILE: path.join(root, "no-such-injector.sh"),
			/* The ledger's closed-ticket lookup would reach the live tracker. */
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
