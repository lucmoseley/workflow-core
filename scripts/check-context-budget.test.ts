// @vitest-environment node
/*
 * The checker reports on this repo's own always-loaded files, so it cannot also
 * be its own fixture: every test builds a throwaway repo and points --root at it.
 * TWO EXCEPTIONS, and neither runs the checker over the real tree — the
 * skill-naming assertion under `skillOverrides` reads the real `.claude/skills`,
 * because what it pins is a property of this repo's skills rather than of the
 * checker's logic (mantahostels#1786); and "the core layer beneath an adopter's own
 * store" reads the real `docs/agents/rules` to find a live id to collide on
 * (#109), the checker itself still pointed at a throwaway --root.
 *
 * Pinned here is each cap's behaviour, not its value. Severity turns on DIRECTION
 * (mantahostels#1224): the checker itself only ever WARNs over cap, and `--against HEAD`
 * refuses exactly the commit that ADDS bytes to a surface at or over it (mantahostels#1834,
 * which replaced --staged). --notify stays silent while both surfaces are inside
 * their caps. What each cap COVERS is pinned too — the scope settled at mantahostels#1235, a
 * silent drift in membership being the failure it guards.
 *
 * .husky/pre-commit runs it under `--against HEAD`: loosen a case and a commit
 * can grow the context every session loads past its cap unrefused, or a
 * commit that trims it is refused.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPoolFiles } from "./lib/always-loaded-pool.js";
import { SHED_REGISTERS } from "./lib/context-budget-pathspecs";
import { liveCaps } from "./lib/context-budget-testkit";
import { PROFILES } from "./lib/fault-profiles.js";
/* The core rule store's own path, so a fixture can find a real id to collide
 * on (#109) without restating rule-text.js's own resolution. */
import { CORE_RULES } from "./lib/rule-text";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-context-budget.js");
const { pool: CAP, injection: INJECTION_CAP } = liveCaps();

let dir: string;

let savedInjectorEnv: string | undefined;
let savedOutputStyleEnv: string | undefined;
let savedRulesFallbackEnv: string | undefined;
/** Every throwaway fallback store minted this test, drained in afterEach. */
const rulesFallbackDirs: string[] = [];

/**
 * The first pool member the host's own `alwaysLoaded` names that `pick` accepts —
 * never a literal this file picks itself (#45, #161).
 */
function poolMember(pick: (rel: string) => boolean, missing: string): string {
	const p = getPoolFiles().find(pick);
	if (!p)
		throw new Error(
			`this suite's alwaysLoaded pool has ${missing} — check vitest.setup.ts's WFC_ALWAYS_LOADED default`,
		);
	return p;
}

/** The style member: the one `vitest.setup.ts` read off this checkout's `overrides.output_style`. */
const VOICE_PATH: string = poolMember(
	(f) => f === process.env.WFC_OUTPUT_STYLE,
	"no member matching WFC_OUTPUT_STYLE",
);

/** A member a case can drop or break without touching `CLAUDE.md` or the style. */
const SPARE_PATH: string = poolMember(
	(f) => f !== "CLAUDE.md" && f !== VOICE_PATH,
	"no member beyond CLAUDE.md and the style to spare",
);

beforeEach(() => {
	savedOutputStyleEnv = process.env.WFC_OUTPUT_STYLE;
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-"));
	fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
	/* check-context-budget.js reads the injector off its own core location, never
	 * off --root (#36), so every fixture below is pointed at through the
	 * WFC_INJECTOR_FILE test-injection seam (`lib/host-root.js`'s header
	 * convention) rather than relying on `--root dir` to find it. Every fixture
	 * in this file writes the same fixed path, so the seam is set once here. */
	savedInjectorEnv = process.env.WFC_INJECTOR_FILE;
	process.env.WFC_INJECTOR_FILE = path.join(
		dir,
		"scripts",
		"inject-tracker-docs.sh",
	);
	/* Pinned to a fresh, empty throwaway store by default, so no fixture in this
	 * file can resolve an injected id against the LIVE core store beneath
	 * `docs/agents/rules` by accident, colliding silently instead of throwing
	 * (#109's second gap). `fallbackStore()` below overrides this per case for
	 * one that wires an injecting guard on purpose. */
	savedRulesFallbackEnv = process.env.WFC_RULES_FALLBACK_DIR;
	const emptyFallback = fs.mkdtempSync(
		path.join(os.tmpdir(), "ctxbudget-fallback-"),
	);
	rulesFallbackDirs.push(emptyFallback);
	process.env.WFC_RULES_FALLBACK_DIR = emptyFallback;
	/* One byte INSIDE the cap, not on it: both surfaces gate at or over their cap
	 * (mantahostels#1834 unified report mode on the gate's boundary), so a baseline sitting
	 * exactly on it would breach in every test that does not mean to. */
	injector(["docs/agents/issue-tracker.md"], INJECTION_CAP - 1);
});

/* The fixture injector's own prose, which the cap counts (mantahostels#1284). */
const FIXTURE_HEADER = "You invoked /implement, a fixture header.";

/**
 * What the injector contributes beyond the documents' own bytes: its header, the
 * blank line joining the two halves, and the marker pair around each document —
 * less the trailing newline `body="$(cat "$f")"` strips off every one.
 *
 * Restated here rather than imported: a test that computed this the checker's way
 * would pass whatever the checker did.
 */
