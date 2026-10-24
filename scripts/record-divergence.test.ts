// @vitest-environment node
/*
 * record-divergence.sh writes one row per refused `git pull` and rejected `git
 * push` (#289), and divergence-report.js reads them back across every repo at
 * once.
 *
 * Every case gets its own CLAUDE_CONFIG_DIR, because that is where the log
 * lands and an unset one would append to the founder's live record — and the
 * report reads EVERY config dir the machine has, so a leak here would be read
 * back by a later case as a real refusal.
 *
 * What each case needs is a specific ahead/behind against a real `origin/main`,
 * so lib/git-fixture.ts builds one template per shape the file uses, and each
 * case copies its shape under its own name, the repo name being on the row
 * (base §X8 (1), #2512). The bare origin sits inside the work tree as
 * `origin.git`, so one template directory carries both and the relink repoints
 * the remote URL at the copy's own origin.
 *
 * The recorder is a PostToolUse hook on every `git` call in `.claude/settings.json`
 * and the plugin's: loosen a case and the refusal counts go wrong or silent, and
 * any reconcile recipe (#290) is aimed at a cause the record misstates.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { projectSlug } from "./lib/project-slug.js";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess } from "./lib/run-in-process";

const RECORDER = path.resolve(__dirname, "record-divergence.sh");
const REPORT = path.resolve(__dirname, "divergence-report.js");

let scratch: string;
let config: string;

/**
 * `git init` plus the identity a commit needs. The env below carries one too,
 * but a runner with no global user.email fails on the config route, which is
 * what every sibling fixture sets (lib/git-fixture.ts's initGitRepo).
 */
const initRepo = (at: string, ...extra: string[]) => {
	git(path.dirname(at), "init", "--initial-branch=main", ...extra, at);
	git(at, "config", "user.email", "test@example.com");
	git(at, "config", "user.name", "test");
};

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
			HUSKY: "0",
		},
	});

/**
 * A work tree at `work` pushed to its own `origin.git`, with `ahead` commits of
 * its own and `behind` commits already fetched into `origin/main` — the
 * divergence a refusal is recorded against.
 */
