// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPoolFiles } from "./lib/always-loaded-pool.js";
import { SHED_REGISTERS } from "./lib/context-budget-pathspecs";
import { liveCaps } from "./lib/context-budget-testkit";
import { PROFILES } from "./lib/fault-profiles.js";
import { defineTemplate, identityRepoTemplate } from "./lib/git-fixture";
import { keptSpawn } from "./lib/kept-spawn.js";
import {
	MIRRORED_FILE,
	MIRRORED_SECTIONS,
} from "./lib/machine-mirrored-rules.js";
import { CORE_RULES } from "./lib/rule-text";
import { runInProcess } from "./lib/run-in-process.js";
import {
	TEXT_MODULE,
	textModuleSource,
	writeTextModule,
} from "./lib/tracker-text-fixture";

const SCRIPT = path.resolve(__dirname, "check-context-budget.js");
const { pool: CAP, injection: INJECTION_CAP } = liveCaps();

let dir: string;

const rulesFallbackDirs: string[] = [];

function poolMember(pick: (rel: string) => boolean, missing: string): string {
	const p = getPoolFiles().find(pick);
	if (!p)
		throw new Error(
			`this suite's alwaysLoaded pool has ${missing} — check vitest.setup.ts's WFC_ALWAYS_LOADED default`,
		);
	return p;
}

const VOICE_PATH: string = poolMember(
	(f) => f === process.env.WFC_OUTPUT_STYLE,
	"no member matching WFC_OUTPUT_STYLE",
);

const SPARE_PATH: string = poolMember(
	(f) => f !== "CLAUDE.md" && f !== VOICE_PATH,
	"no member beyond CLAUDE.md and the style to spare",
);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-"));
	fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
	vi.stubEnv("WFC_TRACKER_TEXT_FILE", path.join(dir, TEXT_MODULE));
	const emptyFallback = fs.mkdtempSync(
		path.join(os.tmpdir(), "ctxbudget-fallback-"),
	);
	rulesFallbackDirs.push(emptyFallback);
	vi.stubEnv("WFC_RULES_FALLBACK_DIR", emptyFallback);
	injector(INJECTION_CAP - 1);
});

function injector(bytes: number, extra = "") {
	writeTextModule(dir, textModuleSource("x".repeat(bytes), extra));
}

function agent(name: string, description: string, body = "") {
	fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
	);
}

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	for (const d of rulesFallbackDirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

function buildPoolText(rel: string, bytes: number) {
	const head = rel === "CLAUDE.md" ? `@${VOICE_PATH}\n` : "";
	return head + "x".repeat(bytes - head.length);
}

function pool(bytes: number) {
	const voice = Math.floor(bytes / 5);
	const rest = bytes - 2 * voice;
	const members = getPoolFiles().filter((f) => f !== VOICE_PATH);
	const each = Math.floor(rest / members.length);
	const last = members.length - 1;
	for (const [i, rel] of [...members, VOICE_PATH].entries()) {
		let size = each;
		if (i > last) size = voice;
		else if (i === last) size = rest - each * last;
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), buildPoolText(rel, size));
	}
	vi.stubEnv("WFC_OUTPUT_STYLE", VOICE_PATH);
}

function shedRegister() {
	for (const rel of Object.values(SHED_REGISTERS)) {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), "# register\n");
	}
}

function skill(
	name: string,
	description: string,
	vendored = false,
	disabled = false,
) {
	const flag = disabled ? "disable-model-invocation: true\n" : "";
	const body = `---\nname: ${name}\ndescription: ${description}\n${flag}---\n\n# ${name}\n`;
	if (vendored) {
		const src = path.join(dir, ".agents", "skills", name);
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(path.join(src, "SKILL.md"), body);
		fs.symlinkSync(
			path.join("..", "..", ".agents", "skills", name),
			path.join(dir, ".claude", "skills", name),
		);
		return;
	}
	const at = path.join(dir, ".claude", "skills", name);
	fs.mkdirSync(at, { recursive: true });
	fs.writeFileSync(path.join(at, "SKILL.md"), body);
}

function run(...args: string[]) {
	const r = runInProcess(SCRIPT, ["--root", dir, ...args]);
	return { ...r, json: () => JSON.parse(r.stdout) };
}

describe("the profile the direction gate reads this envelope through", () => {
	const newFaults = path.resolve(__dirname, "checker-new-faults.js");

	const direction = (staged: unknown, baseline: unknown) => {
		const at = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-direction-"));
		const write = (name: string, body: unknown) => {
			const abs = path.join(at, name);
			fs.writeFileSync(abs, JSON.stringify(body));
			return abs;
		};
		const r = runInProcess(newFaults, [
			"context-budget",
			write("staged.json", staged),
			write("baseline.json", baseline),
		]);
		fs.rmSync(at, { recursive: true, force: true });
		return { code: r.status ?? -1, out: r.stdout ?? "" };
	};

	const atPool = (over: number) => {
		pool(CAP + over);
		return run("--json").json();
	};

	it("refuses a pool that grew, and passes one that shed", () => {
		const smaller = atPool(500);
		const bigger = atPool(1500);

		expect(direction(bigger, smaller).code).toBe(1);
		expect(direction(smaller, bigger).code).toBe(0);
	});

	it("refuses a growing injection surface the same way", () => {
		const at = (over: number) => {
			pool(CAP - 1000);
			injector(INJECTION_CAP + over);
			return run("--json").json();
		};
		const smaller = at(700);
		const bigger = at(1700);

		expect(direction(bigger, smaller).code).toBe(1);
		expect(direction(smaller, bigger).code).toBe(0);
	});

	it("measures every surface off the envelope, breached or not", () => {
		const { measure, unit } = PROFILES["context-budget"];
		expect(unit).toBe("B");
		if (!measure) throw new Error("the context-budget profile has no measure");

		pool(CAP - 2000);
		const clean = run("--json").json();
		expect(clean.findings ?? []).toEqual([]);
		expect(measure({ surface: "pool" }, "findings", clean)).toBe(clean.total);
		expect(measure({ surface: "injection" }, "findings", clean)).toBe(
			clean.injection.total,
		);
		expect(measure({ surface: "pool-files" }, "admissibility", clean)).toBe(
			clean.admissibility[0].bytes,
		);
	});

	it("never gates on `admissibility`, which is a note the prompt reads", () => {
		const under = (bytes: number) => {
			pool(bytes);
			return run("--json").json();
		};
		const smaller = under(CAP - 2000);
		const bigger = under(CAP - 1000);

		expect(smaller.findings ?? []).toEqual([]);
		expect(direction(bigger, smaller).code).toBe(0);
	});
});

