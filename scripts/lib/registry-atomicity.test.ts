// @vitest-environment node
/*
 * lib/registry-atomicity.js, guard-registry-atomicity.js's core (#2794), in
 * process: does a commit land a member of a repo-wide registry without the
 * wiring that registers it?
 *
 * THE LOAD-BEARING CASE IS "the wiring exists but is not in this commit" — a
 * caller line sitting uncommitted in a file the pathspec does not name, which a
 * guard reading the working tree alone would clear (mantahostels#2664).
 *
 * The fixture is a whole small repo rather than a command string: every verdict
 * here is a question about HEAD, the pathspec and the working tree together, so
 * the core runs on lib/registry-atomicity-host.js's real git and disk reads
 * (base §X11 condition 2). Loosen a case and a member lands without its
 * wiring, turning the whole-repo registry tests red for every session until the
 * second commit; widen it and a commit carrying both is refused.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTemplate, initGitRepo, mkScratchDir } from "./git-fixture";
import { kitContextFake } from "./kit-context-fake";

type Decision = { deny?: string } | null;
const { decide } = require("./registry-atomicity.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { buildHostPorts } = require("./registry-atomicity-host.js") as {
	buildHostPorts: () => object;
};
const { treeClassifier } = require("./git-tree.js") as {
	treeClassifier: (
		root: string,
	) => (dir: string) => import("./git-tree.js").TreeClass;
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A hooks file running exactly the hook scripts named. */
const hooksFileFor = (scripts: string[]) =>
	`${JSON.stringify(
		{
			hooks: {
				PreToolUse: scripts.map((s) => ({
					matcher: "Bash",
					hooks: [
						{ type: "command", command: `bash "$CLAUDE_PROJECT_DIR"/${s}` },
					],
				})),
			},
		},
		null,
		2,
	)}\n`;

/**
 * A hooks file registering each entry on the event and matcher it names, so
 * a case can move a registration without changing which script runs (mantahostels#2685).
 */
const hooksFileOf = (
	regs: { event?: string; matcher?: string | null; script: string }[],
) => {
	const hooks: Record<string, unknown[]> = {};
	for (const r of regs) {
		const event = r.event ?? "PreToolUse";
		hooks[event] ??= [];
		hooks[event].push({
			...(r.matcher === null ? {} : { matcher: r.matcher ?? "Bash" }),
			hooks: [
				{ type: "command", command: `bash "$CLAUDE_PROJECT_DIR"/${r.script}` },
			],
		});
	}
	return `${JSON.stringify({ hooks }, null, 2)}\n`;
};

/**
 * A repo already holding one wired guard, one wired checker and the four
 * registry files — so every case below is about what CHANGES, never about a
 * repo that was broken to begin with.
 */
const template = defineTemplate((root) => {
	const hooks = path.join(root, "no-hooks");
	fs.mkdirSync(hooks);
	const repo = path.join(root, "repo");
	initGitRepo(repo, hooks);
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(repo, rel), body);
	};
	write(
		"self-plugin/hooks/hooks.json",
		hooksFileFor(["scripts/guard-existing.sh"]),
	);
	write(
		"scripts/guard-fire-needles.json",
		`${JSON.stringify({ guards: { "guard-existing.sh": { needles: [] } } }, null, 2)}\n`,
	);
	write(
		"scripts/hook-registrations.test.ts",
		'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\n',
	);
	write(
		"scripts/checker-registrations.test.ts",
		"const CALLED_ELSEWHERE = {};\n",
	);
	write("scripts/guard-existing.sh", "#!/usr/bin/env bash\n");
	write("scripts/guard-existing.test.ts", "// covered\n");
	write("scripts/check-existing.js", "// a wired checker\n");
	write("scripts/check-existing.test.ts", "// covered\n");
	write(
		"scripts/caller.sh",
		"#!/usr/bin/env bash\nnode scripts/check-existing.js\n",
	);
	write(".husky/pre-commit", "#!/usr/bin/env bash\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "wiring");
});

let dir: string;
let repo: string;

beforeEach(() => {
	dir = mkScratchDir("registry-atomicity-");
	template.instantiate(dir);
	repo = path.join(dir, "repo");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Write a file into the fixture repo and give git its name, so a pathspec reaches it. */
function add(rel: string, body: string): void {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
	git(repo, "add", "-N", "--", rel);
}

/** Edit a tracked file WITHOUT staging it, so only a pathspec naming it lands. */
function edit(rel: string, body: string): void {
	fs.writeFileSync(path.join(repo, rel), body);
}

/** The three core registries that run, pin and count a hook. */
const CORE_HOOK_FILES =
	"self-plugin/hooks/hooks.json scripts/hook-registrations.test.ts scripts/guard-fire-needles.json";

/** Register scripts/$script beside guard-existing.sh in all of CORE_HOOK_FILES, unstaged. */
function wireCoreHook(script: string): void {
	edit(
		"self-plugin/hooks/hooks.json",
		hooksFileFor(["scripts/guard-existing.sh", `scripts/${script}`]),
	);
	edit(
		"scripts/hook-registrations.test.ts",
		`const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\nid: "scripts/${script}",\n`,
	);
	edit(
		"scripts/guard-fire-needles.json",
		`${JSON.stringify(
			{
				guards: {
					"guard-existing.sh": { needles: [] },
					[script]: { needles: [] },
				},
			},
			null,
			2,
		)}\n`,
	);
}

/** The no-caller line of a checker refusal, naming $surface as the hooks file. */
const buildNoCallerLine = (surface: string) =>
	`no caller: nothing in .husky/, .github/workflows/, ${surface} or another scripts/ file names it`;

interface Verdict {
	denied: boolean;
	reason: string;
}

let faults: string[] = [];

type Repo = Record<string, (rel: string) => unknown>;

/**
 * The core on `command`, run in `cwd` as the entry runs it: the kit's walk
 * ports over the environment `env` adds to, and the host's real reads, each
 * commit's Repo passed through `wrap`.
 */
function run(
	command: string,
	cwd = repo,
	env: Record<string, string> = {},
	wrap: (r: Repo) => Repo = (r) => r,
): Verdict {
	faults = [];
	const host = buildHostPorts() as {
		repo: (tree: string, root: string) => Repo;
	};
	for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
	try {
		const vars: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env))
			if (v !== undefined) vars[k] = v;
		const d = decide(
			command,
			kitContextFake({
				fallbackCwd: cwd,
				vars,
				isDir: (p: string) =>
					fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
				moduleOn: () => true,
				treeClass: treeClassifier(repo),
				log: (what: string, detail?: string) =>
					faults.push(detail ? `${what}\t${detail}` : what),
				...host,
				repo: (tree: string, root: string) => wrap(host.repo(tree, root)),
			}),
		);
		return { denied: Boolean(d?.deny), reason: d?.deny ?? "" };
	} finally {
		vi.unstubAllEnvs();
	}
}

const readFaultReasons = () => faults.map((f) => f.split("\t")[0]);

/** A Repo whose HEAD cannot answer for `rel` alone: the answer a broken tree
 * object under it gives (mantahostels#2702). */
const headUnknown = (rel: string) => (r: Repo) => ({
	...r,
	headNames: (p: string) => (p === rel ? null : r.headNames(p)),
});

/** The loose-object file backing $rev, made writable so a case can break it. */
function looseObject(rev: string): string {
	const sha = git(repo, "rev-parse", rev).trim();
	const at = path.join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2));
	fs.chmodSync(at, 0o644);
	return at;
}

const commit = (paths: string) => `git commit -m "x" -- ${paths}`;

describe("a new checker", () => {
	it("is refused when nothing calls it and it has no sibling test, naming the self-plugin file and the test path it expects (#2457)", () => {
		add("scripts/check-new.js", "// new\n");
		const v = run(commit("scripts/check-new.js"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(
			buildNoCallerLine("self-plugin/hooks/hooks.json"),
		);
		expect(v.reason).not.toContain(".claude/settings.json");
		expect(v.reason).toContain("scripts/check-new.test.ts");
	});

	it("counts a self-plugin hooks.json registration as its caller (#2457)", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		wireCoreHook("check-new.js");
		const v = run(
			commit(
				`scripts/check-new.js scripts/check-new.test.ts ${CORE_HOOK_FILES}`,
			),
		);
		expect(v.reason).not.toContain("no caller");
		expect(v.denied).toBe(false);
	});

	it("is allowed when its caller and its sibling test land with it", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		add("scripts/wire.sh", "#!/usr/bin/env bash\nnode scripts/check-new.js\n");
		expect(
			run(
				commit(
					"scripts/check-new.js scripts/check-new.test.ts scripts/wire.sh",
				),
			).denied,
		).toBe(false);
	});

	it("is refused when the caller line is written but left out of the pathspec", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"scripts/caller.sh",
			"#!/usr/bin/env bash\nnode scripts/check-existing.js\nnode scripts/check-new.js\n",
		);
		const v = run(commit("scripts/check-new.js scripts/check-new.test.ts"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no caller");
	});

	it("is allowed once that caller file joins the same pathspec", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"scripts/caller.sh",
			"#!/usr/bin/env bash\nnode scripts/check-existing.js\nnode scripts/check-new.js\n",
		);
		expect(
			run(
				commit(
					"scripts/check-new.js scripts/check-new.test.ts scripts/caller.sh",
				),
			).denied,
		).toBe(false);
	});

	it("takes a CALLED_ELSEWHERE entry landing in the same commit as the escape", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		expect(
			run(
				commit(
					"scripts/check-new.js scripts/check-new.test.ts scripts/checker-registrations.test.ts",
				),
			).denied,
		).toBe(false);
	});

	it("does not take that entry when it is left out of the pathspec", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		expect(
			run(commit("scripts/check-new.js scripts/check-new.test.ts")).denied,
		).toBe(true);
	});

	it("is allowed when a caller already committed at HEAD names it", () => {
		edit(
			"scripts/caller.sh",
			"#!/usr/bin/env bash\nnode scripts/check-existing.js\nnode scripts/check-new.js\n",
		);
		git(repo, "commit", "-qm", "caller first", "--", "scripts/caller.sh");
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		expect(
			run(commit("scripts/check-new.js scripts/check-new.test.ts")).denied,
		).toBe(false);
	});

	it("allows, saying so, when a caller surface on disk cannot be read", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		const at = path.join(repo, "scripts", "caller.sh");
		fs.chmodSync(at, 0o000);
		try {
			const v = run(commit("scripts/check-new.js scripts/check-new.test.ts"));
			expect(v.denied).toBe(false);
			expect(readFaultReasons()).toContain(
				`could not read scripts/caller.sh in ${repo} — it was treated as a caller and the commit allowed unchecked`,
			);
		} finally {
			fs.chmodSync(at, 0o755);
		}
	});

	it("throws, for the kit to allow and record, when a caller directory cannot be listed", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		const at = path.join(repo, ".github", "workflows");
		fs.mkdirSync(at, { recursive: true });
		fs.chmodSync(at, 0o000);
		try {
			expect(() =>
				run(commit("scripts/check-new.js scripts/check-new.test.ts")),
			).toThrow(/EACCES/);
		} finally {
			fs.chmodSync(at, 0o755);
		}
	});

	it("is refused when the only file naming it is one git does not know and the commit leaves out", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		fs.writeFileSync(
			path.join(repo, "scripts", "wire.sh"),
			"#!/usr/bin/env bash\nnode scripts/check-new.js\n",
		);
		const v = run(commit("scripts/check-new.js scripts/check-new.test.ts"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no caller");
	});
});

