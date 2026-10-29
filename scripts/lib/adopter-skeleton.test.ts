// @vitest-environment node
/*
 * adopter-skeleton.js renders each day-one file — config, rules file,
 * CLAUDE.md, husky hooks, settings keys, label plan — with only the lines the
 * adopter's config and modules call for (#5).
 *
 * The renderers are asserted at their own boundary: what a given config puts
 * in the file an adopter reads.
 *
 * init-adopter.js and every plugin bump write these renders into an adopter's
 * repo: loosen a case here and an adopter ships a hook, rule or setting that
 * is wrong for it, in every session it runs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	ciStatusCommand,
	describePluginRecord,
	HOOKS,
	hookRootOf,
	isHookShim,
	labelPlan,
	renderClaudeMd,
	renderCodeStandards,
	renderConfig,
	renderDocMap,
	renderHookShim,
	renderPluginRecord,
	renderReference,
	renderRoadmap,
	renderSessionRules,
	settingsKeys,
	TOOLS,
	withIgnoreBlock,
} from "./adopter-skeleton.js";
import { readPluginStyles } from "./output-styles.js";
import { CORE_ROOT, cutLocalGateBlock } from "./precommit-gate-testkit";
import { runInProcess } from "./run-in-process";
import { TAKES_PREFIX, TAKES_VALUES, takesLabel } from "./takes-label";
import { MODULES, type Module } from "./workflow-core-config.js";

const CORE = path.resolve(__dirname, "..", "..");
const NO_COMMANDS = {
	test: null,
	lint: null,
	typecheck: null,
	check_staged: null,
};

describe("the plugin provenance record (#108)", () => {
	it("describes a directory source by its HEAD sha and dirty flag", () => {
		expect(
			describePluginRecord({
				source: "directory",
				headSha: "abc1234",
				dirty: false,
			}),
		).toBe("directory source, HEAD abc1234");
		expect(
			describePluginRecord({
				source: "directory",
				headSha: "abc1234",
				dirty: true,
			}),
		).toBe("directory source, HEAD abc1234 (dirty)");
	});

	it("describes a directory source with no readable git at the plugin root", () => {
		expect(
			describePluginRecord({ source: "directory", headSha: null, dirty: null }),
		).toBe("directory source, no readable git at the plugin root");
	});

	it("renders a known sha with an unknown dirty flag as clean, not as an error", () => {
		/* readDirectoryGit() keeps a good `rev-parse HEAD` even where the follow-up
		 * `git status` fails, leaving `dirty: null`. */
		expect(
			describePluginRecord({
				source: "directory",
				headSha: "abc1234",
				dirty: null,
			}),
		).toBe("directory source, HEAD abc1234");
	});

	it("describes a url source by its ref alone where the sha isn't resolved yet", () => {
		expect(
			describePluginRecord({ source: "url", ref: "v1.1.0", resolvedSha: null }),
		).toBe("url source, ref v1.1.0 (sha unknown)");
	});

	it("describes a url source by its ref and the resolved sha, once known", () => {
		expect(
			describePluginRecord({
				source: "url",
				ref: "v1.1.0",
				resolvedSha: "abc1234",
			}),
		).toBe("url source, ref v1.1.0, HEAD abc1234");
	});

	it("renders the source description and the hooks caveat as one block", () => {
		const block = renderPluginRecord({
			source: "directory",
			headSha: "abc1234",
			dirty: false,
		});
		expect(block).toContain("## Plugin provenance");
		expect(block).toContain("directory source, HEAD abc1234");
		expect(block).toContain("WFC_PLUGIN_ROOT");
	});
});