describe("the always-loaded pool", () => {
	it("is OK, with headroom reported, while inside the cap", () => {
		pool(CAP - 1000);
		const r = run("--json");
		expect(r.status).toBe(0);
		expect(r.json().outcome).toBe("OK");
		expect(r.json().total).toBe(CAP - 1000);
		expect(r.json().headroom).toBe(1000);
	});

	it("WARNs but does not gate once over the cap, tagging OVER-POOL and recording the negative headroom", () => {
		pool(CAP + 500);
		const r = run("--json");
		expect(r.json().outcome).toBe("WARN");
		expect(r.json().findings[0].tag).toBe("OVER-POOL");
		expect(r.json().headroom).toBe(-500);
		expect(r.status).toBe(0);
	});

	it("measures a pool this repo does not carry every member of", () => {
		pool(CAP - 1000);
		const absent = fs.statSync(path.join(dir, SPARE_PATH)).size;
		fs.rmSync(path.join(dir, SPARE_PATH));

		const r = run("--json");
		expect(r.status).toBe(0);
		expect(r.json().outcome).toBe("OK");
		expect(r.json().total).toBe(CAP - 1000 - absent);
	});

	it("is BROKEN, not OK, when a pool file is there but will not read", () => {
		pool(CAP - 1000);
		fs.rmSync(path.join(dir, SPARE_PATH));
		fs.symlinkSync(path.basename(SPARE_PATH), path.join(dir, SPARE_PATH));

		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.status).toBe(2);
	});
});

describe("--notify", () => {
	it("says nothing at all while the pool is inside the cap", () => {
		pool(CAP - 1000);
		const r = run("--notify");
		expect(r.stdout.trim()).toBe("");
	});

	it("reports the breach, and still exits 0 so the hook stays alive", () => {
		pool(CAP + 500);
		const r = run("--notify");
		expect(r.stdout).toContain("OVER CAP");
		expect(r.status).toBe(0);
	});

	it("headlines a pool exactly on the cap as AT CAP, not OVER CAP", () => {
		pool(CAP);
		const r = run("--notify");
		expect(r.stdout).toContain("AT CAP");
		expect(r.stdout).toContain("landing exactly on it");
		expect(r.stdout).not.toContain("OVER CAP");
	});
});

describe("skill descriptions", () => {
	it("splits own from vendored on the symlink, as §A's register does", () => {
		pool(CAP - 1000);
		skill("house-thing", "one two three four");
		skill("vendored-thing", "five six", true);
		const d = run("--json").json().descriptions;
		expect(d.ownWords).toBe(4);
		expect(d.vendoredWords).toBe(2);
	});

	it("counts nothing for a skill the model cannot invoke, own or vendored", () => {
		pool(CAP - 1000);
		skill("house-thing", "one two three four");
		skill("house-dead", "never delivered at all", false, true);
		skill("vendored-thing", "five six", true);
		skill("vendored-dead", "also never delivered", true, true);
		const d = run("--json").json().descriptions;
		expect(d.ownWords).toBe(4);
		expect(d.vendoredWords).toBe(2);
	});

	it("lists vendored paths under the VENDORED heading, not own ones", () => {
		pool(CAP - 1000);
		skill("house-thing", "one two three four");
		skill("vendored-thing", "five six", true);
		const r = run();
		const block = r.stderr.slice(
			r.stderr.indexOf("VENDORED SKILL DESCRIPTIONS"),
		);
		expect(block).toContain(".claude/skills/vendored-thing/SKILL.md");
		expect(block).not.toContain(".claude/skills/house-thing/SKILL.md");
	});

	it("counts a folded block scalar, not its marker", () => {
		pool(CAP - 1000);
		const at = path.join(dir, ".claude", "skills", "folded");
		fs.mkdirSync(at, { recursive: true });
		fs.writeFileSync(
			path.join(at, "SKILL.md"),
			"---\nname: folded\ndescription: >\n  four words are here\n  and three more\nname2: x\n---\n",
		);
		expect(run("--json").json().descriptions.ownWords).toBe(7);
	});

	it("counts a command file's description too", () => {
		pool(CAP - 1000);
		fs.writeFileSync(
			path.join(dir, ".claude", "commands", "thing.md"),
			"---\nname: thing\ndescription: a b c\n---\n",
		);
		expect(run("--json").json().descriptions.ownWords).toBe(3);
	});
});