describe("a new guard", () => {
	it("judges a guard-<name>.test.sh as a guard, JS_TEST_FILE naming no shell test (#3012)", () => {
		add("scripts/guard-new.test.sh", "#!/usr/bin/env bash\n");
		const v = run(commit("scripts/guard-new.test.sh"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("not registered");
	});

	it("is refused naming every registry it is missing from", () => {
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		const v = run(commit("scripts/guard-new.sh"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("not registered");
		expect(v.reason).toContain("not pinned");
		expect(v.reason).toContain("not counted");
		expect(v.reason).toContain("no sibling test");
	});

	it("is allowed when the registration, the pin, the needle and the test all land with it", () => {
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add("scripts/guard-new.test.ts", "// covered\n");
		wireCoreHook("guard-new.sh");
		expect(
			run(
				commit(
					`scripts/guard-new.sh scripts/guard-new.test.ts ${CORE_HOOK_FILES}`,
				),
			).denied,
		).toBe(false);
	});

	it("is refused when the hooks.json registration is written but left out of the pathspec", () => {
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add("scripts/guard-new.test.ts", "// covered\n");
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/guard-new.sh"]),
		);
		const v = run(commit("scripts/guard-new.sh scripts/guard-new.test.ts"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("not registered");
	});

	it("is refused when only .claude/settings.json registers it, naming the self-plugin file (#2444)", () => {
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add("scripts/guard-new.test.ts", "// covered\n");
		add(
			".claude/settings.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/guard-new.sh"]),
		);
		edit(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\nid: "scripts/guard-new.sh",\n',
		);
		edit(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify({ guards: { "guard-existing.sh": { needles: [] }, "guard-new.sh": { needles: [] } } }, null, 2)}\n`,
		);
		const v = run(
			commit(
				"scripts/guard-new.sh scripts/guard-new.test.ts .claude/settings.json scripts/hook-registrations.test.ts scripts/guard-fire-needles.json",
			),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(
			"not registered: self-plugin/hooks/hooks.json does not run it after this commit",
		);
	});

	it("takes a REGISTERED_ELSEWHERE entry landing with it, but still wants the sibling test", () => {
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		edit(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = { "guard-new.sh": "called by another script (#1)" };\nid: "scripts/guard-existing.sh",\n',
		);
		const v = run(
			commit("scripts/guard-new.sh scripts/hook-registrations.test.ts"),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no sibling test");
		expect(v.reason).not.toContain("not registered");
	});

	it("is judged the same when it is a Node entry", () => {
		add("scripts/guard-new.js", "#!/usr/bin/env node\n");
		const v = run(commit("scripts/guard-new.js"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("not registered");
		expect(v.reason).toContain("no sibling test");
	});
});

describe("a hooks.json hook list that moves on its own", () => {
	it("is refused when a hook is added with no needle entry, naming the hook as newly run", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/caller.sh"]),
		);
		edit(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\nid: "scripts/caller.sh",\n',
		);
		const v = run(
			commit("self-plugin/hooks/hooks.json scripts/hook-registrations.test.ts"),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Newly run");
		expect(v.reason).toContain("scripts/caller.sh");
	});

	it("is refused when a hook is added with its needle entry but no REGISTRATIONS row", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/caller.sh"]),
		);
		edit(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify({ guards: { "guard-existing.sh": { needles: [] }, "caller.sh": { needles: [] } } }, null, 2)}\n`,
		);
		const v = run(
			commit("self-plugin/hooks/hooks.json scripts/guard-fire-needles.json"),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Newly run");
		expect(v.reason).toContain("scripts/caller.sh");
	});

	it("is refused when a hook is dropped and its needle entry stays behind, naming the hook as no longer run", () => {
		edit("self-plugin/hooks/hooks.json", hooksFileFor([]));
		const v = run(commit("self-plugin/hooks/hooks.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("No longer run");
		expect(v.reason).toContain("scripts/guard-existing.sh");
	});

	it("is allowed when the hook and both registries move together", () => {
		edit("self-plugin/hooks/hooks.json", hooksFileFor([]));
		edit(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify({ guards: {} }, null, 2)}\n`,
		);
		edit(
			"scripts/hook-registrations.test.ts",
			"const REGISTERED_ELSEWHERE = {};\n",
		);
		expect(
			run(
				commit(
					"self-plugin/hooks/hooks.json scripts/guard-fire-needles.json scripts/hook-registrations.test.ts",
				),
			).denied,
		).toBe(false);
	});
});

describe("a repo judged against its host registries (#1456)", () => {
	const core = [
		"scripts/guard-fire-needles.json",
		"scripts/hook-registrations.test.ts",
		"scripts/checker-registrations.test.ts",
	];
	const registrations = (over: Record<string, unknown> = {}) =>
		`${JSON.stringify(
			{ hooks: [], registeredElsewhere: {}, calledElsewhere: {}, ...over },
			null,
			"\t",
		)}\n`;
	const needles = (guards: Record<string, unknown> = {}) =>
		`${JSON.stringify({ guards }, null, "\t")}\n`;
	const row = (script: string, event = "PreToolUse", matcher = "Bash") => ({
		event,
		id: `scripts/${script}`,
		matcher,
	});

	/**
	 * Drop the core's registries and self-plugin file from HEAD, as an
	 * adopter's repo has them, register its hooks in .claude/settings.json and
	 * seed the host's registries.
	 */
	function adopter({ seeded = true } = {}): void {
		git(repo, "rm", "-q", "--", ...core, "self-plugin/hooks/hooks.json");
		add(".claude/settings.json", hooksFileFor(["scripts/guard-existing.sh"]));
		git(repo, "add", "--", ".claude/settings.json");
		if (seeded) {
			add(
				".claude/registrations.json",
				registrations({ hooks: [row("guard-existing.sh")] }),
			);
			add(
				".claude/guard-fire-needles.json",
				needles({ "guard-existing.sh": { needles: [] } }),
			);
			git(repo, "add", "--", ".claude");
		}
		git(repo, "commit", "-qm", "an adopter's repo");
	}

	it("refuses a new guard missing its host row and needle, naming both host files", () => {
		adopter();
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		const v = run(commit("scripts/guard-new.sh"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(
			"not registered: .claude/settings.json does not run it",
		);
		expect(v.reason).toContain(
			"not pinned: .claude/registrations.json has no `hooks` row",
		);
		expect(v.reason).toContain(
			"not counted: .claude/guard-fire-needles.json has no entry",
		);
		expect(v.reason).toContain(
			"no sibling test: no scripts/guard-new.test.{ts,js,mjs,cjs,py}",
		);
		expect(v.reason).toContain("check-registrations.js` lists every hook");
		expect(v.reason).not.toContain("hook-registrations.test.ts");
	});

	it("allows a new guard landing with its registration, host row, host needle and a .test.js sibling", () => {
		adopter();
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add("scripts/guard-new.test.js", "// covered\n");
		edit(
			".claude/settings.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/guard-new.sh"]),
		);
		edit(
			".claude/registrations.json",
			registrations({
				hooks: [row("guard-existing.sh"), row("guard-new.sh")],
			}),
		);
		edit(
			".claude/guard-fire-needles.json",
			needles({
				"guard-existing.sh": { needles: [] },
				"guard-new.sh": { needles: [] },
			}),
		);
		expect(
			run(
				commit(
					"scripts/guard-new.sh scripts/guard-new.test.js .claude/settings.json .claude/registrations.json .claude/guard-fire-needles.json",
				),
			).denied,
		).toBe(false);
	});

	it("takes a registeredElsewhere key as the escape, naming the host key in the refusal", () => {
		adopter();
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		const bare = run(commit("scripts/guard-new.sh"));
		expect(bare.reason).toContain(
			"add a `registeredElsewhere` entry to .claude/registrations.json",
		);
		edit(
			".claude/registrations.json",
			registrations({
				hooks: [row("guard-existing.sh")],
				registeredElsewhere: { "guard-new.sh": "run by caller.sh (#1)" },
			}),
		);
		const v = run(commit("scripts/guard-new.sh .claude/registrations.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no sibling test");
		expect(v.reason).not.toContain("not registered");
	});

	it("refuses a new checker naming the calledElsewhere escape, and allows it with that key and a .test.py", () => {
		adopter();
		add("scripts/check-new.js", "// new\n");
		const v = run(commit("scripts/check-new.js"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no caller");
		expect(v.reason).toContain(
			"add a `calledElsewhere` entry to .claude/registrations.json",
		);
		add("scripts/check-new.test.py", "// covered\n");
		edit(
			".claude/registrations.json",
			registrations({
				hooks: [row("guard-existing.sh")],
				calledElsewhere: { "check-new.js": "hand-only (#1)" },
			}),
		);
		expect(
			run(
				commit(
					"scripts/check-new.js scripts/check-new.test.py .claude/registrations.json",
				),
			).denied,
		).toBe(false);
	});

	it("never reads a check-<name>.test.js or .spec.js as a new checker, nor a guard-<name>.spec.js as a guard (#3012)", () => {
		adopter();
		add("scripts/check-existing.test.js", "// a second test\n");
		expect(run(commit("scripts/check-existing.test.js")).denied).toBe(false);
		add("scripts/check-existing.spec.js", "// a third test\n");
		expect(run(commit("scripts/check-existing.spec.js")).denied).toBe(false);
		add("scripts/guard-existing.spec.js", "// a test\n");
		expect(run(commit("scripts/guard-existing.spec.js")).denied).toBe(false);
	});

	it("refuses a newly run hook missing from both host files, and allows it once both move", () => {
		adopter();
		edit(
			".claude/settings.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/caller.sh"]),
		);
		const v = run(commit(".claude/settings.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(
			"no .claude/guard-fire-needles.json entry or no `hooks` row in .claude/registrations.json",
		);
		expect(v.reason).toContain("scripts/caller.sh");
		edit(
			".claude/registrations.json",
			registrations({ hooks: [row("guard-existing.sh"), row("caller.sh")] }),
		);
		edit(
			".claude/guard-fire-needles.json",
			needles({
				"guard-existing.sh": { needles: [] },
				"caller.sh": { needles: [] },
			}),
		);
		expect(
			run(
				commit(
					".claude/settings.json .claude/registrations.json .claude/guard-fire-needles.json",
				),
			).denied,
		).toBe(false);
	});

	it("reads a moved hook's new event and matcher in the host file's JSON spelling", () => {
		adopter();
		edit(
			".claude/registrations.json",
			registrations({ hooks: [row("guard-existing.sh", "Stop", "Read")] }),
		);
		git(repo, "commit", "-qm", "row first", "--", ".claude/registrations.json");
		edit(
			".claude/settings.json",
			hooksFileOf([
				{ event: "Stop", matcher: "Read", script: "scripts/guard-existing.sh" },
			]),
		);
		expect(run(commit(".claude/settings.json")).denied).toBe(false);
	});

	it("takes the plugin's own needle for a core guard a host registers", () => {
		adopter();
		edit(
			".claude/settings.json",
			hooksFileFor([
				"scripts/guard-existing.sh",
				"scripts/guard-agent-poll.js",
			]),
		);
		edit(
			".claude/registrations.json",
			registrations({
				hooks: [row("guard-existing.sh"), row("guard-agent-poll.js")],
			}),
		);
		expect(
			run(commit(".claude/settings.json .claude/registrations.json")).denied,
		).toBe(false);
	});

	it("refuses a deleted checker whose calledElsewhere key stays behind", () => {
		adopter();
		edit(
			".claude/registrations.json",
			registrations({
				hooks: [row("guard-existing.sh")],
				calledElsewhere: { "check-existing.js": "hand-only (#1)" },
			}),
		);
		git(repo, "commit", "-qam", "host allowlist");
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		const v = run(commit("scripts/check-existing.js"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("its `calledElsewhere` entry stays behind");
		expect(v.reason).toContain(".claude/registrations.json still names");
	});

	it("allows a deleted checker where the host registrations it lands cannot be parsed", () => {
		adopter();
		edit(
			".claude/registrations.json",
			registrations({
				hooks: [row("guard-existing.sh")],
				calledElsewhere: { "check-existing.js": "hand-only (#1)" },
			}),
		);
		git(repo, "commit", "-qam", "host allowlist");
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		edit(".claude/registrations.json", "{ not json");
		expect(
			run(commit("scripts/check-existing.js .claude/registrations.json"))
				.denied,
		).toBe(false);
	});

	describe("each host key read on its own object, as check-registrations.js reads it (#1670)", () => {
		/** A new guard with everything but its `hooks` row and the escape. */
		function guardShortOfItsRow(over: Record<string, unknown>): void {
			adopter();
			add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
			add("scripts/guard-new.test.js", "// covered\n");
			edit(
				".claude/settings.json",
				hooksFileFor(["scripts/guard-existing.sh", "scripts/guard-new.sh"]),
			);
			edit(
				".claude/registrations.json",
				registrations({ hooks: [row("guard-existing.sh")], ...over }),
			);
			edit(
				".claude/guard-fire-needles.json",
				needles({
					"guard-existing.sh": { needles: [] },
					"guard-new.sh": { needles: [] },
				}),
			);
		}
		const guardCommit = commit(
			"scripts/guard-new.sh scripts/guard-new.test.js .claude/settings.json .claude/registrations.json .claude/guard-fire-needles.json",
		);

		it("refuses a new guard keyed only in calledElsewhere, as not pinned", () => {
			guardShortOfItsRow({
				calledElsewhere: { "guard-new.sh": "mis-filed (#1)" },
			});
			const v = run(guardCommit);
			expect(v.denied).toBe(true);
			expect(v.reason).toContain("not pinned");
		});

		it("refuses a new guard whose path appears only inside a reason, as not pinned", () => {
			guardShortOfItsRow({
				registeredElsewhere: {
					"guard-other.sh": "superseded by scripts/guard-new.sh (#1)",
				},
			});
			const v = run(guardCommit);
			expect(v.denied).toBe(true);
			expect(v.reason).toContain("not pinned");
		});

		it("takes a row whose id names the script without its directory as a pin", () => {
			guardShortOfItsRow({
				hooks: [
					row("guard-existing.sh"),
					{ event: "PreToolUse", id: "guard-new.sh", matcher: "Bash" },
				],
			});
			expect(run(guardCommit).denied).toBe(false);
		});

		it("takes a row whose id holds the script's arguments but not its directory as a pin", () => {
			guardShortOfItsRow({
				hooks: [
					row("guard-existing.sh"),
					{ event: "PreToolUse", id: "guard-new.sh --mode x", matcher: "Bash" },
				],
			});
			edit(
				".claude/settings.json",
				hooksFileFor([
					"scripts/guard-existing.sh",
					"scripts/guard-new.sh --mode x",
				]),
			);
			expect(run(guardCommit).denied).toBe(false);
		});

		it("refuses a moved hook whose new event and matcher sit only on two different rows", () => {
			adopter();
			edit(
				".claude/registrations.json",
				registrations({
					hooks: [
						row("guard-existing.sh"),
						row("guard-a.sh", "Stop", "Bash"),
						row("guard-b.sh", "PreToolUse", "Read"),
					],
				}),
			);
			git(
				repo,
				"commit",
				"-qm",
				"rows first",
				"--",
				".claude/registrations.json",
			);
			edit(
				".claude/settings.json",
				hooksFileOf([
					{
						event: "Stop",
						matcher: "Read",
						script: "scripts/guard-existing.sh",
					},
				]),
			);
			const v = run(commit(".claude/settings.json"));
			expect(v.denied).toBe(true);
			expect(v.reason).toContain("now on Stop with matcher Read");
		});

		it("refuses a hook no longer run whose row stays, and allows one whose path is left only as a reason", () => {
			adopter();
			edit(".claude/settings.json", hooksFileFor([]));
			edit(".claude/guard-fire-needles.json", needles());
			const stays = run(
				commit(".claude/settings.json .claude/guard-fire-needles.json"),
			);
			expect(stays.denied).toBe(true);
			expect(stays.reason).toContain("No longer run");
			edit(
				".claude/registrations.json",
				registrations({
					registeredElsewhere: {
						"guard-other.sh": "scripts/guard-existing.sh",
					},
				}),
			);
			expect(
				run(
					commit(
						".claude/settings.json .claude/guard-fire-needles.json .claude/registrations.json",
					),
				).denied,
			).toBe(false);
		});

		it("refuses a new checker keyed only in registeredElsewhere, as having no caller", () => {
			adopter();
			add("scripts/check-new.js", "// new\n");
			add("scripts/check-new.test.js", "// covered\n");
			edit(
				".claude/registrations.json",
				registrations({
					hooks: [row("guard-existing.sh")],
					registeredElsewhere: { "check-new.js": "mis-filed (#1)" },
				}),
			);
			const v = run(
				commit(
					"scripts/check-new.js scripts/check-new.test.js .claude/registrations.json",
				),
			);
			expect(v.denied).toBe(true);
			expect(v.reason).toContain(buildNoCallerLine(".claude/settings.json"));
		});

		it("allows deleting a checker that only registeredElsewhere keys, which the checker never reads for it", () => {
			adopter();
			edit(
				".claude/registrations.json",
				registrations({
					hooks: [row("guard-existing.sh")],
					registeredElsewhere: { "check-existing.js": "mis-filed (#1)" },
				}),
			);
			git(repo, "commit", "-qam", "host allowlist");
			fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
			expect(run(commit("scripts/check-existing.js")).denied).toBe(false);
		});

		it("allows a commit against a host registry it cannot parse, and records that it did", () => {
			adopter();
			add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
			add("scripts/guard-new.test.js", "// covered\n");
			edit(".claude/registrations.json", "{ not json\n");
			expect(
				run(
					commit(
						"scripts/guard-new.sh scripts/guard-new.test.js .claude/registrations.json",
					),
				).denied,
			).toBe(false);
			expect(readFaultReasons()).toEqual([
				expect.stringContaining("could not parse"),
			]);
		});
	});

	describe("an adopter not yet seeded (the #1162 incident)", () => {
		it("allows a commit landing no member, so its first commit after the upgrade is not stranded", () => {
			adopter({ seeded: false });
			add("README.md", "# an adopter\n");
			expect(run(commit("README.md")).denied).toBe(false);
		});

		it("refuses a new guard naming the host files to create and the command that seeds them", () => {
			adopter({ seeded: false });
			add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
			const v = run(commit("scripts/guard-new.sh"));
			expect(v.denied).toBe(true);
			expect(v.reason).toContain(
				"Not in this repo yet: .claude/registrations.json .claude/guard-fire-needles.json.",
			);
			expect(v.reason).toContain("upgrade.js` seeds each empty");
		});

		it("judges host files that land in the same commit", () => {
			adopter({ seeded: false });
			add("scripts/check-new.js", "// new\n");
			add(".claude/registrations.json", registrations());
			const v = run(commit("scripts/check-new.js .claude/registrations.json"));
			expect(v.denied).toBe(true);
			expect(v.reason).toContain("no caller");
			expect(v.reason).not.toContain(
				"Not in this repo yet: .claude/registrations.json ",
			);
		});
	});

	it("judges a commit deleting the core's registry against the host file instead", () => {
		fs.rmSync(path.join(repo, "scripts", "checker-registrations.test.ts"));
		add("scripts/check-new.js", "// new\n");
		const v = run(
			commit("scripts/check-new.js scripts/checker-registrations.test.ts"),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(".claude/registrations.json");
	});

	it("judges a commit deleting the self-plugin file against it, not against settings.json (#2444)", () => {
		fs.rmSync(path.join(repo, "self-plugin", "hooks", "hooks.json"));
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add(
			".claude/settings.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/guard-new.sh"]),
		);
		const v = run(
			commit(
				"scripts/guard-new.sh self-plugin/hooks/hooks.json .claude/settings.json",
			),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(
			"not registered: self-plugin/hooks/hooks.json does not run it",
		);
	});
});

/* The commit form CLAUDE.md requires runs no `git` the hook can see, and
 * intent-adds an untracked path itself — so a guard reading only `git commit`
 * segments, or only the index's names, lets the split land through it. */
describe("a commit-paths.js commit (#1727)", () => {
	const viaScript = (paths: string) =>
		`node scripts/commit-paths.js -m "x" -- ${paths}`;

	/** Write a file git does not know yet, as commit-paths.js finds it. */
	const untracked = (rel: string, body: string) =>
		fs.writeFileSync(path.join(repo, rel), body);

	const refusesCheckNew = (v: Verdict) => {
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("scripts/check-new.js");
		expect(v.reason).toContain("CALLED_ELSEWHERE");
	};

	it("refuses an untracked new checker with no caller and no test, in the hand form's words", () => {
		untracked("scripts/check-new.js", "// new\n");
		const v = run(viaScript("scripts/check-new.js"));
		git(repo, "add", "-N", "--", "scripts/check-new.js");
		const hand = run(commit("scripts/check-new.js"));
		refusesCheckNew(v);
		expect(v.reason).toContain("no caller");
		expect(v.reason).toBe(hand.reason);
	});

	it("allows the same commit carrying its caller and its sibling test, none of them yet known to git", () => {
		untracked("scripts/check-new.js", "// new\n");
		untracked("scripts/check-new.test.ts", "// covered\n");
		untracked(
			"scripts/wire.sh",
			"#!/usr/bin/env bash\nnode scripts/check-new.js\n",
		);
		expect(
			run(
				viaScript(
					"scripts/check-new.js scripts/check-new.test.ts scripts/wire.sh",
				),
			).denied,
		).toBe(false);
	});

	it("reads the script by an absolute path, behind -F and node's own flags, a valued one included", () => {
		add("scripts/check-new.js", "// new\n");
		refusesCheckNew(
			run(
				`node --no-warnings -r ./x.js ${path.join(repo, "scripts/commit-paths.js")} -F msg.txt -- scripts/check-new.js`,
			),
		);
	});

	it("reads the script behind a quoted variable directory", () => {
		add("scripts/check-new.js", "// new\n");
		refusesCheckNew(
			run(
				'node "$CLAUDE_PROJECT_DIR"/scripts/commit-paths.js -m x -- scripts/check-new.js',
			),
		);
	});

	it("judges paths from the directory the call runs in", () => {
		add("scripts/check-new.js", "// new\n");
		refusesCheckNew(
			run("cd scripts && node ../scripts/commit-paths.js -m x -- check-new.js"),
		);
	});

	/** A --patch file creating each path, as `git diff HEAD` cuts it, the paths left untracked. */
	const patchCreating = (rels: string[]) => {
		git(repo, "add", "-N", "--", ...rels);
		fs.writeFileSync(
			path.join(repo, "p.diff"),
			git(repo, "diff", "HEAD", "-U0", "--", ...rels),
		);
		git(repo, "reset", "-q", "--", ...rels);
	};

	it("refuses a new checker its --patch creates, with no caller and no test", () => {
		untracked("scripts/check-new.js", "// new\n");
		patchCreating(["scripts/check-new.js"]);
		refusesCheckNew(run("node scripts/commit-paths.js -m x --patch p.diff"));
	});

	it("allows a --patch creating the checker, its caller and its test together", () => {
		untracked("scripts/check-new.js", "// new\n");
		untracked("scripts/check-new.test.ts", "// covered\n");
		untracked(
			"scripts/wire.sh",
			"#!/usr/bin/env bash\nnode scripts/check-new.js\n",
		);
		patchCreating([
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/wire.sh",
		]);
		expect(
			run("cd scripts && node commit-paths.js -m x --patch ../p.diff").denied,
		).toBe(false);
	});

	/** scripts/wire.sh committed, then edited twice, a line apart: `echo a` to
	 * `echo b`, and a caller of check-new.js added. Two hunks, as two sessions
	 * leave them. */
	const twoHunkWire = () => {
		fs.writeFileSync(
			path.join(repo, "scripts", "wire.sh"),
			"#!/usr/bin/env bash\necho a\necho kept\n",
		);
		git(repo, "add", "--", "scripts/wire.sh");
		git(repo, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "wire");
		fs.writeFileSync(
			path.join(repo, "scripts", "wire.sh"),
			"#!/usr/bin/env bash\necho b\necho kept\nnode scripts/check-new.js\n",
		);
	};

	/** Keep only the hunk of p.diff's wire.sh section that does not add the caller. */
	const dropCallerHunk = () => {
		const at = path.join(repo, "p.diff");
		fs.writeFileSync(
			at,
			fs
				.readFileSync(at, "utf8")
				.replace(/@@[^\n]*@@[^\n]*\n\+node scripts\/check-new\.js\n/, ""),
		);
	};

	it("judges a --patch file on HEAD plus its patch, not on a neighbour's hunk beside it (#2894)", () => {
		untracked("scripts/check-new.js", "// new\n");
		untracked("scripts/check-new.test.ts", "// covered\n");
		twoHunkWire();
		patchCreating([
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/wire.sh",
		]);
		dropCallerHunk();
		refusesCheckNew(run("node scripts/commit-paths.js -m x --patch p.diff"));
		expect(faults).toEqual([]);
	});

	it("allows a --patch file whose landing keeps the caller a neighbour's hunk deletes on disk (#2894)", () => {
		untracked("scripts/check-new.js", "// new\n");
		untracked("scripts/check-new.test.ts", "// covered\n");
		fs.writeFileSync(
			path.join(repo, "scripts", "wire.sh"),
			"#!/usr/bin/env bash\nnode scripts/check-new.js\necho kept\necho a\n",
		);
		git(repo, "add", "--", "scripts/wire.sh");
		git(repo, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "wire");
		fs.writeFileSync(
			path.join(repo, "scripts", "wire.sh"),
			"#!/usr/bin/env bash\necho kept\necho b\n",
		);
		patchCreating([
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/wire.sh",
		]);
		const at = path.join(repo, "p.diff");
		fs.writeFileSync(
			at,
			fs
				.readFileSync(at, "utf8")
				.replace(/@@[^\n]*@@[^\n]*\n-node scripts\/check-new\.js\n/, ""),
		);
		expect(run("node scripts/commit-paths.js -m x --patch p.diff").denied).toBe(
			false,
		);
		expect(faults).toEqual([]);
	});

	it("reads a path named whole as well as patched from its disk copy, which commit-paths.js adds last", () => {
		untracked("scripts/check-new.js", "// new\n");
		untracked("scripts/check-new.test.ts", "// covered\n");
		twoHunkWire();
		patchCreating([
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/wire.sh",
		]);
		dropCallerHunk();
		expect(
			run("node scripts/commit-paths.js -m x --patch p.diff -- scripts/wire.sh")
				.denied,
		).toBe(false);
	});

	it("allows, logged, a --patch file git cannot apply to HEAD", () => {
		untracked("scripts/check-new.js", "// new\n");
		fs.writeFileSync(
			path.join(repo, "p.diff"),
			"diff --git a/scripts/none.js b/scripts/none.js\n--- a/scripts/none.js\n+++ b/scripts/none.js\n@@ -1 +1 @@\n-x\n+y\n",
		);
		expect(run("node scripts/commit-paths.js -m x --patch p.diff").denied).toBe(
			false,
		);
		expect(readFaultReasons()).toEqual([
			`could not read the --patch file of a commit-paths.js call in ${repo}, or apply it to HEAD — the files it carries were left unjudged`,
		]);
	});

	it("judges a commit made in a linked worktree", () => {
		const wt = path.join(dir, "wt");
		git(repo, "worktree", "add", "-q", wt);
		fs.writeFileSync(path.join(wt, "scripts", "check-new.js"), "// new\n");
		refusesCheckNew(run(viaScript("scripts/check-new.js"), wt));
	});

	it("leaves alone a path git ignores, which it will not commit", () => {
		fs.writeFileSync(path.join(repo, ".gitignore"), "scripts/check-new.js\n");
		fs.writeFileSync(path.join(repo, "scripts", "check-new.js"), "// new\n");
		expect(run(viaScript("scripts/check-new.js")).denied).toBe(false);
	});

	it("leaves --tree alone, which commits nothing", () => {
		add("scripts/check-new.js", "// new\n");
		expect(
			run("node scripts/commit-paths.js --tree -- scripts/check-new.js").denied,
		).toBe(false);
	});
});

describe("what it leaves alone", () => {
	it("says nothing about a commit touching neither class", () => {
		edit("a.md", "changed\n");
		expect(run(commit("a.md")).denied).toBe(false);
	});

	it("says nothing about a checker already committed at HEAD", () => {
		edit("scripts/check-existing.js", "// touched\n");
		expect(run(commit("scripts/check-existing.js")).denied).toBe(false);
	});

	it("stands down mid-rebase, where the commit's contents were chosen earlier", () => {
		add("scripts/check-new.js", "// new\n");
		fs.mkdirSync(path.join(repo, ".git", "rebase-merge"), { recursive: true });
		expect(run(commit("scripts/check-new.js")).denied).toBe(false);
	});

	it("says nothing about a git command that is not a commit", () => {
		add("scripts/check-new.js", "// new\n");
		expect(run("git status -- scripts/check-new.js").denied).toBe(false);
	});

	it("judges another repository not at all", () => {
		const other = path.join(dir, "other");
		initGitRepo(other, path.join(dir, "no-hooks"));
		fs.mkdirSync(path.join(other, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(other, "scripts", "check-new.js"), "// new\n");
		git(other, "add", "-N", "--", "scripts/check-new.js");
		expect(run(commit("scripts/check-new.js"), other).denied).toBe(false);
	});
});

describe("the index route", () => {
	it("reads the staged set when the commit names no pathspec", () => {
		add("scripts/check-new.js", "// new\n");
		git(repo, "add", "--", "scripts/check-new.js");
		const v = run('git commit -m "x"');
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("scripts/check-new.js");
	});

	/* mantahostels#2734: a bare commit takes the INDEX copy of every path it lands, so the
	 * working-tree bytes it was judged on before are the wrong ones in both
	 * directions — they acquit a commit landing the split, and they refuse one
	 * that does not. */
	const bare = 'git commit -m "x"';

	it("refuses when the wiring is on disk but left out of the index", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		// Staged with an unrelated edit, so the path lands while the index copy
		// still carries no allowlist entry.
		edit(
			"scripts/checker-registrations.test.ts",
			"const CALLED_ELSEWHERE = {};\n// touched\n",
		);
		git(
			repo,
			"add",
			"--",
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/checker-registrations.test.ts",
		);
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		const v = run(bare);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no caller");
	});

	it("allows when the wiring is in the index but has since left the disk", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		git(
			repo,
			"add",
			"--",
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/checker-registrations.test.ts",
		);
		edit(
			"scripts/checker-registrations.test.ts",
			"const CALLED_ELSEWHERE = {};\n",
		);
		expect(run(bare).denied).toBe(false);
	});

	it("reads the sibling test out of the index, not off the disk", () => {
		// The sibling is in HEAD, and this commit drops it while leaving it on
		// disk — the only way a landing path can be absent from the index.
		add("scripts/check-new.test.ts", "// covered\n");
		git(repo, "add", "--", "scripts/check-new.test.ts");
		git(repo, "commit", "-qm", "a sibling test, no checker yet");
		add("scripts/check-new.js", "// new\n");
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		git(
			repo,
			"add",
			"--",
			"scripts/check-new.js",
			"scripts/checker-registrations.test.ts",
		);
		git(repo, "rm", "-q", "--cached", "--", "scripts/check-new.test.ts");
		const v = run(bare);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no sibling test");
	});

	it("diffs the hook list against the staged hooks.json", () => {
		edit("self-plugin/hooks/hooks.json", hooksFileFor([]));
		git(repo, "add", "--", "self-plugin/hooks/hooks.json");
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileFor(["scripts/guard-existing.sh"]),
		);
		const v = run(bare);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("No longer run");
		expect(v.reason).toContain("scripts/guard-existing.sh");
	});

	it("judges the needle corpus by the staged copy of a printer", () => {
		const printer = path.join(repo, "scripts", "guard-existing.sh");
		fs.writeFileSync(printer, '#!/usr/bin/env bash\necho "the old wording"\n');
		fs.writeFileSync(
			path.join(repo, "scripts", "guard-fire-needles.json"),
			`${JSON.stringify(
				{
					guards: {
						"guard-existing.sh": {
							needles: [{ id: "n1", text: "the old wording" }],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		git(repo, "commit", "-qam", "a needle and its printer");
		fs.writeFileSync(printer, '#!/usr/bin/env bash\necho "the new wording"\n');
		git(repo, "add", "--", "scripts/guard-existing.sh");
		fs.writeFileSync(printer, '#!/usr/bin/env bash\necho "the old wording"\n');
		const v = run(bare);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("the old wording");
	});

	it("reads the staged copy of a printer from the top of the tree, wherever the commit runs", () => {
		const printer = path.join(repo, "scripts", "guard-existing.sh");
		fs.writeFileSync(printer, '#!/usr/bin/env bash\necho "the old wording"\n');
		fs.writeFileSync(
			path.join(repo, "scripts", "guard-fire-needles.json"),
			`${JSON.stringify({ guards: { "guard-existing.sh": { needles: [{ id: "n1", text: "the old wording" }] } } }, null, 2)}\n`,
		);
		git(repo, "commit", "-qam", "a needle and its printer");
		fs.writeFileSync(
			printer,
			'#!/usr/bin/env bash\necho "the old wording"\necho more\n',
		);
		git(repo, "add", "--", "scripts/guard-existing.sh");
		fs.writeFileSync(printer, '#!/usr/bin/env bash\necho "the new wording"\n');
		expect(run(bare, path.join(repo, ".husky")).denied).toBe(false);
	});

	/* `-a` stages every tracked file's WORKING-TREE copy on its way in, so it
	 * lands that copy and not the index's — the index read would judge stale
	 * bytes, and here it would judge them into a false denial (mantahostels#2734).
	 *
	 * scripts/guard-commit-form.js denies `-a` before this guard is reached, so
	 * this case pins the reasoning rather than a reachable verdict. */
	it("reads the working tree for -a, which lands it", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		// An unrelated edit, so the path lands while the index copy carries no
		// allowlist entry.
		edit(
			"scripts/checker-registrations.test.ts",
			"const CALLED_ELSEWHERE = {};\n// touched\n",
		);
		git(
			repo,
			"add",
			"--",
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/checker-registrations.test.ts",
		);
		// The wiring is on disk and out of the index; `-a` will stage it.
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		expect(run('git commit -am "x"').denied).toBe(false);
		expect(run('git commit --all -m "x"').denied).toBe(false);
	});

	/* The positive twin of "reads the sibling test out of the index": the same
	 * staged deletion, put back, so a landingExists that named nothing at all
	 * would still deny here. */
	it("takes the sibling test the index does carry", () => {
		add("scripts/check-new.test.ts", "// covered\n");
		git(repo, "add", "--", "scripts/check-new.test.ts");
		git(repo, "commit", "-qm", "a sibling test, no checker yet");
		add("scripts/check-new.js", "// new\n");
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		git(
			repo,
			"add",
			"--",
			"scripts/check-new.js",
			"scripts/checker-registrations.test.ts",
		);
		expect(run(bare).denied).toBe(false);
	});

	/* The positive twin of the needle case: the same staged rewording, with the
	 * needle moved to match, so an indexShow returning null for everything would
	 * still deny here. */
	it("allows the staged reword whose needle moves with it", () => {
		const printer = path.join(repo, "scripts", "guard-existing.sh");
		const needles = (text: string) =>
			`${JSON.stringify(
				{ guards: { "guard-existing.sh": { needles: [{ id: "n1", text }] } } },
				null,
				2,
			)}\n`;
		fs.writeFileSync(printer, '#!/usr/bin/env bash\necho "the old wording"\n');
		fs.writeFileSync(
			path.join(repo, "scripts", "guard-fire-needles.json"),
			needles("the old wording"),
		);
		git(repo, "commit", "-qam", "a needle and its printer");
		fs.writeFileSync(printer, '#!/usr/bin/env bash\necho "the new wording"\n');
		fs.writeFileSync(
			path.join(repo, "scripts", "guard-fire-needles.json"),
			needles("the new wording"),
		);
		git(
			repo,
			"add",
			"--",
			"scripts/guard-existing.sh",
			"scripts/guard-fire-needles.json",
		);
		expect(run(bare).denied).toBe(false);
	});

	/* `git rm --cached` leaves the file on disk, so only the index shows the
	 * removal. A pathspec commit naming the same path re-stages the working-tree
	 * copy and lands nothing at all (see LIMITS). */
	it("sees a checker dropped with git rm --cached", () => {
		fs.writeFileSync(
			path.join(repo, "scripts", "checker-registrations.test.ts"),
			'const CALLED_ELSEWHERE = { "check-existing.js": "hand-only (#1)" };\n',
		);
		git(repo, "commit", "-qam", "allowlist it");
		git(repo, "rm", "-q", "--cached", "--", "scripts/check-existing.js");
		const v = run(bare);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("stays behind");
	});
});

describe("what the review of mantahostels#2671 found", () => {
	/* `reported` was filled by both limbs, so a new checker ALSO registered
	 * as a hooks.json hook skipped judgeHookList entirely and its missing
	 * needle went unasked-for. */
	it("still demands a needle for a new checker wired as a hook", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/check-new.js"]),
		);
		edit(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\nid: "scripts/check-new.js",\n',
		);
		const v = run(
			commit(
				"scripts/check-new.js scripts/check-new.test.ts self-plugin/hooks/hooks.json scripts/hook-registrations.test.ts",
			),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Newly run");
		expect(v.reason).toContain("scripts/check-new.js");
	});

	/* A git failure is not an absence. An unreadable HEAD must ALLOW and
	 * record, never deny — this guard's one forbidden direction.
	 *
	 * IT COVERS NO BRANCH, and is kept as the end-to-end control; the branches
	 * are reached by "fail-opens no broken object reaches" below. */
	it("allows when the object store is unreadable", () => {
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add("scripts/guard-new.test.ts", "// covered\n");
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/guard-new.sh"]),
		);
		edit(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-new.sh",\n',
		);
		edit(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify({ guards: { "guard-new.sh": { needles: [] } } }, null, 2)}\n`,
		);
		// Break the whole object store, leaving the ref itself intact.
		fs.chmodSync(path.join(repo, ".git", "objects"), 0o000);
		try {
			expect(
				run(
					commit(
						"scripts/guard-new.sh scripts/guard-new.test.ts self-plugin/hooks/hooks.json scripts/hook-registrations.test.ts scripts/guard-fire-needles.json",
					),
				).denied,
			).toBe(false);
		} finally {
			fs.chmodSync(path.join(repo, ".git", "objects"), 0o755);
		}
	});
});

describe("what the review of mantahostels#2671 left open (mantahostels#2685)", () => {
	/* The script's NAME is unchanged, so a name diff saw nothing — while
	 * hook-registrations.test.ts pins the matcher against the id and goes red
	 * from this commit until the table catches up. */
	it("refuses a registration whose matcher moves with the pin table left behind", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ matcher: "Bash|Read", script: "scripts/guard-existing.sh" },
			]),
		);
		const v = run(commit("self-plugin/hooks/hooks.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Moved to another event or matcher");
		expect(v.reason).toContain("scripts/guard-existing.sh");
	});

	it("allows that move once the pin table lands with it", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ matcher: "Bash|Read", script: "scripts/guard-existing.sh" },
			]),
		);
		edit(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\nmatcher: "Bash|Read",\n',
		);
		expect(
			run(
				commit(
					"self-plugin/hooks/hooks.json scripts/hook-registrations.test.ts",
				),
			).denied,
		).toBe(false);
	});

	/* The event moves, which is what "pins every registration in the file"
	 * reads — it matches on event and id together. */
	it("refuses a registration whose event moves with the pin table left behind", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ event: "PostToolUse", script: "scripts/guard-existing.sh" },
			]),
		);
		const v = run(commit("self-plugin/hooks/hooks.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Moved to another event or matcher");
		expect(v.reason).toContain("PostToolUse");
	});

	/* A second registration of the SAME script, told apart by its argument
	 * alone. guardKey carries the argument, so this is a new key with no needle
	 * entry — count-guard-fires.test.ts's `unkeyed` drift. */
	it("refuses a second registration told apart only by its arguments, naming it as newly run", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ script: "scripts/guard-existing.sh" },
				{ script: "scripts/guard-existing.sh start" },
			]),
		);
		const v = run(commit("self-plugin/hooks/hooks.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Newly run");
		expect(v.reason).toContain("scripts/guard-existing.sh start");
	});

	it("allows it once both registries carry the argument-keyed entry", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ script: "scripts/guard-existing.sh" },
				{ script: "scripts/guard-existing.sh start" },
			]),
		);
		edit(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify(
				{
					guards: {
						"guard-existing.sh": { needles: [] },
						"guard-existing.sh start": { needles: [] },
					},
				},
				null,
				2,
			)}\n`,
		);
		edit(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\nid: "scripts/guard-existing.sh start",\n',
		);
		expect(
			run(
				commit(
					"self-plugin/hooks/hooks.json scripts/guard-fire-needles.json scripts/hook-registrations.test.ts",
				),
			).denied,
		).toBe(false);
	});

	/* The pin table was updated in an EARLIER commit, so the suite is green the
	 * moment this settings-only commit lands. Demanding the table land too would
	 * refuse it — the forbidden direction. */
	it("allows a matcher move whose new value the pin table already spells", () => {
		fs.writeFileSync(
			path.join(repo, "scripts", "hook-registrations.test.ts"),
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-existing.sh",\nevent: "PreToolUse",\nmatcher: "Bash|Read",\n',
		);
		git(
			repo,
			"commit",
			"-qm",
			"repin first",
			"--",
			"scripts/hook-registrations.test.ts",
		);
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ matcher: "Bash|Read", script: "scripts/guard-existing.sh" },
			]),
		);
		expect(run(commit("self-plugin/hooks/hooks.json")).denied).toBe(false);
	});

	/* The test matches an id that is any SUBSTRING of the command
	 * line, so a row naming the script alone already pins a registration carrying
	 * arguments. Only the needle entry, which is keyed on the arguments, is
	 * genuinely owed here. */
	it("takes a pin row naming the script alone for an argument-keyed registration", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ script: "scripts/guard-existing.sh" },
				{ script: "scripts/guard-existing.sh start" },
			]),
		);
		edit(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify(
				{
					guards: {
						"guard-existing.sh": { needles: [] },
						"guard-existing.sh start": { needles: [] },
					},
				},
				null,
				2,
			)}\n`,
		);
		expect(
			run(
				commit("self-plugin/hooks/hooks.json scripts/guard-fire-needles.json"),
			).denied,
		).toBe(false);
	});

	/* An unparseable hooks.json must ALLOW. Read as an empty
	 * registration list it would instead read every hook at HEAD as removed. */
	it("allows a hooks.json it cannot parse, rather than reading it as empty", () => {
		edit("self-plugin/hooks/hooks.json", "{ not json\n");
		expect(run(commit("self-plugin/hooks/hooks.json")).denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			"could not read the hook registrations out of the self-plugin/hooks/hooks.json this commit lands — its hook-list change was allowed unchecked",
		]);
	});

	/* guard-fires.js keys any scripts/<name>, so a hook wearing neither .sh
	 * nor .js still demands a needle entry. */
	it("refuses a newly run hook script wearing neither .sh nor .js, naming the script", () => {
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileOf([
				{ script: "scripts/guard-existing.sh" },
				{ script: "scripts/hook-plain" },
			]),
		);
		const v = run(commit("self-plugin/hooks/hooks.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Newly run");
		expect(v.reason).toContain("scripts/hook-plain");
	});
});

