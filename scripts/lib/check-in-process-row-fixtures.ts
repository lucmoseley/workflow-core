export type Files = Record<string, string>;

export interface RowFixture {
	path?: string;
	fault?: {
		inherited: Files;
		added: Files;
		names?: string[];
		scoped?: true;
	};
}

const env = (name: string) => ["process", "env", name].join(".");
const envWrite = (name: string) => `${env(name)} = "x";\n`;
const GH = ["g", "h"].join("");

const THRESHOLD = 10_000;
const HOOK_LIMITS = `const HOOK_PERSIST_CHARS = ${THRESHOLD};\nconst RULE_CAP = 500;\n`;
const textModule = (commands: string[]) =>
	[
		`const COMMANDS = ${JSON.stringify(commands)};`,
		`const BODY = "x".repeat(${THRESHOLD});`,
		'module.exports = { COMMANDS, TAKES_READ: [], pricedOptionsWhole: () => "", trackerContext: () => BODY };',
		"",
	].join("\n");

export const ROW_FIXTURES: Record<string, RowFixture> = {
	"main-checkout-commit": { path: "README.md" },
	"guard-registry": {
		fault: {
			inherited: {
				"CLAUDE.md":
					"<!-- guard-registry:begin -->\n- First rule.\n<!-- guard-registry:end -->\n",
			},
			added: {
				"AGENTS.md":
					"<!-- guard-registry:begin -->\n- Second rule.\n<!-- guard-registry:end -->\n",
			},
		},
	},
	"test-read-edges": { path: "docs/test-read-edges.json" },
	"comment-policy": {
		fault: {
			inherited: { "scripts/a.js": "const a = 1;\n// first note\n" },
			added: { "scripts/b.js": "const b = 1;\n// second note\n" },
			scoped: true,
		},
	},
	"review-hold": { path: "README.md" },
	"roadmap-pair": { path: "docs/reference-roadmap.html" },
	"roadmap-valid": { path: "docs/reference-roadmap.html" },
	"citation-tracker": { path: "README.md" },
	"gate-switches": { path: "README.md" },
	"lockfile-sync": { path: "package.json" },
	"research-added": { path: "docs/research/notes.md" },
	"vendored-skills": { path: ".agents/skills/s/SKILL.md" },
	"hook-liveness": { path: "scripts/guard-x.sh" },
	"plugin-hooks": { path: "scripts/guard-x.sh" },
	"guard-test-isolation": {
		fault: {
			inherited: {
				"scripts/lib/guard-log.sh": "gl_log() { :; }\n",
				"scripts/guard-g.sh": 'source "$here/lib/guard-log.sh"\n',
				"scripts/b.test.ts": 'spawnSync("guard-g.sh", []);\n',
			},
			added: { "scripts/c.test.ts": 'spawnSync("guard-g.sh", []);\n' },
		},
	},
	"host-root-test-isolation": {
		fault: {
			inherited: {
				"scripts/thing.js": 'require("./lib/host-root.js");\n',
				"scripts/b.test.ts": 'spawnSync("node", ["thing.js"]);\n',
			},
			added: { "scripts/c.test.ts": 'spawnSync("node", ["thing.js"]);\n' },
		},
	},
	"git-fixture-identity": {
		fault: {
			inherited: {
				"scripts/b.test.ts": 'git("init", "-q");\ngit("commit", "-qm", "x");\n',
			},
			added: {
				"scripts/c.test.ts": 'git("init", "-q");\ngit("commit", "-qm", "x");\n',
			},
		},
	},
	"test-env-writes": {
		fault: {
			inherited: { "scripts/b.test.ts": envWrite("FOO") },
			added: { "scripts/c.test.ts": envWrite("BAR") },
		},
	},
	"host-root": {
		fault: {
			inherited: {
				".claude-plugin/plugin.json": '{ "name": "fixture" }\n',
				"scripts/b.js": 'const ROOT = path.resolve(__dirname, "..");\n',
			},
			added: {
				"scripts/c.js": 'const ROOT = path.resolve(__dirname, "..");\n',
			},
		},
	},
	"website-copy": {
		fault: {
			inherited: {
				".claude/workflow-core.json": '{ "modules": ["site"] }\n',
				"app/a.tsx": 'export const c = "A surf paradise.";\n',
			},
			added: { "app/b.tsx": 'export const c = "Busy — and cheap.";\n' },
		},
	},
	"skill-frontmatter": {
		fault: {
			inherited: {
				".claude/skills/a/SKILL.md":
					"---\nname: a\ndescription: Turn it on: Sonnet.\n---\n",
			},
			added: {
				".claude/skills/b/SKILL.md":
					"---\nname: b\ndescription: Turn it off: Opus.\n---\n",
			},
		},
	},
	"hand-callers": {
		fault: {
			inherited: { "scripts/b.js": "// Callers: scripts/c.js\n" },
			added: { "scripts/d.js": "/*\n * Caller: scripts/e.js\n */\n" },
		},
	},
	registrations: {
		fault: {
			inherited: {
				".claude/registrations.json":
					'{ "hooks": [], "registeredElsewhere": {}, "calledElsewhere": {} }\n',
				"scripts/check-b.js": "\n",
				"scripts/check-b.test.js": "\n",
			},
			added: { "scripts/check-c.js": "\n", "scripts/check-c.test.js": "\n" },
		},
	},
	"cli-args": {
		fault: {
			inherited: { "scripts/b.js": "const flag = process.argv[2];\n" },
			added: { "scripts/c.js": "const flag = process.argv[2];\n" },
		},
	},
	"test-spawn": {
		fault: {
			inherited: { "scripts/b.test.ts": 'spawnSync("node", [S]);\n' },
			added: { "scripts/c.test.ts": "execFileSync(process.execPath, [S]);\n" },
		},
	},
	"jsonl-reads": {
		fault: {
			inherited: {
				"scripts/b.js": 'text.split("\\n").map((l) => JSON.parse(l));\n',
			},
			added: {
				"scripts/c.js": "raw.split(/\\r?\\n/).map((l) => JSON.parse(l));\n",
			},
		},
	},
	"gh-route": {
		fault: {
			inherited: { "scripts/b.js": `spawnSync("${GH}", ["issue", "list"]);\n` },
			added: { "scripts/c.js": `const gh = ${env("WFC_GH")};\n` },
		},
	},
	"arbiter-commands": {
		fault: {
			inherited: { "scripts/b.js": 'scriptPath("session-arbiter.js");\n' },
			added: {
				"scripts/c.js":
					'const c = "node scripts/session-arbiter.js release";\n',
			},
		},
	},
	"clock-copies": {
		fault: {
			inherited: { "scripts/b.js": "const at = process.env.WFC_NOW;\n" },
			added: { "scripts/c.js": 'const at = env["WFC_NOW"];\n' },
		},
	},
	"report-programs": {
		fault: {
			inherited: { "scripts/report-b.js": 'gh(["issue", "create"]);\n' },
			added: { "scripts/report-c.js": 'execSync("gh issue create");\n' },
		},
	},
	"family-contracts": {
		fault: {
			inherited: { "scripts/b.js": "runCheck(SPEC);\n" },
			added: { "scripts/c.js": "createIssue({});\n" },
		},
	},
	"program-output": {
		fault: {
			inherited: { "scripts/b.js": 'console.log("x");\nprocess.exit(0);\n' },
			added: {
				"scripts/c.js": 'process.stdout.write("x");\nprocess.exit(1);\n',
			},
		},
	},
	"precommit-exit": {
		fault: {
			inherited: {
				".husky/pre-commit.local": "node scripts/check-a.js || exit 1\n",
			},
			added: {
				".husky/pre-commit.local":
					"node scripts/check-a.js || exit 1\nnode scripts/check-b.js || exit 1\n",
			},
		},
	},
	"rule-fragments": { path: "docs/agents/dependabot.md" },
	"effort-guide-routing": { path: "docs/effort-guide.md" },
	"core-docs": { path: "GLOSSARY.md" },
	"user-settings-drift": { path: "README.md" },
	"code-standards": { path: "README.md" },
	primitives: { path: "README.md" },
	"skill-body-size": { path: ".claude/skills/s/SKILL.md" },
	"adopter-boundary": { path: "README.md" },
	"workflow-permissions": { path: ".github/workflows/x.yml" },
	"doc-map": { path: "docs/notes.md" },
	"context-budget": {
		path: "CLAUDE.md",
		fault: {
			inherited: { "docs/working-contract.md": `${"x".repeat(40_000)}\n` },
			added: { "docs/working-contract.md": `${"x".repeat(40_100)}\n` },
		},
	},
	"injector-margin": {
		path: "docs/agents/rules/review-dispatch-shape.txt",
		fault: {
			inherited: {
				"scripts/lib/hook-limits.js": HOOK_LIMITS,
				"scripts/lib/tracker-inject-text.js": textModule(["alpha"]),
			},
			added: {
				"scripts/lib/tracker-inject-text.js": textModule(["alpha", "beta"]),
			},
			names: ["FAIL: 2 payload(s)"],
		},
	},
};