describe("the core-owned rules file", () => {
	it("carries no line for a module that is off", () => {
		const text = renderSessionRules({
			modules: [],
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: null,
		});
		expect(text).not.toContain("[governance]");
		expect(text).not.toContain("[suites]");
		expect(text).not.toContain("reference-roadmap.html");
		expect(text).not.toContain("docs/doc-map.md");
		expect(text).not.toContain("Prefer targeted runs");
	});

	it("carries a module's lines, untagged, when it is on", () => {
		const text = renderSessionRules({
			modules: ["roadmap", "suites"],
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: null,
		});
		expect(text).toContain("reference-roadmap.html");
		// The suite guard hands it over instead (#2237).
		expect(text).not.toContain("Prefer targeted runs");
		expect(text).not.toContain("[roadmap]");
		expect(text).not.toContain("[suites]");
		expect(text).not.toContain("docs/doc-map.md");
	});

	it("leaves the manual-sync rule to the claim guard, every module on (#2233)", () => {
		const text = renderSessionRules({
			modules: ["roadmap", "governance", "suites", "site"],
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: null,
		});
		expect(text).toContain("docs/doc-map.md");
		expect(text).not.toContain("operating-manual.md");
	});

	it.each([
		[[], "check:ci` once", "landing-status.js"],
		[["landing"], "landing-status.js` once", "check:ci"],
	] as [Module[], string, string][])(
		"gives the push line for the landing module's state, modules %j (#2409)",
		(modules, kept, dropped) => {
			const text = renderSessionRules({
				modules,
				founder: "A Founder",
				pluginRoot: CORE,
				ciCheck: "npm run check:ci",
			});
			expect(text).toContain(kept);
			expect(text).not.toContain(dropped);
			expect(text).not.toContain("landing]");
		},
	);

	it("substitutes the founder and drops the template's own instructions", () => {
		const text = renderSessionRules({
			modules: [],
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: null,
		});
		expect(text).toContain("nothing further waits on A Founder");
		expect(text).not.toContain("{{founder}}");
		expect(text).not.toContain("TEMPLATE for");
		expect(text.startsWith("<!-- CORE-OWNED.")).toBe(true);
	});

	it("names only rule ids the core's store can answer for", () => {
		const text = renderSessionRules({
			modules: ["roadmap", "governance", "suites", "site"],
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: null,
		});
		const store = fs.readdirSync(path.join(CORE, "docs/agents/rules"));
		const cited = [...text.matchAll(/`rule:([a-z0-9-]+)`/g)].map((m) => m[1]);
		/* 2 after #2067's cut; the floor only proves the scan finds ids at all. */
		expect(cited.length).toBeGreaterThan(0);
		expect(cited.filter((id) => !store.includes(`${id}.txt`))).toEqual([]);
	});

	/* The commands #654 and #662 name, pinned exactly: a command added to the
	 * template should fail here until it is checked as runnable below. */
	it("spells every core command at the plugin root, and names only scripts the plugin ships (#654)", () => {
		const text = renderSessionRules({
			modules: ["roadmap", "governance", "suites", "site"],
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: "node scripts/check-ci-status.js",
		});
		expect(text).not.toMatch(/\b(?:node|bash|sh|python3) scripts\//);
		expect(text).not.toMatch(/`scripts\/[^`\s]+ [^`]*`/);
		const named = [
			...text.matchAll(new RegExp(`${CORE}/(scripts/[\\w./-]+)`, "g")),
		].map((m) => m[1]);
		expect(new Set(named)).toEqual(
			new Set([
				"scripts/lib/rule-text.sh",
				"scripts/bg-run.sh",
				"scripts/capture-drain.js",
				"scripts/record-delegated-decision.js",
				"scripts/check-ci-status.js",
			]),
		);
		for (const rel of named)
			expect(fs.existsSync(path.join(CORE, rel)), rel).toBe(true);
	});

	/* A module line, or the reference's page-check line, reads as a promise
	 * that a gate runs. Only a backticked script name is seen here, so a check
	 * named in prose — #744's render check — is pinned in the reference group
	 * instead. */
	const render = (modules: Module[]) =>
		renderSessionRules({
			modules,
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: null,
		}).split("\n");

	it("names in each module line only scripts a core hook runs (#744)", () => {
		const base = new Set(render([]));
		const moduleLines = render([...MODULES]).filter((line) => !base.has(line));
		/* The site line's gate moved to the reference at #2067. */
		const promises = [...moduleLines, ...renderReference(CORE).split("\n")];
		/* Listed rather than taken from HOOKS, so a change to any hook selects
		 * this file (base §X10). */
		const huskyHooks = fs
			.readdirSync(path.join(CORE, ".husky"))
			.filter((h) => HOOKS.includes(h));
		expect(huskyHooks.length).toBe(HOOKS.length);
		const hooks = [
			...huskyHooks.map((h) =>
				fs
					.readFileSync(path.join(CORE, ".husky", h), "utf8")
					.split("\n")
					.filter((line) => !/^\s*#/.test(line))
					.join("\n"),
			),
			fs.readFileSync(path.join(CORE, "hooks/hooks.json"), "utf8"),
		].join("\n");
		const named = promises.flatMap((line) =>
			[...line.matchAll(/`([\w.-]+\.(?:js|sh))`/g)].map((m) => m[1]),
		);
		expect(named).toContain("check-website-copy.js");
		for (const script of named) {
			expect(fs.existsSync(path.join(CORE, "scripts", script)), script).toBe(
				true,
			);
			expect(hooks, script).toContain(`scripts/${script}`);
		}
	});

	it("carries no rule that left for a guard or a reference (#2035)", () => {
		const text = render([...MODULES]).join("\n");
		for (const gone of [
			"rule:issue-claim-scope",
			"rule:issue-takes-label",
			"rule:branch-shared-tree",
			"rule:commit-pathspec",
			"rule:pull-fast-forward",
			"rule:file-claim",
			"rule:shared-tree-discard",
			"rule:wait-length",
			"rule:push-cadence",
			"rule:sweep-fire-budget",
			"rule:stale-write-back",
			"rule:guard-registry-gate",
			"rule:shellcheck-not-installed",
			"guard-uncommitted-work.js",
			"check-gate-switches.js",
			"guard-last30days.sh",
			"Artefact: <path>",
			"rename the session",
			"Anyone may apply `urgent`",
			"status-report.js",
			"## Switching a module on",
			"printing `rule:house-decision`",
			"Refused a skill",
			"rule:roadmap-validity",
			"rule:card-close-by-hand",
			"a FOURTH is DENIED",
			"rule:suite-tree-dirty",
			"rule:ci-status-lag",
			"check-website-copy.js",
		])
			expect(text, gone).not.toContain(gone);
		expect(text).toContain("`.claude/workflow-core.reference.md`");
		/* Named literally so a change to the template selects this test. */
		expect(
			fs.readFileSync(
				path.join(CORE, "scripts/templates/adopter/session-rules.md"),
				"utf8",
			),
		).toContain("<!-- TEMPLATE for .claude/workflow-core.md");
	});
});

describe("the push rule's CI check (#739)", () => {
	const made: string[] = [];
	afterAll(() => {
		for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	});

	/** An adopter tree carrying `files`, path → content. */
	const adopter = (files: Record<string, string>) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-ci-"));
		made.push(dir);
		for (const [rel, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
			fs.writeFileSync(path.join(dir, rel), body);
		}
		return dir;
	};
	const pushRule = (root: string) =>
		renderSessionRules({
			modules: [],
			founder: "A Founder",
			pluginRoot: CORE,
			ciCheck: ciStatusCommand(root),
		})
			.split("\n")
			.find((line) => line.startsWith("- **A push is your own act"));
	const workflow = { ".github/workflows/ci.yml": "on: push\n" };

	it("names no CI command where the adopter has no package.json and no workflow", () => {
		const root = adopter({ "README.md": "x\n" });
		expect(ciStatusCommand(root)).toBeNull();
		const line = pushRule(root);
		expect(line).toContain("never asked of A Founder.**");
		expect(line).not.toMatch(/check:ci|check-ci-status|ci_check|\{\{/);
	});

	it("reads a workflows directory holding no workflow as none", () => {
		const root = adopter({
			".github/workflows/README.md": "x\n",
			"package.json": JSON.stringify({ scripts: { "check:ci": "x" } }),
		});
		expect(ciStatusCommand(root)).toBeNull();
		expect(pushRule(root)).not.toContain("check:ci");
	});

	it("names the adopter's own npm script where it declares one", () => {
		const root = adopter({
			...workflow,
			"package.json": JSON.stringify({ scripts: { "check:ci": "x" } }),
		});
		expect(pushRule(root)).toContain(
			"never asked of A Founder; after it, run `npm run check:ci` once",
		);
	});

	it("throws on a package.json it cannot parse, rather than guessing the command", () => {
		const root = adopter({ ...workflow, "package.json": "{ not json" });
		expect(() => ciStatusCommand(root)).toThrow(SyntaxError);
	});

	it("names the plugin's own checker, which it ships, where the adopter has a workflow and no script", () => {
		for (const files of [
			workflow,
			{ ...workflow, "package.json": JSON.stringify({ scripts: {} }) },
		]) {
			const line = pushRule(adopter(files));
			const command = `node ${CORE}/scripts/check-ci-status.js`;
			expect(line).toContain(`; after it, run \`${command}\` once`);
			expect(line).not.toContain("npm run");
		}
		expect(fs.existsSync(path.join(CORE, "scripts/check-ci-status.js"))).toBe(
			true,
		);
	});
});

describe("the reference file (#730)", () => {
	it("promises no page check beyond the copy gate under site (#744)", () => {
		const line = renderReference(CORE)
			.split("\n")
			.find((l) => l.includes("check-website-copy.js"));
		expect(line).toBeDefined();
		expect(line).toContain(".husky/pre-commit.local");
		expect(line).not.toMatch(/render/i);
	});

	it("names every module the config accepts", () => {
		const text = renderReference(CORE);
		/* Named literally so a change to the template selects this test. */
		expect(
			fs.readFileSync(
				path.join(CORE, "scripts/templates/adopter/reference.md"),
				"utf8",
			),
		).toContain("## Switching a module on");
		const listed = text.match(/^The modules are (.+)\. To switch one on/m)?.[1];
		expect(new Set(listed?.match(/(?<=`)[a-z]+(?=`)/g))).toEqual(
			new Set(MODULES),
		);
		expect(text.startsWith("<!-- CORE-OWNED.")).toBe(true);
		expect(text).toContain(`node ${CORE}/scripts/init-adopter.js`);
		expect(text).toContain(`node ${CORE}/scripts/status-report.js`);
	});
});

describe("a rules-file command rewritten for an adopter (#654)", () => {
	/** The rules file with `founder` substituted in, at `pluginRoot`. */
	const rules = (founder: string, pluginRoot = "/opt/wfc") =>
		renderSessionRules({ modules: [], founder, pluginRoot, ciCheck: null });

	it("rewrites a runner invocation and a backticked command, leaving a file named in prose", () => {
		const text = rules(
			"`node scripts/a.js list`, `bash scripts/b.sh`, `scripts/lib/c.sh <id>`; `scripts/d.js` gates it",
		);
		expect(text).toContain(
			"never asked of `node /opt/wfc/scripts/a.js list`, `bash /opt/wfc/scripts/b.sh`, `/opt/wfc/scripts/lib/c.sh <id>`; `scripts/d.js` gates it",
		);
	});

	it("quotes a root the shell would split, and writes a `$` literally", () => {
		expect(rules("`node scripts/a.js x`", "/opt/my plugin/a$&b")).toContain(
			'`node "/opt/my plugin/a\\$&b"/scripts/a.js x`',
		);
	});

	it("runs each command from a directory that carries no core scripts, reaching the plugin's copy (#654, #662)", () => {
		const adopter = fs.mkdtempSync(path.join(os.tmpdir(), "rules-cmd-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: adopter });
			const text =
				renderSessionRules({
					modules: ["governance"],
					founder: "A Founder",
					pluginRoot: CORE,
					ciCheck: null,
				}) + renderReference(CORE);
			const command = (script: string) => {
				const found = text.match(
					new RegExp(`\`((?:node )?${CORE}/scripts/${script})[^\`]*\``),
				)?.[1];
				expect(found, script).toBeDefined();
				return found as string;
			};
			const run = (line: string) =>
				spawnSync("bash", ["-c", line], {
					cwd: adopter,
					encoding: "utf8",
					env: { ...process.env, CLAUDE_PROJECT_DIR: adopter },
				});
			expect(
				run(`${command("lib/rule-text\\.sh")} file-claim`).stdout,
			).toContain("A FILE A LIVE SESSION HAS WRITTEN IS TAKEN");
			expect(run(`${command("bg-run\\.sh")} check nosuch`).stderr).toMatch(
				/no run named nosuch/,
			);
			// No package.json here, so no `npm run status` either (#1825).
			const status = run(`${command("status-report\\.js")} --only git-locks`);
			expect(status.status, status.stderr).toBe(0);
			expect(status.stdout).toContain("1 checker(s) run, 1 clean.");
		} finally {
			fs.rmSync(adopter, { recursive: true, force: true });
		}
	});
});

describe("the day-one code standards (#3466)", () => {
	const Template = path.join(
		CORE,
		"scripts/templates/adopter/code-standards.md",
	);
	const Row =
		"| Retry a call | `withRetry()` | `scripts/lib/no-such-file.js` | §G1 | none |";

	/** check-primitives.js over a fresh adopter holding `text`. */
	const checkTable = (text: string) => {
		const adopter = fs.mkdtempSync(path.join(os.tmpdir(), "day-one-std-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: adopter });
			fs.mkdirSync(path.join(adopter, "docs"));
			fs.writeFileSync(path.join(adopter, "docs/code-standards.md"), text);
			const r = runInProcess(
				path.join(CORE, "scripts/check-primitives.js"),
				["--root", adopter, "--paths-only", "--json"],
				{
					cwd: adopter,
					env: {
						...process.env,
						CLAUDE_PROJECT_DIR: adopter,
						GITHUB_ACTIONS: "",
					},
				},
			);
			return { status: r.status, envelope: JSON.parse(r.stdout) };
		} finally {
			fs.rmSync(adopter, { recursive: true, force: true });
		}
	};

	it("fills every placeholder its template carries", () => {
		expect(fs.readFileSync(Template, "utf8").match(/\{\{\w+\}\}/g)).toEqual([
			"{{project}}",
		]);
		expect(renderCodeStandards({ project: "demo" })).not.toMatch(/\{\{/);
	});

	it("passes the table checker, which reads its empty table as the local one", () => {
		const seeded = renderCodeStandards({ project: "demo" });
		expect(checkTable(seeded)).toMatchObject({
			status: 0,
			envelope: { outcome: "OK", findings: [] },
		});
		// A row under the seeded header is judged, so the table is the one read.
		const { status, envelope } = checkTable(`${seeded}${Row}\n`);
		expect(status).toBe(1);
		expect(envelope.findings.length).toBeGreaterThan(0);
		for (const f of envelope.findings)
			expect(f.message).toContain(
				'docs/code-standards.md:11 (row "Retry a call")',
			);
	});
});

describe("the day-one doc-map (#662)", () => {
	/* init writes it once and upgrade never re-renders it, so a core script
	 * path here — relative or at a versioned plugin root — would not run. */
	it("names no core script, pointing at the gate's refusal for the commands (#2066)", () => {
		const text = renderDocMap({ project: "demo", date: "2026-01-01" });
		expect(text).not.toMatch(/scripts\//);
		expect(text).toContain(
			"doc-map gate refusal that needs one prints its command",
		);
		expect(text).not.toContain("`.claude/workflow-core.md`");
	});

	it("renders under the plugin's generator from an adopter tree", () => {
		const adopter = fs.mkdtempSync(path.join(os.tmpdir(), "day-one-map-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: adopter });
			fs.mkdirSync(path.join(adopter, "docs"));
			fs.writeFileSync(
				path.join(adopter, "docs/doc-map.md"),
				renderDocMap({ project: "demo", date: "2026-01-01" }),
			);
			fs.writeFileSync(
				path.join(adopter, "docs/doc-map-classes.json"),
				JSON.stringify({
					"docs/doc-map.md": {
						section: "Repo-root contracts",
						class: "source-of-truth",
					},
				}),
			);
			const generate = runInProcess(
				path.join(CORE, "scripts/generate-doc-map-section-a.js"),
				[],
				{
					cwd: adopter,
					env: { ...process.env, CLAUDE_PROJECT_DIR: adopter },
				},
			);
			expect(generate.status, generate.stderr).toBe(0);
			expect(
				fs.readFileSync(path.join(adopter, "docs/doc-map.md"), "utf8"),
			).toMatch(/^\| `docs\/doc-map\.md` \|/m);
		} finally {
			fs.rmSync(adopter, { recursive: true, force: true });
		}
	});
});

describe("the config", () => {
	it("declares the founder and nothing derivable", () => {
		const config = JSON.parse(
			renderConfig({
				founder: "A Founder",
				modules: ["roadmap"],
				categories: { tech: "Tech" },
				commands: { ...NO_COMMANDS, test: "npm test" },
			}),
		);
		expect(config).toMatchObject({
			contract: 1,
			founder: "A Founder",
			modules: ["roadmap"],
			categories: { tech: "Tech" },
			commands: { test: "npm test" },
		});
		expect(config.tracker).toBeUndefined();
		expect(config.login).toBeUndefined();
		expect(config.corpus).toBeUndefined();
		expect(config.roadmapMajorPin).toBeUndefined();
	});

	it("seeds roadmapMajorPin from the day-one roadmap's own version under roadmap (#54)", () => {
		const config = JSON.parse(
			renderConfig({
				founder: "A Founder",
				modules: ["roadmap"],
				categories: {},
				commands: NO_COMMANDS,
				roadmapVersion: "3.0",
			}),
		);
		expect(config.roadmapMajorPin).toBe(3);
	});

	it("omits roadmapMajorPin where the roadmap module is off (#54)", () => {
		const config = JSON.parse(
			renderConfig({
				founder: "A Founder",
				modules: [],
				categories: {},
				commands: NO_COMMANDS,
				roadmapVersion: "3.0",
			}),
		);
		expect("roadmapMajorPin" in config).toBe(false);
	});

	it("writes walkedTo at the version passed, for a directory-sourced bootstrap (#252)", () => {
		const config = JSON.parse(
			renderConfig({
				founder: "A Founder",
				modules: [],
				categories: {},
				commands: NO_COMMANDS,
				walkedTo: "v1.1.11",
			}),
		);
		expect(config.walkedTo).toBe("v1.1.11");
	});

	it("omits walkedTo where none is passed, as a url-sourced bootstrap gives none (#252)", () => {
		const config = JSON.parse(
			renderConfig({
				founder: "A Founder",
				modules: [],
				categories: {},
				commands: NO_COMMANDS,
			}),
		);
		expect("walkedTo" in config).toBe(false);
	});

	it("omits commands and categories nobody declared", () => {
		const config = JSON.parse(
			renderConfig({
				founder: "A Founder",
				modules: [],
				categories: {},
				commands: NO_COMMANDS,
			}),
		);
		expect("commands" in config).toBe(false);
		expect("categories" in config).toBe(false);
		expect(config.alwaysLoaded).toContain(".claude/workflow-core.md");
		expect(config.alwaysLoaded).not.toContain(
			".claude/workflow-core.reference.md",
		);
	});

	it("writes the admission gate off, for the adopter to switch on (#2035)", () => {
		const config = JSON.parse(
			renderConfig({
				founder: "A Founder",
				modules: [],
				categories: {},
				commands: NO_COMMANDS,
			}),
		);
		expect(config.admissionGate).toBe(false);
	});
});

describe("CLAUDE.md", () => {
	it("says the checks skip where no command is declared", () => {
		const text = renderClaudeMd({
			founder: "A Founder",
			project: "demo",
			commands: NO_COMMANDS,
		});
		expect(text).toContain("None declared");
		expect(text).toContain("Founder: A Founder");
		expect(text).toContain("<!-- guard-registry:begin -->");
	});

	it("lists each declared command", () => {
		const text = renderClaudeMd({
			founder: "A Founder",
			project: "demo",
			commands: { ...NO_COMMANDS, test: "node --test", lint: "biome lint ." },
		});
		expect(text).toContain("`node --test`");
		expect(text).toContain("`biome lint .`");
	});
});

describe("the .gitignore block (#737, #773)", () => {
	const gitignoreBlock =
		"# workflow-core:begin\n.claude/tmp/\n.claude/worktrees/\n/private/\n# workflow-core:end\n";
	const legacy =
		"# --- workflow-core: paths the core's rules assume are untracked (init-adopter.js) ---\n.claude/tmp/\n/private/\n# --- end workflow-core ignores ---\n";

	it("is the whole file where there is none", () => {
		expect(withIgnoreBlock("")).toBe(gitignoreBlock);
	});

	it("follows an existing file's own lines, unterminated last line included", () => {
		expect(withIgnoreBlock("node_modules/\n")).toBe(
			`node_modules/\n${gitignoreBlock}`,
		);
		expect(withIgnoreBlock("node_modules/")).toBe(
			`node_modules/\n${gitignoreBlock}`,
		);
	});

	it("is not appended twice", () => {
		expect(withIgnoreBlock(`dist/\n${gitignoreBlock}build/\n`)).toBeNull();
	});

	it("has its contents replaced where it stands", () => {
		expect(
			withIgnoreBlock(`dist/\n${gitignoreBlock}build/\n`, ["a/", "b/"]),
		).toBe(
			"dist/\n# workflow-core:begin\na/\nb/\n# workflow-core:end\nbuild/\n",
		);
	});

	it("rewrites the block init wrote before #773 rather than adding a second", () => {
		const next = withIgnoreBlock(`dist/\n${legacy}build/\n`) as string;
		expect(next).toBe(`dist/\n${gitignoreBlock}build/\n`);
		expect(withIgnoreBlock(next)).toBeNull();
	});

	it("finds a block in a CRLF file rather than appending a second", () => {
		const crlf = legacy.replaceAll("\n", "\r\n");
		expect(withIgnoreBlock(`dist/\r\n${crlf}`)).toBe(
			`dist/\r\n${gitignoreBlock}`,
		);
	});
});

describe("the day-one roadmap", () => {
	it("takes its name and areas from the config, at the core's major", () => {
		const html = renderRoadmap({
			project: "demo",
			categories: { tech: "Tech & Stack", ops: "Ops" },
			version: "1.0",
			stamp: "18 September 2026, 02:00",
		});
		expect(html).toContain("<title>demo — build reference</title>");
		expect(html).toContain('tech:"Tech & Stack"');
		expect(html).toContain('ops:"Ops"');
		expect(html).toContain("v1.0 · updated 18 September 2026, 02:00");
		expect(html).not.toContain("{{");
		expect(html).toContain("const CURRENT_PHASE = 0;");
		expect([...html.matchAll(/\{n:\d,title:/g)]).toHaveLength(5);
	});

	it("falls back to one area where the adopter declared none", () => {
		const html = renderRoadmap({
			project: "demo",
			categories: {},
			version: "1.0",
			stamp: "18 September 2026, 02:00",
		});
		expect(html).toContain('core:"Core"');
	});
});

describe("the core hooks an adopter's shims run (#1839)", () => {
	const readCoreHook = (name: string) =>
		fs.readFileSync(path.join(CORE, ".husky", name), "utf8");

	it("covers every hook the core runs", () => {
		for (const name of HOOKS) {
			expect(fs.existsSync(path.join(CORE, ".husky", name))).toBe(true);
		}
	});

	it("marks a shim as one, and finds no root in it", () => {
		for (const name of HOOKS) {
			const shim = renderHookShim(name);
			expect(isHookShim(shim)).toBe(true);
			expect(hookRootOf(shim)).toBeNull();
		}
		expect(isHookShim(readCoreHook("pre-commit"))).toBe(false);
	});

	it("still reads a pre-#1839 hook's root line", () => {
		expect(
			hookRootOf('#!/usr/bin/env sh\nWFC_PLUGIN_ROOT="/plugins/wfc"\n'),
		).toBe("/plugins/wfc");
	});

	it("leaves pre-commit's local-gate block reading the adopter's own tree (#437)", () => {
		/* The load line and the missing-script check both resolve from the
		 * adopter's repo top; spelled through the plugin root, they would source
		 * a file that is never there and check the wrong tree. */
		const block = cutLocalGateBlock(readCoreHook("pre-commit"));
		expect(block).toContain(". ./.husky/pre-commit.local");
		expect(block).not.toContain("${WFC_PLUGIN_ROOT:-");
	});

	it("flags a quoted plugin root inside a double-quoted string or a heredoc (#442)", () => {
		const fixture = [
			"# a hint's apostrophe, in a comment: don't",
			`echo "run ${CORE_ROOT}scripts/fix.js"`,
			`echo "\${hint:-${CORE_ROOT}scripts/fix.js}"`,
			"cat <<<ok",
			`out="$(node ${CORE_ROOT}scripts/ok.js)"`,
			`eval 'node ${CORE_ROOT}scripts/ok.js'`,
			"cat <<EOF",
			`then node ${CORE_ROOT}scripts/fix.js`,
			"EOF",
			`node ${CORE_ROOT}scripts/ok.js`,
		].join("\n");
		expect(quotedRootSites(fixture)).toEqual([
			{ line: 2, context: "double-quoted string" },
			{ line: 3, context: "double-quoted string" },
			{ line: 8, context: "heredoc" },
		]);
	});

	it("quotes no plugin root inside a message in any REAL hook (#442)", () => {
		/* Inside a double-quoted string, the root's own quotes close and reopen
		 * it, leaving the root unquoted. Spell such a hint
		 * `\${WFC_PLUGIN_ROOT:+$WFC_PLUGIN_ROOT/}scripts/…`, as pre-commit's does. */
		const husky = path.join(CORE, ".husky");
		const hooks = fs
			.readdirSync(husky)
			.filter((name) => fs.statSync(path.join(husky, name)).isFile());
		expect(hooks).toEqual(expect.arrayContaining(HOOKS));
		for (const name of hooks) {
			const sites = quotedRootSites(
				fs.readFileSync(path.join(husky, name), "utf8"),
			).map(({ line, context }) => `.husky/${name}:${line} (${context})`);
			expect(sites).toEqual([]);
		}
	});
});

describe("the settings keys", () => {
	it("keeps what the adopter already declared and adds the pin", () => {
		const out = settingsKeys(
			{
				marketplace: "wfc",
				source: { source: "url", url: "git@x", ref: "v1.0.0" },
				plugin: "workflow-core",
				outputStyle: null,
			},
			{ env: { OWN: "1" }, permissions: { allow: ["Bash(ls)"] } },
		);
		expect(out.permissions.allow).toEqual(["Bash(ls)"]);
		expect(out.env).toEqual({
			OWN: "1",
			CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "1",
		});
		expect(out.outputStyle).toBe("workflow-core:Core voice");
		expect(out.enabledPlugins).toEqual({ "workflow-core@wfc": true });
		expect(out.extraKnownMarketplaces).toEqual({
			wfc: { source: { source: "url", url: "git@x", ref: "v1.0.0" } },
		});
	});

	it("ships the secrets deny list, keeping the adopter's own denies", () => {
		const out = settingsKeys(
			{
				marketplace: "wfc",
				source: {},
				plugin: "workflow-core",
				outputStyle: null,
			},
			{ permissions: { deny: ["Read(./private/**)"] } },
		);
		expect(out.permissions.deny).toContain("Read(./private/**)");
		expect(out.permissions.deny).toContain("Bash(gh auth token*)");
		expect(out.permissions.deny).toContain("Read(./.env)");
		/* A union, so a second run adds nothing. */
		expect(new Set(out.permissions.deny).size).toBe(
			out.permissions.deny.length,
		);
	});

	it("turns auto-memory off, and leaves a deliberate choice alone", () => {
		const at = {
			marketplace: "wfc",
			source: {},
			plugin: "workflow-core",
			outputStyle: null,
		};
		expect(settingsKeys(at, {}).autoMemoryEnabled).toBe(false);
		expect(
			settingsKeys(at, { autoMemoryEnabled: true }).autoMemoryEnabled,
		).toBe(true);
	});

	it("defaults the compaction window to the core's 320000 and keeps an adopter's own (#1237)", () => {
		const at = {
			marketplace: "wfc",
			source: {},
			plugin: "workflow-core",
			outputStyle: null,
		};
		expect(settingsKeys(at, {}).autoCompactWindow).toBe(320_000);
		expect(settingsKeys(at, {}).autoCompactWindow).toBe(
			JSON.parse(
				fs.readFileSync(path.join(CORE, ".claude/settings.json"), "utf8"),
			).autoCompactWindow,
		);
		expect(
			settingsKeys(at, { autoCompactWindow: 320_000 }).autoCompactWindow,
		).toBe(320_000);
		expect(
			settingsKeys(at, { autoCompactWindow: 360_000 }).autoCompactWindow,
		).toBe(360_000);
		expect(
			settingsKeys(at, { autoCompactWindow: 500_000 }).autoCompactWindow,
		).toBe(500_000);
	});

	it("turns background worktree isolation off, keeping a deliberate choice (#193)", () => {
		const at = {
			marketplace: "wfc",
			source: {},
			plugin: "workflow-core",
			outputStyle: null,
		};
		expect(settingsKeys(at, {}).worktree).toEqual({ bgIsolation: "none" });
		expect(
			settingsKeys(at, { worktree: { bgIsolation: "worktree" } }).worktree,
		).toEqual({ bgIsolation: "worktree" });
		expect(settingsKeys(at, { worktree: { other: 1 } }).worktree).toEqual({
			other: 1,
			bgIsolation: "none",
		});
	});

	it("leaves an adopter's own output style in place", () => {
		const out = settingsKeys(
			{
				marketplace: "wfc",
				source: {},
				plugin: "workflow-core",
				outputStyle: null,
			},
			{ outputStyle: "My voice" },
		);
		expect(out.outputStyle).toBe("My voice");
	});

	it("names the style the plugin ships, replacing the old `core-voice` default (#1944)", () => {
		const at = {
			marketplace: "wfc",
			source: {},
			plugin: "workflow-core",
			outputStyle: null,
		};
		/* Read through readPluginStyles: `.claude-plugin/plugin.json` and
		 * `.claude/output-styles/core-voice.md`. */
		const shipped = readPluginStyles(CORE).styles;
		expect(shipped).toContain(settingsKeys(at, {}).outputStyle);
		expect(settingsKeys(at, { outputStyle: "core-voice" }).outputStyle).toBe(
			"workflow-core:Core voice",
		);
	});
});

describe("the label plan", () => {
	it("is the core's nineteen with no module on", () => {
		const plan = labelPlan({ modules: [], categories: {} });
		expect(plan).toHaveLength(19);
		expect(plan.map((l) => l.name)).toContain("parked");
		expect(plan.map((l) => l.name)).not.toContain("manual-finding");
		expect(plan.map((l) => l.name)).not.toContain("ci-red");
	});

	it("creates one takes: label per value in TAKES_VALUES, in its order (#2193)", () => {
		const plan = labelPlan({ modules: [], categories: {} });
		expect(
			plan.map((l) => l.name).filter((n) => n.startsWith(TAKES_PREFIX)),
		).toEqual(TAKES_VALUES.map(takesLabel));
	});

	it("adds a module's own label only when that module is on", () => {
		const names = (modules: Module[]) =>
			labelPlan({ modules, categories: {} }).map((l) => l.name);
		expect(names(["governance"])).toContain("manual-finding");
		expect(names(["suites"])).toContain("ci-red");
		expect(names(["roadmap"])).toHaveLength(19);
	});

	it("adds one label per category, even with the roadmap off", () => {
		const plan = labelPlan({
			modules: [],
			categories: { tech: "Tech & Stack", ops: "Ops" },
		});
		expect(plan.map((l) => l.name)).toEqual(
			expect.arrayContaining(["tech", "ops"]),
		);
		expect(plan).toHaveLength(21);
	});

	it("has a description and a colour on every label", () => {
		for (const label of labelPlan({
			modules: ["governance", "suites"],
			categories: { tech: "Tech" },
		})) {
			expect(label.description.length).toBeGreaterThan(10);
			// GitHub refuses a label description over 100 characters.
			expect(label.description.length).toBeLessThanOrEqual(100);
			expect(label.color).toMatch(/^[0-9a-fA-F]{6}$/);
		}
	});
});

describe("the tools it probes", () => {
	it("is the seven no package install supplies", () => {
		expect(TOOLS).toEqual([
			"shellcheck",
			"actionlint",
			"ruff",
			"jq",
			"gitleaks",
			"gh",
			"playwright",
		]);
	});
});

/**
 * Where a hook carries its quoted plugin root, `"${WFC_PLUGIN_ROOT:-.}"/`,
 * inside a double-quoted string or a heredoc body, by line number.
 * A quote-state scan, as far as the hooks need: comments, single quotes,
 * `$(…)` and backticks (whose quoting starts afresh), `${…}` and heredocs.
 * Residual: a `case` pattern inside `$(…)` closes that frame early, and an
 * arithmetic `<<` reads as a heredoc — neither spelled in any hook today.
 */
function quotedRootSites(text: string) {
	const st: QuoteScan = {
		text,
		i: 0,
		stack: ["code"],
		heredocs: [],
		hits: [],
	};
	for (; st.i < text.length; st.i++) {
		if (st.stack.at(-1) === "dq") scanDoubleQuoted(st);
		else if (text[st.i] === "\n" && st.heredocs.length > 0)
			scanHeredocBodies(st);
		else scanCode(st);
	}
	return parseHitLines(text, st.hits);
}

/** quotedRootSites()'s scan state; `i` is the last character consumed. */
interface QuoteScan {
	text: string;
	i: number;
	stack: string[];
	heredocs: { strip: boolean; word: string }[];
	hits: { at: number; context: string }[];
}

function upTo(text: string, s: string, from: number) {
	// An unclosed quote or brace runs to the end, rather than wrapping to 0.
	const at = text.indexOf(s, from);
	return at === -1 ? text.length : at;
}

/** The `}` closing the `${` at `from`, past any nested inside it. */
function braceEnd(text: string, from: number) {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		if (text.startsWith("${", i)) depth++;
		else if (text[i] === "}" && --depth === 0) return i;
	}
	return text.length;
}

/** One character inside a double-quoted string. */
function scanDoubleQuoted(st: QuoteScan) {
	const { text, i } = st;
	const c = text[i];
	if (text.startsWith(CORE_ROOT, i))
		st.hits.push({ at: i, context: "double-quoted string" });
	if (c === "\\") st.i++;
	else if (c === '"') st.stack.pop();
	else if (c === "`") st.stack.push("bt");
	else if (text.startsWith("$(", i)) {
		st.stack.push("paren");
		st.i++;
	} else if (text.startsWith("${", i)) {
		// Its quoting varies by shell, so a site anywhere inside counts.
		const end = braceEnd(text, i);
		const at = text.indexOf(CORE_ROOT, i);
		if (at !== -1 && at < end)
			st.hits.push({ at, context: "double-quoted string" });
		st.i = end;
	}
}

/** A newline with heredocs pending: their bodies follow it, in order. */
function scanHeredocBodies(st: QuoteScan) {
	let pos = st.i + 1;
	for (const heredoc of st.heredocs) pos = scanHeredocBody(st, pos, heredoc);
	st.heredocs = [];
	st.i = pos - 1;
}

/**
 * One heredoc's body, from line start `from`; returns the position past its
 * terminator line, or past the text's end.
 */
function scanHeredocBody(
	st: QuoteScan,
	from: number,
	{ strip, word }: { strip: boolean; word: string },
) {
	const { text } = st;
	let pos = from;
	for (;;) {
		const end = upTo(text, "\n", pos);
		const body = text.slice(pos, end);
		const done = (strip ? body.replace(/^\t+/, "") : body) === word;
		if (!done && body.includes(CORE_ROOT))
			st.hits.push({ at: pos, context: "heredoc" });
		pos = end + 1;
		if (done || end === text.length) return pos;
	}
}

const isCommentStart = (text: string, i: number) =>
	text[i] === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]));

/** One character outside any double-quoted string. */
function scanCode(st: QuoteScan) {
	const { text, i, stack } = st;
	const c = text[i];
	// Never the tail of a `<<<` here-string, which has no body.
	const heredoc =
		text[i - 1] !== "<" &&
		/^<<(-?)\s*(['"]?)(\w+)\2/.exec(text.slice(i, upTo(text, "\n", i)));
	if (c === "\\") st.i++;
	else if (c === "'") st.i = upTo(text, "'", i + 1);
	else if (c === '"') stack.push("dq");
	else if (isCommentStart(text, i)) st.i = upTo(text, "\n", i) - 1;
	else if (text.startsWith("${", i)) st.i = braceEnd(text, i);
	// `$(` included: its `$` is inert here.
	else if (c === "(") stack.push("paren");
	// A `case` pattern's `)` has no `(` to close, so only a frame's pops one.
	else if (c === ")" && stack.at(-1) === "paren") stack.pop();
	else if (c === "`" && stack.at(-1) === "bt") stack.pop();
	else if (c === "`") stack.push("bt");
	else if (heredoc) {
		st.heredocs.push({ strip: heredoc[1] === "-", word: heredoc[3] });
		st.i += heredoc[0].length - 1;
	}
}

/** Each hit's line, counted from 1. */
function parseHitLines(text: string, hits: QuoteScan["hits"]) {
	return hits.map(({ at, context }) => ({
		line: text.slice(0, at).split("\n").length,
		context,
	}));
}