describe("a checker this commit deletes (mantahostels#2685)", () => {
	/** Put a CALLED_ELSEWHERE entry for check-existing.js into HEAD. */
	function allowlistAtHead(): void {
		fs.writeFileSync(
			path.join(repo, "scripts", "checker-registrations.test.ts"),
			'const CALLED_ELSEWHERE = { "check-existing.js": "hand-only (#1)" };\n',
		);
		git(
			repo,
			"commit",
			"-qm",
			"allowlist",
			"--",
			"scripts/checker-registrations.test.ts",
		);
	}

	it("is refused while its CALLED_ELSEWHERE entry stays behind, naming the checker", () => {
		allowlistAtHead();
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		const v = run(commit("scripts/check-existing.js"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("CALLED_ELSEWHERE entry stays behind");
		expect(v.reason).toContain("scripts/check-existing.js");
	});

	/* `git rm` takes the path out of the index, so ls-files never names it — the
	 * staged-deletion list is what keeps it in the landing set. */
	it("is refused on the git rm route too", () => {
		allowlistAtHead();
		git(repo, "rm", "-q", "--", "scripts/check-existing.js");
		expect(run(commit("scripts/check-existing.js")).denied).toBe(true);
	});

	it("is allowed when the entry goes in the same commit", () => {
		allowlistAtHead();
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		edit(
			"scripts/checker-registrations.test.ts",
			"const CALLED_ELSEWHERE = {};\n",
		);
		expect(
			run(
				commit(
					"scripts/check-existing.js scripts/checker-registrations.test.ts",
				),
			).denied,
		).toBe(false);
	});

	/* willExist reads a landing path off the DISK, so a sibling test this commit
	 * deletes is absent rather than present — the case where a checker comes back
	 * and its test does not. */
	it("demands the sibling test when a re-added checker's test goes in the same commit", () => {
		git(repo, "rm", "-q", "--", "scripts/check-existing.js");
		git(repo, "commit", "-qm", "drop it", "--", "scripts/check-existing.js");
		add("scripts/check-existing.js", "// back\n");
		fs.rmSync(path.join(repo, "scripts", "check-existing.test.ts"));
		const v = run(
			commit("scripts/check-existing.js scripts/check-existing.test.ts"),
		);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("no sibling test");
	});

	/* Rename detection reports one R entry naming the NEW path only,
	 * so the old member's disappearance is invisible without --no-renames. */
	it("is refused when a rename carries it away from its allowlist entry", () => {
		allowlistAtHead();
		git(repo, "mv", "scripts/check-existing.js", "scripts/check-renamed.js");
		const v = run('git commit -m "x"');
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("CALLED_ELSEWHERE entry stays behind");
	});

	/* On this limb, HOLDING the literal is what denies — so an
	 * unreadable registry must read as absent and allow, the opposite of
	 * willHold's fail-open.
	 *
	 * The blob is corrupted rather than chmod'd: a chmod on .git/objects does
	 * not reach the branch. */
	it("allows the deletion when the allowlist blob is corrupt", () => {
		allowlistAtHead();
		fs.writeFileSync(
			looseObject("HEAD:scripts/checker-registrations.test.ts"),
			"not a git object",
		);
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		expect(run(commit("scripts/check-existing.js")).denied).toBe(false);
	});

	it("never reads a deleted test file as a checker, whatever the allowlist says", () => {
		fs.writeFileSync(
			path.join(repo, "scripts", "check-existing.test.js"),
			"// covered\n",
		);
		fs.writeFileSync(
			path.join(repo, "scripts", "checker-registrations.test.ts"),
			'const CALLED_ELSEWHERE = { "check-existing.test.js": "hand-only (#1)" };\n',
		);
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "a test file the allowlist names");
		fs.rmSync(path.join(repo, "scripts", "check-existing.test.js"));
		expect(run(commit("scripts/check-existing.test.js")).denied).toBe(false);
	});

	it("is allowed when no allowlist entry ever named it", () => {
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		expect(run(commit("scripts/check-existing.js")).denied).toBe(false);
	});
});

describe("what a broken HEAD does (mantahostels#2702)", () => {
	/* `cat-file -e "HEAD:<path>"` cannot tell a break from an absence: it
	 * exits 128 for BOTH a path HEAD does not name and an unreadable object
	 * store, while its exit 1 means a tree entry whose blob is gone. */

	/** Commit $rel at HEAD with none of the wiring a new member would need. */
	function unwiredAtHead(rel: string, body: string): void {
		fs.writeFileSync(path.join(repo, rel), body);
		git(repo, "add", "--", rel);
		git(repo, "commit", "-qm", "unwired");
	}

	it("allows a member whose HEAD blob is gone, rather than judging it new", () => {
		unwiredAtHead("scripts/check-orphan.js", "// no caller, no sibling\n");
		// The tree still names it, so it is not new — but the object behind the
		// entry is gone.
		fs.rmSync(looseObject("HEAD:scripts/check-orphan.js"));
		edit("scripts/check-orphan.js", "// touched\n");
		expect(run(commit("scripts/check-orphan.js")).denied).toBe(false);
		// Allowed because the path READS as an existing member, not because
		// something failed open — which is what an always-broken read would give.
		// The needle-drift scan's own fail-open is filtered out: that limb reads
		// HEAD's copy of every landing corpus file and legitimately gives up on
		// this broken blob (mantahostels#2708).
		expect(
			readFaultReasons().filter((r) => !r.includes("needle-drift")),
		).toEqual([]);
	});

	it("allows a new checker whose sibling test is in HEAD with its blob gone", () => {
		unwiredAtHead("scripts/check-fresh.test.ts", "// covered\n");
		fs.rmSync(looseObject("HEAD:scripts/check-fresh.test.ts"));
		add("scripts/check-fresh.js", "// new\n");
		edit(
			"scripts/caller.sh",
			"#!/usr/bin/env bash\nnode scripts/check-fresh.js\n",
		);
		expect(run(commit("scripts/check-fresh.js scripts/caller.sh")).denied).toBe(
			false,
		);
		expect(faults).toEqual([]);
	});

	it("leaves a member unjudged when HEAD's tree cannot be read at all", () => {
		unwiredAtHead("scripts/check-orphan.js", "// no caller, no sibling\n");
		// The scripts/ subtree, not the blob: every HEAD read under it now fails,
		// which is `cat-file -e`'s exit 128 — the same code a plain absence gives.
		fs.writeFileSync(looseObject("HEAD:scripts"), "not a git object");
		edit("scripts/check-orphan.js", "// touched\n");
		expect(run(commit("scripts/check-orphan.js")).denied).toBe(false);
		expect(readFaultReasons()).toContain(
			`git could not read HEAD's tree for scripts/check-orphan.js in ${repo} — that path was left unjudged and the commit allowed unchecked`,
		);
	});

	it("treats a wiring file it cannot read at HEAD as present", () => {
		// The hooks.json read alone, so the MEMBER's own read still succeeds and
		// the break lands inside that requirement.
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add("scripts/guard-new.test.ts", "// covered\n");
		add(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-new.sh",\n',
		);
		add(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify({ guards: { "guard-new.sh": { needles: [] } } }, null, 2)}\n`,
		);
		expect(
			run(
				commit(
					"scripts/guard-new.sh scripts/guard-new.test.ts scripts/hook-registrations.test.ts scripts/guard-fire-needles.json",
				),
				repo,
				{},
				headUnknown("self-plugin/hooks/hooks.json"),
			).denied,
		).toBe(false);
		expect(readFaultReasons()).toEqual([
			`git could not read HEAD's tree for self-plugin/hooks/hooks.json in ${repo} — that wiring requirement was treated as met and the commit allowed unchecked`,
		]);
	});

	/* ls-tree's pathspec is CWD-RELATIVE where `cat-file -e HEAD:<path>` was not,
	 * so without --full-tree every HEAD path read from a subdirectory came back
	 * absent — and on this site absent means NEW, which refuses. */
	it("reads HEAD the same way from a subdirectory", () => {
		edit("scripts/check-existing.js", "// touched\n");
		expect(
			run(commit("check-existing.js"), path.join(repo, "scripts")).denied,
		).toBe(false);
	});

	it("records no fault when a registry is simply absent from HEAD", () => {
		git(repo, "rm", "-q", "--", "scripts/checker-registrations.test.ts");
		git(repo, "commit", "-qm", "drop the allowlist");
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		expect(run(commit("scripts/check-existing.js")).denied).toBe(false);
		expect(faults).toEqual([]);
	});
});

