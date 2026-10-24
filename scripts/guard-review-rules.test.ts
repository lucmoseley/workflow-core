// @vitest-environment node
/*
 * guard-review-rules.sh hands a session the code-review rules at the Skill call
 * that loads code-review (mantahostels#3451). Every case but the adopter's bare
 * name (#1165) asserts `permissionDecision` is absent as well as the text.
 *
 * Each case stands up a temp host holding a local `code-review` skill and a
 * separate temp core (`WFC_SCRIPT_ROOT`), so which standards text the host
 * gets is set per case rather than read off this checkout.
 *
 * It runs on every Skill call as a `PreToolUse` hook
 * (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`): break it and a review
 * runs without the rules on where its findings and deviations go; make it deny
 * and code-review cannot load.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";
import { guardErrorsLog } from "./lib/guard-errors-log";
import { guardOutput } from "./lib/pretool-guard-testkit";
import { shellConst } from "./lib/shell-const-testkit";

const GUARD = path.resolve(__dirname, "guard-review-rules.sh");
const GP_RULE_CAP = shellConst(
	path.join(__dirname, "lib", "guard-parse.sh"),
	"GP_RULE_CAP",
);
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};
const RUN_COST_PREFIX = "RUN COST:";
const { failOpenLine } = require("./lib/run-cost-report") as {
	failOpenLine: (error: unknown) => string;
};

const IDS = [
	"review-deviations-write",
	"review-dispatch-shape",
	"review-deviations-read",
	"review-finding-destination",
	"review-ultra-axis",
];

/** One per state of the base and the local file (#965); a host gets exactly one. */
const STANDARDS_IDS = [
	"review-standards-axis",
	"review-standards-axis-base",
	"review-standards-axis-local",
	"review-standards-axis-absent",
];

/**
 * The longest workflow-core plugin root on the founder's machine, a dry-run
 * install, as an adopter's base path is named whole (#1882).
 */
const LONGEST_ROOT =
	"/home/lucmo/.claude3/plugins/cache/workflow-core-dryrun/workflow-core/0.0.1";

let dir: string;
/** Stands in for the resolved core root, where the base is looked for. */
let core: string;

/** The core's shape: a project skill that shadows the harness's built-in (#1165). */
const LOCAL_SKILL = [".claude", "skills", "code-review", "SKILL.md"];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-rules-"));
	core = fs.mkdtempSync(path.join(os.tmpdir(), "review-core-"));
	fs.mkdirSync(path.join(dir, ...LOCAL_SKILL.slice(0, -1)), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(dir, ...LOCAL_SKILL),
		"---\nname: code-review\n---\n",
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(core, { recursive: true, force: true });
});

/** The hook output for a Skill call, parsed, refusals included. Null where it said nothing. */
const rawEmission = (
	skill: unknown,
	payload: Record<string, unknown> = { session_id: "abcdef12-3456" },
	guard = GUARD,
	env: Record<string, string | undefined> = { WFC_SCRIPT_ROOT: core },
) =>
	guardOutput(
		guard,
		{ tool_name: "Skill", tool_input: { skill }, ...payload },
		{ project: dir, config: dir, env },
	);

/** As rawEmission, asserting the call was not refused. */
const emission = (...args: Parameters<typeof rawEmission>) => {
	const parsed = rawEmission(...args);
	expect(parsed?.permissionDecision).toBeUndefined();
	return parsed;
};

/** A host carrying its local docs/code-standards.md. */
const withStandards = (root = dir) => {
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs", "code-standards.md"), "standards\n");
};

/** A core root carrying the standards base. */
const withBase = (root = core) => {
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs", "code-standards-base.md"), "base\n");
};

/** A host carrying its GLOSSARY.md, for base §G8 (#1373). */
const withGlossary = (root = dir) => {
	fs.writeFileSync(path.join(root, "GLOSSARY.md"), "# Glossary\n");
};

const loggedErrors = () => guardErrorsLog(dir);

