// @vitest-environment node
/*
 * Pins the whole-repo pre-commit gates (mantahostels#1753), every row of
 * lib/precommit-gates.js (#4597), as the pre-commit dispatcher runs them
 * (#5172): each row's checker loads as a SPEC without running, takes
 * `--against HEAD` for a direction-gated gate and `--index` for a whole-tree
 * one, and arms on exactly the staged paths the hook's own `armed` ERE took.
 *
 * What the dispatcher does with a row's verdict is proved once, over stub
 * rows, in scripts/lib/precommit-dispatch.test.ts, and through the real hook
 * in scripts/precommit-dispatch.test.ts. What is left here is each row's own.
 *
 * They are hard gates in `.husky/pre-commit`: loosen a case and a commit adding
 * a new fault — a rule claiming backing it lacks, a test escaping its fixture —
 * lands unrefused, or a direction-gated one is refused for faults it inherited.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch, existsUnder, readStaged } from "./lib/precommit-dispatch.js";
import {
	newRepo,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { HOOK, LIB, ROOT } from "./lib/precommit-gate-testkit";
import { GATES, PROFILE_GATES } from "./lib/precommit-gates.js";
import { runInProcess } from "./lib/run-in-process.js";
import { JS_TEST_FILE, siblingTests } from "./lib/test-kind.js";

const temps = registerTempCleanup();

/** A path no gate's condition holds, and where a rename of it goes. */
const OUTSIDE = "lib/page.tsx";

type Gate = (typeof PROFILE_GATES)[number];

/** Whether the dispatcher runs `gate` on what is staged in `root`. */
async function arms(gate: Gate, root: string): Promise<boolean> {
	let ran = false;
	await dispatch({
		rows: [gate],
		gates: "all",
		ports: {
			staged: () => readStaged(root),
			computed: () => [],
			exists: existsUnder(root),
			load: () => () => {
				ran = true;
				return { exit: 0, stdout: "", stderr: "" };
			},
			write: () => undefined,
		},
	});
	return ran;
}

/** A repo committing `from` and staging its `git mv` to `to`. */
function renamed(from: string, to: string): string {
	const { root, git } = stagedRepo(
		"whole-repo-gate-",
		temps,
		{},
		{ [from]: "x\n" },
	);
	git("commit", "-qm", "add");
	fs.mkdirSync(path.join(root, path.dirname(to)), { recursive: true });
	git("mv", "--", from, to);
	return root;
}

describe.each(GATES)("the dispatcher's $id row", (gate) => {
	/* The dispatcher requires the checker: one that ran at load would exit the
	 * dispatcher's own process. */
	it("loads as a SPEC without running", () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`const { SPEC } = require(${JSON.stringify(path.join(ROOT, gate.script))});
				 if (typeof SPEC?.run !== "function") process.exit(3);
				 process.stdout.write("loaded");`,
			],
			{ cwd: ROOT, encoding: "utf8" },
		);
		expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({
			status: 0,
			stdout: "loaded",
			stderr: "",
		});
	});
});

describe.each(PROFILE_GATES)("the pre-commit $id gate", (gate) => {
	it("names a profile lib/fault-profiles.js actually carries", () => {
		const { PROFILES } = require("./lib/fault-profiles.js");
		expect(Object.keys(PROFILES)).toContain(gate.id);
	});

	it("hands its checker --against HEAD or --index, and nothing else", () => {
		expect([["--against", "HEAD"], ["--index"]]).toContainEqual(gate.args);
	});

	it("arms on a path in its condition", async () => {
		const { root } = stagedRepo(
			"whole-repo-gate-",
			temps,
			{},
			{ [gate.staged]: "x\n" },
		);
		expect(await arms(gate, root)).toBe(true);
	});

	/* After `git mv`, a bare `--name-only` prints the new name alone, so a move
	 * out of the condition armed nothing. */
	it("arms on a rename out of its condition (#1483)", async () => {
		const root = renamed(gate.staged, `bin/${path.basename(gate.staged)}`);
		expect(await arms(gate, root)).toBe(true);
	});

	it("does not arm on a rename with neither end in its condition", async () => {
		expect(await arms(gate, renamed(OUTSIDE, "bin/page.tsx"))).toBe(false);
	});

	it("does not arm on a commit outside its condition", async () => {
		const { root } = stagedRepo(
			"whole-repo-gate-",
			temps,
			{},
			{ [OUTSIDE]: "x\n" },
		);
		expect(await arms(gate, root)).toBe(false);
	});
});

/*
 * Each pattern row's arm pinned to the hook's own `armed` ERE it replaced
 * (#5172),
 * frozen here as the hook spelt it, `$JS_TEST_ERE` standing for
 * JS_TEST_FILE in grep's ERE: grep -E and the row's pattern must take the
 * same paths of a list spanning every condition.
 */
