// @vitest-environment node
/**
 * Tests for read-audit-git.js (#5078): the guard's record, git's option
 * walk, the key and answer id, which calls run again, and that run again.
 *
 * The bash guard writes the record this module reads, and nothing else ties
 * the two: the parity cases read the guard's own `case` list and variable
 * loop, and run the real guard on PATH in a tmp repository, so a list edited
 * on one side alone fails here rather than voiding pass-store rows unseen.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const require = createRequire(import.meta.url);
/** The answer id the guard spells: status, then the sha1 of stdout. */
const answerOf = (status: number, stdout: string | Buffer) =>
	`${status}:${createHash("sha1").update(stdout).digest("hex")}`;
const {
	buildGitRunner,
	GIT_ANSWER_VARS,
	keyOf,
	parseGitRecords,
	gitCallsOf,
	stepGitOptions,
} = require("./read-audit-git.js");
const { GIT_VALUED } = require("./git-options.js");

const GUARD_DIR = path.join(__dirname, "host-git-guard");
const GUARD = fs.readFileSync(
	path.join(__dirname, "host-git-guard/git"),
	"utf8",
);

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

const scratch = (prefix: string) => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	dirs.push(d);
	return d;
};

/** A repository whose one commit holds `sub/<file>`. */
function repository(file: string) {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rag-")));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: d, encoding: "utf8" });
	git("init", "-q");
	fs.mkdirSync(path.join(d, "sub"));
	fs.writeFileSync(path.join(d, "sub", file), "a\n");
	git("add", ".");
	git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "one");
	return d;
}

/* Read-only repositories, built once. */
let repo: string;
let elsewhere: string;
beforeAll(() => {
	repo = repository("a.txt");
	elsewhere = repository("b.txt");
});
afterAll(() => {
	for (const d of [repo, elsewhere])
		fs.rmSync(d, { recursive: true, force: true });
});

const ROOT = "/r";
const Answer = "0:da39a3ee5e6b4b0d3255bfef95601890afd80709";
const NoStanding = { env: {}, gitAt: 0 };

/** One call's two guard records, begun then answered, as parsed. */
const records = (
	args: string[],
	{ dir = ROOT, steered = "", answer = Answer, env = {}, at = 0 } = {},
) =>
	["", answer].map((a) => ({ at, steered, dir, pid: 7, answer: a, env, args }));

describe("the guard's record is the one this module reads", () => {
	it("steps the options the guard's `case` steps", () => {
		const line = /^\s*(-C \|[^)]*)\) takes=1 ;;$/m.exec(GUARD)?.[1];
		expect(line?.split(" | ").sort()).toEqual([...GIT_VALUED].sort());
	});

	it("records the variables GIT_ANSWER_VARS names, in the guard's loop", () => {
		const loop = /^\s*for name in (.*); do$/m.exec(GUARD)?.[1] as string;
		const guard = loop
			.split(" ")
			.map((w) => w.replace(/^\$\{!(\w+)\*\}$/, "$1.*"))
			.sort();
		const ours = /^\^\((.*)\)\$$/.exec(GIT_ANSWER_VARS.source)?.[1] as string;
		expect(guard).toEqual(ours.split("|").sort());
	});

	it("parses a record the guard writes to the fields it was given", () => {
		const log = scratch("rag-log-");
		const cwd = path.join(repo, "sub");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: `${GUARD_DIR}${path.delimiter}${process.env.PATH}`,
			WFC_HOST_GIT_DIR: path.join(repo, ".git"),
			WFC_READ_AUDIT: log,
			WFC_READ_AUDIT_OWNER: "1",
			WFC_READ_AUDIT_ROOT: repo,
			TZ: "Pacific/Chatham",
			GIT_AUTHOR_NAME: "ünï",
		};
		delete env.WFC_HOST_GIT_GUARD_DEPTH;
		const call = spawnSync("git", ["ls-files", "-z", "a.txt"], { cwd, env });
		const gitDir = { ...env, GIT_DIR: path.join(repo, ".git") };
		spawnSync("git", ["ls-files", "-z", "a.txt"], { cwd, env: gitDir });
		const [begun, answered, ...steered] = parseGitRecords(
			fs.readFileSync(path.join(log, "1.git")),
		);
		expect(steered.map((s: { steered: string }) => s.steered)).toEqual([
			"1",
			"1",
		]);
		for (const r of [begun, answered]) {
			expect(r).toMatchObject({
				steered: "",
				dir: cwd,
				args: ["ls-files", "-z", "a.txt"],
			});
			expect(r.env).toMatchObject({
				TZ: "Pacific/Chatham",
				GIT_AUTHOR_NAME: "ünï",
			});
			for (const name of Object.keys(r.env))
				expect(name).toMatch(GIT_ANSWER_VARS);
		}
		expect(begun.at).toBe(0);
		expect(begun.answer).toBe("");
		expect([begun.pid, answered.pid]).toEqual([call.pid, call.pid]);
		expect(answered.answer).toBe(answerOf(0, call.stdout));
		expect(answered.at).toBeGreaterThan(0);
	});

	it("throws on a torn record", () => {
		expect(() => parseGitRecords(Buffer.from("9\0a\0"))).toThrow(/torn/);
		expect(() => parseGitRecords(Buffer.from("5\0\0/r\x007\0\0x\0"))).toThrow(
			/torn/,
		);
	});
});