describe("judgeHookList's HEAD-side fail-opens (mantahostels#2702)", () => {
	/* All three allow, so the VERDICT alone cannot tell them apart — reversing one
	 * leaves the next to catch it. Each case therefore pins the recorded reason. */

	/** A hooks.json change that refuses on its own: a hook dropped, its needle left. */
	const dropWithNeedleLeftBehind = () => {
		edit("self-plugin/hooks/hooks.json", hooksFileFor([]));
		return commit("self-plugin/hooks/hooks.json");
	};

	it("allows, saying so, when HEAD's hooks.json cannot be shown", () => {
		// The blob is corrupted rather than removed: HEAD's tree still names the
		// path, so judgeHookList is reached and `git show` is what fails.
		fs.writeFileSync(
			looseObject("HEAD:self-plugin/hooks/hooks.json"),
			"not a git object",
		);
		const v = run(dropWithNeedleLeftBehind());
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`could not read HEAD's self-plugin/hooks/hooks.json in ${repo} — its hook-list change was allowed unchecked`,
		]);
	});

	it("allows, saying so, when HEAD's hooks.json registers no hook", () => {
		fs.writeFileSync(
			path.join(repo, "self-plugin", "hooks", "hooks.json"),
			`${JSON.stringify({ hooks: {} }, null, 2)}\n`,
		);
		git(repo, "add", "--", "self-plugin/hooks/hooks.json");
		git(repo, "commit", "-qm", "no hooks at HEAD");
		// guard-other.sh is in no needle registry, so without the fail-open this
		// addition is refused.
		edit(
			"self-plugin/hooks/hooks.json",
			hooksFileFor(["scripts/guard-existing.sh", "scripts/guard-other.sh"]),
		);
		const v = run(commit("self-plugin/hooks/hooks.json"));
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`HEAD's self-plugin/hooks/hooks.json in ${repo} registers no hook at all — its hook-list change was allowed unchecked`,
		]);
	});
});