describe("skillOverrides", () => {
	function settings(overrides: Record<string, string>, raw?: string) {
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			raw ?? JSON.stringify({ skillOverrides: overrides }, null, 2),
		);
	}

	it("charges every description when there is no settings file at all", () => {
		pool(CAP - 1000);
		skill("house-thing", "one two three four");
		expect(run("--json").json().descriptions.ownWords).toBe(4);
	});

	it("charges a description whose entry says on, and one with no entry", () => {
		pool(CAP - 1000);
		skill("explicit-on", "one two three");
		skill("no-entry", "four five");
		settings({ "explicit-on": "on" });
		expect(run("--json").json().descriptions.ownWords).toBe(5);
	});

	it("charges nothing for a name-only own skill", () => {
		pool(CAP - 1000);
		skill("hidden-desc", "one two three four");
		skill("kept", "five six");
		settings({ "hidden-desc": "name-only" });
		const d = run("--json").json().descriptions;
		expect(d.ownWords).toBe(2);
		expect(d.ownBytes).toBe(Buffer.byteLength("five six"));
	});

	it("charges nothing for a name-only VENDORED skill", () => {
		pool(CAP - 1000);
		skill("vendored-thing", "one two three", true);
		settings({ "vendored-thing": "name-only" });
		expect(run("--json").json().descriptions.vendoredWords).toBe(0);
	});

	it.each(["name-only", "user-invocable-only", "off"])(
		"charges nothing under the %s state",
		(state) => {
			pool(CAP - 1000);
			skill("thing", "one two three four");
			settings({ thing: state });
			expect(run("--json").json().descriptions.ownWords).toBe(0);
		},
	);

	describe("a skill or command with no description key", () => {
		const bare = (name: string, body: string) => {
			const at = path.join(dir, ".claude", "skills", name);
			fs.mkdirSync(at, { recursive: true });
			fs.writeFileSync(
				path.join(at, "SKILL.md"),
				`---\nname: ${name}\n---\n${body}`,
			);
		};
		const ownBytes = () => run("--json").json().descriptions.ownBytes;

		it("is charged its body's first line, the heading marker stripped", () => {
			pool(CAP - 1000);
			bare("zhead", "\n\n###   Say   it  \n\nbody\n");
			expect(ownBytes()).toBe(Buffer.byteLength("Say   it"));
		});

		it("keeps a `#` with no space after it", () => {
			pool(CAP - 1000);
			bare("ztag", "#tag line\n");
			expect(ownBytes()).toBe(Buffer.byteLength("#tag line"));
		});

		it("keeps a 100-character line whole and cuts a 101-character one", () => {
			pool(CAP - 1000);
			bare("zlong", `${"b".repeat(101)}\n`);
			expect(ownBytes()).toBe(100);
			bare("zexact", `${"a".repeat(100)}\n`);
			expect(ownBytes()).toBe(200);
		});

		it("charges a command file with no frontmatter its first line", () => {
			pool(CAP - 1000);
			fs.writeFileSync(
				path.join(dir, ".claude", "commands", "zcmd.md"),
				"# Do the thing\n\nbody\n",
			);
			expect(ownBytes()).toBe(Buffer.byteLength("Do the thing"));
		});

		it("is charged nothing under a name-only entry", () => {
			pool(CAP - 1000);
			bare("zhead", "# Say it\n");
			settings({ zhead: "name-only" });
			expect(ownBytes()).toBe(0);
		});
	});

	it("keys a command by its filename without the extension", () => {
		pool(CAP - 1000);
		fs.writeFileSync(
			path.join(dir, ".claude", "commands", "card-close.md"),
			"---\ndescription: a b c\n---\n",
		);
		settings({ "card-close": "name-only" });
		expect(run("--json").json().descriptions.ownWords).toBe(0);
	});

	it("does not let one skill's override silence another's description", () => {
		pool(CAP - 1000);
		skill("alpha", "one two three");
		skill("beta", "four five");
		settings({ alpha: "name-only" });
		expect(run("--json").json().descriptions.ownWords).toBe(2);
	});

	it("keys every real skill by a directory name matching its frontmatter name", () => {
		const skillsDir = path.resolve(__dirname, "..", ".claude", "skills");
		const misnamedLinks = fs.readdirSync(skillsDir).filter((name) => {
			const at = path.join(skillsDir, name);
			return (
				fs.lstatSync(at).isSymbolicLink() &&
				path.basename(fs.readlinkSync(at)) !== name
			);
		});
		expect(misnamedLinks).toEqual([]);
		const skills = spawnSync(
			"git",
			[
				"ls-files",
				"-z",
				".claude/skills/*/SKILL.md",
				".agents/skills/*/SKILL.md",
			],
			{ cwd: path.resolve(__dirname, ".."), encoding: "utf8" },
		)
			.stdout.split("\0")
			.filter(Boolean);
		expect(skills.length).toBeGreaterThan(0);
		const mismatched = skills
			.map((rel) => ({
				name: rel.split("/")[2],
				declared: /^name:[ \t]*(.+)$/m.exec(
					fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8"),
				)?.[1],
			}))
			.filter((s) => s.declared?.trim() !== s.name);
		expect(mismatched).toEqual([]);
	});

	it("is BROKEN, and still says so, when the settings JSON will not parse", () => {
		pool(CAP - 1000);
		skill("thing", "one two three four");
		settings({}, "{ this is not json");
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain(".claude/settings.json");
		const finding = r
			.json()
			.findings.find((f: { tag: string }) => f.tag === "UNPARSEABLE-SETTINGS");
		expect(finding?.severity).toBe("WARN");
		expect(finding?.message).toContain("will not parse");
		expect(run().stderr).toContain("will not parse");
	});

	it("says nothing about parsing when the settings file is simply absent", () => {
		pool(CAP - 1000);
		skill("thing", "one two three four");
		expect(run("--json").stderr).not.toContain("will not parse");
	});

	it("charges every description when skillOverrides is not an object", () => {
		pool(CAP - 1000);
		skill("thing", "one two three four");
		settings({}, JSON.stringify({ skillOverrides: "name-only" }));
		expect(run("--json").json().descriptions.ownWords).toBe(4);
	});
});

describe("what the pool covers", () => {
	it("counts own descriptions inside the pool total, not beside it", () => {
		pool(CAP - 1000);
		skill("house-thing", "abcdefghij");
		expect(run("--json").json().total).toBe(CAP - 1000 + 10);
	});

	it("counts the voice contract twice — the output style and the import (mantahostels#1503)", () => {
		pool(CAP - 1000);
		fs.appendFileSync(path.join(dir, VOICE_PATH), "x".repeat(100));
		const j = run("--json").json();
		expect(j.total).toBe(CAP - 1000 + 200);
		expect(
			j.pool.filter((f: { path: string }) => f.path === VOICE_PATH),
		).toHaveLength(2);
	});

	it("counts the style once when no other pool file imports it (#2034)", () => {
		pool(CAP - 1000);
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), "x".repeat(100));
		const before = run("--json").json().total;
		fs.appendFileSync(path.join(dir, VOICE_PATH), "x".repeat(100));
		const j = run("--json").json();
		expect(j.total).toBe(before + 100);
		expect(
			j.pool.filter((f: { path: string }) => f.path === VOICE_PATH),
		).toHaveLength(1);
	});

	it("counts the style once, undoubled, when overrides.output_style is undeclared (#45)", () => {
		pool(CAP - 1000);
		vi.stubEnv("WFC_OUTPUT_STYLE", "");
		const before = run("--json").json().total;
		fs.appendFileSync(path.join(dir, VOICE_PATH), "x".repeat(100));
		const j = run("--json").json();
		expect(j.total).toBe(before + 100);
		expect(
			j.pool.filter((f: { path: string }) => f.path === VOICE_PATH),
		).toHaveLength(1);
	});

	it("warns when the declared style is not itself an always-loaded file, naming it and offering to add it to alwaysLoaded (#45)", () => {
		pool(CAP - 1000);
		const unpooled = ".claude/output-styles/unpooled.md";
		vi.stubEnv("WFC_OUTPUT_STYLE", unpooled);
		const j = run("--json").json();
		const finding = j.findings.find(
			(f: { tag: string }) => f.tag === "STYLE-NOT-POOLED",
		);
		expect(finding?.severity).toBe("WARN");
		expect(finding?.message).toContain(unpooled);
		expect(finding?.message).toContain(`Add ${unpooled} to alwaysLoaded`);
		expect(
			j.pool.filter((f: { path: string }) => f.path === VOICE_PATH),
		).toHaveLength(1);
	});

	it("leaves vendored descriptions out of the total — the repo cannot delete them", () => {
		pool(CAP - 1000);
		skill("vendored-thing", "abcdefghij", true);
		const j = run("--json").json();
		expect(j.total).toBe(CAP - 1000);
		expect(j.descriptions.vendoredBytes).toBe(10);
	});

	it("counts an agent definition's name and description, never its body", () => {
		pool(CAP - 1000);
		agent("scout", "abcde", "x".repeat(5000));
		const j = run("--json").json();
		expect(j.agents[0].bytes).toBe("scout".length + 5);
		expect(j.total).toBe(CAP - 1000 + 10);
	});

	it("measures agent definitions at zero before the directory exists", () => {
		pool(CAP - 1000);
		const j = run("--json").json();
		expect(j.agents).toEqual([]);
		expect(j.total).toBe(CAP - 1000);
	});
});