const HOOK_ERE: Record<string, string> = {
	"scripts/check-guard-registry.js": String.raw`^(docs/|\.claude/|scripts/|\.husky/|self-plugin/|AGENTS\.md$|CLAUDE\.md$)`,
	"scripts/check-guard-test-isolation.js": String.raw`^scripts/.*$JS_TEST_ERE|^scripts/.*\.(ts|sh)$`,
	"scripts/check-host-root-test-isolation.js": String.raw`^scripts/.*$JS_TEST_ERE|^scripts/.*\.(js|sh)$`,
	"scripts/check-git-fixture-identity.js": "^scripts/.*$JS_TEST_ERE",
	"scripts/check-test-env-writes.js": String.raw`$JS_TEST_ERE|^scripts/.*\.ts$`,
	"scripts/check-host-root.js": String.raw`^(scripts/|\.claude/|\.husky/)`,
	"scripts/check-website-copy.js": "^app/",
	"scripts/check-skill-frontmatter.js": String.raw`^\.claude/skills/[^/]+/SKILL\.md$`,
	"scripts/check-hand-callers.js": String.raw`^(scripts/|\.claude/skills/[^/]+/scripts/)`,
	"scripts/check-registrations.js": String.raw`^(\.claude/(settings|registrations|guard-fire-needles)\.json$|self-plugin/hooks/hooks\.json$|scripts/|\.husky/|\.github/workflows/)`,
	"scripts/check-cli-args.js": String.raw`^scripts/[^/]+\.js$`,
	"scripts/check-test-spawn.js": String.raw`^(scripts|\.claude/skills)/.*$JS_TEST_ERE`,
	"scripts/check-jsonl-reads.js": String.raw`^scripts/.+\.[cm]?js$`,
	"scripts/check-gh-route.js": String.raw`^(scripts|\.claude/skills|\.husky|hooks)/`,
	"scripts/check-arbiter-commands.js": String.raw`^scripts/.+\.[cm]?js$`,
	"scripts/check-clock-copies.js": String.raw`^scripts/.+\.[cm]?js$`,
	"scripts/check-report-programs.js": String.raw`^scripts/report-[^/]+\.[cm]?js$`,
	"scripts/check-program-output.js": String.raw`^(scripts|\.claude/skills/[^/]+/scripts)/.+\.[cm]?js$`,
	"scripts/check-precommit-exit.js": String.raw`^\.husky/pre-commit(\.local)?$`,
	"scripts/check-roadmap-valid.js": String.raw`^docs/reference-roadmap\.html$`,
	"scripts/check-research-added.js": "^docs/research/",
	"scripts/check-vendored-skills.js": String.raw`^(\.agents/skills/|\.agents/vendored-skill-edits\.json$|skills-lock\.json$|\.claude/skills/THIRD-PARTY-NOTICES\.md$)`,
	"scripts/check-hook-liveness.js": String.raw`^(self-plugin/hooks/hooks\.json$|\.claude/settings\.json$|scripts/)`,
	"scripts/check-workflow-permissions.js": String.raw`^\.github/workflows/[^/]+\.ya?ml$`,
};

/** Every row arming on a path pattern, which HOOK_ERE pins. */
const PATTERN_GATES = GATES.flatMap((g) =>
	"pattern" in g.arm ? [{ ...g, arm: g.arm }] : [],
);

/* grep's ERE has no non-capturing group. */
const JS_TEST_ERE = JS_TEST_FILE.source.replaceAll("(?:", "(");

const PATHS = [
	...PROFILE_GATES.map((g) => g.staged),
	...siblingTests("scripts/a"),
	...siblingTests("scripts/lib/a"),
	...siblingTests(".claude/skills/x/scripts/a"),
	...siblingTests("app/a"),
	"scripts/a.js",
	"scripts/a.mjs",
	"scripts/a.cjs",
	"scripts/a.sh",
	"scripts/a.ts",
	"scripts/lib/a.js",
	"scripts/report-a.js",
	"scripts/lib/report-a.js",
	"scripts/a.json",
	".claude/settings.json",
	".claude/registrations.json",
	".claude/guard-fire-needles.json",
	".claude/settings.local.json",
	".claude/skills/x/SKILL.md",
	".claude/skills/x/y/SKILL.md",
	".claude/skills/x/scripts/a.js",
	".claude/skills/x/notes.md",
	".husky/pre-commit",
	".husky/pre-commit.local",
	".husky/post-commit",
	".github/workflows/ci.yml",
	".github/workflows/ci.yaml",
	".github/workflows/sub/ci.yml",
	"docs/reference-roadmap.html",
	"vendor/docs/reference-roadmap.html",
	"docs/research/a.md",
	".agents/skills/x/SKILL.md",
	".agents/vendored-skill-edits.json",
	"skills-lock.json",
	".claude/skills/THIRD-PARTY-NOTICES.md",
	"self-plugin/hooks/hooks.json",
	"self-plugin/a.json",
	"hooks/a.js",
	"docs/a.md",
	"AGENTS.md",
	"CLAUDE.md",
	"README.md",
	"app/page.tsx",
	"lib/page.tsx",
	"a.test.ts",
];