/*
 * Every fail-open branch a broken OBJECT cannot reach. A chmod-000 object store
 * proves nothing — git answers from a cached ref or the pack index either way,
 * and where it does fail it fails for `git ls-files` too, so `landing` comes
 * back empty and judgeCommit returns before any of these branches run.
 *
 * The seam here is a WFC_GIT stub that fails ONE git call, so a branch can be
 * reached without breaking the reads around it. Each case pins the RECORDED
 * REASON as well as the verdict: an allow is what most of these branches
 * produce, so the verdict alone cannot tell one reversed fix from another. The
 * pin is a ONE-element list, so a second fail-open firing alongside fails too.
 */
describe("fail-opens no broken object reaches (mantahostels#2686)", () => {
	/**
	 * A `git` at WFC_GIT that exits 128 when its arguments carry `subcommand` — and
	 * `want` too, where one is given — and execs the real git otherwise.
	 *
	 * Both go into a bash double-quoted string, so both must be shell-inert
	 * literals; and the match is over the whole argument list rather than
	 * positional, so a subcommand name arriving as a VALUE would match too.
	 */
	function gitShim(subcommand: string, want = ""): Record<string, string> {
		const bin = fs.mkdtempSync(path.join(dir, "shim-"));
		const real = execFileSync("bash", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		fs.writeFileSync(
			path.join(bin, "git"),
			`#!/usr/bin/env bash
sub_seen=0
arg_seen=${want ? 0 : 1}
for a in "$@"; do
  [[ "$a" == ${JSON.stringify(subcommand)} ]] && sub_seen=1
  [[ "$a" == ${JSON.stringify(want)} ]] && arg_seen=1
done
((sub_seen && arg_seen)) && exit 128
exec ${JSON.stringify(real)} "$@"
`,
			{ mode: 0o755 },
		);
		return { WFC_GIT: path.join(bin, "git") };
	}

	/* willHold's working-tree limb: the copy this commit takes is on disk but
	 * unreadable, so the read answers "absent" — which on this limb DENIES. */
	it("treats a landing wiring file it cannot read as holding the wiring", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		const at = path.join(repo, "scripts", "checker-registrations.test.ts");
		fs.chmodSync(at, 0o000);
		try {
			const v = run(
				commit(
					"scripts/check-new.js scripts/check-new.test.ts scripts/checker-registrations.test.ts",
				),
			);
			expect(v.denied).toBe(false);
			expect(readFaultReasons()).toEqual([
				`could not read the copy of scripts/checker-registrations.test.ts this commit lands in ${repo} — that wiring requirement was treated as met and the commit allowed unchecked`,
			]);
		} finally {
			fs.chmodSync(at, 0o644);
		}
	});

	/* willHold's HEAD limb: HEAD's tree still names the file, so ls-tree
	 * succeeds and `git show` is what fails. No shim — a corrupt blob reaches
	 * this one on its own. */
	it("treats a wiring file HEAD names but cannot show as holding the wiring", () => {
		add("scripts/guard-new.sh", "#!/usr/bin/env bash\n");
		add("scripts/guard-new.test.ts", "// covered\n");
		add(
			"scripts/hook-registrations.test.ts",
			'const REGISTERED_ELSEWHERE = {};\nid: "scripts/guard-new.sh",\n',
		);
		add(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify({ guards: { "guard-new.sh": { needles: [] } } }, null, 2)}\n`,
		);
		fs.writeFileSync(
			looseObject("HEAD:self-plugin/hooks/hooks.json"),
			"not a git object",
		);
		const v = run(
			commit(
				"scripts/guard-new.sh scripts/guard-new.test.ts scripts/hook-registrations.test.ts scripts/guard-fire-needles.json",
			),
		);
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`git could not show HEAD:self-plugin/hooks/hooks.json in ${repo} — that wiring requirement was treated as met and the commit allowed unchecked`,
		]);
	});

	/* willExist: the sibling test is neither landing nor readable at HEAD, and
	 * absence here is what denies. The shim breaks the sibling's own ls-tree
	 * alone, so the member's read still answers "new" and the case is judged. */
	it("treats a sibling test it cannot look up at HEAD as present", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/wire.sh", "#!/usr/bin/env bash\nnode scripts/check-new.js\n");
		const v = run(
			commit("scripts/check-new.js scripts/wire.sh"),
			repo,
			{},
			headUnknown("scripts/check-new.test.ts"),
		);
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`git could not read HEAD's tree for scripts/check-new.test.ts in ${repo} — that sibling test was treated as present and the commit allowed unchecked`,
		]);
	});

	/* willSurelyHold: the mirror direction — HOLDING the allowlist entry is
	 * what denies a deletion, so an unreadable registry must read as absent. */
	it("reads an allowlist it cannot look up at HEAD as no longer naming the member", () => {
		fs.writeFileSync(
			path.join(repo, "scripts", "checker-registrations.test.ts"),
			'const CALLED_ELSEWHERE = { "check-existing.js": "hand-only (#1)" };\n',
		);
		git(
			repo,
			"commit",
			"-qm",
			"allowlist",
			"--",
			"scripts/checker-registrations.test.ts",
		);
		fs.rmSync(path.join(repo, "scripts", "check-existing.js"));
		const v = run(
			commit("scripts/check-existing.js"),
			repo,
			{},
			headUnknown("scripts/checker-registrations.test.ts"),
		);
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`git could not read HEAD's tree for scripts/checker-registrations.test.ts in ${repo} — that registry was read as no longer naming the member, and the commit allowed unchecked`,
		]);
	});

	/* The landing computation itself. A pathspec word git cannot expand leaves
	 * `landing` empty, so nothing is judged at all — the new checker in this case
	 * is refused without the shim. */
	it("leaves a pathspec word unjudged when git cannot list what it names", () => {
		add("scripts/check-new.js", "// new\n");
		const v = run(commit("scripts/check-new.js"), repo, gitShim("ls-files"));
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`git could not list tracked files under ${repo}/scripts/check-new.js in ${repo} — that pathspec word was left unjudged for mantahostels#2671`,
		]);
	});

	/* The staged-deletion read is a SECOND source of landing paths, so its
	 * failure narrows the commit rather than emptying it: what ls-files did name
	 * is still judged, and the new checker is still refused — refused with the
	 * fail-open removed too, that limb changing no control flow, so the reason is
	 * the whole case. */
	it("records the staged deletions it could not read, and judges the rest", () => {
		add("scripts/check-new.js", "// new\n");
		const v = run(
			commit("scripts/check-new.js"),
			repo,
			gitShim("diff", "--diff-filter=D"),
		);
		expect(v.denied).toBe(true);
		expect(readFaultReasons()).toEqual([
			`git could not read the staged deletions under ${repo}/scripts/check-new.js in ${repo} — a member this commit removes may have gone unjudged`,
		]);
	});

	/* The index route has one source of landing paths and no second, so the same
	 * break allows the whole commit — which it would with the fail-open removed
	 * too, an empty `landing` returning early, so the reason is the whole case. */
	it("allows a bare commit whose staged path list cannot be read", () => {
		fs.writeFileSync(path.join(repo, "scripts", "check-new.js"), "// new\n");
		git(repo, "add", "--", "scripts/check-new.js");
		const v = run('git commit -m "x"', repo, gitShim("diff"));
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`git could not read the staged path list in ${repo} — that commit was allowed unchecked`,
		]);
	});

	/* Without a top level every path this guard reads is unresolvable, so the
	 * commit is allowed before any of the limbs above run. */
	it("allows a commit whose repository top level cannot be resolved", () => {
		add("scripts/check-new.js", "// new\n");
		const v = run(
			commit("scripts/check-new.js"),
			repo,
			gitShim("rev-parse", "--show-toplevel"),
		);
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`could not resolve the top level of ${repo} — that commit was allowed unchecked`,
		]);
	});

	/* indexNames' unknown answer on the wiring limb: a git break is not an absence, so
	 * the requirement reads as met and the commit is allowed. */
	it("treats a wiring file it cannot look up in the index as holding the wiring", () => {
		add("scripts/check-new.js", "// new\n");
		add("scripts/check-new.test.ts", "// covered\n");
		edit(
			"scripts/checker-registrations.test.ts",
			'const CALLED_ELSEWHERE = { "check-new.js": "hand-only (#1)" };\n',
		);
		git(
			repo,
			"add",
			"--",
			"scripts/check-new.js",
			"scripts/check-new.test.ts",
			"scripts/checker-registrations.test.ts",
		);
		const v = run('git commit -m "x"', repo, gitShim("ls-files", "--cached"));
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toContain(
			`could not read the copy of scripts/checker-registrations.test.ts this commit lands in ${repo} — that wiring requirement was treated as met and the commit allowed unchecked`,
		);
	});

	/* judgeHookList's HEAD-side extractor failure. Its working-tree twin is
	 * pinned by "allows a hooks.json it cannot parse" above, and mantahostels#2702 covers
	 * `git show` failing rather than the JSON being unparseable. */
	it("allows a hook-list change whose HEAD hooks.json cannot be parsed", () => {
		fs.writeFileSync(
			path.join(repo, "self-plugin", "hooks", "hooks.json"),
			"{ not json\n",
		);
		git(repo, "add", "--", "self-plugin/hooks/hooks.json");
		git(repo, "commit", "-qm", "unparseable settings at HEAD");
		// A hook dropped with its needle left behind: refused on its own.
		edit("self-plugin/hooks/hooks.json", hooksFileFor([]));
		const v = run(commit("self-plugin/hooks/hooks.json"));
		expect(v.denied).toBe(false);
		expect(readFaultReasons()).toEqual([
			`could not read the hook registrations out of HEAD's self-plugin/hooks/hooks.json in ${repo} — its hook-list change was allowed unchecked`,
		]);
	});
});