describe("stepGitOptions", () => {
	it.each([
		[["ls-files"], 0, ""],
		[["-C", "/x", "--no-pager", "log"], 3, "[-C@0][--no-pager@2]"],
		[["-c", "log"], 2, "[-c@0]"],
		[["--shallow-file", "s", "log"], 2, "[--shallow-file@0]"],
		[["--exec-path=/e", "log"], 1, "[--exec-path=/e@0]"],
		[["--git-dir=/g", "log"], 1, "[--git-dir=/g@0]"],
		[["-C"], 1, "[-C@0]"],
	])("steps %j to %i", (words, sub, seen) => {
		const got: string[] = [];
		expect(
			stepGitOptions(words, (w: string, at: number) =>
				got.push(`[${w}@${at}]`),
			),
		).toBe(sub);
		expect(got.join("")).toBe(seen);
	});
});

describe("keyOf", () => {
	it("spells a row's key", () => {
		expect(keyOf({ args: ["log"], cwd: "." })).toBe(
			'{"cwd":".","args":["log"]}',
		);
	});
});

describe("gitCallsOf", () => {
	it("keeps a read-only call made under the root, repo-relative, with its answer", () => {
		expect(
			gitCallsOf(
				records(["ls-files", "-z"], { dir: "/r/sub" }),
				NoStanding,
				ROOT,
			),
		).toEqual([{ cwd: "sub", args: ["ls-files", "-z"], answer: Answer }]);
	});

	it.each([
		[["status"], {}, "read this repository"],
		[["diff", "--output=/t/d"], {}, "wrote its answer to a file"],
		[["diff", "--output", "/t/d"], {}, "wrote its answer to a file"],
		[["-C", "/r", "ls-files"], {}, "named its repository"],
		[["--git-dir=/r/.git", "log"], {}, "named its repository"],
		[["--work-tree", "/r", "log"], {}, "named its repository"],
		[["--shallow-file", "s", "status"], {}, "read this repository"],
		[["log"], { steered: "1" }, "was steered by a git-dir variable"],
		[
			["log"],
			{ dir: "/elsewhere" },
			"read another checkout of this repository",
		],
	])("doubts %j %j: %s", (args, opts, doubt) => {
		expect(gitCallsOf(records(args, opts), NoStanding, ROOT).doubt).toBe(
			`a git call (git ${args.join(" ")}) ${doubt}`,
		);
	});

	it("keeps a read-only call past --shallow-file's value, which git takes as the next word", () => {
		const args = ["--shallow-file", "s", "log"];
		expect(gitCallsOf(records(args), NoStanding, ROOT)).toEqual([
			{ cwd: ".", args, answer: Answer },
		]);
	});

	it.each([
		[["cat-file", "--batch"]],
		[["cat-file", "--batch-check=%(objectname)"]],
		[["check-ignore", "--stdin"]],
		[["rev-list", "--stdin"]],
		[["diff", "--no-index", "-", "scripts/lib/hooks.js"]],
		[["grep", "-l", "-f-"]],
		[["ls-files", "-o", "--exclude-from=-"]],
		[["check-ignore", "--stdi", "-v"]],
		[["rev-list", "--std"]],
		[["name-rev", "--annotate-std"]],
		[["show-ref", "--exclude-e"]],
		[["show-ref", "--exclude-e=refs/heads/"]],
		[["cat-file", "--b"]],
		[["grep", "-l", "-f", "/dev/stdin"]],
		[["grep", "-lf/dev/stdin"]],
		[["grep", "-f", "/proc/self/fd/0"]],
		[["grep", "-f", "/proc/4242/fd/0"]],
		[["grep", "-l", "-f", "/dev/fd/3"]],
		[["ls-files", "-o", "--exclude-from=/dev/stdin"]],
		[["ls-files", "-o", "--exclude-from=/dev/./fd//0"]],
		[["diff", "--no-index", "/dev/stdin", "scripts/lib/hooks.js"]],
		[["diff", "--no-index", "../../dev/fd/0", "scripts/lib/hooks.js"]],
		[["grep", "-l", "--file=/../dev/stdin"]],
		[["grep", "-l", "-F/../dev/stdin"]],
		[["grep", "-l", "--file=/dev/stdout"]],
		[["grep", "-lf/dev/stderr"]],
	])(
		"doubts a call fed by its standard input or another descriptor, which a run again never has: %j",
		(words) => {
			expect(gitCallsOf(records(words), NoStanding, ROOT).doubt).toMatch(
				/a git call \(git .*\) read its standard input or another descriptor/,
			);
		},
	);

	it.each([
		[["diff", "--no-index", "/dev/null", "scripts/lib/hooks.js"]],
		[["ls-files", "-o", "--exclude-from=dev/stdin.txt"]],
		[["ls-files", "--stage", "--exclude-standard"]],
		[["log", "--stat", "--all", "--branches", "--parents"]],
		[["rev-parse", "--abbrev-ref", "HEAD", "--"]],
	])(
		"keeps a call whose options only resemble one fed by a descriptor: %j",
		(words) => {
			expect(gitCallsOf(records(words), NoStanding, ROOT)).toEqual([
				{ cwd: ".", args: words, answer: Answer },
			]);
		},
	);

	it("doubts a call logged begun and never answered, or answered two ways", () => {
		const [begun, answered] = records(["ls-files"]);
		expect(gitCallsOf([begun, begun, answered], NoStanding, ROOT).doubt).toBe(
			"a git call (git ls-files) was logged without its answer",
		);
		expect(gitCallsOf([begun], NoStanding, ROOT).doubt).toMatch(
			/without its answer/,
		);
		const other = { ...answered, answer: "0:x" };
		expect(
			gitCallsOf([begun, answered, begun, other], NoStanding, ROOT).doubt,
		).toBe("a git call (git ls-files) answered differently within the run");
		expect(
			gitCallsOf([begun, answered, begun, answered], NoStanding, ROOT),
		).toHaveLength(1);
	});

	it("doubts a call made under an answer variable set apart from the settled one, and weighs none made before the setup settled", () => {
		const standing = { env: { HOME: "/h", GIT_TRACE2_EVENT: "/a" }, gitAt: 10 };
		const apart = records(["log"], {
			at: 10,
			env: { HOME: "/o", TZ: "UTC", WFC_X: "1" },
		});
		expect(gitCallsOf(apart, standing, ROOT).doubt).toBe(
			"a git call (git log) ran under a variable that steers git (HOME, TZ)",
		);
		expect(
			gitCallsOf(
				records(["log"], { at: 9, env: { HOME: "/o" } }),
				standing,
				ROOT,
			),
		).toHaveLength(1);
		const settled = records(["log"], {
			at: 10,
			env: { HOME: "/h", GIT_TRACE2_EVENT: "/b" },
		});
		expect(gitCallsOf(settled, standing, ROOT)).toHaveLength(1);
	});
});