function overhead(docs: string[]) {
	return docs.reduce(
		(n, rel) =>
			n +
			Buffer.byteLength(`--- BEGIN ${rel} ---\n`) +
			Buffer.byteLength(`\n--- END ${rel} ---\n\n`) -
			1,
		Buffer.byteLength(FIXTURE_HEADER) + 2,
	);
}

/**
 * The injector and the docs it names, sized so the whole injected surface weighs
 * `bytes`. The checker reads the `DOCS=(...)` array and the header assignments out
 * of the script rather than restating either, so the fixture writes real ones.
 */
function injector(docs: string[], bytes: number, extra = "") {
	fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "scripts", "inject-tracker-docs.sh"),
		/* `matched=""` is the real script's own initialiser, and is here so the
		 * fixture pins that it does not overwrite the command the cap measures (mantahostels#1284). */
		`#!/usr/bin/env bash\nDOCS=(${docs.join(" ")})\nmatched=""\n` +
			`header="You invoked /\${matched}, a fixture header."\n${extra}`,
	);
	const body = bytes - overhead(docs);
	const each = Math.floor(body / docs.length);
	docs.forEach((rel, i) => {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		const n = i === docs.length - 1 ? body - each * (docs.length - 1) : each;
		fs.writeFileSync(path.join(dir, rel), "x".repeat(n));
	});
}

/** An agent definition, whose name and description are all that reach the prompt. */
function agent(name: string, description: string, body = "") {
	fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
	);
}

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	if (savedInjectorEnv === undefined) delete process.env.WFC_INJECTOR_FILE;
	else process.env.WFC_INJECTOR_FILE = savedInjectorEnv;
	if (savedOutputStyleEnv === undefined) delete process.env.WFC_OUTPUT_STYLE;
	else process.env.WFC_OUTPUT_STYLE = savedOutputStyleEnv;
	if (savedRulesFallbackEnv === undefined)
		delete process.env.WFC_RULES_FALLBACK_DIR;
	else process.env.WFC_RULES_FALLBACK_DIR = savedRulesFallbackEnv;
	for (const d of rulesFallbackDirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/** `bytes` of a pool file, `CLAUDE.md`'s opening on the style's import. */
function buildPoolText(rel: string, bytes: number) {
	const head = rel === "CLAUDE.md" ? `@${VOICE_PATH}\n` : "";
	return head + "x".repeat(bytes - head.length);
}

/**
 * Write the four pool files so the pool MEASURES `bytes`, and declare the
 * fourth as the double-loaded style (`WFC_OUTPUT_STYLE`, #45's test-injection
 * seam for `overrides.output_style`), `@`-imported by `CLAUDE.md`, so it is
 * counted twice (mantahostels#1503); a caller wanting the undeclared case
 * overrides afterwards. The style takes a fifth of the target and the other
 * three share what is left after both its copies.
 */

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
	process.env.WFC_OUTPUT_STYLE = VOICE_PATH;
}

/** The core's two shed registers, which a cap refusal names only where the
 * host keeps them (#1673). */
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
		/* RELATIVE, as the repo's own 24 vendored links are: a fixture built on an
		 * absolute one passes --against by escaping to the worktree (mantahostels#1834). */
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

