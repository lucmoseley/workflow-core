// @vitest-environment node
/*
 * .husky/prepare-commit-msg's dispatcher (#5208, spec #5207):
 * lib/prepare-commit-msg-rows.js run through lib/precommit-dispatch.js by
 * scripts/prepare-commit-msg-dispatch.js.
 *
 * The missing-dispatcher refusal is prepare-commit-msg-gate.test.ts's, with
 * the hook's other boundary cases.
 *
 * Over the 10 s budget (base §X8 (5)): its nine hook cases are each a real
 * git operation firing the real hook, 0.5–1 s apiece, which is the boundary
 * under test; the row cases build a real repo for the route markers at
 * ~0.25 s each.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { scrubbedGitEnv } from "./lib/hook-entry.js";
import { installHuskyShim } from "./lib/husky-testkit";
import { ROWS } from "./lib/prepare-commit-msg-rows.js";
import { reviewTierStamp } from "./lib/review-tier-stamp.js";
import { shellQuote } from "./lib/sh-quote.js";
import { runPrepareCommitMsg } from "./prepare-commit-msg-dispatch.js";

const ROOT = path.join(__dirname, "..");
const SID = "dispatch-session";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/** A stub program the dispatcher loads in-process: logs its name, exits
 * `exit`, saying `stderr`. */
const programStub = (log: string, name: string, exit = 0, stderr = "") =>
	`const fs = require("node:fs");\nmodule.exports = { PROGRAM: () => { fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)}); return { exit: ${exit}, stdout: "", stderr: ${JSON.stringify(stderr)} }; } };\n`;

interface Repo {
	root: string;
	gitDir: string;
	log: string;
	env: NodeJS.ProcessEnv;
	git: (...a: string[]) => string;
	/** Every step's name that ran, in order. */
	ran: () => string[];
	/** Rewrites the stub `pre-commit`: logs, exits `code`, stamps only on 0. */
	precommitExits: (code: number) => void;
	/** Puts a stub program at `rel` under the root. */
	stub: (rel: string, name: string, exit?: number, stderr?: string) => void;
}

function repo(): Repo {
	const root = fs.realpathSync(mkScratchDir("prepare-commit-msg-dispatch-"));
	dirs.push(root);
	const log = path.join(root, "ran.log");
	const env: NodeJS.ProcessEnv = {
		...scrubbedGitEnv(process.env),
		CLAUDE_CODE_SESSION_ID: SID,
		CLAUDE_CONFIG_DIR: path.join(root, "config"),
		GIT_EDITOR: "true",
	};
	delete env.WFC_PLUGIN_ROOT;
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: root, env, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.mkdirSync(path.join(root, ".husky"));
	installHuskyShim(root);
	fs.mkdirSync(path.join(root, "scripts"));
	fs.copyFileSync(
		path.join(ROOT, ".husky", "prepare-commit-msg"),
		path.join(root, ".husky", "prepare-commit-msg"),
	);
	for (const rel of [
		"scripts/prepare-commit-msg-dispatch.js",
		"scripts/check-commit-message-closes.js",
	])
		fs.symlinkSync(path.join(ROOT, rel), path.join(root, rel));
	fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "*.log\n");
	const precommitExits = (code: number) =>
		fs.writeFileSync(
			path.join(root, ".husky", "pre-commit"),
			`echo pre-commit >> ${shellQuote(log)}\n` +
				(code === 0
					? 'd="$(git rev-parse --absolute-git-dir)"\ngit write-tree >"$d/wfc-precommit-stamp"\nexit 0\n'
					: `exit ${code}\n`),
		);
	const stub = (rel: string, name: string, exit = 0, stderr = "") =>
		fs.writeFileSync(
			path.join(root, rel),
			programStub(log, name, exit, stderr),
		);
	precommitExits(0);
	stub("scripts/review-hold-gate.js", "hold");
	stub("scripts/review-tier-trailer.js", "trailer");
	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	git("add", "--", "base.txt");
	git("commit", "-qm", "base", "--no-verify");
	fs.rmSync(log, { force: true });
	return {
		root,
		gitDir: path.join(root, ".git"),
		log,
		env,
		git,
		ran: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
		precommitExits,
		stub,
	};
}

