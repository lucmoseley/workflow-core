// @vitest-environment node
/*
 * The parse half of mantahostels#1818: given one opaque shell string, which paths is this
 * command about to WRITE?
 *
 * A command that merely MENTIONS a guarded path — a grep, a cat, an echo, a
 * `cp` reading one as its source — must produce nothing, or the injection fires
 * on reading the very file it is about.
 *
 * Each case spawns a COPY of the guard with the real shell libraries beside it
 * and a stub judge that records its argv, so what is asserted is the path list
 * and ledger flags the shell hands the judge, not the judge's verdict.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`) and nothing else announces a Bash-route write to a
 * claimed file: a missed write route lets a session overwrite a neighbour's
 * tier-1 doc unwarned.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";
import {
	buildBashPayload,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-claimed-bash-write.sh");
const require_ = createRequire(__filename);
const { errorLog } = require_("./lib/arbiter-store.js");
const { ruleText } = require_("./lib/rule-text.js");

let dir: string;
let repo: string;
let config: string;
let argvLog: string;
/*
 * THE CORE, STOOD UP AWAY FROM THE HOST (#1) — what a plugin install looks
 * like. The guard, its shell libraries and its judge are one shipment:
 * `warn-claimed-bash-write.js` is named from the guard's own directory, never
 * from the host root, because the host repo has no `scripts/` of the core's at
 * all.
 */
let coreDir: string;
let guard: string;

const STUB_WARNING = "STUB-WARNING";

/** A copy of the guard with the real shell libraries beside it, in `coreDir`. */
function standCore() {
	copyLibs(path.join(coreDir, "lib"), sourcedLibs(GUARD));
	guard = path.join(coreDir, "guard-claimed-bash-write.sh");
	fs.copyFileSync(GUARD, guard);
	fs.chmodSync(guard, 0o755);
}