describe("each row's arm, against the hook ERE it replaced", () => {
	it("covers every row", () => {
		expect(Object.keys(HOOK_ERE).sort()).toEqual(
			PATTERN_GATES.map((g) => g.script).sort(),
		);
	});

	it.each(PATTERN_GATES)("$id takes the paths grep -E took", (gate) => {
		const ere = (HOOK_ERE[gate.script] ?? "").replaceAll(
			"$JS_TEST_ERE",
			JS_TEST_ERE,
		);
		let matched = "";
		try {
			matched = execFileSync("grep", ["-E", "-e", ere], {
				input: `${PATHS.join("\n")}\n`,
				encoding: "utf8",
			});
		} catch {
			/* grep exits 1 where nothing matches. */
		}
		expect(PATHS.filter((p) => gate.arm.pattern.test(p))).toEqual(
			matched.split("\n").filter(Boolean),
		);
	});
});

describe("the shell's direction gate (mantahostels#1793)", () => {
	it("keeps gate_direction for its one caller, the doc map", () => {
		// Spelled out deliberately, for its --map-dirty flag, temp index and
		// untracked-entry replay (mantahostels#1793).
		expect(LIB).toContain("gate_direction() {");
		expect(HOOK).toContain("gate_direction doc-map");
	});
});

describe("the --root each side of the comparison is read through", () => {
	/* An EMPTY tree, because a --root silently ignored answers about the live
	 * worktree, which is the one answer an empty tree cannot produce. */
	const emptyTree = () => newRepo("empty-root-", temps).root;

	const runChecker = (checker: string, args: string[]) =>
		runInProcess(path.join(ROOT, "scripts", checker), args, {
			cwd: ROOT,
			env: { ...process.env, GITHUB_ACTIONS: "" },
		});

	it("reads check-guard-registry.js's --root, not its own directory", () => {
		const r = runChecker("check-guard-registry.js", [
			"--root",
			emptyTree(),
			"--json",
		]);

		const envelope = JSON.parse(r.stdout);
		expect(envelope.ruleCount).toBe(0);
		const tags = envelope.findings.map((f: { tag: string }) => f.tag);
		expect(tags).toContain("NO-REGION");
	});

	const plantedStore = (root: string) => {
		const store = path.join(root, "docs", "agents", "rules");
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(path.join(store, "rule-planted.txt"), "planted\n");
		fs.writeFileSync(
			path.join(store, "manifest.json"),
			JSON.stringify({ "rule-planted": {} }),
		);
	};

	it("points the rule-text store at --root's own store, not the live worktree", () => {
		/* A CORE tree, which is what --against materialises here: the checker's
		 * own file in it is what marks it one. */
		const root = emptyTree();
		plantedStore(root);
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "check-guard-registry.js"), "");
		fs.mkdirSync(path.join(root, "self-plugin", "hooks"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "self-plugin", "hooks", "hooks.json"),
			'{"hooks": {}}',
		);
		const r = runChecker("check-guard-registry.js", ["--root", root, "--json"]);

		expect(JSON.parse(r.stdout).ruleStore.fragments).toEqual(["rule-planted"]);
	});

	it("layers an adopter --root's own store over the CORE's", () => {
		/* An adopter that generates a fragment still reads every core guard's
		 * from the plugin (#97). */
		const root = emptyTree();
		plantedStore(root);
		const r = runChecker("check-guard-registry.js", ["--root", root, "--json"]);

		const { fragments } = JSON.parse(r.stdout).ruleStore;
		expect(fragments).toContain("rule-planted");
		expect(fragments.length).toBeGreaterThan(50);
	});

	it("falls back to the CORE's store where --root has none of its own", () => {
		/* An adopter never copies the fragments — they ship in the plugin — so
		 * pinning its absent store would call every rule id in its rules file
		 * unresolvable (#5). */
		const r = runChecker("check-guard-registry.js", [
			"--root",
			emptyTree(),
			"--json",
		]);

		expect(JSON.parse(r.stdout).ruleStore.fragments.length).toBeGreaterThan(50);
	});

	it("reads check-guard-test-isolation.js's --root instead of asking git", () => {
		// Its live scope comes from `git ls-files`, which in a temp directory would
		// read the enclosing repo or nothing at all.
		const r = runChecker("check-guard-test-isolation.js", [
			"--root",
			emptyTree(),
			"--json",
		]);

		expect(JSON.parse(r.stdout).scanned).toBe(0);
	});

	/* --review writes anchors back into the tree it read, so both flags that
	 * point the read somewhere throwaway must refuse it (mantahostels#1833). */
	it.each([
		["--root", ["--review", "--root", "<tree>"]],
		["--against", ["--review", "--against", "HEAD"]],
	])("refuses --review under %s", (flag, args) => {
		const r = runChecker(
			"check-guard-registry.js",
			args.map((a) => (a === "<tree>" ? emptyTree() : a)),
		);

		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toContain(`cannot run under ${flag}`);
	});
});