/** Runs git in `r`, its hooks firing; the exit code and stderr. */
function attempt(r: Repo, ...args: string[]) {
	const out = spawnSync("git", args, {
		cwd: r.root,
		env: r.env,
		encoding: "utf8",
	});
	return { code: out.status, stderr: out.stderr };
}

/** A `side` branch adding `rel`, `r` left on `main` one commit ahead, and
 * the steps' log cleared of the commits making them. */
function sideCommit(r: Repo, rel: string, body = "side\n"): string {
	r.git("checkout", "-qb", "side");
	fs.writeFileSync(path.join(r.root, rel), body);
	r.git("add", "--", rel);
	r.git("commit", "-qm", rel, "--no-verify");
	const sha = r.git("rev-parse", "HEAD");
	r.git("checkout", "-q", "main");
	fs.writeFileSync(path.join(r.root, "base.txt"), "moved\n");
	r.git("commit", "-qam", "moved", "--no-verify");
	fs.rmSync(r.log, { force: true });
	return sha;
}

/** A scanner at a WFC_GITLEAKS path: prints a line, exits `code`. */
function scanner(r: Repo, code: number): string {
	const bin = path.join(r.root, "stub-gitleaks");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho "STUB SCANNER $*" >&2\nexit ${code}\n`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

const ABORT = (name: string, abort: string) =>
	`  The ${name} is left IN PROGRESS. Clear it with:  ${abort}\n`;

describe("the registry", () => {
	it("runs the closing-keyword scan, the replay scan, the hold, the inline pre-commit and the trailer, in that order, every one gating", () => {
		expect(ROWS.map((r) => [r.id, r.policy, r.when])).toEqual([
			[
				"closing-keyword",
				"gate",
				{ unlessRoutes: ["replay"], facts: ["message"] },
			],
			["replay-scan", "gate", { routes: ["replay"], unlessFacts: ["stamped"] }],
			[
				"review-hold",
				"gate",
				{ routes: ["cherry-pick"], unlessFacts: ["stamped"] },
			],
			[
				"inline-pre-commit",
				"gate",
				{ unlessRoutes: ["replay"], unlessFacts: ["stamped"] },
			],
			["trailer", "gate", { facts: ["trailer"] }],
		]);
	});

	it("leaves the route to lib/commit-route.js: neither the hook nor its rows spell a marker", () => {
		for (const rel of [
			".husky/prepare-commit-msg",
			"scripts/lib/prepare-commit-msg-rows.js",
		]) {
			const code = fs
				.readFileSync(path.join(ROOT, rel), "utf8")
				.split("\n")
				.filter((l) => !/^\s*(#|\*|\/\*|$)/.test(l))
				.join("\n");
			expect(code).not.toMatch(
				/rebase-merge|\/rebase-apply|rebase-apply\/|CHERRY_PICK_HEAD|REVERT_HEAD|sequencer|MERGE_HEAD|AUTO_MERGE|BISECT_LOG|GIT_REFLOG_ACTION/,
			);
		}
	});
});

describe("the real hook, under real git", () => {
	it("gives a commit pre-commit stamped the trailer alone", () => {
		const r = repo();
		fs.writeFileSync(path.join(r.root, "f.txt"), "f\n");
		r.git("add", "--", "f.txt");
		const out = attempt(r, "commit", "-qm", "land\n\nReview-Tier: x");
		expect(out.code).toBe(0);
		expect(r.ran()).toEqual(["pre-commit", "trailer"]);
		expect(fs.existsSync(path.join(r.gitDir, "wfc-precommit-stamp"))).toBe(
			false,
		);
	});

	it("runs the inline pre-commit then the trailer on a commit pre-commit did not gate", () => {
		const r = repo();
		fs.writeFileSync(path.join(r.root, "f.txt"), "f\n");
		r.git("add", "--", "f.txt");
		const out = attempt(
			r,
			"commit",
			"-qm",
			"land\n\nReview-Tier: x",
			"--no-verify",
		);
		expect(out.code).toBe(0);
		expect(r.ran()).toEqual(["pre-commit", "trailer"]);
		expect(fs.existsSync(path.join(r.gitDir, "wfc-precommit-stamp"))).toBe(
			false,
		);
	});

	it.each([
		["cherry-pick", "git cherry-pick", "git cherry-pick --abort"],
		["rebase", "git rebase", "git rebase --abort"],
	])(
		"refuses a %s the replay scan does not pass, the scanner's output first and the abort last",
		(op, name, abort) => {
			const r = repo();
			const pick = sideCommit(r, "s.txt");
			r.env.WFC_GITLEAKS = scanner(r, 1);
			if (op === "rebase") r.git("checkout", "-q", "side");
			const out = attempt(r, op, op === "rebase" ? "main" : pick);
			expect(out.code).not.toBe(0);
			expect(out.stderr).toContain(
				"STUB SCANNER git --staged --redact\n" +
					`prepare-commit-msg: the secrets scan did not pass on this ${name} (mantahostels#1706).\n` +
					"  Its own output is above — a finding, or gitleaks itself is missing.\n" +
					ABORT(name, abort),
			);
			expect(r.ran()).toEqual([]);
		},
	);

	it("passes a clean cherry-pick through the scan, the hold and the trailer, never pre-commit", () => {
		const r = repo();
		const pick = sideCommit(r, "s.txt");
		r.env.WFC_GITLEAKS = scanner(r, 0);
		fs.appendFileSync(
			reviewTierStamp(r.gitDir, SID) as string,
			"t\nescalated\n",
		);
		const out = attempt(r, "cherry-pick", pick);
		expect(out.code).toBe(0);
		expect(r.ran()).toEqual(["hold", "trailer"]);
	});

	it("refuses a cherry-pick the hold refuses, its text then the abort, and runs no trailer", () => {
		const r = repo();
		const pick = sideCommit(r, "s.txt");
		r.env.WFC_GITLEAKS = scanner(r, 0);
		r.stub("scripts/review-hold-gate.js", "hold", 1, "the hold refused\n");
		const out = attempt(r, "cherry-pick", pick);
		expect(out.code).not.toBe(0);
		expect(out.stderr).toContain(
			`the hold refused\n${ABORT("git cherry-pick", "git cherry-pick --abort")}`,
		);
		expect(r.ran()).toEqual(["hold"]);
	});

	it("refuses a merge the inline pre-commit refuses, naming the merge's abort", () => {
		const r = repo();
		sideCommit(r, "s.txt");
		r.precommitExits(3);
		const out = attempt(r, "merge", "--no-verify", "side", "-m", "m");
		expect(out.code).not.toBe(0);
		expect(out.stderr).toContain(
			"prepare-commit-msg: the gates above refused this commit's content.\n" +
				"  This hook runs them because --no-verify cannot turn it off (mantahostels#1705).\n" +
				"  Fix the finding and commit again.\n" +
				ABORT("git merge", "git merge --abort"),
		);
		expect(fs.existsSync(path.join(r.gitDir, "MERGE_HEAD"))).toBe(true);
		expect(r.ran()).toEqual(["pre-commit"]);
	});

	it("refuses a commit the inline pre-commit refuses with the revert hint, where the route names no abort", () => {
		const r = repo();
		fs.writeFileSync(path.join(r.root, "f.txt"), "f\n");
		r.git("add", "--", "f.txt");
		r.precommitExits(3);
		const out = attempt(r, "commit", "-qm", "land", "--no-verify");
		expect(out.code).toBe(1);
		expect(out.stderr).toContain(
			"  Fix the finding and commit again.\n" +
				"  Was this a revert? It is left IN PROGRESS:  git revert --abort\n",
		);
	});

	it("passes the inline pre-commit's own code through on a direct run", () => {
		const r = repo();
		r.precommitExits(3);
		const out = spawnSync("sh", ["-e", ".husky/prepare-commit-msg"], {
			cwd: r.root,
			env: r.env,
			encoding: "utf8",
		});
		expect(out.status).toBe(3);
		const pass = repo();
		const ok = spawnSync("sh", ["-e", ".husky/prepare-commit-msg"], {
			cwd: pass.root,
			env: pass.env,
			encoding: "utf8",
		});
		expect(ok.status).toBe(0);
	});
});