describe("files a pool member `@`-imports (#1956)", () => {
	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	};

	it("counts each imported file, nested ones resolved against their importer", () => {
		pool(CAP - 10_000);
		const line = "\n@AGENTS-FIXTURE.md\n";
		fs.appendFileSync(path.join(dir, "CLAUDE.md"), line);
		write("AGENTS-FIXTURE.md", `${"a".repeat(300)}\n@docs/nested.md\n`);
		write("docs/nested.md", "n".repeat(50));
		const j = run("--json").json();
		const agents = 300 + "\n@docs/nested.md\n".length;
		expect(j.total).toBe(CAP - 10_000 + line.length + agents + 50);
		expect(
			j.pool.find((f: { path: string }) => f.path === "docs/nested.md").note,
		).toBe("imported by AGENTS-FIXTURE.md");
	});

	it("skips imports inside code, prose that names no file, and members already counted", () => {
		pool(CAP - 10_000);
		const text =
			"\n`@code-span.md` and --add-assignee @me\n" +
			"```\n@fenced.md\n```\n" +
			`@${SPARE_PATH}\n@~/home.md\n`;
		fs.appendFileSync(path.join(dir, "CLAUDE.md"), text);
		write("code-span.md", "c".repeat(100));
		write("fenced.md", "f".repeat(100));
		const j = run("--json").json();
		expect(j.total).toBe(CAP - 10_000 + text.length);
		expect(
			j.pool.filter((f: { path: string }) => f.path === SPARE_PATH),
		).toHaveLength(1);
	});
});

describe("an adopter's rendered tracker payload (#1956)", () => {
	function coreInjector(): string {
		fs.mkdirSync(path.join(dir, "core"));
		const text = path.join(dir, "core", "tracker-inject-text.js");
		fs.writeFileSync(text, textModuleSource("You invoked a fixture header."));
		const entry = path.join(dir, "core", "inject-tracker-docs.js");
		fs.writeFileSync(
			entry,
			[
				'const fs = require("node:fs");',
				'const cmd = JSON.parse(fs.readFileSync(0, "utf8")).prompt.slice(1).split(" ")[0];',
				'if (cmd === "triage") process.exit(1);',
				'const host = fs.readFileSync(process.env.CLAUDE_PROJECT_DIR + "/host.txt", "utf8");',
				'process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: cmd + " " + host } }));',
				"",
			].join("\n"),
		);
		fs.rmSync(path.join(dir, TEXT_MODULE));
		vi.stubEnv("WFC_TRACKER_TEXT_FILE", text);
		vi.stubEnv("WFC_INJECTOR_ENTRY", entry);
		return entry;
	}

	it("renders each command against the host, beside the core's union", () => {
		pool(CAP - 1000);
		const script = coreInjector();
		fs.writeFileSync(path.join(dir, "host.txt"), "this host's own text");
		const { injection } = run("--json").json();
		expect(injection.rendered).toEqual({
			script,
			commands: [
				{
					command: "implement",
					chars: "implement this host's own text".length,
				},
				{ command: "triage", chars: null, error: "exit 1" },
			],
		});
		expect(injection.files.at(-1).note).toBe("the core's union, capped there");
	});

	it("headlines none rendered, never a largest of 0, where every command fails", () => {
		pool(CAP - 1000);
		coreInjector();
		expect(run().stderr).toContain("per command — none rendered, uncapped");
	});

	it("renders nothing where the host carries its own text module", () => {
		pool(CAP - 1000);
		expect(run("--json").json().injection.rendered).toBeNull();
	});

	it("renders nothing on an --against run's silent baseline side (#4296)", () => {
		pool(CAP - 1000);
		coreInjector();
		const r = runInProcess(SCRIPT, ["--root", dir, "--json"], {
			env: { ...process.env, WFC_CHECK_SIDE: "baseline" },
		});
		expect(JSON.parse(r.stdout).injection.rendered).toBeNull();
	});
});

describe("the injected tracker docs", () => {
	it("is OK with headroom while the injection is inside its own cap", () => {
		pool(CAP - 1000);
		injector(INJECTION_CAP - 500);
		const j = run("--json").json();
		expect(j.outcome).toBe("OK");
		expect(j.injection.headroom).toBe(500);
	});

	it("WARNs on its own tag, OVER-INJECTION, and never gates, recording the negative headroom", () => {
		pool(CAP - 1000);
		injector(INJECTION_CAP + 700);
		const r = run("--json");
		expect(r.json().outcome).toBe("WARN");
		expect(r.json().findings[0].tag).toBe("OVER-INJECTION");
		expect(r.json().injection.headroom).toBe(-700);
		expect(r.status).toBe(0);
	});

	it("never touches the pool's own headroom", () => {
		pool(CAP - 1000);
		injector(INJECTION_CAP + 700);
		expect(run("--json").json().headroom).toBe(1000);
	});

	describe("each part, at its largest variant", () => {
		const headroomWith = (extra: string) => {
			pool(CAP - 1000);
			injector(INJECTION_CAP - 500, extra);
			return run("--json").json().injection.headroom;
		};

		it("counts the residue index of the command whose index is longest", () => {
			expect(
				headroomWith(
					'INDEX: { implement: [], triage: [] }, trackerIndex: (c) => (c === "triage" ? "y".repeat(400) : "y"),',
				),
			).toBe(100);
		});

		it("counts the longest command's closing steps", () => {
			expect(
				headroomWith(
					'CLOSING_STEPS: { implement: "c".repeat(150), triage: "c".repeat(300) },',
				),
			).toBe(200);
		});

		it("counts the header of the command it is longest for", () => {
			expect(
				headroomWith(
					'header: (c) => HEADER + (c === "triage" ? "t".repeat(120) : ""),',
				),
			).toBe(380);
		});

		it("counts the takes line of every takes-reading command against every other command", () => {
			expect(
				headroomWith(
					'TAKES_READ: ["implement"], takesLine: (issue, other, matched) => [issue, other, matched].join(":"),',
				),
			).toBe(500 - "1:triage:implement".length);
		});

		it("counts the longest standards state, with the glossary sentence", () => {
			expect(
				headroomWith(
					'codeReviewParts: (h) => [h.standardsState === "neither" ? "s".repeat(90) : "s", h.glossary],',
				),
			).toBe(500 - 90 - "GLOSSARY.md".length);
		});

		it("counts each fixed string once", () => {
			expect(
				headroomWith(
					'WAYFINDER_CLAUSES: "w".repeat(60), PRICED_OPTIONS_POINTER: "u".repeat(40),',
				),
			).toBe(400);
		});
	});

	describe("the priced-options pointer (#2039)", () => {
		it("measures the pointer and not the whole shape a host without Core voice gets", () => {
			pool(CAP - 1000);
			injector(
				INJECTION_CAP - 500,
				'PRICED_OPTIONS_POINTER: "p".repeat(150), pricedOptionsWhole: () => "w".repeat(400),',
			);
			expect(run("--json").json().injection.headroom).toBe(350);
		});
	});

	describe("the rule fragments the review strings read", () => {
		const rule = (id: string, text: string) =>
			fs.writeFileSync(
				path.join(dir, "docs", "agents", "rules", `${id}.txt`),
				text,
			);

		it("counts each from the root's store, its trailing newlines dropped", () => {
			vi.stubEnv("WFC_RULES_DIR", path.join(dir, "docs", "agents", "rules"));
			pool(CAP - 1000);
			injector(
				INJECTION_CAP - 500,
				'codeReviewParts: (h) => ["review-dispatch-shape", "review-deviations-read", "review-finding-destination"].map(h.fragment),',
			);
			rule("review-dispatch-shape", `${"d".repeat(100)}\n`);
			rule("review-deviations-read", `${"v".repeat(50)}\n\n`);
			rule("review-finding-destination", "f".repeat(25));
			expect(run("--json").json().injection.headroom).toBe(325);
		});

		it("hands codeReviewParts the plugin reviewer type and a session suffix", () => {
			pool(CAP - 1000);
			injector(
				INJECTION_CAP - 500,
				"codeReviewParts: (h) => [h.reviewType + h.sidSuffix],",
			);
			expect(run("--json").json().injection.headroom).toBe(
				500 - "workflow-core:code-reviewer".length - "-check-co".length,
			);
		});
	});

	it("is BROKEN, naming each, when the module lacks an export the union reads", () => {
		pool(CAP - 1000);
		injector(INJECTION_CAP - 500, "codeReviewParts: undefined, INDEX: null,");
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("INDEX (an object)");
		expect(r.json().summary).toContain("codeReviewParts (a function)");
	});

	it("is BROKEN, never short, when a part's export throws", () => {
		pool(CAP - 1000);
		injector(
			INJECTION_CAP - 500,
			'codeReviewParts: () => { throw new Error("no standards"); },',
		);
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("no standards");
	});

	it("is BROKEN, running nothing, on a module that reaches for require", () => {
		pool(CAP - 1000);
		writeTextModule(
			dir,
			`require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "ran"))}, "");\n${textModuleSource("x")}`,
		);
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("will not evaluate");
		expect(fs.existsSync(path.join(dir, "ran"))).toBe(false);
	});

	it("reports a breach under --notify, alongside the pool's", () => {
		pool(CAP + 500);
		injector(INJECTION_CAP + 700);
		const r = run("--notify");
		expect(r.stdout).toContain("ALWAYS-LOADED POOL OVER CAP");
		expect(r.stdout).toContain("INJECTED TRACKER DOCS OVER CAP");
		expect(r.status).toBe(0);
	});
});