describe("loading code-review", () => {
	it("hands over the five review rules and one standards rule, and refuses nothing", () => {
		withStandards();
		withBase();
		const out = emission("code-review");
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		for (const id of IDS) expect(out.additionalContext).toContain(ruleText(id));
		expect(out.additionalContext).toContain(ruleText("review-standards-axis"));
	});

	// The deviations record is owed before the dispatch goes out, so it leads.
	it("states the deviations record ahead of the dispatch shape", () => {
		const ctx = emission("code-review").additionalContext as string;
		expect(ctx.indexOf("RECORD WHERE THE BUILD DEPARTED")).toBeLessThan(
			ctx.indexOf("Spawn the review runs"),
		);
	});

	// A subagent's Write expands no environment variable (mantahostels#2088), so the prelude
	// has to carry the literal, session-suffixed paths (mantahostels#2220).
	it("names this session's two Artefact paths", () => {
		const ctx = emission("code-review").additionalContext as string;
		expect(ctx).toContain("`.claude/tmp/review-standards-abcdef12.md`");
		expect(ctx).toContain("`.claude/tmp/review-spec-abcdef12.md`");
	});

	it("gives two sessions two different paths", () => {
		const a = emission("code-review", { session_id: "11111111-x" });
		const b = emission("code-review", { session_id: "22222222-y" });
		expect(a.additionalContext).toContain("review-spec-11111111.md");
		expect(b.additionalContext).toContain("review-spec-22222222.md");
	});

	// Must match inject-tracker-docs.sh and concision-backstop.sh, which strip
	// before truncating.
	it("sanitises the session id before truncating it", () => {
		const ctx = emission("code-review", { session_id: "ab/cd.efgh-99" })
			.additionalContext as string;
		expect(ctx).toContain("review-spec-ab_cd_ef.md");
	});

	it("says nothing the second time in one session", () => {
		expect(emission("code-review")).not.toBeNull();
		expect(emission("code-review")).toBeNull();
	});

	// gp_rule keys its latch on the agent as well, so a subagent is told on its
	// own account.
	it("tells a subagent under an already-told session", () => {
		expect(emission("code-review")).not.toBeNull();
		const sub = emission("code-review", {
			session_id: "abcdef12-3456",
			agent_id: "sub1",
		});
		expect(sub).not.toBeNull();
		expect(sub.additionalContext).toContain(ruleText("review-dispatch-shape"));
	});
});

/*
 * #965: the Standards axis is handed the base at the resolved core root and the
 * host's local file, and a missing one is named in the report's opening line.
 */
describe("the standards base and local file (#965)", () => {
	it.each([
		{
			state: "both",
			base: true,
			local: true,
			id: "review-standards-axis",
			opening: "`Base unreadable: <path>`",
		},
		{
			state: "base only",
			base: true,
			local: false,
			id: "review-standards-axis-base",
			opening: "`No local standards file: the base applies unchanged.`",
		},
		{
			state: "local only",
			base: false,
			local: true,
			id: "review-standards-axis-local",
			opening: "`No standards base: <path> is absent.`",
		},
		{
			state: "neither",
			base: false,
			local: false,
			id: "review-standards-axis-absent",
			opening:
				"`No standards base or local file: <path> and docs/code-standards.md are absent.`",
		},
	])(
		"$state: hands over its one standards rule",
		({ base, local, id, opening }) => {
			if (base) withBase();
			if (local) withStandards();
			const ctx = emission("code-review").additionalContext as string;
			expect(ctx).toContain(ruleText(id));
			expect(ctx).toContain(opening);
			for (const other of STANDARDS_IDS.filter((i) => i !== id))
				expect(ctx).not.toContain(ruleText(other));
			for (const i of IDS) expect(ctx).toContain(ruleText(i));
			// The fragments are static, so the path rides in the prelude.
			expect(ctx).toContain(
				`Its standards base: \`${path.join(core, "docs", "code-standards-base.md")}\`.`,
			);
		},
	);

	it.each([
		["local only", false, true, true],
		["neither", false, false, true],
		["both", true, true, false],
		["base only", true, false, false],
	])(
		"%s: logs a missing base only where it is missing",
		(_s, base, local, logged) => {
			if (base) withBase();
			if (local) withStandards();
			emission("code-review");
			const log = loggedErrors();
			expect(log.includes("standards base absent")).toBe(logged);
			if (logged)
				expect(log).toContain(
					path.join(core, "docs", "code-standards-base.md"),
				);
		},
	);

	// In an adopter the plugin cache is reached through ~/.claude3 or ~/.claude2,
	// symlinks onto ~/.claude, and #711's Read rule names only the physical path.
	it("names the resolved base path in an adopter, never a symlink spelling", () => {
		const real = path.join(core, "cache");
		const ver = path.join(real, "1.0.0");
		copyLibs(path.join(ver, "scripts", "lib"), sourcedLibs(GUARD));
		fs.copyFileSync(GUARD, path.join(ver, "scripts", "guard-review-rules.sh"));
		withBase(ver);
		const link = path.join(core, "link");
		fs.symlinkSync(real, link);

		const ctx = emission(
			"code-review",
			undefined,
			path.join(link, "1.0.0", "scripts", "guard-review-rules.sh"),
			{
				WFC_SCRIPT_ROOT: undefined,
				WFC_RULES_DIR: path.resolve(__dirname, "..", "docs", "agents", "rules"),
			},
		).additionalContext as string;
		const resolved = path.join(
			fs.realpathSync(real),
			"1.0.0",
			"docs",
			"code-standards-base.md",
		);
		expect(ctx).toContain(`Its standards base: \`${resolved}\`.`);
		expect(ctx).not.toContain(path.join(link, "1.0.0", "docs"));
	});
});