const buildShape = (work: string, ahead: number, behind: number) => {
	const origin = path.join(work, "origin.git");
	initRepo(work);
	initRepo(origin, "--bare");
	// Built and pushed rather than cloned from empty: cloning an empty origin
	// warns on stderr on every fixture, and a test file that prints twenty
	// warnings trains the reader past the one that matters.
	git(work, "remote", "add", "origin", origin);
	git(work, "commit", "--allow-empty", "--no-verify", "-m", "base");
	git(work, "push", "--quiet", "-u", "origin", "main");

	if (behind) {
		const other = mkScratchDir("divergence-other-");
		try {
			git(other, "clone", "--quiet", origin, ".");
			for (let i = 0; i < behind; i++)
				git(
					other,
					"commit",
					"--allow-empty",
					"--no-verify",
					"-m",
					`theirs${i}`,
				);
			git(other, "push", "--quiet", "origin", "main");
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
		git(work, "fetch", "--quiet", "origin");
		// It names the template's origin, which the relink does not reach and
		// the leak check refuses; nothing here reads it (#2512).
		fs.rmSync(path.join(work, ".git", "FETCH_HEAD"));
	}
	for (let i = 0; i < ahead; i++)
		git(work, "commit", "--allow-empty", "--no-verify", "-m", `mine${i}`);
};

/** Every [ahead, behind] a case below asks `repoWith` for. */
const SHAPES = [
	[0, 0],
	[0, 1],
	[0, 2],
	[1, 0],
	[1, 1],
	[1, 2],
	[2, 0],
	[2, 1],
	[2, 3],
] as const;

const shapes = defineTemplate(
	Object.fromEntries(
		SHAPES.map(([ahead, behind]) => [
			`${ahead}/${behind}`,
			(dir: string) => buildShape(dir, ahead, behind),
		]),
	),
);

const repoWith = (name: string, ahead: number, behind: number) =>
	shapes.instantiate(path.join(scratch, name), `${ahead}/${behind}`);

const fire = (
	cwd: string,
	command: string,
	response: unknown,
	env: Record<string, string> = {},
) => {
	const r = spawnSync(RECORDER, [], {
		encoding: "utf8",
		input: JSON.stringify({
			tool_name: "Bash",
			cwd,
			tool_input: { command },
			tool_response: response,
		}),
		env: { ...process.env, CLAUDE_CONFIG_DIR: config, ...env },
	});
	if (r.status === null) throw new Error(`recorder did not run: ${r.error}`);
	// A PostToolUse hook's stdout is context handed to the session, on every
	// git call.
	expect(r.stdout).toBe("");
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return r;
};

/** Every row written so far, across every project directory. */
const rows = () => {
	const projects = path.join(config, "projects");
	if (!fs.existsSync(projects)) return [];
	const out: string[][] = [];
	for (const entry of fs.readdirSync(projects)) {
		const file = path.join(projects, entry, "divergence.log");
		if (!fs.existsSync(file)) continue;
		for (const line of fs.readFileSync(file, "utf8").split("\n"))
			if (line) out.push(line.split("\t"));
	}
	return out;
};

const FF_REFUSAL = {
	stdout: "",
	stderr: "fatal: Not possible to fast-forward, aborting.",
};
const PUSH_REJECT = {
	stdout: "",
	stderr:
		"! [rejected]        main -> main (fetch first)\nUpdates were rejected because the remote contains work",
};

beforeEach(() => {
	scratch = mkScratchDir("divergence-");
	config = path.join(scratch, "cfg");
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("record-divergence.sh", () => {
	it("records a refused ff-only pull with the divergence that caused it", () => {
		const work = repoWith("diverged", 2, 3);
		fire(work, "git pull --ff-only", FF_REFUSAL);

		const [row] = rows();
		expect(row).toBeDefined();
		const [when, repo, kind, ahead, behind, state, sessions, ref, marker] = row;
		expect(when).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
		expect(repo).toBe("diverged");
		expect(kind).toBe("pull");
		expect(ahead).toBe("2");
		expect(behind).toBe("3");
		expect(state).toBe("diverged");
		expect(sessions).toMatch(/^(\d+|-)$/);
		expect(ref).toBe("origin/main");
		expect(marker).toBe("Not possible to fast-forward");
	});

	it("calls a session with no commits of its own `behind`, not `diverged`", () => {
		const work = repoWith("laggard", 0, 2);
		fire(work, "git pull --ff-only", FF_REFUSAL);
		expect(rows()[0].slice(2, 6)).toEqual(["pull", "0", "2", "behind"]);
	});

	it("records a rejected push, whose behind count is a lower bound", () => {
		const work = repoWith("rejected", 1, 0);
		fire(work, "git push origin main", PUSH_REJECT);
		expect(rows()[0].slice(2, 6)).toEqual(["push", "1", "0", "ahead"]);
	});

	it("reads git's subcommand past its global options", () => {
		const work = repoWith("viaC", 1, 1);
		fire(work, `git -c core.pager=cat -C ${work} pull --ff-only`, FF_REFUSAL);
		expect(rows()).toHaveLength(1);
		expect(rows()[0][2]).toBe("pull");
	});

	it("files a `git -C` refusal under the repo it was refused in", () => {
		// Level, so a row misfiled here would read `level` — a state at which a
		// fast-forward cannot be refused at all.
		const here = repoWith("session-repo", 0, 0);
		const there = repoWith("elsewhere", 2, 3);
		fire(here, `git -C ${there} pull --ff-only`, FF_REFUSAL);
		expect(rows()).toHaveLength(1);
		expect(rows()[0].slice(1, 6)).toEqual([
			"elsewhere",
			"pull",
			"2",
			"3",
			"diverged",
		]);
	});

	it("resolves a relative `-C` against the command's own cwd", () => {
		repoWith("relative-target", 2, 1);
		fire(scratch, "git -C relative-target pull --ff-only", FF_REFUSAL);
		expect(rows()).toHaveLength(1);
		expect(rows()[0].slice(1, 5)).toEqual([
			"relative-target",
			"pull",
			"2",
			"1",
		]);
	});

	it("composes repeated `-C`, as git does", () => {
		repoWith("nested", 1, 2);
		fs.mkdirSync(path.join(scratch, "hop"));
		// `hop/../nested` reaches the repo only if the two compose: a walker taking
		// the first `-C` lands in `hop`, one taking the last lands in `../nested`,
		// and neither is a repository.
		fire(scratch, "git -C hop -C ../nested pull --ff-only", FF_REFUSAL);
		expect(rows()).toHaveLength(1);
		expect(rows()[0].slice(1, 5)).toEqual(["nested", "pull", "1", "2"]);
	});

	it("drops the row where the `-C` path does not resolve", () => {
		const here = repoWith("unresolved-C", 1, 1);
		// #289 counts refusals per repo. Filing this under the session's own repo
		// would invent an observation there and hide one wherever it really
		// happened; the count is a lower bound instead.
		fire(here, "git -C $WORKTREE pull --ff-only", FF_REFUSAL);
		expect(rows()).toEqual([]);
	});

	it("finds a pull in a later segment of a compound command", () => {
		const work = repoWith("compound", 1, 1);
		fire(work, "git fetch origin && git pull --ff-only", FF_REFUSAL);
		expect(rows()).toHaveLength(1);
	});

	it("records a pull after an empty segment", () => {
		const work = repoWith("after-empty", 1, 1);
		fire(work, "true; ( ); git pull --ff-only", FF_REFUSAL);
		expect(rows()).toHaveLength(1);
	});

	for (const [why, command, response] of [
		[
			"a pull that succeeded",
			"git pull --ff-only",
			{ stdout: "Already up to date." },
		],
		[
			"another subcommand entirely",
			"git status",
			{ stdout: "nothing to commit" },
		],
		[
			"a command that only mentions a pull",
			'grep -rn "git pull" docs',
			{ stdout: "Not possible to fast-forward" },
		],
		[
			"a config key whose value reads like a subcommand",
			"git -c alias.x=pull status",
			{ stdout: "Not possible to fast-forward" },
		],
		// An empty segment must leave stderr silent under the script's `set -u`
		// (#2388).
		["an empty trailing segment", "ls; ", FF_REFUSAL],
		["a blank line between commands", "echo a\n\necho b", FF_REFUSAL],
	] as const) {
		it(`writes nothing for ${why}`, () => {
			const work = repoWith("quiet", 1, 1);
			fire(work, command, response);
			expect(rows()).toEqual([]);
		});
	}

	it("writes nothing when switched off", () => {
		const work = repoWith("off", 1, 1);
		fire(work, "git pull --ff-only", FF_REFUSAL, {
			WFC_NO_DIVERGENCE_LOG: "1",
		});
		expect(rows()).toEqual([]);
	});

	it("files each repo under its own project directory", () => {
		fire(repoWith("alpha", 1, 1), "git pull --ff-only", FF_REFUSAL);
		fire(repoWith("beta", 1, 1), "git pull --ff-only", FF_REFUSAL);
		const dirs = fs
			.readdirSync(path.join(config, "projects"))
			.filter((d) =>
				fs.existsSync(path.join(config, "projects", d, "divergence.log")),
			);
		expect(dirs).toHaveLength(2);
		expect(
			rows()
				.map((r) => r[1])
				.sort(),
		).toEqual(["alpha", "beta"]);
	});

	it("appends rather than replacing", () => {
		const work = repoWith("twice", 1, 1);
		fire(work, "git pull --ff-only", FF_REFUSAL);
		fire(work, "git push origin main", PUSH_REJECT);
		expect(rows().map((r) => r[2])).toEqual(["pull", "push"]);
	});

	it("records a missing jq, which otherwise looks like a repo that never diverges", () => {
		const work = repoWith("nojq", 1, 1);
		// A PATH carrying only what the script needs before it gives up — bash for
		// the shebang, mkdir for the fail-open log — and no jq. Shadowing an absence
		// is impossible, so the way to take jq away is to hand over a PATH that
		// never had it.
		const bin = path.join(scratch, "nobin");
		fs.mkdirSync(bin);
		for (const tool of ["bash", "mkdir"])
			fs.symlinkSync(
				execFileSync("which", [tool], { encoding: "utf8" }).trim(),
				path.join(bin, tool),
			);
		fire(work, "git pull --ff-only", FF_REFUSAL, { PATH: bin });
		expect(rows()).toEqual([]);
		const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
		const log = fs.readFileSync(
			path.join(config, "projects", projectSlug(root), "guard-errors.log"),
			"utf8",
		);
		expect(log).toMatch(/jq not found/);
	});

	it("counts sessions off the ps at WFC_PS, one per Claude bg-pty-host (#1305)", () => {
		const work = repoWith("counted", 1, 1);
		const ps = writePsStub(scratch, [
			"10 1 /home/u/.local/share/claude/versions/2.1.234 bg-pty-host --job a /spare/a.pty.sock",
			"11 1 claude bg-pty-host --job b /spare/b.pty.sock",
			"12 1 C:\\Users\\u\\claude.exe bg-pty-host --job c",
			"13 11 claude bg-spare",
			"14 1 vim bg-pty-host",
		]);
		fire(work, "git pull --ff-only", FF_REFUSAL, { WFC_PS: ps });
		expect(rows()[0][6]).toBe("3");
	});

	it("records sessions as `-` where WFC_PS names no binary, and still writes the row", () => {
		const work = repoWith("nops", 1, 1);
		fire(work, "git pull --ff-only", FF_REFUSAL, {
			WFC_PS: path.join(scratch, "absent-ps"),
		});
		expect(rows()[0][6]).toBe("-");
	});

	it("slugs the project directory exactly as lib/project-slug.js does", () => {
		// The recorder restates that transform in bash rather than sourcing it
		// (its own header says why).
		const work = repoWith("slugged", 1, 1);
		fire(work, "git pull --ff-only", FF_REFUSAL);
		expect(
			fs.existsSync(
				path.join(config, "projects", projectSlug(work), "divergence.log"),
			),
		).toBe(true);
	});

	it("names the repository, not the worktree it was refused in", () => {
		const work = repoWith("mainline", 1, 1);
		const tree = path.join(scratch, "throwaway");
		git(work, "worktree", "add", "--quiet", "--detach", tree);
		fire(tree, "git pull --ff-only", FF_REFUSAL);
		expect(rows()[0][1]).toBe("mainline");
	});

	it("counts against origin/landing with the landing module on (#2408)", () => {
		const work = repoWith("queued", 1, 0);
		git(work, "push", "--quiet", "origin", "HEAD~1:refs/heads/landing");
		fire(work, "git push origin main:landing", PUSH_REJECT, {
			WFC_MODULES: "landing",
		});
		expect(rows()[0].slice(3, 6)).toEqual(["1", "0", "ahead"]);
		expect(rows()[0][7]).toBe("origin/landing");
	});

	it("records `unknown` rather than nothing where there is no ref to count against", () => {
		const bare = path.join(scratch, "solo");
		fs.mkdirSync(bare);
		initRepo(bare);
		git(bare, "commit", "--allow-empty", "--no-verify", "-m", "only");
		fire(bare, "git pull --ff-only", FF_REFUSAL);
		expect(rows()[0].slice(3, 6)).toEqual(["-", "-", "unknown"]);
		expect(rows()[0][7]).toBe("-");
	});
});

describe("divergence-report.js", () => {
	/* One sandbox pointed at three times over, so a real plan's log cannot leak
	 * in and the deduplication is exercised at the same time. */
	const env = () => ({
		...process.env,
		CLAUDE_CONFIG_DIR: config,
		WFC_CLAUDE_CONFIG_A: config,
		WFC_CLAUDE_CONFIG_B: config,
		WFC_CLAUDE_CONFIG_C: config,
	});

	const report = (...args: string[]) => {
		const r = runInProcess(REPORT, args, { env: env(), cwd: scratch });
		expect(r.status).toBe(0);
		return r.stdout;
	};

	it("says so plainly when nothing has been recorded", () => {
		fs.mkdirSync(config, { recursive: true });
		expect(report()).toMatch(/No divergence rows recorded yet/);
	});

	it("summarises each repo separately, which is the whole point", () => {
		fire(repoWith("noisy", 1, 2), "git pull --ff-only", FF_REFUSAL);
		fire(repoWith("noisy2", 0, 1), "git pull --ff-only", FF_REFUSAL);
		const out = JSON.parse(report("--json"));
		expect(Object.keys(out.byRepo).sort()).toEqual(["noisy", "noisy2"]);
		expect(out.byRepo.noisy.state.diverged).toBe(1);
		expect(out.byRepo.noisy2.state.behind).toBe(1);
		expect(out.byRepo.noisy.medianBehindOnPull).toBe(2);
	});

	it("counts a row once however many config dirs reach the same log", () => {
		fire(repoWith("once", 1, 1), "git pull --ff-only", FF_REFUSAL);
		const out = JSON.parse(report("--json"));
		expect(out.byRepo.once.refusals).toBe(1);
	});

	it("separates pull counts from push counts, the push ones being a lower bound", () => {
		const work = repoWith("both", 2, 0);
		fire(work, "git pull --ff-only", FF_REFUSAL);
		fire(work, "git push origin main", PUSH_REJECT);
		const out = JSON.parse(report("--json"));
		expect(out.byRepo.both.pull).toBe(1);
		expect(out.byRepo.both.push).toBe(1);
		expect(report()).toMatch(/on push \(lower bound\)/);
	});

	it("drops rows outside --since", () => {
		fire(repoWith("old", 1, 1), "git pull --ff-only", FF_REFUSAL);
		expect(JSON.parse(report("--json", "--since", "2099-01-01")).rows).toEqual(
			[],
		);
		expect(JSON.parse(report("--json", "--since", "1d")).rows).toHaveLength(1);
	});

	it("prints the rows themselves on --rows", () => {
		fire(repoWith("shown", 1, 1), "git pull --ff-only", FF_REFUSAL);
		expect(report("--rows")).toMatch(/shown\s+pull\s+\+1\/-1\s+diverged/);
	});

	it("refuses a --since it cannot read rather than silently reporting everything", () => {
		fs.mkdirSync(config, { recursive: true });
		const r = runInProcess(REPORT, ["--since", "yesterday"], {
			env: env(),
			cwd: scratch,
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/--since wants/);
	});
});