function gate(...args: string[]) {
	const r = keptSpawn("fd").spawnSync(
		"node",
		[SCRIPT, "--against", "HEAD", ...args],
		{
			cwd: dir,
			encoding: "utf8",
		},
	);
	return { ...r, json: () => JSON.parse(r.stdout) };
}

describe("--against HEAD, the pre-commit gate (mantahostels#1224, mantahostels#1834)", () => {
	function git(...args: string[]) {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	}

	const mainRepo = defineTemplate(identityRepoTemplate);

	beforeEach(() => {
		mainRepo.instantiate(dir);
	});

	function baseline() {
		git("add", "-A");
		git("commit", "-q", "--no-verify", "-m", "baseline");
	}

	function stage(rel: string, bytes: number) {
		fs.writeFileSync(path.join(dir, rel), buildPoolText(rel, bytes));
		git("add", "--", rel);
	}

	function stageInjector(bytes: number) {
		injector(bytes);
		git("add", "--", TEXT_MODULE);
	}

	function totalIn(line: string) {
		const m = line.match(/ (\d+) B,/);
		if (!m) throw new Error(`no byte total in ${JSON.stringify(line)}`);
		return Number(m[1]);
	}

	it("passes an increase that leaves the pool inside its cap", () => {
		pool(CAP - 5000);
		baseline();
		stage("CLAUDE.md", 2000);
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("reads a commit dropping the style's import as shedding its second copy (#2034)", () => {
		pool(CAP - 100);
		baseline();
		const voice = fs.statSync(path.join(dir, VOICE_PATH)).size;
		const size = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", size + 200);
		expect(gate("--json").status).toBe(1);
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), "x".repeat(size + 200));
		git("add", "--", "CLAUDE.md");
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
		expect(run("--json").json().total).toBe(CAP - 100 + 200 - voice);
	});

	it("counts a staged name-only override as a shed, not a growth", () => {
		const desc = "z".repeat(600);
		skill("fat-desc", desc);
		pool(CAP - 200);
		baseline();
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ skillOverrides: { "fat-desc": "name-only" } }),
		);
		git("add", "--", ".claude/settings.json");
		const r = gate("--json");
		expect(r.json().outcome).toBe("OK");
		expect(r.status).toBe(0);
	});

	it("reads the overrides from git at the revision, never from disk", () => {
		const desc = "z".repeat(600);
		skill("fat-desc", desc);
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ skillOverrides: {} }),
		);
		pool(CAP - 200);
		baseline();
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ skillOverrides: { "fat-desc": "name-only" } }),
		);
		const fromGit = totalIn(gate("--json").json().inherited[0]);
		const fromDisk = run("--json").json();
		expect(fromGit - fromDisk.total).toBe(desc.length);
		expect(fromDisk.descriptions.ownBytes).toBe(0);
	});

	it("refuses a commit that stages settings which will not parse, reporting BROKEN and naming the settings file", () => {
		skill("fat-desc", "z".repeat(600));
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ skillOverrides: { "fat-desc": "name-only" } }),
		);
		pool(CAP - 200);
		baseline();
		fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "{ nope");
		git("add", "--", ".claude/settings.json");
		const r = gate();
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain(".claude/settings.json");
	});

	it("FAILs a commit that adds bytes to a pool at its cap, as a NEW-FAULT stating the pool size", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		const r = gate("--json");
		expect(r.json().outcome).toBe("FAIL");
		expect(r.json().findings[0].tag).toBe("NEW-FAULT");
		expect(r.json().added[0]).toContain(`always-loaded pool is ${CAP + 100} B`);
		expect(r.status).toBe(1);
	});

	it("names HEAD's own total and the bytes this commit adds", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		const r = gate();
		expect(r.status).toBe(1);
		const at = r.stderr.indexOf("are NOT in HEAD");
		expect(at, "the gate did not refuse").toBeGreaterThan(-1);
		const lines = r.stderr.slice(at).split("\n");
		expect(lines[1]).toContain("always-loaded pool is");
		expect(lines[2]).toBe(
			`  HEAD had ${CAP - 100} B, so this commit adds 200 B.`,
		);
	});

	it("names the delta for a surface HEAD was already over cap on", () => {
		pool(CAP + 500);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 300);
		const r = gate("--json");
		expect(r.status).toBe(1);
		const f = r.json().findings[0];
		expect(f.tag).toBe("NEW-FAULT");
		expect(f.base).toBe(CAP + 500);
		expect(f.delta).toBe(300);
		expect(gate().stderr).toContain(
			`HEAD had ${CAP + 500} B, so this commit adds 300 B.`,
		);
	});

	it("prints no delta beside a finding that measures nothing", () => {
		pool(CAP - 5000);
		baseline();
		const envelope = JSON.parse(
			runInProcess(SCRIPT, ["--root", dir, "--json"]).stdout,
		);
		const { measure } = PROFILES["context-budget"];
		if (!measure) throw new Error("the context-budget profile has no measure");
		expect(
			measure({ tag: "UNPARSEABLE-SETTINGS" }, "findings", envelope),
		).toBeUndefined();
	});

	it("carries the baseline and the delta as finding data, not prose alone", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		const r = gate("--json");
		expect(r.status).toBe(1);
		const f = r.json().findings[0];
		expect(f.tag).toBe("NEW-FAULT");
		expect(f.base).toBe(CAP - 100);
		expect(f.delta).toBe(200);
	});

	it("measures the injection surface against its own baseline, not the pool's", () => {
		pool(CAP - 5000);
		injector(INJECTION_CAP - 1);
		baseline();
		stageInjector(INJECTION_CAP + 300);
		const r = gate("--json");
		expect(r.status).toBe(1);
		const f = r.json().findings[0];
		expect(f.base).toBe(INJECTION_CAP - 1);
		expect(f.delta).toBe(301);
	});

	it("names the shed-candidate list in the refusal", () => {
		pool(CAP - 100);
		shedRegister();
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		expect(gate().stderr).toContain(
			"Candidates: docs/research/always-loaded-shed-candidates.md.",
		);
	});

	it("names no shed-candidate list where the host keeps none", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		const r = gate();
		expect(r.stderr).toContain("ALWAYS-LOADED POOL");
		expect(r.stderr).not.toContain("Candidates:");
	});

	it("names the mantahostels#1220 escape in the refusal, on both capped surfaces", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		expect(gate().stderr).toContain(
			"unpayable-correction trigger (mantahostels#1220)",
		);
	});

	describe("the admissibility prompt", () => {
		it("prints when a commit grows the pool, even inside the cap, and does not gate", () => {
			pool(CAP - 5000);
			baseline();
			const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
			stage("CLAUDE.md", before + 2000);
			const r = gate();
			expect(r.stderr).toContain("ADMISSIBILITY");
			expect(r.stderr).toContain("What already covers this need, and why");
			expect(r.stderr).toContain(
				".claude/skills/pressure-test/SKILL.md step 1",
			);
			expect(r.status).toBe(0);
			expect(gate("--json").json().added).toEqual([]);
		});

		it("charges the double-loaded file twice, as the cap does", () => {
			pool(CAP - 5000);
			baseline();
			const at = path.join(dir, VOICE_PATH);
			const was = run("--json").json().admissibility[0].bytes;
			stage(VOICE_PATH, fs.statSync(at).size + 100);
			expect(run("--json").json().admissibility[0].bytes - was).toBe(200);
			expect(gate().stderr).toContain("ADMISSIBILITY");
		});

		it("carries the pool files' own baseline and growth", () => {
			pool(CAP - 5000);
			baseline();
			const was = run("--json").json().admissibility[0].bytes;
			const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
			stage("CLAUDE.md", before + 2000);
			expect(gate().stderr).toContain(
				`HEAD had ${was} B, so this commit adds 2000 B.`,
			);
			const note = gate("--json")
				.json()
				.findings.find((f: { tag: string }) => f.tag === "NEW-NOTE");
			expect(note.base).toBe(was);
			expect(note.delta).toBe(2000);
		});

		it("stays silent when the commit does not grow the pool", () => {
			pool(CAP - 5000);
			baseline();
			const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
			stage("CLAUDE.md", before - 200);
			expect(gate().stderr).not.toContain("ADMISSIBILITY");
		});

		it("stays silent when nothing pool-related is staged", () => {
			pool(CAP - 5000);
			baseline();
			fs.writeFileSync(path.join(dir, "unrelated.md"), "x");
			git("add", "--", "unrelated.md");
			expect(gate().stderr).not.toContain("ADMISSIBILITY");
		});

		it("stays silent when only a skill description grows, not a pool file", () => {
			pool(CAP - 5000);
			skill("a-skill", "x".repeat(20));
			baseline();
			const was = run("--json").json().total;
			const at = path.join(dir, ".claude", "skills", "a-skill", "SKILL.md");
			const before = fs.readFileSync(at, "utf8");
			fs.writeFileSync(at, before.replace("x".repeat(20), "x".repeat(500)));
			git("add", "--", ".claude/skills/a-skill/SKILL.md");
			expect(run("--json").json().total).toBeGreaterThan(was);
			expect(gate().stderr).not.toContain("ADMISSIBILITY");
		});

		it("still fires alongside a refusal, and does not change the outcome", () => {
			pool(CAP - 100);
			baseline();
			const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
			stage("CLAUDE.md", before + 200);
			const r = gate("--json");
			expect(r.json().outcome).toBe("FAIL");
			expect(gate().stderr).toContain("ADMISSIBILITY");
		});
	});

	it("WARNs rather than FAILs an over-cap pool this commit did not increase, listing it as inherited rather than added", () => {
		pool(CAP + 500);
		baseline();
		fs.writeFileSync(path.join(dir, "unrelated.md"), "x");
		git("add", "--", "unrelated.md");
		const r = gate("--json");
		expect(r.json().outcome).toBe("WARN");
		expect(r.json().added).toEqual([]);
		expect(r.json().inherited[0]).toContain("always-loaded pool");
		expect(r.status).toBe(0);
	});

	it("passes a commit that sheds bytes while still over cap", () => {
		pool(CAP + 500);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before - 200);
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.json().inherited).toHaveLength(1);
		expect(r.json().outcome).toBe("WARN");
		expect(r.status).toBe(0);
	});

	it("FAILs a commit that adds to the injected docs, naming their own audit", () => {
		pool(CAP - 5000);
		injector(INJECTION_CAP - 1);
		shedRegister();
		baseline();
		stageInjector(INJECTION_CAP + 300);
		const r = gate("--json");
		expect(r.json().outcome).toBe("FAIL");
		expect(r.json().added[0]).toContain(
			`injected tracker docs are ${INJECTION_CAP + 300} B`,
		);
		expect(r.status).toBe(1);
		expect(gate().stderr).toContain("#1268");
	});

	it("ignores an over-cap worktree the commit has not staged", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		fs.writeFileSync(
			path.join(dir, "CLAUDE.md"),
			buildPoolText("CLAUDE.md", before + 500),
		);
		expect(gate("--json").json().added).toEqual([]);
		expect(gate("--json").status).toBe(0);
		expect(run("--json").json().outcome).toBe("WARN");
	});

	it("FAILs a commit landing exactly ON the cap, saying exactly at rather than 0 B over", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 100);
		const r = gate("--json");
		expect(r.json().added).toHaveLength(1);
		expect(r.json().outcome).toBe("FAIL");
		expect(r.status).toBe(1);
		expect(r.json().added[0]).toContain("exactly at");
		expect(r.json().added[0]).not.toContain("0 B over");
	});

	it("raises nothing at exactly the cap when the commit did not grow it", () => {
		pool(CAP);
		baseline();
		fs.writeFileSync(path.join(dir, "unrelated.md"), "x");
		git("add", "--", "unrelated.md");
		expect(gate("--json").json().added).toEqual([]);
		expect(gate("--json").status).toBe(0);
	});

	it("prints the surface and the shed candidates on a WARN, not just a count", () => {
		pool(CAP + 500);
		shedRegister();
		baseline();
		fs.writeFileSync(path.join(dir, "unrelated.md"), "x");
		git("add", "--", "unrelated.md");
		const r = gate();
		expect(r.stderr).toContain("500 B over");
		expect(r.stderr).toContain("always-loaded-shed-candidates.md");
	});

	it("measures the staged text module, not the working tree's", () => {
		pool(CAP - 5000);
		injector(INJECTION_CAP - 1);
		shedRegister();
		baseline();
		stageInjector(INJECTION_CAP + 300);
		injector(INJECTION_CAP - 1);
		expect(gate("--json").json().outcome).toBe("FAIL");
	});

	it("agrees with report mode on both totals over one tree", () => {
		pool(CAP - 5000);
		skill("house-thing", "one two three");
		agent("scout", "abcde");
		injector(30_000);
		baseline();
		const j = gate("--json").json();
		expect(j.indexSummary).toBe(run("--json").json().summary);
		expect(j.baselineSummary).toBe(j.indexSummary);
	});

	it("follows a symlinked pool file whose target is materialised too", () => {
		pool(CAP - 5000);
		const held = path.join(dir, ".agents", "skills");
		fs.mkdirSync(held, { recursive: true });
		fs.writeFileSync(path.join(held, "real-claude.md"), "x".repeat(4000));
		fs.rmSync(path.join(dir, "CLAUDE.md"));
		fs.symlinkSync(
			path.join(".agents", "skills", "real-claude.md"),
			path.join(dir, "CLAUDE.md"),
		);
		baseline();
		const j = gate("--json").json();
		expect(j.outcome).toBe("OK");
		expect(j.indexSummary).toBe(run("--json").json().summary);
	});

	it("is BROKEN, not followed, when a capped symlink escapes the tree", () => {
		pool(CAP - 5000);
		const outside = path.join(dir, "real-claude.md");
		fs.writeFileSync(outside, "x".repeat(4000));
		fs.rmSync(path.join(dir, "CLAUDE.md"));
		fs.symlinkSync(outside, path.join(dir, "CLAUDE.md"));
		baseline();
		const r = gate("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("outside the materialised tree");
		expect(r.status).toBe(2);
	});

	it("reads a capped file missing from the index as bytes this commit shed", () => {
		pool(CAP - 100);
		baseline();
		git("rm", "-q", "--cached", "--", SPARE_PATH);
		const r = gate("--json");
		expect(r.status).toBe(0);
		expect(r.json().outcome).not.toBe("BROKEN");
	});

	it("refuses a first commit over the cap, against the empty tree", () => {
		pool(CAP + 500);
		git("add", "-A");
		const r = gate("--json");
		expect(r.json().outcome).toBe("FAIL");
		expect(r.status).toBe(1);
	});

	it("charges an own skill's description to the pool, and a vendored one to nothing", () => {
		pool(CAP - 9);
		baseline();
		skill("house-thing", "abcdefghij");
		skill("vendored-thing", "abcdefghij", true);
		git("add", "-A");
		const r = gate("--json");
		expect(totalIn(r.json().added[0])).toBe(CAP - 9 + 10);
	});

	it("charges nothing for a staged skill the model cannot invoke", () => {
		pool(CAP - 9);
		baseline();
		skill("house-thing", "abcdefghij");
		skill("house-dead", "abcdefghij", false, true);
		git("add", "-A");
		const r = gate("--json");
		expect(totalIn(r.json().added[0])).toBe(CAP - 9 + 10);
	});

	it("refuses nothing when a commit enables a plugin, priced or unpriced", () => {
		pool(CAP - 1000);
		fs.writeFileSync(
			path.join(dir, ".claude", "plugin-context-cost.json"),
			JSON.stringify({ plugins: { "a@m": { tokens: 529 } } }),
		);
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "a@m": false } }),
		);
		baseline();
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "a@m": true, "unpriced@m": true } }),
		);
		git("add", "--", ".claude/settings.json");
		const r = gate("--json");
		expect(r.status).toBe(0);
		expect(r.json().added ?? []).toEqual([]);
	});
});

