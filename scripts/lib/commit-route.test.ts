// @vitest-environment node

/*
 * scripts/lib/commit-route.js (#1503): which git operation made the commit a
 * hook is asked about, the route's abort and name, and the replay secrets
 * scan's refusal.
 *
 * The route cases drive REAL git operations in a throwaway repo whose every
 * hook asks the live module and logs the route it reads, because what the
 * module encodes is git's own behaviour per hook — which a constructed $GIT_DIR
 * can only restate.
 *
 * spawn-kept: the route cases spawn git to fire real hooks, each of which
 * starts node on the module as a dispatcher hook does.
 *
 * A loosened row lets a hook gate a replay as an ordinary commit or stand an
 * ordinary commit down as a replay, on a route git does not show it as.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	commitRoute,
	inRouteSet,
	isReplayRoute,
	routeAbort,
	routeName,
	scanRefusal,
} from "./commit-route.js";
import { newRepo, registerTempCleanup } from "./precommit-gate-harness";
import { ROOT } from "./precommit-gate-testkit";
import { shellQuote } from "./sh-quote.js";

const MODULE = path.join(ROOT, "scripts", "lib", "commit-route.js");
const temps = registerTempCleanup(afterEach);

/** The hooks a commit route can reach; pre-push and post-merge never ask. */
const HOOKS = [
	"applypatch-msg",
	"pre-applypatch",
	"post-applypatch",
	"pre-commit",
	"pre-merge-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
];

/** Prints commitRoute(argv[1], argv[2]) from the live module. */
const ASK = `process.stdout.write(require(${JSON.stringify(MODULE)}).commitRoute(process.argv[1], process.argv[2]))`;

/** A marker hook logging `<hook> <route>` for each step a case labels `act`;
 * node starts only then, so a case's setup pays none. */
function markerHook(hook: string): string {
	const ask = `route="$(node -e ${shellQuote(ASK)} ${shellQuote(hook)} "$(git rev-parse --absolute-git-dir)")"`;
	const log = `echo "\${WFC_ASKER:+$WFC_ASKER>}${hook} $route" >> "$ROUTE_LOG"`;
	// pre-merge-commit runs pre-commit as the real one does, so the merge
	// that has not written MERGE_HEAD yet is asked about from inside it too.
	const nested =
		hook === "pre-merge-commit"
			? `WFC_ASKER=pre-merge-commit "$(dirname "$0")/pre-commit"\n`
			: "";
	return `#!/bin/sh\n[ "$LABEL" = act ] || exit 0\n${ask}\n${log}\n${nested}`;
}

type Git = (...args: string[]) => string;

/** A repo with the marker hooks installed, one base commit, and a `git` whose
 * steps log only once `act()` is called. */
function routeRepo() {
	const { root } = newRepo("commit-route-", temps);
	const log = path.join(root, ".git", "route.log");
	const hooks = path.join(root, ".git", "marker-hooks");
	fs.mkdirSync(hooks);
	for (const h of HOOKS)
		fs.writeFileSync(path.join(hooks, h), markerHook(h), { mode: 0o755 });
	let label = "setup";
	const env = () => ({
		...process.env,
		GIT_EDITOR: "true",
		LABEL: label,
		ROUTE_LOG: log,
	});
	const git: Git = (...args) =>
		execFileSync("git", args, { cwd: root, env: env(), encoding: "utf8" });
	/** A step expected to stop, as a conflict does. */
	const stops = (...args: string[]) =>
		expect(
			spawnSync("git", args, { cwd: root, env: env(), stdio: "ignore" }).status,
		).not.toBe(0);
	git("config", "core.hooksPath", hooks);
	const commit = (file: string, body: string) => {
		fs.writeFileSync(path.join(root, file), `${body}\n`);
		git("add", "--", file);
		git("commit", "-qm", `${file} ${body}`);
	};
	commit("f", "base");
	const base = git("symbolic-ref", "--short", "HEAD").trim();
	return {
		root,
		git,
		stops,
		commit,
		base,
		act: () => {
			label = "act";
		},
		routes: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
	};
}

type Repo = ReturnType<typeof routeRepo>;

/** `side` with one commit per file, the base branch one commit ahead of it. */
function forked(r: Repo, files: string[], baseFile = "m"): void {
	r.git("checkout", "-q", "-b", "side");
	for (const f of files) r.commit(f, "side");
	r.git("checkout", "-q", r.base);
	r.commit(baseFile, "moved");
}