describe("the host's glossary (#1373)", () => {
	const named = (ctx: string) =>
		ctx.includes("Hand the Standards axis `GLOSSARY.md` too, for base §G8.");

	it("names the host's GLOSSARY.md in the prelude where it exists", () => {
		withBase();
		withGlossary();
		expect(named(emission("code-review").additionalContext)).toBe(true);
	});

	it("names no glossary where the host has none", () => {
		withBase();
		const ctx = emission("code-review").additionalContext as string;
		expect(named(ctx)).toBe(false);
		expect(ctx).not.toContain("GLOSSARY.md");
	});
});

/*
 * Named relative to the host root, the paths cost the same under any
 * checkout, so every rule still fits one envelope (#1729).
 */
describe("the envelope's size under a long checkout path (#1729)", () => {
	/** The core's shape: host and core one root, both standards files and a glossary. */
	const envelopeAt = (root: string) => {
		fs.mkdirSync(path.join(root, ...LOCAL_SKILL.slice(0, -1)), {
			recursive: true,
		});
		fs.copyFileSync(
			path.join(dir, ...LOCAL_SKILL),
			path.join(root, ...LOCAL_SKILL),
		);
		// A package.json is what marks a root as the core checkout, not a plugin install.
		fs.writeFileSync(path.join(root, "package.json"), "{}\n");
		withBase(root);
		withStandards(root);
		withGlossary(root);
		return emission("code-review", undefined, GUARD, {
			CLAUDE_PROJECT_DIR: root,
			CLAUDE_CONFIG_DIR: root,
			WFC_SCRIPT_ROOT: root,
		}).additionalContext as string;
	};

	it("carries every rule and no root path, at the same size as under a short path", () => {
		const short = path.join(dir, "s");
		// Longer than the envelope's whole spare room, so a path still counted would overflow it.
		const long = path.join(dir, ...new Array(10).fill("a".repeat(30)));
		const atShort = envelopeAt(short);
		const atLong = envelopeAt(long);
		expect(atLong).not.toContain(long);
		for (const id of [...IDS, "review-standards-axis"])
			expect(atLong).toContain(ruleText(id));
		expect(Buffer.byteLength(atLong)).toBe(Buffer.byteLength(atShort));
		expect(Buffer.byteLength(atLong)).toBeLessThanOrEqual(GP_RULE_CAP);
	});
});

describe("the envelope at the longest adopter base path (#1882)", () => {
	it("carries every rule, the run-cost line among them, under the cap", () => {
		// Where the temp core is already longer, the case runs at that longer
		// path, which is the stricter test.
		const pad = Math.max(1, LONGEST_ROOT.length - core.length - 1);
		const root = path.join(core, "p".repeat(pad));
		withBase(root);
		withStandards();
		withGlossary();
		const ctx = emission("workflow-core:code-review", undefined, GUARD, {
			WFC_SCRIPT_ROOT: root,
		}).additionalContext as string;
		expect(ctx).toContain(path.join(root, "docs", "code-standards-base.md"));
		for (const id of [...IDS, "review-standards-axis"])
			expect(ctx).toContain(ruleText(id));
		/* The prefix the fragment names is the one the report prints. */
		expect(failOpenLine("x").startsWith(`${RUN_COST_PREFIX} `)).toBe(true);
		expect(ctx).toContain(
			`every \`${RUN_COST_PREFIX}\` line your last suite run printed`,
		);
		expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(GP_RULE_CAP);
	});
});

describe("any other skill", () => {
	it.each([
		["code-review:code-review", "the plugin's pull-request review"],
		["last30days", "an unrelated skill"],
		["concision-pass", "the pass that follows a review"],
		["", "an empty name"],
	])("%j is told nothing — %s", (skill) => {
		expect(emission(skill)).toBeNull();
	});
});

/*
 * MUTATION ANCHORS. `toContain(ruleText(id))` reads the file the guard reads, so
 * it moves with a cut to a fragment rather than catching it.
 */