describe("an adopter's machine-mirrored rules (#5683)", () => {
	function git(...args: string[]) {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	}

	const mainRepo = defineTemplate(identityRepoTemplate);
	const HeadPool =
		CAP + 500 + 1000 + "## Ground truth\n\n\n\n## Machine\n\nlast\n".length;
	const sections = MIRRORED_SECTIONS.map(
		(h) => `## ${h}\n\n${"m".repeat(200)}\n\n`,
	).join("");
	const rules = (own: number) =>
		`## Ground truth\n\n${"g".repeat(own)}\n\n${sections}## Machine\n\nlast\n`;
	const writeRules = (text: string) => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(dir, MIRRORED_FILE), text);
	};

	beforeEach(() => {
		mainRepo.instantiate(dir);
		vi.stubEnv(
			"WFC_ALWAYS_LOADED",
			[...getPoolFiles(), MIRRORED_FILE].join(","),
		);
		pool(CAP + 500);
		writeRules(
			`## Ground truth\n\n${"g".repeat(1000)}\n\n## Machine\n\nlast\n`,
		);
		git("add", "-A");
		git("commit", "-q", "--no-verify", "-m", "baseline");
	});

	const stageWalk = (own: number) => {
		writeRules(rules(own));
		const claude = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		fs.writeFileSync(
			path.join(dir, "CLAUDE.md"),
			buildPoolText("CLAUDE.md", claude - 100),
		);
		git("add", "-A");
	};

	it("passes an over-cap walk that adds the sections and nets its other growth to zero", () => {
		stageWalk(1100);
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("refuses one byte more, quoting a delta that leaves the sections out", () => {
		stageWalk(1101);
		const r = gate();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			`HEAD had ${HeadPool} B, so this commit adds 1 B.`,
		);
	});

	it("prints the sections as their own uncapped row, out of the pool total", () => {
		writeRules(rules(1000));
		const j = run("--json").json();
		expect(j.mirrored.bytes).toBe(Buffer.byteLength(sections));
		expect(j.total).toBe(HeadPool);
		expect(run().stderr).toContain(
			`MACHINE-MIRRORED RULES — ${Buffer.byteLength(sections)} B of ${MIRRORED_FILE}, outside the pool above. Uncapped.`,
		);
	});

	it("counts those headings whole in any other pool file", () => {
		fs.appendFileSync(path.join(dir, "CLAUDE.md"), `\n${sections}`);
		expect(run("--json").json().total).toBe(
			HeadPool + 1 + Buffer.byteLength(sections),
		);
	});
});