describe("the rows, in-process", () => {
	/** The dispatcher's run in `r` on message `body`; its code and output. */
	async function run(r: Repo, body: string | null, env = r.env) {
		let file = "";
		if (body !== null) {
			file = path.join(r.root, ".git", "COMMIT_EDITMSG");
			fs.writeFileSync(file, body);
		}
		let out = "";
		const code = await runPrepareCommitMsg(
			{ cwd: r.root, env },
			{
				write: (_fd, text) => {
					out += text;
				},
				husky: ".husky",
				file,
			},
		);
		return { code, out };
	}
	/** Stages `f.txt`, and where `stamped` writes pre-commit's stamp on it. */
	const stage = (r: Repo, stamped: boolean) => {
		fs.writeFileSync(path.join(r.root, "f.txt"), "f\n");
		r.git("add", "--", "f.txt");
		if (stamped)
			fs.writeFileSync(
				path.join(r.gitDir, "wfc-precommit-stamp"),
				`${r.git("write-tree")}\n`,
			);
	};
	/** Lays `marker` in the git directory, so the route reads as its own. */
	const marker = (r: Repo, rel: string) => {
		const abs = path.join(r.gitDir, rel);
		if (rel.endsWith("/")) fs.mkdirSync(abs, { recursive: true });
		else fs.writeFileSync(abs, `${r.git("rev-parse", "HEAD")}\n`);
	};
	beforeEach(() => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", mkScratchDir("pcm-dispatch-config-"));
	});

	it("stands down on a matching stamp, consuming it, and runs the trailer alone", async () => {
		const r = repo();
		stage(r, true);
		const { code } = await run(r, "land\n\nReview-Tier: x\n");
		expect(code).toBe(0);
		expect(r.ran()).toEqual(["trailer"]);
		expect(fs.existsSync(path.join(r.gitDir, "wfc-precommit-stamp"))).toBe(
			false,
		);
	});

	it("runs the inline pre-commit where the stamp names another tree, deleting the stamp it leaves", async () => {
		const r = repo();
		stage(r, true);
		fs.writeFileSync(path.join(r.root, "f.txt"), "moved\n");
		r.git("add", "--", "f.txt");
		const { code } = await run(r, "land\n\nReview-Tier: x\n");
		expect(code).toBe(0);
		expect(r.ran()).toEqual(["pre-commit", "trailer"]);
		expect(fs.existsSync(path.join(r.gitDir, "wfc-precommit-stamp"))).toBe(
			false,
		);
	});

	it("refuses a closing keyword with exit 1 and its scanner's text, on a commit", async () => {
		const r = repo();
		stage(r, true);
		const { code, out } = await run(r, "land\n\nFixes #12\n");
		expect(code).toBe(1);
		expect(out).toContain(
			"prepare-commit-msg: this commit message closes an issue server-side the moment it is pushed.",
		);
		expect(r.ran()).toEqual([]);
	});

	it("lets a closing keyword through on a replay, and with no message file", async () => {
		const r = repo();
		stage(r, true);
		marker(r, "rebase-merge/");
		expect((await run(r, "land\n\nFixes #12\n")).code).toBe(0);
		const s = repo();
		stage(s, true);
		expect((await run(s, null)).code).toBe(0);
	});

	it.each([
		[
			"no stamp of this session's and no Review-Tier: line",
			"land\n",
			false,
			[],
		],
		["a Review-Tier: line", "land\n\nreview-tier : x\n", false, ["trailer"]],
		["this session's stamp", "land\n", true, ["trailer"]],
	])("arms the trailer on %s", async (_name, body, sessionStamp, ran) => {
		const r = repo();
		stage(r, true);
		if (sessionStamp)
			fs.writeFileSync(
				reviewTierStamp(r.gitDir, SID) as string,
				"t\nescalated\n",
			);
		expect((await run(r, body)).code).toBe(0);
		expect(r.ran()).toEqual(ran);
	});

	it("arms no trailer with no message file, even on this session's stamp", async () => {
		const r = repo();
		stage(r, true);
		fs.writeFileSync(
			reviewTierStamp(r.gitDir, SID) as string,
			"t\nescalated\n",
		);
		expect((await run(r, null)).code).toBe(0);
		expect(r.ran()).toEqual([]);
	});

	it("says a missing trailer went unchecked, and logs it, on an idle commit too", async () => {
		const r = repo();
		stage(r, true);
		fs.rmSync(path.join(r.root, "scripts", "review-tier-trailer.js"));
		const { code, out } = await run(r, "land\n");
		expect(code).toBe(0);
		expect(out).toBe(
			`prepare-commit-msg: ${path.join(r.root, "scripts", "review-tier-trailer.js")} is missing, so this commit lands with no Review-Tier: trailer and no check that its tree stayed put.\n`,
		);
		expect(readGuardErrorsLog(process.env.CLAUDE_CONFIG_DIR as string)).toMatch(
			/\tprepare-commit-msg\treview-tier-trailer\.js is missing — this commit lands with no Review-Tier: trailer and no check that its tree stayed put\n$/,
		);
	});

	it("refuses where the trailer refuses, its text then the route's abort", async () => {
		const r = repo();
		stage(r, true);
		marker(r, "MERGE_HEAD");
		r.stub("scripts/review-tier-trailer.js", "trailer", 1, "tree moved\n");
		const { code, out } = await run(r, "land\n\nReview-Tier: x\n");
		expect(code).toBe(1);
		expect(out).toBe(`tree moved\n${ABORT("git merge", "git merge --abort")}`);
	});

	it("refuses where the trailer refuses on a commit, with no abort line to add", async () => {
		const r = repo();
		stage(r, true);
		r.stub("scripts/review-tier-trailer.js", "trailer", 1, "tree moved\n");
		const { code, out } = await run(r, "land\n\nReview-Tier: x\n");
		expect(code).toBe(1);
		expect(out).toBe("tree moved\n");
	});

	it("runs the scan, the hold and then the trailer on a cherry-pick", async () => {
		const r = repo();
		stage(r, false);
		marker(r, "CHERRY_PICK_HEAD");
		const env = { ...r.env, WFC_GITLEAKS: "true" };
		expect((await run(r, "land\n\nReview-Tier: x\n", env)).code).toBe(0);
		expect(r.ran()).toEqual(["hold", "trailer"]);
	});

	it("says a missing hold went unchecked and runs no trailer after it", async () => {
		const r = repo();
		stage(r, false);
		marker(r, "CHERRY_PICK_HEAD");
		fs.rmSync(path.join(r.root, "scripts", "review-hold-gate.js"));
		const env = { ...r.env, WFC_GITLEAKS: "true" };
		const { code, out } = await run(r, "land\n\nReview-Tier: x\n", env);
		expect(code).toBe(0);
		expect(out).toBe(
			`prepare-commit-msg: ${path.join(r.root, "scripts", "review-hold-gate.js")} is missing, so this cherry-pick went unchecked for a sensitive-path review.\n`,
		);
		expect(r.ran()).toEqual([]);
	});

	it("takes no hold and no trailer on a rebase, and never the inline pre-commit", async () => {
		const r = repo();
		stage(r, false);
		marker(r, "rebase-merge/");
		const env = { ...r.env, WFC_GITLEAKS: "true" };
		expect((await run(r, "land\n\nReview-Tier: x\n", env)).code).toBe(0);
		expect(r.ran()).toEqual([]);
	});

	it("refuses a replay whose scanner will not start, naming it before the refusal", async () => {
		const r = repo();
		stage(r, false);
		marker(r, "rebase-merge/");
		const env = { ...r.env, WFC_GITLEAKS: path.join(r.root, "no-such-bin") };
		const { code, out } = await run(r, "land\n", env);
		expect(code).toBe(1);
		expect(out).toMatch(
			/^prepare-commit-msg: \S+no-such-bin would not start: .*ENOENT.*\nprepare-commit-msg: the secrets scan did not pass on this git rebase \(mantahostels#1706\)\.\n/,
		);
	});

	it("runs the plugin root's steps where WFC_PLUGIN_ROOT names one", async () => {
		const r = repo();
		stage(r, true);
		const plugin = path.join(r.root, "plugin");
		fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
		fs.symlinkSync(
			path.join(ROOT, "scripts", "check-commit-message-closes.js"),
			path.join(plugin, "scripts", "check-commit-message-closes.js"),
		);
		fs.writeFileSync(
			path.join(plugin, "scripts", "review-tier-trailer.js"),
			programStub(r.log, "plugin trailer"),
		);
		const env = { ...r.env, WFC_PLUGIN_ROOT: plugin };
		expect((await run(r, "land\n\nReview-Tier: x\n", env)).code).toBe(0);
		expect(r.ran()).toEqual(["plugin trailer"]);
	});
});