describe("a needle keyed on wording that moved (mantahostels#2708)", () => {
	/** Key the fixture's registry on one literal of guard-existing.sh's. */
	const keyOn = (text: string) =>
		edit(
			"scripts/guard-fire-needles.json",
			`${JSON.stringify({ guards: { "guard-existing.sh": { needles: [{ id: "n1", kind: "deny", text }] } } }, null, 2)}\n`,
		);

	/** Commit that keying, so HEAD carries it and the guard prints it. */
	const atHead = (text: string) => {
		keyOn(text);
		edit("scripts/guard-existing.sh", `#!/usr/bin/env bash\ndeny '${text}'\n`);
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "needle and its printer");
	};

	it("denies a commit that rewords the guard and leaves the needle behind, naming the needle and quoting the old wording", () => {
		atHead("the OLD wording");
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		const v = run(commit("scripts/guard-existing.sh"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(
			"keys a needle on, and the needle does not move",
		);
		expect(v.reason).toContain("guard-existing.sh / n1");
		expect(v.reason).toContain("the OLD wording");
	});

	it("denies it even where the needle is corrected on disk but left out of the pathspec", () => {
		// Reading the registry from the working tree acquits this.
		atHead("the OLD wording");
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		keyOn("the NEW wording");
		expect(run(commit("scripts/guard-existing.sh")).denied).toBe(true);
	});

	it("allows the reword where the needle moves in the same commit", () => {
		atHead("the OLD wording");
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		keyOn("the NEW wording");
		expect(
			run(commit("scripts/guard-existing.sh scripts/guard-fire-needles.json"))
				.denied,
		).toBe(false);
	});

	/** p.diff cut from the working tree's edits to `rels`, the tree then put back to HEAD. */
	const patchOf = (...rels: string[]) => {
		fs.writeFileSync(
			path.join(repo, "p.diff"),
			git(repo, "diff", "HEAD", "-U0", "--", ...rels),
		);
		git(repo, "checkout", "-q", "HEAD", "--", ...rels);
	};

	it("denies a --patch reword that leaves the needle behind, judged on the patch and not the disk copy (#2897)", () => {
		atHead("the OLD wording");
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		patchOf("scripts/guard-existing.sh");
		const v = run("node scripts/commit-paths.js -m x --patch p.diff");
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("guard-existing.sh / n1");
	});

	it("allows a --patch reword whose needle moves in the same patch (#2897)", () => {
		atHead("the OLD wording");
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		keyOn("the NEW wording");
		patchOf("scripts/guard-existing.sh", "scripts/guard-fire-needles.json");
		expect(run("node scripts/commit-paths.js -m x --patch p.diff").denied).toBe(
			false,
		);
		expect(faults).toEqual([]);
	});

	it("allows, saying so, when the staged copy of a printer cannot be read (#2897)", () => {
		atHead("the OLD wording");
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		git(repo, "add", "--", "scripts/guard-existing.sh");
		fs.writeFileSync(
			looseObject(":scripts/guard-existing.sh"),
			"not a git object",
		);
		expect(run('git commit -m "x"').denied).toBe(false);
		expect(faults.join(" ")).toContain(
			"could not read the copy of scripts/guard-existing.sh this commit lands",
		);
	});

	it("denies a needle ARRIVING keyed on wording nothing prints, and says which limb", () => {
		keyOn("wording no file in this tree carries");
		const v = run(commit("scripts/guard-fire-needles.json"));
		expect(v.denied).toBe(true);
		expect(v.reason).toContain("Keyed by a needle this commit ADDS");
		expect(v.reason).not.toContain("put the old wording back");
	});

	it("allows a commit that lands nothing the corpus reads", () => {
		atHead("the OLD wording");
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		// The rewording is on disk but unlanded, and README.md is outside every
		// corpus directory, so the scan never runs.
		add("README.md", "unrelated\n");
		expect(run(commit("README.md")).denied).toBe(false);
		expect(readFaultReasons()).toEqual([]);
	});

	it("allows, saying so, when HEAD's needle registry cannot be read", () => {
		atHead("the OLD wording");
		fs.writeFileSync(
			looseObject("HEAD:scripts/guard-fire-needles.json"),
			"not a git object",
		);
		edit(
			"scripts/guard-existing.sh",
			"#!/usr/bin/env bash\ndeny 'the NEW wording'\n",
		);
		const v = run(commit("scripts/guard-existing.sh"));
		expect(v.denied).toBe(false);
		expect(readFaultReasons().join(" ")).toContain(
			"the needle-drift scan failed",
		);
	});
});

describe("a target reached through a variable (#313, #327)", () => {
	const unset =
		"`$UNSET_327` is unset in this call; shell variables do not carry over between Bash calls.";

	it("judges an unset variable's `cd` as the cwd, and says why", () => {
		add("scripts/check-new.js", "// new\n");
		const v = run(`cd "$UNSET_327" && ${commit("scripts/check-new.js")}`);
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(unset);
		expect(v.reason).toContain("scripts/check-new.js is a new checker");
	});

	it("judges an unset variable's `git -C` the same way", () => {
		add("scripts/check-new.js", "// new\n");
		const v = run('git -C "$UNSET_327" commit -m "x" -- scripts/check-new.js');
		expect(v.denied).toBe(true);
		expect(v.reason).toContain(unset);
	});

	it("leaves the line out where the tree resolved on its own", () => {
		add("scripts/check-new.js", "// new\n");
		const v = run(commit("scripts/check-new.js"));
		expect(v.denied).toBe(true);
		expect(v.reason).not.toContain("is unset in this call");
	});

	it("allows a `$(…)` target, and records that it did", () => {
		add("scripts/check-new.js", "// new\n");
		expect(run(`cd "$(pwd)" && ${commit("scripts/check-new.js")}`).denied).toBe(
			false,
		);
		expect(readFaultReasons()).toEqual([
			expect.stringMatching(
				/could not resolve the working tree for a git commit/,
			),
		]);
	});

	it("allows a default-value target, and records that it did", () => {
		add("scripts/check-new.js", "// new\n");
		expect(
			run(`cd "\${UNSET_327:-.}" && ${commit("scripts/check-new.js")}`).denied,
		).toBe(false);
		expect(readFaultReasons()).toEqual([
			expect.stringMatching(
				/could not resolve the working tree for a git commit/,
			),
		]);
	});
});