function stubJudge(prints = true) {
	fs.writeFileSync(
		path.join(coreDir, "warn-claimed-bash-write.js"),
		`require("node:fs").writeFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join("\\n"));\n` +
			(prints ? `console.log(${JSON.stringify(STUB_WARNING)});\n` : ""),
	);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claimed-bash-write-"));
	repo = path.join(dir, "repo");
	config = path.join(dir, "config");
	argvLog = path.join(dir, "argv");
	coreDir = path.join(dir, "core");
	fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
	fs.mkdirSync(path.join(repo, "docs", "agents"), { recursive: true });
	fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
	fs.mkdirSync(config, { recursive: true });
	// A host whose tests read the selection ledger (#1245).
	fs.writeFileSync(
		path.join(repo, "package.json"),
		'{"scripts":{"test":"node scripts/run-vitest.js"}}',
	);
	standCore();
	stubJudge();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Runs the guard on `command`, as Claude Code would. */
function run(command: string) {
	const r = spawnGuard(guard, buildBashPayload(command, "mine"), {
		project: repo,
		config,
		cwd: repo,
	});
	expect(r.status).toBe(0);
	return r;
}

/** Every argument the guard handed the judge, or null where it never called it. */
function judgeArgv(command: string): string[] | null {
	fs.rmSync(argvLog, { force: true });
	run(command);
	if (!fs.existsSync(argvLog)) return null;
	return fs.readFileSync(argvLog, "utf8").split("\n");
}

/**
 * The judge's argv split into its parts: the `--credit` paths (mantahostels#2778),
 * the tier-1 targets, and nothing else. Null where the judge was never called.
 *
 * Every leading flag is variadic, so the split walks them rather than slicing
 * a fixed prefix.
 */
function judgeParts(
	command: string,
): { credits: string[]; targets: string[] } | null {
	return judgeSplit(command)?.parts ?? null;
}

function judgeSplit(command: string): {
	parts: { credits: string[]; targets: string[] };
	selects: string[];
} | null {
	const argv = judgeArgv(command);
	if (argv === null) return null;
	const credited: string[] = [];
	const selects: string[] = [];
	let rest = argv;
	for (;;) {
		if (rest[0] === "--ledger") {
			rest = rest.slice(2);
			continue;
		}
		if (rest[0] === "--credit") {
			credited.push(rest[1]);
			rest = rest.slice(2);
			continue;
		}
		if (rest[0] === "--select") {
			selects.push(rest[1]);
			rest = rest.slice(2);
			continue;
		}
		break;
	}
	expect(rest[0]).toBe("mine");
	return {
		parts: {
			credits: credited,
			targets: rest.slice(1).map((p) => path.relative(repo, p)),
		},
		selects,
	};
}

/** The `--select` paths alone (#1220), sorted; null where the judge was never called. */
function selectsOf(command: string): string[] | null {
	return judgeSplit(command)?.selects.sort() ?? null;
}

/**
 * The tier-1 targets alone, repo-relative. Null where the judge was never
 * called at all — which since mantahostels#2778 also requires the command to name no code
 * path, since one of those calls the judge on its own.
 */
function targets(command: string): string[] | null {
	return judgeParts(command)?.targets ?? null;
}

/** The `--credit` paths alone (mantahostels#2778), already repo-relative. */
function credits(command: string): string[] | null {
	return judgeParts(command)?.credits ?? null;
}

/**
 * Everything the guard has written to its fail-open log.
 *
 * errorLog() derives its path from the environment, so the sandbox's is put
 * back afterwards — the suite's afterEach deletes these directories, and a
 * leaked value would point a later suite's log at a path that is gone.
 */
const logLines = () => {
	const saved = { ...process.env };
	process.env.CLAUDE_CONFIG_DIR = config;
	process.env.CLAUDE_PROJECT_DIR = repo;
	try {
		const at = errorLog();
		return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
	} finally {
		process.env = saved;
	}
};

describe("the session ledger it hands the judge (mantahostels#2345)", () => {
	it("names a ledger inside clear-rule-latch.sh's own glob", () => {
		const argv = judgeArgv("echo hi > docs/x.md");
		expect(argv?.[0]).toBe("--ledger");
		// What clear-rule-latch.sh globs and arbiter-markers.js sweeps: the
		// marker directory (.claude/tmp/markers), not the repo root itself
		// (mantahostels#3515 F8, issue #2). A path outside it outlives the
		// compaction that discards what it records.
		expect(path.dirname(argv?.[1] ?? "")).toBe(
			path.join(repo, ".claude", "tmp", "markers"),
		);
		expect(path.basename(argv?.[1] ?? "")).toBe(
			".rule-injected-led.claimed-bash-write-main-mine",
		);
	});

	it("keys it on the AGENT too, so a subagent does not inherit its parent's", () => {
		const r = spawnGuard(
			guard,
			{ ...buildBashPayload("echo hi > docs/x.md", "mine"), agent_id: "sub" },
			{ project: repo, config, cwd: repo },
		);
		expect(r.status).toBe(0);
		const argv = fs.readFileSync(argvLog, "utf8").split("\n");
		expect(path.basename(argv[1])).toBe(
			".rule-injected-led.claimed-bash-write-asub-mine",
		);
	});

	/*
	 * WHAT gp_latch_path RETURNS is covered in scripts/lib/guard-parse.test.ts
	 * (mantahostels#2411).
	 *
	 * The guard sources both libraries out of its own directory, so no fixture
	 * can withhold them from the guard where it lives — `gr_root` returns empty
	 * only when guard-root.sh fails to LOAD, and emptying CLAUDE_PROJECT_DIR
	 * does not stand in, `:-` treating it as unset (mantahostels#2420).
	 */

	/**
	 * Runs a byte-for-byte copy of the guard whose `gp_latch_path` returns `rc`,
	 * every other parser function staying real — `null` overrides nothing, which
	 * is the control.
	 */
	function withLatchRc(rc: number | null) {
		const real = path.resolve(__dirname, "lib");
		// The shim replaces the copy standCore() put in the core's own lib
		// directory, the only place the guard sources it from.
		fs.writeFileSync(
			path.join(coreDir, "lib", "guard-parse.sh"),
			`source ${JSON.stringify(path.join(real, "guard-parse.sh"))}\n` +
				(rc === null ? "" : `gp_latch_path() { return ${rc}; }\n`),
		);
		fs.rmSync(argvLog, { force: true });
		const r = spawnGuard(
			guard,
			buildBashPayload("echo hi > docs/x.md", "mine"),
			{
				project: repo,
				config,
				cwd: repo,
			},
		);
		expect(r.status).toBe(0);
		return r;
	}

	const lastArgv = () => fs.readFileSync(argvLog, "utf8").split("\n");

	it("hands the judge a ledger where nothing is staged, as in place", () => {
		withLatchRc(null);
		const argv = lastArgv();
		expect(argv[0]).toBe("--ledger");
		expect(path.basename(argv[1])).toBe(
			".rule-injected-led.claimed-bash-write-main-mine",
		);
		expect(logLines()).toBe("");
	});

	it("names the unresolved root on code 1, and drops --ledger", () => {
		withLatchRc(1);
		expect(lastArgv()[0]).toBe("mine");
		expect(logLines()).toContain(
			"repo root unresolved — the claimed-bash-write ledger is unwritable",
		);
		expect(logLines()).not.toContain("no session key");
	});

	it("names the missing session key on code 2, the payload not parsing", () => {
		withLatchRc(2);
		expect(lastArgv()[0]).toBe("mine");
		expect(logLines()).toContain(
			"no session key — the claimed-bash-write ledger is unwritable",
		);
		expect(logLines()).not.toContain("repo root unresolved");
	});

	it("names the missing session key on code 3, no session id in it", () => {
		withLatchRc(3);
		expect(lastArgv()[0]).toBe("mine");
		expect(logLines()).toContain(
			"no session key — the claimed-bash-write ledger is unwritable",
		);
		expect(logLines()).not.toContain("repo root unresolved");
	});

	/*
	 * 127 is the shape that matters: a guard-parse.sh too old to carry
	 * gp_latch_path at all passes the load gate, which asks for gp_begin alone.
	 */
	it("names an unrecognised code rather than folding it into another arm", () => {
		withLatchRc(127);
		expect(lastArgv()[0]).toBe("mine");
		expect(logLines()).toContain("gp_latch_path exited 127");
		expect(logLines()).not.toContain("no session key");
		expect(logLines()).not.toContain("repo root unresolved");
	});
});

describe("the write routes it reads", () => {
	it("reads a redirect target, spaced and glued, appending and clobbering", () => {
		expect(targets("echo hi > docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi >docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi >> docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi 1>docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi >| docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi &> docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("> docs/x.md")).toEqual(["docs/x.md"]);
	});

	it("does not read a `>` inside a conditional as a redirect", () => {
		// `[[ a > b ]]` compares two strings and writes nothing.
		expect(targets('[[ "$a" > docs/x.md ]]')).toBe(null);
		expect(targets('[ "$a" \\> docs/x.md ]')).toBe(null);
	});

	it("reads cp and mv destinations, and never cp's sources", () => {
		expect(targets("cp /tmp/a docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("mv /tmp/a CLAUDE.md")).toEqual(["CLAUDE.md"]);
		expect(targets("cp docs/x.md /tmp/a")).toBe(null);
	});

	it("reads mv's SOURCE too, which mv destroys", () => {
		expect(targets("mv docs/x.md /tmp/a")).toEqual(["docs/x.md"]);
		expect(targets("mv docs/x.md docs/y.md")).toEqual([
			"docs/x.md",
			"docs/y.md",
		]);
	});

	it("reads cp -t, which moves the destination out of the positionals", () => {
		expect(targets("cp -t docs/agents /tmp/a.md /tmp/b.md")).toEqual([
			"docs/agents/a.md",
			"docs/agents/b.md",
		]);
	});

	it("expands a cp into an existing directory to dir/<basename>", () => {
		expect(targets("cp /tmp/a.md docs/agents")).toEqual(["docs/agents/a.md"]);
		expect(targets("cp /tmp/a.md /tmp/b.md docs/agents/")).toEqual([
			"docs/agents/a.md",
			"docs/agents/b.md",
		]);
	});

	it("reads in-place sed and perl, bundled flags included", () => {
		expect(targets("sed -i s/a/b/ docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("sed -i.bak s/a/b/ docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("perl -pi -e s/a/b/ AGENTS.md")).toEqual(["AGENTS.md"]);
		expect(targets("sed -n 1p docs/x.md")).toBe(null);
		expect(targets("perl -ne print docs/x.md")).toBe(null);
	});

	it("does not read perl's -I directory as an in-place switch", () => {
		// `-Ilib` carries an `i`, and a naive letter scan calls the run in-place.
		expect(targets("perl -Ilib -ne print docs/x.md")).toBe(null);
	});

	it("reads truncate and tee", () => {
		expect(targets("truncate -s 0 docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("cat /tmp/a | tee .claude/settings.json")).toEqual([
			".claude/settings.json",
		]);
	});

	it("reads git restore, and git checkout only past its --", () => {
		expect(targets("git restore docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("git checkout -- docs/x.md")).toEqual(["docs/x.md"]);
		// Without the separator the word is a revision at least as often as a
		// path.
		expect(targets("git checkout docs/x.md")).toBe(null);
	});

	it("does not read a restore that rewrites only the index", () => {
		// `--staged` alone leaves the file on disk untouched.
		expect(targets("git restore --staged docs/x.md")).toBe(null);
		expect(targets("git restore --staged --worktree docs/x.md")).toEqual([
			"docs/x.md",
		]);
	});

	it("gives up on a git global option rather than guessing", () => {
		// `-C <dir>` puts the subcommand in a different word; the guard declines
		// to guess which words are still git's own.
		expect(targets("git -C . checkout -- docs/x.md")).toBe(null);
	});
});

describe("what it must stay silent about", () => {
	it("says nothing about a path merely mentioned", () => {
		expect(targets("grep foo docs/x.md")).toBe(null);
		expect(targets("cat docs/x.md")).toBe(null);
		expect(targets("echo 'sed -i s/a/b/ docs/x.md'")).toBe(null);
	});

	it("says nothing about a write outside tier 1", () => {
		// It still CREDITS the first, which is code (mantahostels#2778) — but names no target,
		// so the judge has no claim line to print.
		expect(targets("echo hi > scripts/x.js")).toEqual([]);
		expect(targets("echo hi > /tmp/x")).toBe(null);
		expect(targets("echo hi > package.json")).toBe(null);
	});

	it("does not read a descriptor duplication as a file", () => {
		expect(targets("echo ok 2>&1")).toBe(null);
		expect(targets("echo ok >&2")).toBe(null);
	});

	it("does not guess at a path it cannot read literally", () => {
		expect(targets("echo hi > $DEST/docs/x.md")).toBe(null);
		expect(targets("echo hi > $(mktemp)")).toBe(null);
	});

	it("never denies, whatever it finds", () => {
		const r = run("sed -i s/a/b/ CLAUDE.md");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(STUB_WARNING);
		expect(r.stdout).not.toContain("permissionDecision");
	});

	it("stays silent when the judge has nothing to say", () => {
		stubJudge(false);
		const r = run("sed -i s/a/b/ CLAUDE.md");
		expect(r.stdout.trim()).toBe("");
	});
});

describe("the code paths it hands the judge to credit (mantahostels#2778)", () => {
	it("credits a code write the warning half is not allowed to name", () => {
		expect(credits("echo hi > scripts/x.js")).toEqual(["scripts/x.js"]);
		expect(credits("sed -i s/a/b/ scripts/x.sh")).toEqual(["scripts/x.sh"]);
		expect(credits("tee app/page.tsx")).toEqual(["app/page.tsx"]);
	});

	it("calls the judge for a code write even with no tier-1 target at all", () => {
		// The credit rides on this call: a guard that skipped node for want of a
		// tier-1 target would leave a Bash-only code edit on no ledger.
		expect(judgeArgv("echo hi > scripts/x.js")).not.toBe(null);
	});

	it("credits a path repo-relative, never absolute", () => {
		// The write ledger holds repo-relative paths and concision-backstop.sh
		// compares them with `grep -Fx`, so an absolute one would never match.
		for (const c of credits("echo hi > scripts/x.js") ?? [])
			expect(path.isAbsolute(c)).toBe(false);
	});

	it("credits a tier-1 path that is also code, on both lists", () => {
		const parts = judgeParts("sed -i s/a/b/ .claude/hooks/x.sh");
		expect(parts?.credits).toEqual([".claude/hooks/x.sh"]);
		expect(parts?.targets).toEqual([".claude/hooks/x.sh"]);
	});

	it("credits nothing that is not code by the backstop's own globs", () => {
		expect(credits("echo hi > docs/x.md")).toEqual([]);
		expect(credits("echo hi > package.json")).toBe(null);
		expect(credits("echo hi > public/x.css")).toBe(null);
	});

	it("credits nothing outside the repo, however code-shaped", () => {
		expect(credits("echo hi > /tmp/x.js")).toBe(null);
		expect(credits("echo hi > ../elsewhere/x.ts")).toBe(null);
	});

	it("credits nothing it could not read literally", () => {
		// Same rule as the warning half: an unreadable word is dropped, never
		// guessed at — which is what keeps the credit list from naming a path the
		// command may not write.
		expect(credits("echo hi > $DEST/x.js")).toBe(null);
		expect(credits('echo hi > "$(mktemp).js"')).toBe(null);
	});

	it("credits nothing for a path merely mentioned", () => {
		expect(credits("grep foo scripts/x.js")).toBe(null);
		expect(credits("node scripts/x.js")).toBe(null);
	});

	it("credits mv's source, which mv destroys, as well as its destination", () => {
		expect(credits("mv scripts/a.js scripts/b.js")?.sort()).toEqual([
			"scripts/a.js",
			"scripts/b.js",
		]);
	});

	it("credits cp's destination only, cp leaving its source alone", () => {
		expect(credits("cp scripts/a.js scripts/b.js")).toEqual(["scripts/b.js"]);
	});
});

describe("the line join mantahostels#287 named as a gap, left open", () => {
	/*
	 * The masker pairs quotes by COUNT, which is not how shell pairs them, so two
	 * stray apostrophes read as one quoted span and the lines between them are
	 * joined into a single segment headed by the first. `_gp_guarded_head` bounds
	 * that join, and widening it is rejected (guard-claimed-bash-write.sh's
	 * LIMITS carries why). Change this only by fixing the quote pairing itself,
	 * never by widening that list.
	 */
	it("misses a write swallowed between two stray apostrophes", () => {
		expect(targets("echo it's fine\ncp /tmp/a docs/x.md\necho don't")).toBe(
			null,
		);
	});

	it("still reads the write where nothing swallows it", () => {
		expect(targets('echo "fine"\ncp /tmp/a docs/x.md\necho "done"')).toEqual([
			"docs/x.md",
		]);
	});
});

describe("the code globs it duplicates from the backstop (mantahostels#2778)", () => {
	it("credits every path lib/code-signal.sh's CODE array counts", () => {
		// The guard spells those globs a second time, so a drift makes it miss a
		// file the backstop counts. mantahostels#2779 is why
		// this is not extensions alone: the Husky hooks carry none.
		const backstop = fs.readFileSync(
			path.resolve(__dirname, "lib", "code-signal.sh"),
			"utf8",
		);
		const array = backstop.match(/^CODE=\(\n([\s\S]*?)^\)$/m);
		expect(array).not.toBeNull();
		// Comment lines stripped first: one of them holds an apostrophe, which a
		// bare single-quote scan reads as the start of a glob.
		const body = (array?.[1] ?? "")
			.split("\n")
			.filter((l) => !l.trim().startsWith("#"))
			.join("\n");
		const globs = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
		expect(globs.length).toBeGreaterThan(0);

		const guardText = fs.readFileSync(GUARD, "utf8");
		const exts = (guardText.match(/^CODE_EXT='([^']+)'$/m)?.[1] ?? "").split(
			"|",
		);
		const codeDir = guardText.match(/^CODE_DIR='([^']+)'$/m)?.[1] ?? "";

		for (const glob of globs) {
			if (glob.startsWith("*.")) expect(exts).toContain(glob.slice(2));
			else expect(codeDir).toBe(glob);
		}
	});

	it("credits a Husky hook, which carries no extension at all", () => {
		expect(credits("sed -i s/a/b/ .husky/pre-commit")).toEqual([
			".husky/pre-commit",
		]);
	});
});

describe("the spawn-saving prefix test", () => {
	it("covers every prefix the arbiter's refusing tier holds", () => {
		// The prefix case in `add_target` only saves a node start; `store.isGuarded`
		// is the authority
		// (guard-claimed-bash-write.sh's LIMITS). So drift is safe in one direction
		// only — the prefix list must never be NARROWER than the tier, or a real
		// claim goes unannounced.
		const core = fs.readFileSync(
			path.join(__dirname, "lib", "arbiter-core.js"),
			"utf8",
		);
		const refusing = core.match(/^const REFUSING = \[(.*)\];$/m);
		expect(refusing).not.toBeNull();
		const tier = [...(refusing?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(tier.length).toBeGreaterThan(0);

		const guardText = fs.readFileSync(GUARD, "utf8");
		const cases = guardText.match(/^\s+docs\/\*.*\)$/m);
		expect(cases).not.toBeNull();
		for (const prefix of tier) {
			const pattern = prefix.endsWith("/") ? `${prefix}*` : prefix;
			expect(cases?.[0]).toContain(pattern);
		}
	});
});

describe("failing open", () => {
	it("records the judge being unrunnable, rather than passing silently", () => {
		fs.rmSync(path.join(coreDir, "warn-claimed-bash-write.js"));
		expect(run("sed -i s/a/b/ CLAUDE.md").stdout).toBe("");
		expect(logLines()).toContain("guard-claimed-bash-write.sh");
		expect(logLines()).toContain("allowed unchecked");
	});

	it("records a judge that exits non-zero", () => {
		fs.writeFileSync(
			path.join(coreDir, "warn-claimed-bash-write.js"),
			"process.exit(3);\n",
		);
		expect(run("sed -i s/a/b/ CLAUDE.md").stdout).toBe("");
		expect(logLines()).toContain("guard-claimed-bash-write.sh");
	});

	it("allows unchecked, and records, when the payload names no session", () => {
		// Without a session id every claim reads as a neighbour's, so the guard
		// would announce the reader's own work back to it.
		const r = spawnGuard(
			guard,
			buildBashPayload("sed -i s/a/b/ CLAUDE.md", null),
			{
				project: repo,
				config,
				cwd: repo,
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(logLines()).toContain("no session_id in payload");
	});
});

describe("the cwd a relative target resolves against (mantahostels#2807)", () => {
	it("drops a relative target once a cd has moved off the hook's cwd", () => {
		expect(credits("cd /elsewhere && sed -i s/a/b/ scripts/x.sh")).toBe(null);
		expect(targets("cd /elsewhere && cp /tmp/a docs/x.md")).toBe(null);
	});

	it("keeps a relative target where the cd lands back on the hook's cwd", () => {
		// The dominant idiom in the corpus, and what rules out dropping every
		// target on any cd at all (mantahostels#2807).
		expect(credits(`cd ${repo} && sed -i s/a/b/ scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
		expect(credits("cd . && sed -i s/a/b/ scripts/x.sh")).toEqual([
			"scripts/x.sh",
		]);
		expect(credits(`cd ${repo}/scripts/.. && tee scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
	});

	it("keeps an absolute target, which names the same file from any cwd", () => {
		expect(credits(`cd /elsewhere && tee ${repo}/scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
	});

	it("counts an unreadable cd target as moved, never as staying put", () => {
		expect(credits('cd "$WT" && sed -i s/a/b/ scripts/x.sh')).toBe(null);
		expect(credits("cd $(mktemp -d) && sed -i s/a/b/ scripts/x.sh")).toBe(null);
	});

	it("counts a bare cd, a pushd and a popd as moved", () => {
		expect(credits("cd && sed -i s/a/b/ scripts/x.sh")).toBe(null);
		expect(credits("pushd /elsewhere && sed -i s/a/b/ scripts/x.sh")).toBe(
			null,
		);
		// No `cd` before it: a popd alone must move the flag on its own, or this
		// case passes on the cd's account rather than the popd's.
		expect(credits("popd; sed -i s/a/b/ scripts/x.sh")).toBe(null);
	});

	it("tracks a relative hop, so a cd down and back reads as unmoved", () => {
		expect(credits("cd docs && cd .. && sed -i s/a/b/ scripts/x.sh")).toEqual([
			"scripts/x.sh",
		]);
		expect(credits("cd docs && sed -i s/a/b/ scripts/x.sh")).toBe(null);
	});

	it("stays unknown after an unreadable cd, however it is followed", () => {
		// `cd .`, the one relative hop landing back on $PWD: a resolver that
		// wrongly reads the hop against the hook's own cwd still drops `cd sub`,
		// so only keeping unknown unknown drops this.
		expect(credits('cd "$WT" && cd . && tee scripts/x.sh')).toBe(null);
	});

	it("finds the cd past a grouping or builtin prefix", () => {
		// _gp_flatten splits on `;` but not on `{`, so the cd heads a segment
		// beginning `{`, and the write after it would otherwise be credited to the
		// shared tree.
		expect(credits("{ cd /elsewhere; sed -i s/a/b/ scripts/x.sh; }")).toBe(
			null,
		);
		expect(credits("builtin cd /elsewhere && sed -i s/a/b/ scripts/x.sh")).toBe(
			null,
		);
		expect(credits("command cd /elsewhere && tee scripts/x.sh")).toBe(null);
	});

	it("reads a write before the cd, which really is against this tree", () => {
		expect(credits("sed -i s/a/b/ scripts/x.sh && cd /elsewhere")).toEqual([
			"scripts/x.sh",
		]);
	});

	it("drops a redirect target too, not just the named-route ones", () => {
		expect(credits("cd /elsewhere && echo hi > scripts/x.js")).toBe(null);
		expect(targets("cd /elsewhere && echo hi >> docs/x.md")).toBe(null);
	});

	it("keeps an absolute TIER-1 target under a moved cwd, as it keeps a code one", () => {
		expect(targets(`cd /elsewhere && cp /tmp/a ${repo}/docs/x.md`)).toEqual([
			"docs/x.md",
		]);
	});

	it("reads a cd back to the root after moving away", () => {
		expect(
			credits(`cd /elsewhere && cd ${repo} && sed -i s/a/b/ scripts/x.sh`),
		).toEqual(["scripts/x.sh"]);
	});

	it("normalises a trailing and a doubled slash in the cd target", () => {
		expect(credits(`cd ${repo}/ && tee scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
		expect(credits(`cd ${repo}//scripts/.. && tee scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
	});

	it("credits nothing for the cd itself", () => {
		expect(credits("cd scripts/x.sh")).toBe(null);
	});
});

/*
 * The inline-interpreter arm (mantahostels#2854). The dominant edit form here is a
 * read-modify-write inside `python3`/`node`, whose destination is a string in
 * another language: the nine routes above cannot see it, so this arm names
 * every tier-1 path the command QUOTES and lets the judge pick the held one.
 */
describe("the inline-interpreter arm (mantahostels#2854)", () => {
	it("names a path a python heredoc writes", () => {
		expect(
			targets(
				[
					"python3 - <<'PY'",
					"from pathlib import Path",
					"Path('docs/x.md').write_text('hi')",
					"PY",
				].join("\n"),
			),
		).toEqual(["docs/x.md"]);
	});

	it("names a path python3 -c writes", () => {
		expect(targets(`python3 -c "open('docs/w.md','w').write('a')"`)).toEqual([
			"docs/w.md",
		]);
	});

	it("names a path node -e writes", () => {
		expect(
			targets(`node -e 'require("fs").writeFileSync("docs/y.md","z")'`),
		).toEqual(["docs/y.md"]);
	});

	it("names a path a node heredoc writes", () => {
		expect(
			targets(
				["node <<'EOF'", "fs.writeFileSync('docs/z.md','q')", "EOF"].join("\n"),
			),
		).toEqual(["docs/z.md"]);
	});

	it("reads a node template literal, the ordinary spelling in a node heredoc", () => {
		expect(targets("node -e 'fs.writeFileSync(`docs/t.md`, x)'")).toEqual([
			"docs/t.md",
		]);
	});

	it("says nothing without the interpreter limb, however the path is quoted", () => {
		expect(targets("grep 'docs/x.md' notes.txt")).toBe(null);
		expect(targets('grep "docs/x.md" notes.txt')).toBe(null);
		expect(targets("python3 script.py 'docs/x.md'")).toBe(null);
	});

	it("says nothing without the path limb", () => {
		expect(targets("node --version")).toBe(null);
		expect(targets(`node -e 'console.log(1)'`)).toBe(null);
	});

	/*
	 * A PIPED program is inline by every measure but this one (mantahostels#2865): the pipe
	 * leaves the interpreter's segment with no word after it, so inline_interp
	 * has no flag and no heredoc opener to read. Reading it would mean calling a
	 * bare `python3` inline, which fires on every python in a pipeline.
	 */
	it("says nothing about a program arriving down a pipe", () => {
		expect(targets(`echo "open('docs/x.md','w')" | python3`)).toBe(null);
		expect(targets(`echo "open('docs/x.md','w')" | python3 -`)).toBe(null);
	});

	/*
	 * The arm hands the judge every candidate; picking the one a live neighbour
	 * holds is the judge's half, pinned end to end by *names one held path out
	 * of five candidates* in warn-claimed-bash-write.test.ts.
	 *
	 * ORDER IS NOT PART OF THE CONTRACT (mantahostels#2865). quoted_tokens scans once per
	 * quote kind, so candidates come out grouped by quote character rather than
	 * in source order, and the judge filters by claim rather than reading the
	 * list positionally, so this ONE case sorts before comparing. The next case
	 * pins the grouping itself and does assert an order.
	 */
	it("hands every tier-1 path it quotes, resolving none of them", () => {
		expect(
			targets(
				`python3 -c "a=open('docs/a.md');b=open('docs/b.md','w')"`,
			)?.sort(),
		).toEqual(["docs/a.md", "docs/b.md"]);
	});

	// quoted_tokens' `'` pass runs before its backtick pass, so the backticked
	// `docs/b.md`, first in the source, comes out second.
	it("emits candidates grouped by quote kind, not in source order", () => {
		expect(targets(`node -e "w(\`docs/b.md\`); r('docs/a.md')"`)).toEqual([
			"docs/a.md",
			"docs/b.md",
		]);
	});

	/*
	 * The `scripts/` tier is detect-only by mantahostels#287, and the arm inherits that from
	 * add_target's tier case rather than stating it — so a candidate under
	 * `scripts/` reaches the judge as neither a target nor a credit (mantahostels#2865),
	 * only as a `--select` (#1220). Crediting is barred separately: a quoted
	 * candidate is not a resolved write, and mantahostels#114 bars over-billing.
	 */
	it("never warns about a scripts/ path the interpreter quotes", () => {
		expect(
			judgeParts(`node -e "fs.writeFileSync('scripts/foo.sh','')"`),
		).toEqual({ credits: [], targets: [] });
		expect(
			judgeParts(`python3 -c "open('scripts/a.sh');open('docs/a.md','w')"`),
		).toEqual({ credits: [], targets: ["docs/a.md"] });
	});

	/*
	 * The arm's documented false fire (mantahostels#2865): the scan's scope is the WHOLE
	 * command string, not the interpreter's own segment, so a path quoted by a
	 * LATER command is named too. Narrowing that is a behaviour change, not a bug
	 * fix, so it fails here rather than landing unnoticed.
	 */
	it("names a path quoted by a neighbouring command, not the interpreter", () => {
		expect(targets(`node -e 'x=1' && grep "docs/x.md" y`)).toEqual([
			"docs/x.md",
		]);
	});

	it("credits nothing, a quoted candidate not being a resolved target", () => {
		expect(judgeParts(`node -e "fs.writeFileSync('.claude/x.sh','')"`)).toEqual(
			{
				credits: [],
				targets: [".claude/x.sh"],
			},
		);
	});

	it("leaves the CREDIT list of a real route untouched", () => {
		expect(judgeParts(`node -e 'x' > .claude/z.sh`)).toEqual({
			credits: [".claude/z.sh"],
			targets: [".claude/z.sh"],
		});
	});

	it("drops a relative candidate once a cd has moved off the hook's cwd", () => {
		expect(targets(`cd /tmp && python3 -c "open('docs/x.md','w')"`)).toBe(null);
	});

	it("requires a quote to be closed by its own kind", () => {
		expect(targets(`node -e 'x' ; echo "docs/a.md'`)).toBe(null);
	});

	it("reads a versioned interpreter name", () => {
		expect(targets(`python3.12 -c "open('docs/v.md','w')"`)).toEqual([
			"docs/v.md",
		]);
	});
});

describe("the selection ledger it hands the judge (#1220)", () => {
	it("hands every path-shaped quoted path, of any tier", () => {
		expect(
			selectsOf(
				[
					"python3 - <<'EOF'",
					"from pathlib import Path",
					"p = Path('scripts/lib/x.js')",
					"p.write_text(p.read_text().replace('a', 'b'))",
					"open(\"docs/y.md\", 'w')",
					"EOF",
				].join("\n"),
			),
		).toEqual(["docs/y.md", "scripts/lib/x.js"]);
	});

	it("keeps a token with no slash or dot, or a byte no path carries, off it", () => {
		expect(
			selectsOf(
				`python3 -c "open('x', 'w', encoding='utf-8'); print('%s.md')"`,
			),
		).toBe(null);
	});

	it("notes nothing for a command with no inline interpreter", () => {
		expect(selectsOf("grep 'scripts/x.js' notes.txt")).toBe(null);
		expect(selectsOf("python3 scripts/x.py 'scripts/y.js'")).toBe(null);
	});

	it("drops a relative quoted path once a cd has moved off the hook's cwd", () => {
		expect(selectsOf(`cd /tmp && node -e "w('scripts/x.js')"`)).toBe(null);
	});

	it("drops a quoted path outside the repo", () => {
		expect(selectsOf(`node -e "w('/etc/x.conf')"`)).toBe(null);
	});

	it("credits none of them to the write ledger", () => {
		expect(credits(`node -e "fs.writeFileSync('scripts/x.js','')"`)).toEqual(
			[],
		);
	});

	it("notes nothing in a host whose test script never runs run-vitest.js (#1245)", () => {
		const pkg = path.join(repo, "package.json");
		fs.writeFileSync(pkg, '{"scripts":{"test":"vitest run"}}');
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toBe(null);
		fs.writeFileSync(
			pkg,
			'{"scripts":{"test":"vitest run"},"comments":{"x":"see run-vitest.js"}}',
		);
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toBe(null);
		fs.rmSync(pkg);
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toBe(null);
	});

	it("notes them in a host reaching run-vitest.js through resolve-core.js, as mantahostels does", () => {
		fs.writeFileSync(
			path.join(repo, "package.json"),
			'{"scripts":{"test": "node scripts/lib/resolve-core.js scripts/run-vitest.js"}}',
		);
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toEqual(["scripts/x.js"]);
	});

	it("notes the tracked files an rm, git rm or git mv names, and warns on and credits none (#1791)", () => {
		const tracked = [
			"scripts/gone.js",
			"docs/gone.md",
			"docs/old.md",
			"scripts/lib/a.test.ts",
			"scripts/old/x.js",
			"scripts/old/y.js",
		];
		for (const f of tracked) {
			fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
			fs.writeFileSync(path.join(repo, f), "");
		}
		const git = (...args: string[]) =>
			spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		git("init", "-q");
		git("add", "--", ...tracked);
		for (const [command, paths] of [
			[
				"rm -f scripts/gone.js docs/gone.md .claude/scratch.md",
				["docs/gone.md", "scripts/gone.js"],
			],
			["git rm -q -- docs/old.md", ["docs/old.md"]],
			// The destination is not tracked yet; the rename pairing bills it.
			[
				"git mv scripts/lib/a.test.ts scripts/lib/b.test.ts",
				["scripts/lib/a.test.ts"],
			],
			["rm -r scripts/old", ["scripts/old/x.js", "scripts/old/y.js"]],
		] as const) {
			const split = judgeSplit(command);
			expect(split?.selects.sort()).toEqual(paths);
			expect(split?.parts).toEqual({ credits: [], targets: [] });
		}
	});

	it("logs a git that will not list the deletion's files, and notes none (#1950)", () => {
		expect(judgeSplit("rm -f docs/gone.md")).toBe(null);
		expect(logLines()).toMatch(/git ls-files exited [1-9]\d* — a deletion's/);
	});

	it("logs nothing where git lists the deletion's files (#1950)", () => {
		spawnSync("git", ["-C", repo, "init", "-q"]);
		judgeSplit("rm -f docs/gone.md");
		expect(logLines()).toBe("");
	});

	it("never reaches the judge for an rm of untracked scratch (#1791)", () => {
		spawnSync("git", ["-C", repo, "init", "-q"]);
		expect(judgeSplit("rm -f .claude/scratch.md scripts/tmp.js")).toBe(null);
	});

	it("still warns on, and notes nothing for, a quoted tier-1 path in a host with no package.json (#1245)", () => {
		fs.rmSync(path.join(repo, "package.json"));
		const split = judgeSplit(`node -e "w('docs/x.md')"`);
		expect(split?.parts.targets).toEqual(["docs/x.md"]);
		expect(split?.selects).toEqual([]);
	});

	it("matches this repo's own test script, so renaming run-vitest.js cannot empty the ledger unseen", () => {
		const real = fs.readFileSync(
			path.join(__dirname, "..", "package.json"),
			"utf8",
		);
		expect(real).toMatch(/"test": *"[^"]*run-vitest\.js/);
	});
});

/* The scan stops at the script (mantahostels#2854 review). */
describe("what ends the inline-interpreter scan", () => {
	it("says nothing about a flag belonging to the program, not the interpreter", () => {
		expect(targets(`python3 -m pip install -c "docs/x.md"`)).toBe(null);
		expect(targets(`node scripts/foo.js -e "docs/x.md"`)).toBe(null);
	});

	it("still reads the bare - a python heredoc needs", () => {
		expect(
			targets(["python3 - <<'PY'", "open('docs/x.md','w')", "PY"].join("\n")),
		).toEqual(["docs/x.md"]);
	});

	/*
	 * And it takes the heredoc-carrying-DATA case with it (mantahostels#2865). `node
	 * script.js <<'EOF'` feeds a heredoc to a program the walk CAN read, so the
	 * body is input rather than the program — the scan stops at `script.js`
	 * before it ever reaches the `<<`, and the arm stays silent. Pinned because
	 * the `<<` test sits FIRST in inline_interp's loop and reads as unbounded.
	 */
	it("says nothing about a heredoc feeding DATA to a script file", () => {
		expect(
			targets(
				["node script.js <<'EOF'", '{"out": "docs/x.md"}', "EOF"].join("\n"),
			),
		).toBe(null);
	});
});

describe("the whole-file restore rule it hands over (#2028)", () => {
	const rule = ruleText("whole-file-restore");

	/** A git host with `f.txt` committed, and `dirty` deciding whether it is then edited. */
	function gitHost(dirty: boolean) {
		const git = (...args: string[]) =>
			spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
				cwd: repo,
				encoding: "utf8",
			});
		git("init", "-q");
		fs.writeFileSync(path.join(repo, "f.txt"), "a\n");
		fs.writeFileSync(path.join(repo, "docs", "x.md"), "a\n");
		git("add", "f.txt", "docs/x.md");
		git("commit", "-qm", "base");
		if (dirty) {
			fs.appendFileSync(path.join(repo, "f.txt"), "b\n");
			fs.appendFileSync(path.join(repo, "docs", "x.md"), "b\n");
		}
	}

	/** What the hook told the session, run from its real entry point. */
	function told(command: string, at = GUARD, session = "mine"): string {
		const out = guardOutput(at, buildBashPayload(command, session), {
			project: repo,
			config,
			cwd: repo,
			env: {
				WFC_RULES_DIR: path.resolve(__dirname, "..", "docs", "agents", "rules"),
			},
		});
		return out === null ? "" : out.additionalContext;
	}

	it.each([
		"git restore -- f.txt",
		"git checkout -- f.txt",
		"git checkout f.txt",
		"git checkout HEAD f.txt",
		"cp /tmp/f.bak f.txt",
		"mv f.bak f.txt",
		// The redirect row leads the answer (#2142).
		"cp /tmp/f.bak f.txt > log",
	])("hands over the whole rule on %s over uncommitted changes", (command) => {
		gitHost(true);
		expect(told(command)).toBe(rule);
	});

	it("says it once a session", () => {
		gitHost(true);
		expect(told("git restore -- f.txt")).toBe(rule);
		expect(told("git restore -- f.txt")).toBe("");
		expect(told("git restore -- f.txt", GUARD, "other")).toBe(rule);
	});

	it.each([
		["a clean file", false, "git restore -- f.txt"],
		["an untracked file", true, "cp /tmp/f.bak new.txt"],
		["an unstage", true, "git restore --staged f.txt"],
		["a redirect", true, "echo b > f.txt"],
		["a redirect beside a cp", true, "cp /tmp/f.bak log > f.txt"],
		["a cp reading the file", true, "cp f.txt /tmp/f.bak"],
		["a branch switch", true, "git checkout -b f.txt"],
		["a word naming no path", true, "git checkout main"],
	])("stays silent on %s", (_, dirty, command) => {
		gitHost(dirty as boolean);
		expect(told(command as string)).toBe("");
	});

	it("stays silent where git cannot answer, and logs why", () => {
		fs.writeFileSync(path.join(repo, "f.txt"), "a\n");
		expect(told("git restore -- f.txt")).toBe("");
		expect(logLines()).toContain("a whole-file restore went unjudged");
	});

	it("carries the claim warning ahead of the rule in one envelope", () => {
		gitHost(true);
		expect(told("git restore -- docs/x.md", guard)).toBe(
			`${STUB_WARNING}\n\n${rule}`,
		);
	});
});