describe("--against HEAD outside a git repository", () => {
	it("is BROKEN outside a git repository, never an empty baseline", () => {
		pool(CAP + 500);
		const r = gate("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.status).toBe(2);
	});
});

describe("always-enabled plugins", () => {
	const tablePath = ".claude/plugin-context-cost.json";

	function enabled(plugins: Record<string, boolean>) {
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: plugins }, null, 2),
		);
	}

	function table(
		plugins: Record<
			string,
			{ tokens: number; measured?: string; uncounted?: string }
		>,
		raw?: string,
	) {
		fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, tablePath),
			raw ?? JSON.stringify({ plugins }, null, 2),
		);
	}

	it("sums the enabled plugins' tokens from the table and names the uncounted ones", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true, "b@m": true });
		table({
			"a@m": { tokens: 22, measured: "2026-09-06" },
			"b@m": {
				tokens: 0,
				measured: "2026-09-06",
				uncounted: "MCP tool schemas",
			},
		});
		const r = run("--json");
		expect(r.json().outcome).toBe("OK");
		expect(r.json().plugins).toMatchObject({
			tokens: 22,
			enabled: 2,
			unpriced: [],
			uncounted: ["b@m"],
		});
		const text = run().stderr;
		expect(text).toContain(
			"ALWAYS-ENABLED PLUGINS — ~22 tok across 2, uncounted: b@m. Uncapped.",
		);
	});

	it("lists a disabled plugin and leaves it out of the sum", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true, "gated@m": false });
		table({ "a@m": { tokens: 22 }, "gated@m": { tokens: 529 } });
		const j = run("--json").json();
		expect(j.plugins.tokens).toBe(22);
		expect(j.plugins.enabled).toBe(1);
		expect(j.plugins.entries).toContainEqual({
			name: "gated@m",
			enabled: false,
			tokens: 529,
		});
		expect(run().stderr).toContain("gated@m  [disabled — listed, not summed]");
	});

	it("WARNs on an enabled plugin with no row, never pricing it at zero, naming the plugin and printing its tokens as ?", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true, "new@m": true });
		table({ "a@m": { tokens: 22 } });
		const r = run("--json");
		expect(r.json().outcome).toBe("WARN");
		const finding = r
			.json()
			.findings.find((f: { tag: string }) => f.tag === "UNPRICED-PLUGIN");
		expect(finding?.severity).toBe("WARN");
		expect(finding?.surface).toBe("plugin:new@m");
		expect(finding?.message).toContain("new@m is enabled");
		expect(r.json().plugins.unpriced).toEqual(["new@m"]);
		expect(r.json().plugins.tokens).toBe(22);
		expect(run().stderr).toMatch(/\?\s+tok\s+new@m/);
	});

	it("prices an enabled wfc-self at the core's hooks-only row with no table row (#2445)", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true, "wfc-self@wfc-self": true });
		table({ "a@m": { tokens: 22 } });
		const j = run("--json").json();
		expect(j.outcome).toBe("OK");
		expect(j.plugins.unpriced).toEqual([]);
		expect(j.plugins.tokens).toBe(22);
		expect(j.plugins.entries).toContainEqual({
			name: "wfc-self@wfc-self",
			enabled: true,
			tokens: 0,
			measured: "2026-10-22",
		});
	});

	it("does not WARN on a disabled plugin with no row", () => {
		pool(CAP - 1000);
		enabled({ "off@m": false });
		table({});
		const r = run("--json");
		expect(r.json().outcome).toBe("OK");
		expect(r.json().findings ?? []).toEqual([]);
	});

	it("WARNs every enabled plugin unpriced when the table is absent", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true });
		const j = run("--json").json();
		expect(j.outcome).toBe("WARN");
		expect(j.plugins.unpriced).toEqual(["a@m"]);
	});

	it("is BROKEN on a table that will not parse, naming the table file", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true });
		table({}, "{ not json");
		const j = run("--json").json();
		expect(j.outcome).toBe("BROKEN");
		expect(j.summary).toContain("plugin-context-cost.json");
	});

	it("is BROKEN on a table that exists but will not read, naming the table file", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true });
		fs.mkdirSync(path.join(dir, tablePath), { recursive: true });
		const j = run("--json").json();
		expect(j.outcome).toBe("BROKEN");
		expect(j.summary).toContain("cannot read .claude/plugin-context-cost.json");
	});

	it("prices nothing and raises nothing with no settings file", () => {
		pool(CAP - 1000);
		table({ "a@m": { tokens: 22 } });
		const j = run("--json").json();
		expect(j.plugins).toMatchObject({ tokens: 0, enabled: 0, entries: [] });
		expect(j.findings ?? []).toEqual([]);
	});

	it("stays silent under --notify while every cap holds", () => {
		pool(CAP - 1000);
		enabled({ "a@m": true });
		table({ "a@m": { tokens: 22 } });
		expect(run("--notify").stdout.trim()).toBe("");
	});
});

