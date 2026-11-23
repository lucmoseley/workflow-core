// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTemplate } from "./git-fixture";
import { keptSpawn } from "./kept-spawn.js";

const CODE_LIB = path.resolve(__dirname, "guard-code.js");
const { CORE_FAULT_TEXT } = require("./core-fault.js") as {
	CORE_FAULT_TEXT: string;
};
const HOOKS = "self-plugin/hooks/hooks.json";

const { adoptGuardCodeAt, guardFiles } = require(CODE_LIB) as {
	adoptGuardCodeAt: (
		root: string,
		o: { env: NodeJS.ProcessEnv },
	) => { kind: string; sha?: string; why?: string } | null;
	guardFiles: (codeDir: string) => Record<string, string>;
};

let dir: string;
let repo: string;
let codeDir: string;

const gitIn =
	(cwd: string) =>
	(...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function land(entry: string): string {
	const git = gitIn(repo);
	fs.writeFileSync(path.join(repo, "scripts/guard-dispatch.js"), entry);
	git("add", "-A");
	git("commit", "--quiet", "-m", "guard entry");
	git("push", "--quiet", "origin", "HEAD:main");
	return git("rev-parse", "HEAD");
}

const OK = "process.stdin.resume(); process.stdin.on('end', () => {});\n";
const THROWS = "throw new SyntaxError(\"Unexpected token '}'\");\n";
const DENIES = `process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "guard-x ${CORE_FAULT_TEXT}: scripts/lib/shell-parse.js failed to load"}}));\n`;

const at = (root: string) =>
	adoptGuardCodeAt(root, {
		env: { ...process.env, WFC_GUARD_CODE_DIR: codeDir },
	});
const adopt = () => at(repo);
const files = () => guardFiles(codeDir);
const live = () => fs.readlinkSync(files().current);

const originAndClone = defineTemplate((root) => {
	const origin = path.join(root, "origin.git");
	const clone = path.join(root, "repo");
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", "--quiet", origin, clone]);
	const git = gitIn(clone);
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	fs.mkdirSync(path.join(clone, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(clone, "self-plugin/hooks"), { recursive: true });
	fs.writeFileSync(path.join(clone, HOOKS), '{"hooks":{}}\n');
});

beforeEach(() => {
	dir = originAndClone.instantiate(
		fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-code-"))),
	);
	repo = path.join(dir, "repo");
	codeDir = path.join(dir, "home", ".guard-code");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("adoption", () => {
	it("sets the link up where there is none, as on a fresh machine", () => {
		const sha = land(OK);
		expect(adopt()).toEqual({ kind: "adopted", sha });
		expect(live()).toBe(path.join(codeDir, sha));
		expect(adopt()).toEqual({ kind: "current", sha });
	});

	it("does not adopt a tip whose guards fail to load, keeping the previous code live, and never tries it again", () => {
		const good = land(OK);
		adopt();
		const bad = land(THROWS);
		const r = adopt();
		expect(r?.kind).toBe("refused");
		expect(r?.why).toMatch(/Unexpected token/);
		expect(live()).toBe(path.join(codeDir, good));
		expect(fs.readdirSync(codeDir).sort()).toEqual([good, bad].sort());
		expect(fs.readFileSync(files().refused, "utf8")).toBe(`${bad}\n`);
		expect(fs.readFileSync(files().log, "utf8")).toMatch(
			new RegExp(`refused ${bad.slice(0, 9)}: .*Unexpected token`),
		);
		expect(adopt()).toEqual({ kind: "known-refused", sha: bad });
	});

	it("refuses a tip whose probe call is denied, as a core whose module fails to load answers", () => {
		const good = land(OK);
		adopt();
		land(DENIES);
		const r = adopt();
		expect(r?.kind).toBe("refused");
		expect(r?.why).toMatch(/denied: guard-x could not judge/);
		expect(live()).toBe(path.join(codeDir, good));
	});

	it("adopts a tip whose probe call is denied for any reason but a core it could not run", () => {
		const sha = land(DENIES.replace(CORE_FAULT_TEXT, "refuses ls"));
		expect(adopt()).toEqual({ kind: "adopted", sha });
	});

	it("refuses nothing where the probe could not run, trying the tip again next time", () => {
		const sha = land(OK);
		fs.mkdirSync(path.dirname(codeDir), { recursive: true });
		fs.writeFileSync(codeDir, "");
		const r = adopt();
		expect(r?.kind).toBe("error");
		expect(r?.why).toMatch(/not probed, .*tried again next time/);
		expect(fs.existsSync(files().refused)).toBe(false);
		fs.rmSync(codeDir);
		expect(adopt()).toEqual({ kind: "adopted", sha });
	});

	it("keeps the code it replaces as the previous, and one spare beside, removing every other worktree", () => {
		const first = land(OK);
		adopt();
		const second = land(`${OK}// two\n`);
		adopt();
		fs.mkdirSync(path.join(codeDir, "stray"));
		const third = land(`${OK}// three\n`);
		adopt();
		expect(live()).toBe(path.join(codeDir, third));
		expect(fs.readlinkSync(files().previous)).toBe(path.join(codeDir, second));
		expect(fs.readdirSync(codeDir).sort()).toEqual(
			[first, second, third].sort(),
		);
	});

	it("checks a new tip out in place in the spare, never in the live or previous code (#5426)", () => {
		const first = land(OK);
		adopt();
		land(`${OK}// two\n`);
		adopt();
		const third = land(`${OK}// three\n`);
		adopt();
		const inode = (sha: string) =>
			fs.statSync(path.join(codeDir, sha, HOOKS)).ino;
		const spareInode = inode(first);
		const fourth = land(`${OK}// four\n`);
		expect(adopt()).toEqual({ kind: "adopted", sha: fourth });
		expect(fs.existsSync(path.join(codeDir, first))).toBe(false);
		expect(inode(fourth)).toBe(spareInode);
		const tree = path.join(codeDir, fourth);
		expect(gitIn(tree)("rev-parse", "HEAD")).toBe(fourth);
		expect(gitIn(tree)("status", "--porcelain", "--ignored")).toBe("");
		expect(
			fs.readFileSync(path.join(tree, "scripts/guard-dispatch.js"), "utf8"),
		).toBe(`${OK}// four\n`);
		expect(fs.readlinkSync(files().previous)).toBe(path.join(codeDir, third));
	});

	it("makes a fresh tree where the spare will not check out, leaving no half-made one", () => {
		const first = land(OK);
		adopt();
		const second = land(`${OK}// two\n`);
		adopt();
		const third = land(`${OK}// three\n`);
		adopt();
		const gitDir = gitIn(path.join(codeDir, first))(
			"rev-parse",
			"--absolute-git-dir",
		);
		fs.writeFileSync(path.join(gitDir, "index.lock"), "");
		const fourth = land(`${OK}// four\n`);
		expect(adopt()).toEqual({ kind: "adopted", sha: fourth });
		expect(gitIn(path.join(codeDir, fourth))("rev-parse", "HEAD")).toBe(fourth);
		expect(fs.readdirSync(codeDir).sort()).toEqual(
			[second, third, fourth].sort(),
		);
		expect(fs.readFileSync(files().log, "utf8")).toMatch(
			new RegExp(
				`${fourth.slice(0, 9)} checked out fresh, checking out in the spare failed: `,
			),
		);
	});

	// guess, #5431
	const probeHoldMs = 1500;
	// guess, #5431
	const probeWaitMs = 30_000;
	// guess, #5431
	const raceTestMs = 60_000;

	it(
		"never lets a second adopter take the tree the first is probing, so `.current` never names a missing one (#5431)",
		async () => {
			const probing = path.join(dir, "x-probing");
			const first = land(
				`require("fs").writeFileSync(${JSON.stringify(probing)}, ""); process.stdin.resume(); setTimeout(() => {}, ${probeHoldMs});\n`,
			);
			const run = () =>
				new Promise<{ code: number | null; out: string }>((resolve) => {
					let out = "";
					const child = keptSpawn("concurrent").spawn(
						process.execPath,
						[path.resolve(__dirname, "../adopt-guard-code.js")],
						{
							env: {
								...process.env,
								CLAUDE_PROJECT_DIR: repo,
								WFC_GUARD_CODE_DIR: codeDir,
							},
							stdio: ["ignore", "pipe", "ignore"],
						},
					);
					child.stdout.on("data", (d) => {
						out += d;
					});
					child.on("close", (code) => resolve({ code, out }));
				});
			const x = run();
			await vi.waitFor(() => expect(fs.existsSync(probing)).toBe(true), {
				timeout: probeWaitMs,
				interval: 20,
			});
			const second = land(`${OK}// two\n`);
			const y = await run();
			expect((await x).code).toBe(0);
			expect(y).toEqual({
				code: 0,
				out: `guard code: adopted ${second.slice(0, 9)}\n`,
			});
			expect(live()).toBe(path.join(codeDir, second));
			expect(
				fs.existsSync(path.join(live(), "scripts/guard-dispatch.js")),
			).toBe(true);
			expect(fs.readlinkSync(files().previous)).toBe(path.join(codeDir, first));
			expect(fs.existsSync(files().previous)).toBe(true);
		},
		raceTestMs,
	);

	it("adopts nothing in a checkout whose hooks do not run from it", () => {
		land(OK);
		fs.rmSync(path.join(repo, HOOKS));
		expect(at(repo)).toBeNull();
	});
});