describe("the fragments carry what the review needs", () => {
	it.each([
		["review-dispatch-shape", 'model: "opus"` on every one'],
		["review-dispatch-shape", "subagent type named above"],
		["review-dispatch-shape", "SINGLE message"],
		["review-dispatch-shape", "or say there were none, for base §X8 (5)"],
		["review-standards-axis", "`docs/code-standards.md`"],
		["review-standards-axis", "`Base unreadable: <path>`"],
		["review-standards-axis", '"§X2 (base), excepted by local row 2"'],
		["review-standards-axis", "the standards base named above"],
		[
			"review-standards-axis-base",
			"`No local standards file: the base applies unchanged.`",
		],
		["review-standards-axis-base", "`Base unreadable: <path>`"],
		["review-standards-axis-local", "`No standards base: <path> is absent.`"],
		["review-standards-axis-local", "never hand that path"],
		[
			"review-standards-axis-absent",
			"`No standards base or local file: <path> and docs/code-standards.md are absent.`",
		],
		["review-standards-axis-absent", "hand the Standards axis neither path"],
		["review-deviations-read", "## Declared departures"],
		["review-deviations-read", "never suppressed"],
		["review-deviations-write", "No departure, no comment."],
		["review-deviations-write", "**waived:**"],
		["review-finding-destination", "`**Outstanding:**`"],
		["review-ultra-axis", "NEVER START ONE UNASKED."],
	])("%s says %j", (id, clause) => {
		expect(ruleText(id)).toContain(clause);
	});
});

/* A plugin skill arrives namespaced (#201). */
describe("a namespaced code-review still gets its rules (#201)", () => {
	it.each(["workflow-core:code-review", "my-fork:code-review"])(
		"%s is told, as the bare name is",
		(skill) => {
			expect(emission(skill)).not.toBeNull();
		},
	);

	/* Anthropic's own pull-request plugin takes this name and is a different
	 * skill, which is why the exclusion sits before the namespaced arm. */
	it("still says nothing to Anthropic's own code-review plugin", () => {
		expect(emission("code-review:code-review")).toBeNull();
	});
});

/*
 * #1165: in an adopter a bare `code-review` is the harness's built-in reviewer.
 * Only a project carrying its own skill shadows the built-in.
 */
describe("a bare code-review in an adopter (#1165)", () => {
	const makeAdopter = () =>
		fs.rmSync(path.join(dir, ...LOCAL_SKILL.slice(0, -2)), {
			recursive: true,
			force: true,
		});

	it("is refused, naming the plugin's skill", () => {
		makeAdopter();
		const out = rawEmission("code-review");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"`workflow-core:code-review`",
		);
		expect(out.permissionDecisionReason).toContain("@{upstream}...HEAD");
		expect(out.additionalContext).toBeUndefined();
	});

	// Refused before the latch, so the namespaced retry is still told.
	it("leaves the rules for the namespaced retry", () => {
		makeAdopter();
		rawEmission("code-review");
		const ctx = emission("workflow-core:code-review")
			.additionalContext as string;
		expect(ctx).toContain(ruleText("review-dispatch-shape"));
	});

	it.each(["workflow-core:code-review", "my-fork:code-review"])(
		"never refuses %s",
		(skill) => {
			makeAdopter();
			expect(emission(skill)).not.toBeNull();
		},
	);

	it("still says nothing to Anthropic's own code-review plugin", () => {
		makeAdopter();
		expect(emission("code-review:code-review")).toBeNull();
	});

	// The skill directory without its SKILL.md loads nothing, so it shadows nothing.
	it("is refused where the skill directory holds no SKILL.md", () => {
		fs.rmSync(path.join(dir, ...LOCAL_SKILL));
		expect(rawEmission("code-review").permissionDecision).toBe("deny");
	});

	// guard-root.sh unreadable leaves gr_root's empty stub, the disarm signal: an
	// empty root must not read as a project lacking the skill.
	it("fails open to the injection where the root is unresolved", () => {
		makeAdopter();
		const copy = path.join(core, "scripts");
		copyLibs(path.join(copy, "lib"), sourcedLibs(GUARD), ["guard-root.sh"]);
		fs.copyFileSync(GUARD, path.join(copy, "guard-review-rules.sh"));
		const out = emission(
			"code-review",
			undefined,
			path.join(copy, "guard-review-rules.sh"),
			{
				WFC_SCRIPT_ROOT: core,
				WFC_RULES_DIR: path.resolve(__dirname, "..", "docs", "agents", "rules"),
			},
		);
		expect(out?.permissionDecision).toBeUndefined();
	});
});