describe("buildGitRunner", () => {
	const spawnGit = (
		args: string[],
		opts: { cwd: string; env: NodeJS.ProcessEnv },
	) => spawnSync("git", args, opts);

	it("answers a call run again at the root as the test's call answered, without the git-dir variables", () => {
		vi.stubEnv("GIT_DIR", path.join(elsewhere, ".git"));
		const run = buildGitRunner(repo, spawnGit);
		const key = keyOf({ cwd: "sub", args: ["ls-files", "-z"] });
		expect(run(key)).toBe(answerOf(0, "a.txt\0"));
		expect(
			run(keyOf({ cwd: ".", args: ["cat-file", "-e", "HEAD:nope"] })),
		).toMatch(/^128:/);
	});

	it("answers null for a key that will not parse or a call that will not run, and runs a key once", () => {
		let runs = 0;
		const run = buildGitRunner(
			repo,
			(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
				runs += 1;
				return spawnGit(args, opts);
			},
		);
		expect(run("{")).toBeNull();
		expect(run(keyOf({ cwd: "gone", args: ["log"] }))).toBeNull();
		const key = keyOf({ cwd: ".", args: ["rev-parse", "HEAD"] });
		expect(run(key)).toBe(run(key));
		expect(runs).toBe(2);
	});
});