/*
 * The direction gate reads THIS checker's envelope through
 * lib/fault-profiles.js's `context-budget` profile, and that profile names the
 * finding's fields — `tag`, `surface`, `total` — as string literals of its own
 * (mantahostels#1938). The tags are a shared module; the field names are not and cannot be,
 * being payload keys rather than values. So the coupling is pinned by
 * feeding the profile the REAL envelope rather than a hand-built fixture, which
 * would carry the profile's own spelling and see nothing.
 */
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
			injector(["docs/agents/issue-tracker.md"], INJECTION_CAP + over);
			return run("--json").json();
		};
		const smaller = at(700);
		const bigger = at(1700);

		expect(direction(bigger, smaller).code).toBe(1);
		expect(direction(smaller, bigger).code).toBe(0);
	});

	/*
	 * mantahostels#1939. `measure` reads a surface's total off the ENVELOPE and never off a
	 * fault list, because the commit whose delta matters most is the one that
	 * first breaches a cap — and its baseline carries no finding at all.
	 */
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
		// The mantahostels#1177 prompt fires on a pool that GREW without breaching anything.
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
		/* ABSENT is not UNREADABLE. A pool member the tree never carried — the
		 * spare here; AGENTS.md in this core itself (#161) — costs the session no
		 * context, so it drops out of the measurement rather than reporting the
		 * instrument as broken and refusing every commit in that tree. The cap can
		 * only be under-counted this way, never over, so no breach hides behind
		 * it. */
		pool(CAP - 1000);
		const absent = fs.statSync(path.join(dir, SPARE_PATH)).size;
		fs.rmSync(path.join(dir, SPARE_PATH));

		const r = run("--json");
		expect(r.status).toBe(0);
		expect(r.json().outcome).toBe("OK");
		expect(r.json().total).toBe(CAP - 1000 - absent);
	});

	it("is BROKEN, not OK, when a pool file is there but will not read", () => {
		/* A self-referential symlink is present at the path and answers ELOOP,
		 * which is the instrument failing over scope it was meant to cover. */
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

	/* "0 B over" would read as a rounding artefact (mantahostels#1940). */
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

	/* mantahostels#1757. */
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

/*
 * mantahostels#1786. `skillOverrides` in .claude/settings.json silences a description without
 * touching the file that carries it — which is why it reaches the vendored,
 * hash-locked skills a frontmatter edit cannot hold.
 */
describe("skillOverrides", () => {
	/** Write .claude/settings.json carrying exactly these overrides. */
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

	/* The expected lines are the harness's own, probed on 2.1.302 (#2054). */
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

	/*
	 * The settings schema keys by SKILL NAME; the checker derives the key from the
	 * directory name. That is only sound while the two agree, so assert it against
	 * the real repo — a vendored skill arriving with a frontmatter name unlike its
	 * directory would silently un-apply its override.
	 */
	it("keys every real skill by a directory name matching its frontmatter name", () => {
		/* A vendored skill is a link into .agents/skills/, keyed by the link's
		 * name, so the link keeps the vendored directory's name. */
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
			/* A missing `name:` is reported, not filtered away: it is exactly the
			 * shape that would hide a mismatch from this assertion. */
			.filter((s) => s.declared?.trim() !== s.name);
		expect(mismatched).toEqual([]);
	});

	/*
	 * BROKEN (mantahostels#2004), and the whole run with it: settings that will not parse
	 * leave the PreToolUse wiring unknown, and the session cap reported as 0 B
	 * there would pass whatever is really wired. The descriptions limb still
	 * charges everything, but the charge is not
	 * observable through a full run, so what stays asserted here is the WARN, on
	 * which the direction diff depends and which survives inside the BROKEN
	 * envelope.
	 */
	it("is BROKEN, and still says so, when the settings JSON will not parse", () => {
		pool(CAP - 1000);
		skill("thing", "one two three four");
		settings({}, "{ this is not json");
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain(".claude/settings.json");
		/* An unreadable settings file is not the same fact as no overrides, so it
		 * must be said rather than folded silently into a full charge. A FINDING
		 * (mantahostels#1834), not only a stream write: --against reads the envelope, and
		 * a note that reaches stderr alone cannot reach the direction diff. */
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

	/*
	 * MUTATION SURVIVOR. Replacing the checker's
	 * `typeof value === "object"` guard with a bare `value ?? {}` leaves this
	 * green, because indexing a string by a skill name already yields undefined
	 * and charges the description anyway. The guard is belt-and-braces over
	 * behaviour that is correct without it, so treat it as UNVERIFIED.
	 */
	it("charges every description when skillOverrides is not an object", () => {
		pool(CAP - 1000);
		skill("thing", "one two three four");
		settings({}, JSON.stringify({ skillOverrides: "name-only" }));
		expect(run("--json").json().descriptions.ownWords).toBe(4);
	});
});

/*
 * The scope settled at mantahostels#1235: the pool is every byte in EVERY session's context
 * before any work that this repo can delete. These pin membership.
 */
describe("what the pool covers", () => {
	it("counts own descriptions inside the pool total, not beside it", () => {
		pool(CAP - 1000);
		skill("house-thing", "abcdefghij"); // 10 B
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
		process.env.WFC_OUTPUT_STYLE = "";
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
		process.env.WFC_OUTPUT_STYLE = unpooled;
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
	/* An injector off the host's own scripts/ path, as a plugin install's is,
	 * whose payload names the command and a file read off the host; /triage,
	 * and every command where the host has no such file, fails. */
	function coreInjector(): string {
		fs.mkdirSync(path.join(dir, "core"));
		const script = path.join(dir, "core", "inject-tracker-docs.sh");
		fs.writeFileSync(
			script,
			"#!/usr/bin/env bash\nDOCS=()\nCOMMANDS=(implement triage)\n" +
				`matched=""\nheader="You invoked /\${matched}, a fixture header."\n` +
				`input="$(cat)"\ncmd="\${input#*/}"\ncmd="\${cmd%% *}"\n` +
				'[ "$cmd" = triage ] && exit 1\n' +
				'host="$(cat "$CLAUDE_PROJECT_DIR/host.txt")" || exit 1\n' +
				'printf \'{"hookSpecificOutput":{"additionalContext":"%s %s"}}\' "$cmd" "$host"\n',
		);
		fs.rmSync(path.join(dir, "scripts", "inject-tracker-docs.sh"));
		process.env.WFC_INJECTOR_FILE = script;
		return script;
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

	it("renders nothing where the host carries its own injector", () => {
		pool(CAP - 1000);
		expect(run("--json").json().injection.rendered).toBeNull();
	});
});

describe("the injected tracker docs", () => {
	it("is OK with headroom while the injection is inside its own cap", () => {
		pool(CAP - 1000);
		injector(["docs/agents/issue-tracker.md"], INJECTION_CAP - 500);
		const j = run("--json").json();
		expect(j.outcome).toBe("OK");
		expect(j.injection.headroom).toBe(500);
	});

	it("WARNs on its own tag, OVER-INJECTION, and never gates, recording the negative headroom", () => {
		pool(CAP - 1000);
		injector(["docs/agents/issue-tracker.md"], INJECTION_CAP + 700);
		const r = run("--json");
		expect(r.json().outcome).toBe("WARN");
		expect(r.json().findings[0].tag).toBe("OVER-INJECTION");
		expect(r.json().injection.headroom).toBe(-700);
		expect(r.status).toBe(0);
	});

	it("never touches the pool's own headroom", () => {
		pool(CAP - 1000);
		injector(["docs/agents/issue-tracker.md"], INJECTION_CAP + 700);
		expect(run("--json").json().headroom).toBe(1000);
	});

	/* mantahostels#2499 narrowed /implement's payload to a residue index in place of the two
	 * documents. That index is prose in the injected payload like any other
	 * header string, so it counts against the cap — leaving it out would read a
	 * relocation as a shed, which is exactly what mantahostels#1284 built PAYLOAD_VARS to
	 * stop. */
	it("counts the residue index /implement takes in place of the documents", () => {
		pool(CAP - 1000);
		const pointer = "y".repeat(400);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP - 500,
			`tracker_index="${pointer}"\n`,
		);
		expect(run("--json").json().injection.headroom).toBe(500 - 400);
	});

	/* The other half of mantahostels#1817: the injector filters a document out of one
	 * command's payload, and the cap must not follow it down. Narrowing what is
	 * measured narrows the cap by the same bytes and returns no headroom at all
	 * (c00aa652a160), so the cap reads DOCS and never the per-command
	 * set — a later session teaching it about `docs_for_command` would shed ~15 KB
	 * of cap while costing every other command exactly what it cost before. */
	it("counts a doc the injector drops from one command's payload", () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md"],
			INJECTION_CAP - 500,
			"LABEL_DOC=docs/agents/triage-labels.md\n" +
				'docs_for_command=("docs/agents/issue-tracker.md")\n',
		);
		// The fixture sizes BOTH documents to 500 B under the cap. Reading the
		// per-command set instead would leave one of them out and the headroom
		// would be that document's whole size, not 500.
		expect(run("--json").json().injection.headroom).toBe(500);
	});

	/* The real injector writes tracker_index one level deep inside an `if`
	 * block, as `$'\n\n'"..."` — a $'...' literal concatenated straight onto a
	 * "..." one, no operator between them. This case nests it a second level,
	 * which the parser must handle just as well since nothing about its
	 * indentation logic assumes a fixed depth. */
	it("parses an indented $'\\n\\n' literal concatenated onto a quoted string", () => {
		pool(CAP - 1000);
		const filler = "y".repeat(400);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP - 500,
			`if [[ "$matched" == "implement" ]]; then\n` +
				`  if [[ -n "$x" ]]; then\n` +
				`    tracker_index=$'\\n\\n'"${filler}"\n` +
				"  fi\n" +
				"fi\n",
		);
		expect(run("--json").json().injection.headroom).toBe(
			500 - (2 + filler.length),
		);
	});

	/* A variable reference inside the array reaches the cap as a literal,
	 * unreadable path, and BREAKS rather than silently resolving to the file
	 * it names. */
	it("is BROKEN when DOCS names a variable reference instead of a literal path", () => {
		pool(CAP - 1000);
		fs.mkdirSync(path.join(dir, "docs", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "docs", "agents", "issue-tracker.md"),
			"x".repeat(100),
		);
		fs.writeFileSync(
			path.join(dir, "scripts", "inject-tracker-docs.sh"),
			"#!/usr/bin/env bash\n" +
				"LABEL_DOC=docs/agents/triage-labels.md\n" +
				`DOCS=(docs/agents/issue-tracker.md \${LABEL_DOC})\nmatched=""\n` +
				`header="You invoked /\${matched}, a fixture header."\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("LABEL_DOC");
	});

	/* The assignment regex requires a quoted or $-led RHS, so a bare
	 * NAME=value never enters `vars` — and every ${NAME} referring to it then
	 * returns null, tripping `unparsed` on any string over PROSE_BYTES rather
	 * than being silently dropped. */
	it("is BROKEN when a bare assignment feeds an unresolved interpolation into a long header string", () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP,
			"LABEL_DOC=docs/agents/triage-labels.md\n" +
				`header="You invoked /\${matched}. \${LABEL_DOC} ${"z".repeat(100)}"\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("header");
	});

	it("follows a doc added to the injector rather than a list restated here", () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md"],
			INJECTION_CAP,
		);
		const j = run("--json").json();
		expect(j.injection.files.map((f: { path: string }) => f.path)).toEqual([
			"docs/agents/issue-tracker.md",
			"docs/agents/triage-labels.md",
			"scripts/inject-tracker-docs.sh (header + markers)",
		]);
		expect(j.injection.total).toBe(INJECTION_CAP);
	});

	it("counts the injector's own header and markers, not the DOCS array alone", () => {
		pool(CAP - 1000);
		const docs = ["docs/agents/issue-tracker.md"];
		injector(docs, INJECTION_CAP);
		const j = run("--json").json();
		const doc = j.injection.files.find(
			(f: { path: string }) => f.path === docs[0],
		);
		expect(j.injection.total).toBe(doc.bytes + overhead(docs));
		expect(j.injection.total).toBeGreaterThan(doc.bytes);
	});

	it("counts a string the header reaches by interpolation, so relocating into one is not a shed", () => {
		pool(CAP - 1000);
		const docs = ["docs/agents/issue-tracker.md"];
		const rule = "y".repeat(400);
		injector(
			docs,
			INJECTION_CAP,
			`priced_options="${rule}"\nclosing_steps="\${priced_options}"\n`,
		);
		const j = run("--json").json();
		/* priced_options is counted once as itself and once through closing_steps,
		 * exactly as the injector concatenates both into the payload. */
		expect(j.injection.total).toBe(INJECTION_CAP + 2 * rule.length);
	});

	it("is BROKEN, never short, on a header string it cannot evaluate, naming the variable", () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP,
			`priced_options="$(cat ${"z".repeat(120)})"\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().summary).toContain("priced_options");
	});

	describe("the priced-options pointer (#2039)", () => {
		const whole = `priced_options_whole="${"w".repeat(400)}"\n`;
		const pointer = `priced_options="${"p".repeat(150)}"\n`;

		it("measures the pointer and not the whole shape it falls back to", () => {
			pool(CAP - 1000);
			injector(
				["docs/agents/issue-tracker.md"],
				INJECTION_CAP - 500,
				`${whole}${pointer}wfc_core_voice_loaded || priced_options="$priced_options_whole"\n`,
			);
			expect(run("--json").json().injection.total).toBe(
				INJECTION_CAP - 500 + 150,
			);
		});

		it("is BROKEN where the last column-zero assignment takes the whole shape", () => {
			pool(CAP - 1000);
			injector(
				["docs/agents/issue-tracker.md"],
				INJECTION_CAP - 500,
				`${whole}${pointer}priced_options="\${priced_options_whole}"\n`,
			);
			const r = run("--json");
			expect(r.status).toBe(2);
			expect(r.json().summary).toContain("priced_options_whole");
		});
	});

	it("counts a rule fragment the injector reads through rule_text, from the root's store", () => {
		pool(CAP - 1000);
		fs.mkdirSync(path.join(dir, "docs", "agents", "rules"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, "docs", "agents", "rules", "fixture-shape.txt"),
			`${"f".repeat(300)}\n`,
		);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP,
			`dispatch_shape="$(rule_text fixture-shape 2>/dev/null)"\ndispatch="\${dispatch_shape}"\n`,
		);
		expect(run("--json").json().injection.total).toBe(INJECTION_CAP + 300);
	});

	it("is BROKEN, never short, on a rule fragment that will not read", () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP,
			`dispatch_shape="$(rule_text no-such-fixture-id 2>/dev/null)"\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().summary).toContain("dispatch_shape");
	});

	it("is BROKEN when the injector assigns no header at all", () => {
		pool(CAP - 1000);
		fs.writeFileSync(
			path.join(dir, "scripts", "inject-tracker-docs.sh"),
			"#!/usr/bin/env bash\nDOCS=(docs/agents/issue-tracker.md)\n",
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().summary).toContain("no header=");
	});

	it("is BROKEN on a long string emitted into a variant this cap does not measure, naming the variable", () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP,
			`review_only="${"y".repeat(400)}"\nemit "\${review_only}"\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().summary).toContain("review_only");
	});

	/* mantahostels#1853: emit "$context" is a bare $var, so namesIn() alone read nothing off
	 * it and a string reached only through the context= assembly counted as
	 * zero. */
	it('is BROKEN on a long string reached only through a bare `emit "$context"`, naming the variable that holds it', () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP,
			`review_only="${"y".repeat(400)}"\ncontext="\${review_only}"\nemit "$context"\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("review_only");
	});

	/* mantahostels#1853: the ownBytes guard this needs. */
	it('is OK when `emit "$context"` only reaches names PAYLOAD_VARS already counts', () => {
		pool(CAP - 1000);
		const filler = "z".repeat(40);
		injector(
			["docs/agents/issue-tracker.md"],
			/* The fixture's own sizing has no notion of the four PAYLOAD_VARS this
			 * case adds beyond `header`, so the target leaves room for their bytes
			 * on top of what `injector()` sizes the doc body to. */
			INJECTION_CAP - 1000,
			/* Mirrors the real injector's shape: `context` self-references its own
			 * prior (empty) value, so it is a pure container over already-counted
			 * names — over PROSE_BYTES once concatenated, but with no bytes of its
			 * own beyond theirs, so flagging the container itself would be a false
			 * BROKEN on a fully-counted tree. */
			`context=""\n` +
				`wayfinder_clauses="${filler}"\n` +
				`tracker_index="${filler}"\n` +
				`closing_steps="${filler}"\n` +
				`priced_options="${filler}"\n` +
				`context="\${wayfinder_clauses}\${tracker_index}\${closing_steps}\${priced_options}\${context}"\n` +
				`emit "$context"\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(0);
		expect(r.json().outcome).toBe("OK");
	});

	/* mantahostels#1853 mutation: a name with refs of its own (not a pure container) is
	 * still a leaf a caller could omit from PAYLOAD_VARS — "has no refs" is the
	 * wrong test for "already counted", which is why this checks OWN bytes
	 * instead. */
	it("is BROKEN on a long uncounted string that also interpolates a ref, reached only via context=, naming the variable that holds it", () => {
		pool(CAP - 1000);
		injector(
			["docs/agents/issue-tracker.md"],
			INJECTION_CAP,
			`sub="x"\n` +
				`composite="prefix-\${sub}-${"y".repeat(400)}"\n` +
				`context="\${composite}"\n` +
				`emit "$context"\n`,
		);
		const r = run("--json");
		expect(r.status).toBe(2);
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("composite");
	});

	it("is BROKEN when the injector has no DOCS array to read", () => {
		pool(CAP - 1000);
		fs.writeFileSync(
			path.join(dir, "scripts", "inject-tracker-docs.sh"),
			"#!/usr/bin/env bash\n",
		);
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.status).toBe(2);
	});

	it("reports a breach under --notify, alongside the pool's", () => {
		pool(CAP + 500);
		injector(["docs/agents/issue-tracker.md"], INJECTION_CAP + 700);
		const r = run("--notify");
		expect(r.stdout).toContain("ALWAYS-LOADED POOL OVER CAP");
		expect(r.stdout).toContain("INJECTED TRACKER DOCS OVER CAP");
		expect(r.status).toBe(0);
	});
});

/*
 * --against HEAD: the pre-commit gate (mantahostels#1834). Every
 * fixture here commits a baseline and then stages a change, because the verdict
 * is index-minus-HEAD and neither revision alone can produce it.
 *
 * The checker itself measures ONE tree and raises the LEVEL finding; lib/check.js
 * materialises the index and HEAD by blob fetch, re-execs this file over each and
 * reports only what the commit adds. So a run here spawns with `cwd: dir` and no
 * --root — --against materialises its own trees and refuses --root outright.
 */
/*
 * mantahostels#2264: carried a 20,000 ms override (mantahostels#1941's 880 ms / 2,780 ms quiet
 * readings across this file and scripts/lib/check.test.ts). Removed as a
 * raise made redundant by mantahostels#2262's 90,000 ms repo default.
 */
describe("--against HEAD, the pre-commit gate (mantahostels#1224, mantahostels#1834)", () => {
	function git(...args: string[]) {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	}

	/**
	 * The gate, run from inside the fixture repo. No --root: the parent resolves
	 * `--git-path index` and `write-tree` in its own working directory, and hands
	 * each materialised tree to the child itself.
	 */
	/* Stays a real spawn (mantahostels#1945's real-fd exemption): lib/check.js's `reread`
	 * streams the index side's report by handing its own grandchild `stdio:
	 * "inherit"` on stderr, which writes straight to this process's OS fd and
	 * bypasses runInProcess's captured state.stderr entirely. */
	function gate(...args: string[]) {
		const r = spawnSync("node", [SCRIPT, "--against", "HEAD", ...args], {
			cwd: dir,
			encoding: "utf8",
		});
		return { ...r, json: () => JSON.parse(r.stdout) };
	}

	/** Commit everything written so far as the HEAD the gate measures against. */
	function baseline() {
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.invalid");
		git("config", "user.name", "t");
		git("add", "-A");
		git("commit", "-q", "--no-verify", "-m", "baseline");
	}

	/** Rewrite a pool file and stage it, as a pathspec commit would. */
	function stage(rel: string, bytes: number) {
		fs.writeFileSync(path.join(dir, rel), buildPoolText(rel, bytes));
		git("add", "--", rel);
	}

	/** The byte total a cap finding reports, out of its own message. */
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
		/* 200 B more CLAUDE.md, at cap with the second copy, under it without. */
		stage("CLAUDE.md", size + 200);
		expect(gate("--json").status).toBe(1);
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), "x".repeat(size + 200));
		git("add", "--", "CLAUDE.md");
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
		expect(run("--json").json().total).toBe(CAP - 100 + 200 - voice);
	});

	/* mantahostels#1786. The override is a shed, so the gate must read it on the same footing
	 * as a deleted paragraph — otherwise the commit that frees the bytes is the
	 * one refused for spending them. */
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

	/*
	 * The tree is shared, so a neighbour's half-saved settings must not un-charge
	 * descriptions this commit still delivers. Pinned as a difference in what the
	 * two readings CHARGE rather than as a row in the envelope: --against carries
	 * the parent's own payload, so the per-side rows are not in it.
	 */
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
		/* Report mode reads disk, so it sees the shed the gate correctly does not. */
		const fromDisk = run("--json").json();
		expect(fromGit - fromDisk.total).toBe(desc.length);
		expect(fromDisk.descriptions.ownBytes).toBe(0);
	});

	/* mantahostels#1786: an unreadable settings file charges every description rather than
	 * silently shedding them all, and says so on the stream the session reads. */
	/* The commit that breaks the settings file is refused rather than measured
	 * (mantahostels#2004): with the wiring unknown neither side of the diff can be read, and
	 * a checker that cannot read a revision is BROKEN by lib/check.js's model. */
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

	/*
	 * mantahostels#1939. "1,037 B over cap" leaves a session unable to tell whether its own
	 * commit added 20 of those bytes or 900, and the refusal's own instruction —
	 * name the shed that pays for the bytes — is sized on the second figure. Only
	 * the parent holds both readings, so this pins the line it composes.
	 */
	it("names HEAD's own total and the bytes this commit adds", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		/* Read out of the REFUSAL's own block, not the whole stream: the same
		 * commit also grows the pool files, so the admissibility note prints a
		 * delta of its own and a bare `toContain` would pass on either. */
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

	/*
	 * mantahostels#1939's own opening case, and the one every test above misses: they all
	 * breach a cap the baseline was inside, where the family is absent and the
	 * fault is new outright. THIS one travels the `worse`/`family` path — the
	 * surface was already over cap and grew — which is where a session is least
	 * able to tell its own bytes from the ones it inherited.
	 */
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

	/*
	 * The guard `measure` exists to be: UNPARSEABLE-SETTINGS carries no surface
	 * and no measurement, is not gate material and so reaches the reader through
	 * the NOTE path on every run. Measured as the pool's total — which a
	 * two-way ternary does by default — it tells a session to shed 15 kB to fix
	 * a JSON syntax error.
	 *
	 * ASSERTED AGAINST THE PROFILE DIRECTLY (mantahostels#2004): a run whose settings
	 * will not parse is BROKEN before any diff is composed, so this finding cannot
	 * reach `measure` through the gate.
	 */
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

	/* The two capped surfaces move independently, so a delta read off the wrong
	 * one would send the reader shedding from a surface that did not grow. */
	it("measures the injection surface against its own baseline, not the pool's", () => {
		pool(CAP - 5000);
		injector(["docs/agents/issue-tracker.md"], INJECTION_CAP - 1);
		baseline();
		stage(
			"docs/agents/issue-tracker.md",
			INJECTION_CAP + 300 - overhead(["docs/agents/issue-tracker.md"]),
		);
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

	/* An adopter's tree holds no copy of the core's register (#1673). */
	it("names no shed-candidate list where the host keeps none", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		const r = gate();
		expect(r.stderr).toContain("ALWAYS-LOADED POOL");
		expect(r.stderr).not.toContain("Candidates:");
	});

	/* A refused session that is not told the cap can be MOVED reads the shed as
	 * the only way out, which is the mantahostels#1220 escape going missing (mantahostels#1834). */
	it("names the mantahostels#1220 escape in the refusal, on both capped surfaces", () => {
		pool(CAP - 100);
		baseline();
		const before = fs.statSync(path.join(dir, "CLAUDE.md")).size;
		stage("CLAUDE.md", before + 200);
		expect(gate().stderr).toContain(
			"unpayable-correction trigger (mantahostels#1220)",
		);
	});

	/*
	 * The admissibility prompt (mantahostels#1177). The checker emits the pool files' own byte
	 * total on every run and lib/check.js prints the prompt where the index's
	 * exceeds HEAD's, so this is now a NEW-NOTE — a WARN finding, which is what
	 * gets it past .husky/pre-commit's hold-and-replay. It still never gates.
	 */
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
			/* A note, never a gating fault: the refusal list stays empty. */
			expect(gate("--json").json().added).toEqual([]);
		});

		/*
		 * The prompt and the cap must charge the same number. The voice contract is
		 * double-loaded, so 100 B added to it costs the pool 200 (mantahostels#1503). The prompt
		 * is one-sided (mantahostels#1834) and carries no delta of its own, so the doubling
		 * is pinned on the measurement the prompt fires off.
		 */
		it("charges the double-loaded file twice, as the cap does", () => {
			pool(CAP - 5000);
			baseline();
			const at = path.join(dir, VOICE_PATH);
			const was = run("--json").json().admissibility[0].bytes;
			stage(VOICE_PATH, fs.statSync(at).size + 100);
			expect(run("--json").json().admissibility[0].bytes - was).toBe(200);
			expect(gate().stderr).toContain("ADMISSIBILITY");
		});

		/* The prompt fires on growth, so the growth itself is the figure it was
		 * missing — and it reaches the reader through the same NEW-NOTE path
		 * a refusal reaches them through (mantahostels#1939). */
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

		/*
		 * mantahostels#1177 scoped this to the pool files alone. A skill description also counts
		 * toward the wider pool figure the cap gates on, so this pins that growing
		 * ONLY a description must not fire the prompt.
		 */
		it("stays silent when only a skill description grows, not a pool file", () => {
			pool(CAP - 5000);
			skill("a-skill", "x".repeat(20));
			baseline();
			const was = run("--json").json().total;
			const at = path.join(dir, ".claude", "skills", "a-skill", "SKILL.md");
			const before = fs.readFileSync(at, "utf8");
			fs.writeFileSync(at, before.replace("x".repeat(20), "x".repeat(500)));
			git("add", "--", ".claude/skills/a-skill/SKILL.md");
			/* The wider pool DID grow — which is the point: the prompt reads the four
			 * pool files, not this figure. */
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

	/*
	 * The mirror image, and what lib/fault-profiles.js's `worse` exists for: the
	 * over-cap finding carries the byte total, so a plain set difference would read
	 * a SHED as a fault this commit added and refuse the very repair the cap
	 * demands.
	 */
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
		injector(["docs/agents/issue-tracker.md"], INJECTION_CAP - 1);
		shedRegister();
		baseline();
		/* The surface is the doc plus the injector's own bytes, so the doc is sized
		 * to leave the whole thing 300 B over. */
		stage(
			"docs/agents/issue-tracker.md",
			INJECTION_CAP + 300 - overhead(["docs/agents/issue-tracker.md"]),
		);
		const r = gate("--json");
		expect(r.json().outcome).toBe("FAIL");
		expect(r.json().added[0]).toContain(
			`injected tracker docs are ${INJECTION_CAP + 300} B`,
		);
		expect(r.status).toBe(1);
		expect(gate().stderr).toContain("#1268");
	});

	/*
	 * The whole reason neither side reads disk. The tree is repo-global, so an
	 * on-disk read would refuse this commit for a neighbour's unsaved bytes.
	 */
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

	/* The stated condition is "at OR over", so exactly-at-cap is the boundary the
	 * rule turns on (mantahostels#1224, and the checker's own header). */
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

	/* DOCS is data: nothing may assume which directory an injected doc sits in,
	 * and that governs the MATERIALISATION too (mantahostels#1834) — the pathspec is read
	 * out of the injector at the revision, so a doc outside the fixed list is
	 * fetched or it is not measured at all. */
	it("measures an injected doc wherever DOCS puts it", () => {
		pool(CAP - 5000);
		injector(["docs/agents/issue-tracker.md", "docs/effort-guide.md"], 30_000);
		baseline();
		const j = run("--json").json();
		expect(j.injection.total).toBe(30_000);
		expect(
			j.injection.files.find(
				(f: { path: string }) => f.path === "docs/effort-guide.md",
			).bytes,
		).toBeGreaterThan(0);
		/* And the materialised index reads the same number, which is what proves
		 * the second pathspec pass fetched it. */
		expect(gate("--json").json().indexSummary).toBe(j.summary);
	});

	it("agrees with report mode on both totals over one tree", () => {
		pool(CAP - 5000);
		skill("house-thing", "one two three");
		agent("scout", "abcde");
		injector(["docs/agents/issue-tracker.md", "docs/effort-guide.md"], 30_000);
		baseline();
		const j = gate("--json").json();
		expect(j.indexSummary).toBe(run("--json").json().summary);
		/* Both sides, so a materialisation that dropped a path would show here. */
		expect(j.baselineSummary).toBe(j.indexSummary);
	});

	/*
	 * A vendored pool file is a symlink, and git stores a symlink's TARGET PATH
	 * as its blob. The `blobs` materialisation writes the symlink back AS a
	 * symlink (mantahostels#1834), so both sides follow it exactly as report mode always did.
	 */
	it("follows a symlinked pool file whose target is materialised too", () => {
		pool(CAP - 5000);
		/* Inside .agents/skills, which is materialised though never capped, so the
		 * link lands within the fetched tree exactly as a vendored skill's does. */
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

	/* The fail-open this replaced: both sides read the same live file through the
	 * escape, agreed, and passed bytes neither had judged (mantahostels#1834). */
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

	/* Was BROKEN until #11, on the reasoning that counting an unmeasurable file 0
	 * reads as a shed and passes the commit. That conflated two states: a member
	 * this revision does not carry, and one it carries unreadably. Only the
	 * second is a broken instrument, and refusing the first made every commit in
	 * a fork of this core that never took an AGENTS.md impossible to land.
	 *
	 * THE RESIDUAL IS NAMED, NOT CLOSED: `git rm --cached` on a pool member (the
	 * spare here) leaves the file on disk, where a session still loads it, while the measurement now
	 * reads its bytes as shed. The checker cannot see that — `--against`
	 * materialises trees, and a materialised tree is all either side gets. */
	it("reads a capped file missing from the index as bytes this commit shed", () => {
		pool(CAP - 100);
		baseline();
		git("rm", "-q", "--cached", "--", SPARE_PATH);
		const r = gate("--json");
		expect(r.status).toBe(0);
		expect(r.json().outcome).not.toBe("BROKEN");
	});

	/* A git that cannot answer must not read as an empty baseline: that charges
	 * the whole ~51 KB surface to the commit as new bytes. */
	it("is BROKEN outside a git repository, never an empty baseline", () => {
		pool(CAP + 500);
		const r = gate("--json"); // never `git init`ed
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.status).toBe(2);
	});

	/*
	 * --against names a rev, and lib/check.js resolves it before it reads anything
	 * — so `HEAD` in a repo with no commit is an unresolvable rev, which fails
	 * closed rather than inventing a baseline.
	 */
	it("is BROKEN, not an empty baseline, in a repo with no commit yet", () => {
		pool(CAP + 500);
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.invalid");
		git("config", "user.name", "t");
		git("add", "-A");
		const r = gate("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.status).toBe(2);
	});

	it("charges an own skill's description to the pool, and a vendored one to nothing", () => {
		/* Sized so the 10 B description is exactly what tips the pool over: the
		 * per-side totals left the envelope with stagedGate, so the refusal's own
		 * number is where the charge is now readable (mantahostels#1834). */
		pool(CAP - 9);
		baseline();
		skill("house-thing", "abcdefghij"); // 10 B, this repo's to delete
		skill("vendored-thing", "abcdefghij", true); // hash-locked, reverts on pull
		git("add", "-A");
		const r = gate("--json");
		expect(totalIn(r.json().added[0])).toBe(CAP - 9 + 10);
	});

	/* mantahostels#1757: the same exclusion, on the limb the pre-commit ratchet reads. */
	it("charges nothing for a staged skill the model cannot invoke", () => {
		pool(CAP - 9);
		baseline();
		skill("house-thing", "abcdefghij"); // 10 B, delivered
		skill("house-dead", "abcdefghij", false, true); // never listed
		git("add", "-A");
		const r = gate("--json");
		expect(totalIn(r.json().added[0])).toBe(CAP - 9 + 10);
	});

	/* The plugin surface has no direction gate (mantahostels#3116 rejected folding it into
	 * the pool): the enabling commit names the figure in its message instead,
	 * so a commit that flips a plugin on — priced or not — is passed (mantahostels#3132). */
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

/*
 * The third measured-and-uncapped surface (mantahostels#3116, ruled 6 September 2026;
 * built at mantahostels#3132): each `true` in `enabledPlugins` priced from
 * .claude/plugin-context-cost.json in tokens. Pinned here: the table is read,
 * a disabled plugin is listed and not summed, an enabled plugin with no row is
 * a WARN and never a silent zero, and nothing on this surface gates.
 */
describe("always-enabled plugins", () => {
	/* One literal, so test-read-edges links the live table to this suite. */
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
		/* A `?`, not a 0: the printed row must not read as measured. */
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
		/* A directory at the table's path: EISDIR, which is not absence. */
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

/*
 * The core layer beneath an adopter's own rule store (#101): a guard wired in
 * a root that is not this core resolves an injected id out of the core's own
 * `docs/agents/rules` where the adopter root's store carries no fragment of
 * that name.
 */
describe("the core layer beneath an adopter's own store (#101, #109)", () => {
	/** Points the pinned fallback seam at these fragments, id → body. */
	function fallbackStore(fragments: Record<string, string>) {
		const at = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-fallback-"));
		rulesFallbackDirs.push(at);
		for (const [id, body] of Object.entries(fragments))
			fs.writeFileSync(path.join(at, `${id}.txt`), body);
		process.env.WFC_RULES_FALLBACK_DIR = at;
	}

	/** Wires one core whose whole content is a single injection of `id`. */
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