const COMMIT_HOOKS = (route: string, from = "pre-commit") =>
	["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]
		.slice(["pre-commit", "prepare-commit-msg"].indexOf(from))
		.map((h) => `${h} ${route}`);

/** One replayed commit's hooks, for an operation replaying two. */
const twice = (lines: string[]) => [...lines, ...lines];

/*
 * Each row is the marker table in commit-route.js's header, driven: the hooks
 * that fire on the route, in firing order, and the route each one reads.
 */
const CASES: [string, (r: Repo) => void, string[]][] = [
	[
		"an ordinary commit",
		(r) => {
			r.act();
			r.commit("a", "x");
		},
		COMMIT_HOOKS("commit"),
	],
	[
		"`git commit --no-verify`",
		(r) => {
			fs.writeFileSync(path.join(r.root, "a"), "x\n");
			r.git("add", "a");
			r.act();
			r.git("commit", "-q", "--no-verify", "-m", "a");
		},
		["prepare-commit-msg commit", "post-commit commit"],
	],
	[
		"a clean `git merge`, before and after MERGE_HEAD exists",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("merge", "-q", "--no-edit", "side");
		},
		[
			"pre-merge-commit merge",
			"pre-merge-commit>pre-commit merge",
			"prepare-commit-msg merge",
			"commit-msg merge",
		],
	],
	[
		"`git pull`'s merge, whose reflog action is not `merge`",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("pull", "-q", "--no-rebase", "--no-edit", ".", "side");
		},
		[
			"pre-merge-commit merge",
			"pre-merge-commit>pre-commit merge",
			"prepare-commit-msg merge",
			"commit-msg merge",
		],
	],
	[
		"`git merge --no-verify`",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("merge", "-q", "--no-verify", "--no-edit", "side");
		},
		["prepare-commit-msg merge"],
	],
	[
		"the `git commit` resolving a conflicted merge",
		(r) => {
			forked(r, ["f"], "f");
			r.stops("merge", "-q", "--no-edit", "side");
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("commit", "-q", "--no-edit");
		},
		[...COMMIT_HOOKS("merge").slice(0, 3), "post-commit commit"],
	],
	[
		"a clean `git cherry-pick`",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("cherry-pick", "side");
		},
		["prepare-commit-msg cherry-pick", "post-commit cherry-pick"],
	],
	[
		"a cherry-picked range, which sets `sequencer` too",
		(r) => {
			forked(r, ["s", "t"]);
			r.act();
			r.git("cherry-pick", `${r.base}..side`);
		},
		twice(["prepare-commit-msg cherry-pick", "post-commit cherry-pick"]),
	],
	[
		"`git cherry-pick --continue`",
		(r) => {
			forked(r, ["f"], "f");
			r.stops("cherry-pick", "side");
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("cherry-pick", "--continue");
		},
		[...COMMIT_HOOKS("cherry-pick").slice(0, 3), "post-commit commit"],
	],
	[
		"a clean single `git revert`, which nothing tells from a commit",
		(r) => {
			r.commit("a", "x");
			r.act();
			r.git("revert", "--no-edit", "HEAD");
		},
		COMMIT_HOOKS("commit", "prepare-commit-msg").filter(
			(l) => !l.startsWith("commit-msg"),
		),
	],
	[
		"`git revert A B`",
		(r) => {
			r.commit("a", "x");
			r.commit("b", "x");
			r.act();
			r.git("revert", "--no-edit", "HEAD", "HEAD~1");
		},
		twice([
			"prepare-commit-msg revert-sequence",
			"post-commit revert-sequence",
		]),
	],
	[
		"a `git commit` by hand resolving a stopped `git revert A B`",
		(r) => {
			r.commit("g", "1");
			r.commit("g", "2");
			r.stops("revert", "--no-edit", "HEAD~1", "HEAD");
			fs.writeFileSync(path.join(r.root, "g"), "resolved\n");
			r.git("add", "g");
			r.act();
			r.git("commit", "-qm", "by hand");
		},
		[...COMMIT_HOOKS("revert-continue").slice(0, 3), "post-commit commit"],
	],
	[
		"an ordinary commit over the `sequencer` that resolving leaves (#3298)",
		(r) => {
			r.commit("g", "1");
			r.commit("g", "2");
			r.stops("revert", "--no-edit", "HEAD~1", "HEAD");
			fs.writeFileSync(path.join(r.root, "g"), "resolved\n");
			r.git("add", "g");
			r.git("commit", "-qm", "by hand");
			r.act();
			r.commit("a", "x");
		},
		COMMIT_HOOKS("commit"),
	],
	[
		"an ordinary commit after a single cherry-pick over a leftover `sequencer`",
		(r) => {
			forked(r, ["s"]);
			r.commit("g", "1");
			r.commit("g", "2");
			r.stops("revert", "--no-edit", "HEAD~1", "HEAD");
			fs.writeFileSync(path.join(r.root, "g"), "resolved\n");
			r.git("add", "g");
			r.git("commit", "-qm", "by hand");
			r.git("cherry-pick", "side");
			r.act();
			r.commit("a", "x");
		},
		// Before post-commit only abort-safety is there to read, and the pick
		// rewrote it; no hook acts on the route this reads as.
		[...COMMIT_HOOKS("revert-sequence").slice(0, 3), "post-commit commit"],
	],
	[
		"`git revert --continue`",
		(r) => {
			r.commit("g", "1");
			r.commit("g", "2");
			r.stops("revert", "--no-edit", "HEAD~1");
			fs.writeFileSync(path.join(r.root, "g"), "resolved\n");
			r.git("add", "g");
			r.act();
			r.git("revert", "--continue");
		},
		[...COMMIT_HOOKS("revert-continue").slice(0, 3), "post-commit commit"],
	],
	[
		"a rebase replaying two commits",
		(r) => {
			forked(r, ["s", "t"]);
			r.git("checkout", "-q", "side");
			r.act();
			r.git("rebase", "-q", r.base);
		},
		twice(["prepare-commit-msg rebase", "post-commit rebase"]),
	],
	[
		"`git rebase --continue`",
		(r) => {
			forked(r, ["f"], "f");
			r.git("checkout", "-q", "side");
			r.stops("rebase", "-q", r.base);
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("rebase", "--continue");
		},
		["prepare-commit-msg rebase", "post-commit rebase"],
	],
	[
		"a `git commit` by hand in the middle of a rebase",
		(r) => {
			forked(r, ["f"], "f");
			r.git("checkout", "-q", "side");
			r.stops("rebase", "-q", r.base);
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("commit", "-qm", "by hand");
		},
		COMMIT_HOOKS("rebase"),
	],
	[
		"`git rebase --apply`",
		(r) => {
			forked(r, ["s"]);
			r.git("checkout", "-q", "side");
			r.act();
			r.git("rebase", "-q", "--apply", r.base);
		},
		[
			"applypatch-msg rebase-apply",
			"pre-applypatch rebase-apply",
			"post-applypatch rebase-apply",
		],
	],
	[
		"`git am`",
		(r) => {
			forked(r, ["s"]);
			const dir = path.join(r.root, ".git", "patches");
			r.git("format-patch", "-q", "-1", "side", "-o", dir);
			r.act();
			r.git("am", "-q", ...fs.readdirSync(dir).map((f) => path.join(dir, f)));
		},
		["applypatch-msg am", "pre-applypatch am", "post-applypatch am"],
	],
	[
		"a commit by hand mid-bisect",
		(r) => {
			r.commit("a", "x");
			r.commit("b", "x");
			r.git("bisect", "start", "HEAD", "HEAD~2");
			r.act();
			r.commit("z", "x");
		},
		COMMIT_HOOKS("bisect"),
	],
];