describe("the core layer beneath an adopter's own store (#101, #109)", () => {
	function fallbackStore(fragments: Record<string, string>) {
		const at = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-fallback-"));
		rulesFallbackDirs.push(at);
		for (const [id, body] of Object.entries(fragments))
			fs.writeFileSync(path.join(at, `${id}.txt`), body);
		vi.stubEnv("WFC_RULES_FALLBACK_DIR", at);
	}

	function wireGuard(id: string) {
		fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "scripts", "guard-a.js"),
			`module.exports = () => ({ injectRules: ["${id}"] });\n`,
		);
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [
								{
									type: "command",
									command: 'node "$CLAUDE_PROJECT_DIR"/scripts/guard-a.js',
								},
							],
						},
					],
				},
			}),
		);
	}

	it("resolves a core guard's id an adopter root's own store lacks", () => {
		pool(CAP - 1000);
		fallbackStore({ "core-only": "c".repeat(37) });
		wireGuard("core-only");
		const r = run("--json").json();
		expect(r.session.tools.Bash.bytes).toBe(37);
		expect(r.session.tools.Bash.ids).toEqual(["core-only"]);
	});

	it("resolves a fixture id against the pinned store, never the live core one", () => {
		const liveId = fs
			.readdirSync(CORE_RULES)
			.find((f) => f.endsWith(".txt"))
			?.replace(/\.txt$/, "");
		if (!liveId)
			throw new Error(
				"this repo's core rule store has no fragment to collide on",
			);
		const liveBytes = fs.statSync(path.join(CORE_RULES, `${liveId}.txt`)).size;

		pool(CAP - 1000);
		fallbackStore({ [liveId]: "x".repeat(11) });
		wireGuard(liveId);
		const r = run("--json").json();
		expect(r.session.tools.Bash.bytes).toBe(11);
		expect(r.session.tools.Bash.bytes).not.toBe(liveBytes);
	});

	it("is BROKEN, naming the id, where neither the adopter root nor the pinned fallback carries it", () => {
		pool(CAP - 1000);
		fallbackStore({});
		wireGuard("missing-everywhere");
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("missing-everywhere");
	});
});