describe("the route each hook reads, through real git (#1503)", () => {
	it.each(CASES)(
		"%s: each hook reads the route the marker table gives it",
		(_name, drive, expected) => {
			const r = routeRepo();
			drive(r);
			expect(r.routes()).toEqual(expected);
		},
	);
});

/** A $GIT_DIR holding exactly `markers`; a path ending in `/` is a directory. */
function gitDir(markers: string[]): string {
	const { root } = newRepo("commit-route-dir-", temps);
	const dir = path.join(root, ".git");
	for (const m of markers) {
		const abs = path.join(dir, m);
		if (m.endsWith("/")) fs.mkdirSync(abs, { recursive: true });
		else {
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, "x\n");
		}
	}
	return dir;
}

/**
 * A repo two commits deep whose git directory carries `markers`, each
 * `<path>[=<rev>]` or `reflog=<verb>`: a file naming `<rev>`'s commit, or
 * with `other` one git cannot match.
 */
function laid(markers: string[]): string {
	const { root } = newRepo("commit-route-js-", temps);
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
	fs.writeFileSync(path.join(root, "f"), "1\n");
	git("add", "f");
	git("commit", "-qm", "one");
	fs.writeFileSync(path.join(root, "f"), "2\n");
	git("commit", "-qam", "two");
	const dir = git("rev-parse", "--absolute-git-dir");
	for (const m of markers) {
		if (m.startsWith("reflog=")) {
			fs.appendFileSync(
				path.join(dir, "logs", "HEAD"),
				`a b t <t> 0 +0000\t${m.slice("reflog=".length)}: x\n`,
			);
			continue;
		}
		const [rel, rev] = m.split("=");
		const file = path.join(dir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		let body = "x";
		if (rev === "other") body = "0".repeat(40);
		else if (rev !== undefined) body = git("rev-parse", rev);
		fs.writeFileSync(file, `${body}\n`);
	}
	return dir;
}

describe("commitRoute on a git directory laid by hand", () => {
	const route = (hook: string, markers: string[], GitReflogAction = "") =>
		commitRoute(hook, gitDir(markers), {
			env: { GIT_REFLOG_ACTION: GitReflogAction },
		});

	it.each([
		[
			"rebase-merge before CHERRY_PICK_HEAD",
			["rebase-merge/", "CHERRY_PICK_HEAD"],
			"rebase",
		],
		[
			"`rebasing` as the apply backend",
			["rebase-apply/rebasing"],
			"rebase-apply",
		],
		["`applying` as `git am`", ["rebase-apply/applying"], "am"],
		[
			"CHERRY_PICK_HEAD before sequencer",
			["CHERRY_PICK_HEAD", "sequencer/"],
			"cherry-pick",
		],
		[
			"REVERT_HEAD before sequencer",
			["REVERT_HEAD", "sequencer/"],
			"revert-continue",
		],
		// A cherry-pick range finished by a plain `git commit` leaves
		// `sequencer` behind, and a later merge must still read as one (#1503).
		[
			"MERGE_HEAD before a leftover sequencer",
			["sequencer/", "MERGE_HEAD"],
			"merge",
		],
		[
			"a sequencer with no abort-safety as a leftover",
			["sequencer/"],
			"commit",
		],
		[
			"a sequencer whose abort-safety git cannot match as a leftover",
			["sequencer/abort-safety"],
			"commit",
		],
		["MERGE_HEAD before BISECT_LOG", ["MERGE_HEAD", "BISECT_LOG"], "merge"],
		[
			"AUTO_MERGE and MERGE_MSG as a commit",
			["AUTO_MERGE", "MERGE_MSG"],
			"commit",
		],
	])("reads %s", (_name, markers, expected) => {
		expect(route("prepare-commit-msg", markers)).toBe(expected);
	});

	it("names `git am --abort` for prepare-commit-msg's `rebase-apply/applying`", () => {
		expect(
			routeAbort(route("prepare-commit-msg", ["rebase-apply/applying"])),
		).toBe("git am --abort");
	});

	it("reads GIT_REFLOG_ACTION as a merge at pre-commit alone", () => {
		// `pull …` is `git pull`'s merge.
		for (const action of ["merge side", "pull . side"])
			expect(route("pre-commit", [], action)).toBe("merge");
		expect(route("prepare-commit-msg", [], "merge side")).toBe("commit");
		expect(route("pre-commit", [], "rebase (reword)")).toBe("commit");
	});

	it("reads pre-merge-commit as a merge whatever $GIT_DIR holds", () => {
		expect(route("pre-merge-commit", ["CHERRY_PICK_HEAD"])).toBe("merge");
	});

	it("reads an empty git dir, a git that would not answer, as no marker", () => {
		expect(commitRoute("commit-msg", "", { env: {} })).toBe("commit");
		expect(commitRoute("pre-commit", "", { env: {} })).toBe("commit");
		expect(commitRoute("pre-applypatch", "", { env: {} })).toBe("am");
	});

	it("throws naming a hook it has no row for, so a caller refuses", () => {
		expect(() => commitRoute("pre-push", gitDir([]))).toThrow(
			"no marker table for the hook 'pre-push'",
		);
	});

	/*
	 * A leftover `sequencer` is not a sequence (#3298): live only where its
	 * abort-safety names the commit this one is made on, and at post-commit
	 * only after the sequence's own reflog entry.
	 */
	it.each([
		["prepare-commit-msg", ["sequencer/abort-safety=HEAD"], "revert-sequence"],
		["prepare-commit-msg", ["sequencer/abort-safety=other"], "commit"],
		[
			"prepare-commit-msg",
			["CHERRY_PICK_HEAD", "sequencer/abort-safety=HEAD"],
			"cherry-pick",
		],
		[
			"prepare-commit-msg",
			["MERGE_HEAD", "sequencer/abort-safety=HEAD"],
			"merge",
		],
		[
			"post-commit",
			["sequencer/abort-safety=HEAD^", "reflog=revert"],
			"revert-sequence",
		],
		[
			"post-commit",
			["sequencer/abort-safety=HEAD^", "reflog=cherry-pick"],
			"revert-sequence",
		],
		[
			"post-commit",
			["sequencer/abort-safety=HEAD^", "reflog=commit"],
			"commit",
		],
		["post-commit", ["sequencer/abort-safety=HEAD"], "commit"],
	])("reads %s over %j as %s", (hook, markers, expected) => {
		expect(commitRoute(hook, laid(markers), { env: {} })).toBe(expected);
	});
});

describe("isReplayRoute", () => {
	it.each([
		["rebase", true],
		["rebase-apply", true],
		["am", true],
		["cherry-pick", true],
		["revert-sequence", false],
		["revert-continue", false],
		["merge", false],
		["bisect", false],
		["commit", false],
	])("answers %s with %s", (route, replays) => {
		expect(isReplayRoute(route)).toBe(replays);
		expect(inRouteSet("replay", route)).toBe(replays);
	});
});

/*
 * Each route's abort, display name and post-commit stand-down answer. A wrong
 * abort strands the tree, and a wrong stand-down releases claims over a
 * replay.
 */
describe("routeAbort, routeName and the post-commit stand-down set", () => {
	it.each([
		["rebase", "git rebase --abort", "git rebase", true],
		["rebase-apply", "git rebase --abort", "git rebase --apply", true],
		["am", "git am --abort", "git am", true],
		["cherry-pick", "git cherry-pick --abort", "git cherry-pick", true],
		["revert-sequence", "git revert --abort", "git revert", true],
		["revert-continue", "git revert --abort", "git revert", true],
		["merge", "git merge --abort", "git merge", false],
		["bisect", "", "commit", true],
		["commit", "", "commit", false],
	])(
		"%s clears with `%s`, reads as `%s`, and stands post-commit down: %s",
		(route, abort, name, standsDown) => {
			expect(routeAbort(route)).toBe(abort);
			expect(routeName(route)).toBe(name);
			expect(inRouteSet("post-commit-stand-down", route)).toBe(standsDown);
		},
	);

	it("reads a name ROUTE_SETS lacks as the one route it spells", () => {
		expect(inRouteSet("merge", "merge")).toBe(true);
		expect(inRouteSet("merge", "commit")).toBe(false);
		expect(inRouteSet("replay", "cherry-pick")).toBe(true);
		expect(inRouteSet("replay", "merge")).toBe(false);
	});
});

describe("scanRefusal", () => {
	it.each([
		["pre-applypatch", "am", "git am", "git am --abort"],
		[
			"pre-applypatch",
			"rebase-apply",
			"git rebase --apply",
			"git rebase --abort",
		],
		[
			"prepare-commit-msg",
			"cherry-pick",
			"git cherry-pick",
			"git cherry-pick --abort",
		],
		["prepare-commit-msg", "rebase", "git rebase", "git rebase --abort"],
	])(
		"refuses for %s on a %s, naming %s and `%s`",
		(hook, route, name, abort) => {
			// Spelled here, never derived, so a drift in the text fails.
			expect(scanRefusal(hook, route)).toBe(
				`${hook}: the secrets scan did not pass on this ${name} (mantahostels#1706).\n` +
					"  Its own output is above — a finding, or gitleaks itself is missing.\n" +
					`  The ${name} is left IN PROGRESS. Clear it with:  ${abort}\n`,
			);
		},
	);
});
