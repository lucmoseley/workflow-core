// @vitest-environment node
/*
 * The practice guard hands a session the craft list (#2324) and the
 * evidence-tier ranking (#2637) on its first touch of docs/practice/, and
 * refuses a note written under a slug off the list (#2324); at Stop, it
 * refuses once a session that wrote a tracked file with no **Practice:** line,
 * or one that does not hold up (#2326).
 *
 * The guard is machine-level, at ~/.claude/hooks/practice-guard.sh, so what
 * runs here is its reference copy in docs/claude-user-settings.md, against the
 * craft list's reference copy there; `npm run check:settings` holds both to the
 * live files. A miss here lets an off-list note land in every repo on the
 * machine, or charges every session the list where none touched a note.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guardOutput, spawnGuard } from "./lib/pretool-guard-testkit";
import { copyBlockPattern } from "./lib/settings-copy";

const DOC = path.resolve(__dirname, "..", "docs", "claude-user-settings.md");
const SESSION = "s1";
const NO_LIST = /^practice-guard: no craft list at .*, so nothing is judged\n$/;
/** The clause of the evidence-tier ranking a note writer most often gets wrong (#2637, #2657). */
const RANKING =
	"A project's docs, open-source or company-run, earn the top tier only for how that project's own product behaves or is configured";

let dir: string;
let hook: string;
let home: string;
let repo: string;
let list: string;
/** The session latch's XDG_RUNTIME_DIR, fresh for each case. */
let tmp: string;

const block = (doc: string, name: string, fence: string) => {
	const found = doc.match(copyBlockPattern(name, fence));
	if (!found) throw new Error(`no ${name} block in ${DOC}`);
	return found[1];
};

beforeAll(() => {
	const doc = fs.readFileSync(DOC, "utf8");
	// Real, so the work tree root git prints matches the paths fed in.
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "practice-guard-")),
	);
	hook = path.join(dir, "practice-guard.sh");
	fs.writeFileSync(hook, `${block(doc, "practice-guard.sh", "```bash")}\n`, {
		mode: 0o755,
	});
	list = block(doc, "practice-crafts.md", "````markdown");
	home = path.join(dir, "home");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", "practice-crafts.md"),
		`${list}\n`,
	);
	repo = path.join(dir, "repo");
	execFileSync("git", ["init", "-q", repo]);
	fs.mkdirSync(path.join(repo, "docs"));
	fs.mkdirSync(path.join(dir, "loose"));
});

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(dir, "tmp-"));
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** What the guard hands the session on one call: hookSpecificOutput, or null. */
const run = (
	toolName: string,
	toolInput: Record<string, string>,
	{
		session = SESSION,
		agent,
		homeDir = home,
		stderr,
	}: {
		session?: string;
		agent?: string;
		homeDir?: string;
		stderr?: RegExp;
	} = {},
) =>
	guardOutput(
		hook,
		{
			session_id: session,
			...(agent ? { agent_id: agent } : {}),
			tool_name: toolName,
			tool_input: toolInput,
		},
		{
			project: repo,
			config: path.join(homeDir, ".claude"),
			env: { HOME: homeDir, XDG_RUNTIME_DIR: tmp },
			stderr,
		},
	);

const note = (slug: string) =>
	path.join(repo, "docs", "practice", `${slug}.md`);

describe("the craft list on a session's first docs/practice/ touch", () => {
	it.each([
		["Read", () => ({ file_path: note("llm-agent-design") })],
		[
			"Glob",
			() => ({ pattern: "*.md", path: path.join(repo, "docs/practice") }),
		],
		[
			"Glob",
			() => ({ pattern: "practice/*.md", path: path.join(repo, "docs") }),
		],
		["Glob", () => ({ pattern: "docs/practice/*.md" })],
		["Bash", () => ({ command: "ls docs/practice" })],
		["Write", () => ({ file_path: note("llm-agent-design"), content: "x" })],
	])("%s hands it over once, then nothing", (tool, input) => {
		const first = run(tool, input());
		expect(first.permissionDecision).toBeUndefined();
		expect(first.additionalContext).toContain(list);
		expect(first.additionalContext).toContain(RANKING);
		expect(run("Read", { file_path: note("llm-agent-design") })).toBeNull();
	});

	it.each([
		["session", { session: "s2" }],
		["subagent", { agent: "a1" }],
	])("hands it to each %s apart", (_, other) => {
		const input = { file_path: note("llm-agent-design") };
		expect(run("Read", input).additionalContext).toContain(list);
		expect(run("Read", input, other).additionalContext).toContain(list);
		expect(run("Read", input, other)).toBeNull();
	});
});

describe("a latch that cannot be made", () => {
	it("hands the list over on every touch, saying so on stderr (#2601)", () => {
		fs.mkdirSync(path.join(tmp, `practice-guard-${os.userInfo().uid}`), {
			mode: 0o500,
		});
		const stderr =
			/^practice-guard: cannot create the latch .*, so nothing latches\n$/;
		const input = { file_path: note("llm-agent-design") };
		for (let i = 0; i < 2; i++) {
			expect(run("Read", input, { stderr }).additionalContext).toContain(list);
		}
	});
});

describe("a note under a slug off the list", () => {
	it.each([
		["bash-hooks", '"bash-hooks" is not a craft'],
		["llm-agent-design/sub", '"llm-agent-design/sub" is not a craft'],
	])(
		"%s is refused with the list printed, on a first touch and a later one",
		(slug, says) => {
			const write = { file_path: note(slug), content: "x" };
			for (let i = 0; i < 2; i++) {
				const out = run("Write", write);
				expect(out.permissionDecision).toBe("deny");
				expect(out.permissionDecisionReason).toContain(says);
				expect(out.permissionDecisionReason).toContain(list);
				expect(out.permissionDecisionReason).toContain(RANKING);
			}
			expect(run("Read", { file_path: note("llm-agent-design") })).toBeNull();
		},
	);

	it("passes on a slug on the list once the list is handed over", () => {
		run("Bash", { command: "ls docs/practice" });
		expect(
			run("Write", {
				file_path: note("shell-scripting-and-hooks"),
				content: "x",
			}),
		).toBeNull();
	});

	it.each([
		["outside any work tree", () => path.join(dir, "loose")],
		["below a work tree's root", () => path.join(repo, "pkg")],
	])("is no note %s", (_, root) => {
		const filePath = path.join(root(), "docs", "practice", "bash-hooks.md");
		const out = run("Write", { file_path: filePath, content: "x" });
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(list);
	});
});

describe("silence", () => {
	it.each([
		["Read", { file_path: "/r/docs/practices.md" }],
		["Read", { file_path: "/r/mydocs/practice/a.md" }],
		["Glob", { pattern: "docs/practice-notes/*.md" }],
		["Bash", { command: "git log --oneline -3" }],
		[
			"Write",
			{ file_path: "/r/docs/doc-map.md", content: "docs/practice/x.md" },
		],
		["Edit", { file_path: "/r/docs/practice/bash-hooks.md" }],
	])("%s touching nothing under docs/practice/ says nothing", (tool, input) => {
		expect(run(tool, input)).toBeNull();
	});

	it("refuses nothing where no craft list is installed, and says why on stderr", () => {
		const bare = path.join(dir, "bare-home");
		fs.mkdirSync(path.join(bare, ".claude"), { recursive: true });
		const write = { file_path: note("bash-hooks"), content: "x" };
		expect(run("Write", write, { homeDir: bare, stderr: NO_LIST })).toBeNull();
	});
});

/** The day the guard's expiry reckons from, through PRACTICE_GUARD_TODAY. */
const TODAY = "2026-06-15";
/** Researched: dates counted back from TODAY; a note expires at exactly 6 months. */
const FIVE_MONTHS_AGO = "2026-01-15";
const SIX_MONTHS_LESS_A_DAY = "2025-12-16";
const SIX_MONTHS_AGO = "2025-12-15";
const SEVEN_MONTHS_AGO = "2025-11-15";

type Block = Record<string, unknown>;
const text = (body: string): Block => ({ type: "text", text: body });
const toolUse = (name: string, input: Record<string, string>): Block => ({
	type: "tool_use",
	name,
	input,
});
const wrote = (filePath: string) =>
	toolUse("Write", { file_path: filePath, content: "x" });
const declared = (line: string) => text(`Done.\n\n**Practice:** ${line}`);

/**
 * The guard's Stop verdict on a session whose main chain made `blocks`, one
 * assistant turn each, a string being a raw transcript line: the refusal's
 * reason, or null where it passed silent.
 */
const stop = (
	blocks: (Block | string)[],
	{
		session = SESSION,
		env = {},
		active = false,
		stderr = /^$/,
	}: {
		session?: string;
		env?: NodeJS.ProcessEnv;
		active?: boolean;
		stderr?: RegExp;
	} = {},
) => {
	const transcript = path.join(tmp, "transcript.jsonl");
	fs.writeFileSync(
		transcript,
		blocks
			.map((b) =>
				typeof b === "string"
					? b
					: JSON.stringify({
							type: "assistant",
							isSidechain: false,
							cwd: repo,
							message: { content: [b] },
						}),
			)
			.join("\n"),
	);
	const r = spawnGuard(
		hook,
		{
			session_id: session,
			transcript_path: transcript,
			cwd: repo,
			hook_event_name: "Stop",
			stop_hook_active: active,
		},
		{
			project: repo,
			config: path.join(home, ".claude"),
			args: ["stop"],
			env: {
				HOME: home,
				XDG_RUNTIME_DIR: tmp,
				CLAUDE_JOB_DIR: "",
				PRACTICE_GUARD_TODAY: TODAY,
				...env,
			},
		},
	);
	expect(r.status).toBe(0);
	expect(r.stderr).toMatch(stderr);
	const out = r.stdout.trim();
	if (!out) return null;
	const verdict = JSON.parse(out);
	expect(verdict.decision).toBe("block");
	return verdict.reason as string;
};

describe("the Stop limb", () => {
	const code = () => path.join(repo, "src", "a.js");
	const fresh = "docs/practice/shell-scripting-and-hooks.md";
	const stale = "docs/practice/test-design-and-reliability.md";
	const undated = "docs/practice/code-review-process.md";
	const precedent = "docs/research/logo-precedent.md";
	const bad = "docs/practice/technical-documentation.md";
	const boundary = "docs/practice/web-frontend-development.md";
	const lastDay = "docs/practice/data-schema-and-validation.md";
	const noKind =
		'is no exempt kind: the line opens with a kind\'s whole phrase, its last word singular or plural, and no word before it but "a", "an" or "the", as in "version bump of biome"';
	const clause = (phrase: string) =>
		`adds a second clause to the exempt kind "${phrase}"`;
	const holds = (char: string) =>
		`holds "${char}", off the tail's allowlist: ASCII letters and digits, spaces, "#", "'", "@", and a "-", "." or "/" inside a word`;
	const nbsp = "\u00a0";

	beforeAll(() => {
		fs.writeFileSync(path.join(repo, ".gitignore"), "scratch/\n");
		fs.mkdirSync(path.join(repo, "docs", "practice"), { recursive: true });
		fs.mkdirSync(path.join(repo, "docs", "research"), { recursive: true });
		const dated = (when: string) => `# craft\n\nResearched: ${when}\n`;
		fs.writeFileSync(path.join(repo, fresh), dated(FIVE_MONTHS_AGO));
		fs.writeFileSync(path.join(repo, stale), dated(SEVEN_MONTHS_AGO));
		fs.writeFileSync(path.join(repo, boundary), dated(SIX_MONTHS_AGO));
		fs.writeFileSync(path.join(repo, lastDay), dated(SIX_MONTHS_LESS_A_DAY));
		fs.writeFileSync(path.join(repo, undated), "# craft\n");
		fs.writeFileSync(path.join(repo, bad), dated("2026-13-45"));
		fs.writeFileSync(path.join(repo, precedent), "# logo precedent\n");
	});

	describe("is silent where the session wrote nothing tracked", () => {
		it.each([
			["no write at all", () => []],
			["a write git ignores", () => [wrote(path.join(repo, "scratch", "a"))]],
			[
				"a write outside any work tree",
				() => [wrote(path.join(dir, "loose", "a.md"))],
			],
			["a read", () => [toolUse("Read", { file_path: code() })]],
		])("%s", (_, blocks) => {
			expect(stop(blocks())).toBeNull();
		});

		it("a write in the job directory, even inside a work tree", () => {
			const job = path.join(repo, "job");
			expect(
				stop([wrote(path.join(job, "tmp", "a.md"))], {
					env: { CLAUDE_JOB_DIR: job },
				}),
			).toBeNull();
		});
	});

	describe("passes a declaration that holds up", () => {
		it.each([
			[
				"ran — a note written this session",
				() => [wrote(path.join(repo, fresh)), declared(`ran — ${fresh}`)],
			],
			[
				"covered — a current note",
				() => [declared(`covered — \`${fresh}\`, ${FIVE_MONTHS_AGO}`)],
			],
			[
				"covered — a note on its last day before 6 months (#2601)",
				() => [declared(`covered — ${lastDay}, ${SIX_MONTHS_LESS_A_DAY}`)],
			],
			[
				"none-fits — an on-list nearest craft",
				() => [declared("none-fits — nearest `llm-agent-design`")],
			],
			[
				"covered — design-vault's precedent path",
				() => [declared(`covered — ${precedent}, 2026-01-01`)],
			],
			[
				"ran — design-vault's precedent path",
				() => [
					wrote(path.join(repo, precedent)),
					declared(`ran — ${precedent}`),
				],
			],
		])("%s", (_, blocks) => {
			expect(stop([wrote(code()), ...blocks()])).toBeNull();
		});

		it.each([
			"typo fix",
			"a wording fix",
			"re-anchor of the census row",
			"regeneration of the digest",
			"concision cut",
			"propagating an already-settled fact",
			"revert",
			"version bump",
			"reply that only answers a question",
			"a typo or wording fix",
			"reply that only answers a question (a triage relabel)",
			"typo fix in the README",
			"wording fix to the rule",
			"propagating an already-settled fact to 4 docs",
			"version bump for the release",
			"concision cut over d2fb95fa9",
			"revert on main",
			"re-anchor after the rename",
			"regeneration from the new source",
			"version bump from 1.2 to 1.3",
			"typo fixes",
			"reverts of two commits",
			"version bumps",
			"concision cuts in practice notes",
			"re-anchor of scripts/lib/gate-sweep.js",
			"revert of #3011",
			"typo fix in the README's intro",
			"revert of the so-called fix",
			"version bump of @biomejs/biome",
			"propagating already-settled fact",
			"propagating already-settled facts",
			"reply that only answers questions",
			"typo or a wording fix",
			"reply that only answers the question",
			"a re-anchor or a regeneration",
		])(
			"skipped — %s, an exempt kind (#2601, #2806, #3077, #3491, #3594, #3603)",
			(kind) => {
				expect(stop([wrote(code()), declared(`skipped — ${kind}`)])).toBeNull();
			},
		);

		it.each([
			["a non-breaking space", "version bump of biome"],
			["a narrow no-break space", "typo fix in the README"],
		])(
			"skipped — an exempt kind set off by %s, read as a plain space (#3491)",
			(_, kind) => {
				expect(stop([wrote(code()), declared(`skipped — ${kind}`)])).toBeNull();
			},
		);

		it.each([
			"revert of\u200b one commit",
			"ver\u200bsion bump",
			"version bump of foo.\u200bbar",
			"revert o\u200bf one commit",
		])(
			"skipped — an exempt kind holding a zero-width space, which is deleted, passes: %s (#3594, #3603, #3611)",
			(kind) => {
				expect(stop([wrote(code()), declared(`skipped — ${kind}`)])).toBeNull();
			},
		);

		it("an Edit counts as the session writing the note", () => {
			const edit = toolUse("Edit", { file_path: path.join(repo, fresh) });
			expect(stop([edit, declared(`ran — ${fresh}`)])).toBeNull();
		});
	});

	describe("refuses once a declaration that is missing or does not hold up", () => {
		it.each([
			["no line", [], "no **Practice:** line"],
			[
				"a line in none of the four forms",
				[declared("done, researched it")],
				"none of the four forms",
			],
			[
				"covered — a missing note",
				[declared("covered — docs/practice/llm-evaluation.md, 2026-10-01")],
				"which does not exist",
			],
			[
				"covered — a note 6 months old or more",
				[declared(`covered — ${stale}, ${SEVEN_MONTHS_AGO}`)],
				"6 months ago or more",
			],
			[
				"covered — a note exactly 6 months old (#2601)",
				[declared(`covered — ${boundary}, ${SIX_MONTHS_AGO}`)],
				"6 months ago or more",
			],
			[
				"covered — a note with no Researched: date",
				[declared(`covered — ${undated}, 2026-10-01`)],
				"no Researched: date",
			],
			[
				"covered — an off-list slug",
				[declared("covered — docs/practice/bash-hooks.md, 2026-10-01")],
				"slug is not a craft",
			],
			[
				"covered — a path that is no note",
				[declared("covered — README.md, 2026-10-01")],
				"no docs/practice/<craft>.md note",
			],
			[
				"ran — a note this session did not write",
				[declared(`ran — ${fresh}`)],
				"this session did not write",
			],
			[
				"skipped — a kind off the exempt list",
				[declared("skipped — small refactor")],
				"no exempt kind",
			],
			[
				"covered — a Researched: date that is no date",
				[declared(`covered — ${bad}, 2026-10-01`)],
				"is no date",
			],
			[
				"skipped — an exempt kind named only in passing",
				[declared("skipped — new feature, not a typo")],
				"no exempt kind",
			],
			[
				"none-fits — an off-list craft",
				[declared("none-fits — nearest bash-hooks")],
				"not a craft on the list",
			],
		])("%s", (_, blocks, says) => {
			const session = [wrote(code()), ...blocks];
			const reason = stop(session);
			expect(reason).toContain(says);
			expect(reason).toContain(list);
			expect(stop(session)).toBeNull();
		});

		it.each([
			...[
				"typography system overhaul",
				"reverting nothing; built the new hook",
				"reply-driven feature build",
			].map((kind) => [
				`a word an exempt kind's stem opens: ${kind} (#2601)`,
				kind,
				noKind,
			]),
			...[
				"typo in the new scheduler design",
				"reply that rewrote the parser",
				"revert'd and built a new hook",
			].map((kind) => [
				`an invented kind opening with an exempt kind's head word: ${kind} (#2656)`,
				kind,
				noKind,
			]),
			...["typo", "propagation"].map((kind) => [
				`a bare head word, no whole kind: ${kind} (#2656)`,
				kind,
				noKind,
			]),
			...["biome version bump", "new feature and a typo fix"].map((kind) => [
				`a qualifier before the kind: ${kind} (#3491)`,
				kind,
				noKind,
			]),
			[
				'an article before "or": typo the or wording fix (#3611)',
				"typo the or wording fix",
				noKind,
			],
			...[
				["revert plus a new feature", "revert"],
				["concision cut of 400 lines plus new guard", "concision cut"],
				["revert of one commit and a new feature", "revert"],
				["version bump (and a new feature)", "version bump"],
				["revert (plus a new feature)", "revert"],
				["revert (or a new hook)", "revert"],
				["revert (but also a new hook)", "revert"],
				["revert (with a new scheduler)", "revert"],
				["revert ( and a new feature)", "revert"],
				["revert, then a new feature", "revert"],
				["revert of one commit. Also built a scheduler", "revert"],
				["revert of one commit with a new scheduler", "revert"],
				["revert of one commit but also a new hook", "revert"],
				["revert of one commit or a new hook", "revert"],
				["revert of one commit then built a new scheduler", "revert"],
				["revert of one commit also built a scheduler", "revert"],
				["reverts of two commits and a new hook", "reverts"],
				["revert of one commit 'and' built a scheduler", "revert"],
				["revert of one commit/and built a scheduler", "revert"],
				["revert of one commit.Also built a scheduler", "revert"],
				["revert of x#and built y", "revert"],
				["revert of x@and built y", "revert"],
				["revert of one commit a\u200bnd built a scheduler", "revert"],
			].map(([kind, phrase]) => [
				`an exempt kind with a second clause: ${kind} (#2806, #3077, #3491, #3594, #3603)`,
				kind,
				clause(phrase),
			]),
			...[
				["revert of nothing; built a new scheduler", ";"],
				["typo fix in the README — and a new hook", "—"],
				["revert (one commit) and a new feature", ")"],
				["revert of one commit, built a new scheduler", ","],
				["revert of one commit: built a new scheduler", ":"],
				["revert of one commit & a new hook", "&"],
				["revert of one commit + a new hook", "+"],
				["revert (one commit; and a new feature)", ";"],
				["revert (one commit, plus a new hook)", ","],
				["revert (one commit — built a scheduler)", "—"],
				["revert of PR #12 (the guard)", "("],
				...["―", "‒", "?", "!", "|", "…", "，", "；"].map((mark) => [
					`revert of one commit${mark} built a scheduler`,
					mark,
				]),
				["revert of one commit ａｎｄ built a scheduler", "ａ"],
				["revert of one commit \u0430nd built a scheduler", "\u0430"],
			].map(([kind, char]) => [
				`a character off the tail's allowlist: ${kind} (#3077, #3491)`,
				kind,
				holds(char),
			]),
			[
				"a slash outside a word (#3491)",
				"revert of one commit / built a scheduler",
				'puts a "-", "." or "/" outside a word',
			],
			...[
				"and",
				"but",
				"or",
				"nor",
				"yet",
				"so",
				"plus",
				"with",
				"then",
				"also",
				"as well as",
			].map((join) => [
				`a JOINS word: ${join} (#3077, #3491)`,
				`revert of one commit ${join} built a scheduler`,
				clause("revert"),
			]),
			...[
				["revert because main was red", "revert"],
				["revert about the hook", "revert"],
				["version bump 4.1 to 5.0", "version bump"],
			].map(([kind, phrase]) => [
				`an exempt kind followed by an opener off PREPOSITIONS: ${kind} (#3077, #3491)`,
				kind,
				`follows the exempt kind "${phrase}" with neither an aside in brackets nor a phrase opening with one of: of, in, on, to, for, from, over, after, before, since, across, at, by, into, under, via, per, during, through, between, within; write it as "${phrase} (<aside>)" or "${phrase} of <what>"`,
			]),
		])("skipped — %s", (_, kind, says) => {
			const reason = stop([wrote(code()), declared(`skipped — ${kind}`)]);
			// fault_in strips an aside's closing bracket and skipped_fault deletes U+200B before the line is named.
			const named = kind.replace(/\)$/, "").replaceAll("\u200b", "");
			expect(reason).toContain(`skipped names "${named}", which ${says}`);
			expect(reason).toContain(list);
		});

		it.each([
			[
				"revert of one commit\u200band built a scheduler",
				"revert of one commit and built a scheduler",
				"revert",
			],
			[
				"ver\u200bsion bump of x\u200band built y",
				"version bump of x and built y",
				"version bump",
			],
			[
				"re\u200bvert of one commit\u200band built y",
				"revert of one commit and built y",
				"revert",
			],
			[
				"revert o\u200bf one commit\u200band built a scheduler",
				"revert o f one commit and built a scheduler",
				"revert",
			],
			[
				"version bump fr\u200bom x\u200band rewrote y",
				"version bump fr om x and rewrote y",
				"version bump",
			],
		])(
			"skipped — a JOINS word a zero-width space parts off a word, named with it read as a space: %s (#3603, #3611)",
			(kind, named, phrase) => {
				const reason = stop([wrote(code()), declared(`skipped — ${kind}`)]);
				expect(reason).toContain(
					`skipped names "${named}", which ${clause(phrase)}`,
				);
				expect(reason).toContain(list);
			},
		);

		it.each([
			[
				"a non-breaking space",
				`revert of one commit${nbsp}and${nbsp}built a scheduler`,
			],
			[
				"a narrow no-break space",
				"revert of one commit\u202fand built a scheduler",
			],
		])(
			"skipped — a JOINS word set off by %s, read as a plain space (#3491)",
			(_, kind) => {
				const reason = stop([wrote(code()), declared(`skipped — ${kind}`)]);
				expect(reason).toContain(`which ${clause("revert")}`);
				expect(reason).toContain(list);
			},
		);

		it("refuses each session apart", () => {
			expect(stop([wrote(code())])).not.toBeNull();
			expect(stop([wrote(code())], { session: "s2" })).not.toBeNull();
		});

		it("says so on stderr, and refuses only a first stop, where the session id latches nothing (#2656)", () => {
			const odd = {
				session: "../x",
				stderr:
					/^practice-guard: the session id "\.\.\/x" is no plain name, so nothing latches\n$/,
			};
			expect(stop([wrote(code())], odd)).not.toBeNull();
			expect(stop([wrote(code())], { ...odd, active: true })).toBeNull();
		});

		it("says so on stderr, and refuses only a first stop, where the latch cannot be made (#2601)", () => {
			const latches = path.join(tmp, `practice-guard-${os.userInfo().uid}`);
			fs.mkdirSync(latches, { mode: 0o500 });
			const says =
				/^practice-guard: cannot create the latch .*, so nothing latches\n$/;
			expect(stop([wrote(code())], { stderr: says })).not.toBeNull();
			expect(stop([wrote(code())], { stderr: says, active: true })).toBeNull();
		});
	});

	describe("takes the latest line", () => {
		it("a later line that does not hold up beats an earlier one that does", () => {
			const blocks = [
				wrote(code()),
				declared("skipped — typo fix"),
				declared("skipped — big change"),
			];
			expect(stop(blocks)).toContain('"big change"');
		});

		/** A resolve-ticket.js close whose body file holds `body`. */
		const closeWith = (body: string) => {
			fs.writeFileSync(path.join(tmp, "close.md"), body);
			return JSON.stringify({
				type: "assistant",
				isSidechain: false,
				cwd: tmp,
				message: {
					content: [
						toolUse("Bash", {
							command:
								"node scripts/resolve-ticket.js 12 --comment-file close.md",
						}),
					],
				},
			});
		};

		it("a close comment's body file, after an earlier bad line", () => {
			const close = closeWith(
				`Shipped.\n\n**Practice:** covered — ${fresh}, ${FIVE_MONTHS_AGO}\n`,
			);
			expect(
				stop([wrote(code()), declared("skipped — big change"), close]),
			).toBeNull();
		});

		it("a gh comment's inline body", () => {
			const comment = toolUse("Bash", {
				command: 'gh issue comment 12 --body "**Practice:** skipped — revert"',
			});
			expect(stop([wrote(code()), comment])).toBeNull();
		});

		/** A gh comment whose $'...' body ends on the declaration `skipped — <kind>`. */
		const ansiComment = (kind: string) =>
			toolUse("Bash", {
				command: `gh issue comment 12 --body $'Done.\\r\\n\\r\\n**Practice:** skipped — ${kind}'`,
			});

		it.each(["revert", "revert of x\\'s fix", "revert\\r\\n"])(
			"a gh comment's $'...' body, its \\r, \\n and \\' decoded: skipped — %s (#3491, #3594)",
			(kind) => {
				expect(stop([wrote(code()), ansiComment(kind)])).toBeNull();
			},
		);

		it.each([
			["revert and a new hook", "revert and a new hook", clause("revert")],
			[
				"revert of one commit\\x2c built a scheduler",
				"revert of one commit\\x2c built a scheduler",
				holds("\\"),
			],
			[
				"revert and a new hook\\r\\n",
				"revert and a new hook",
				clause("revert"),
			],
		])(
			"a gh comment's $'...' body, refused where a kept escape or a second clause follows the kind: skipped — %s (#3491, #3594)",
			(kind, named, says) => {
				const reason = stop([wrote(code()), ansiComment(kind)]);
				expect(reason).toContain(`skipped names "${named}", which ${says}`);
				expect(reason).toContain(list);
			},
		);

		it.each([
			["ran", () => `ran — ${fresh}`, () => [wrote(path.join(repo, fresh))]],
			["none-fits", () => "none-fits — nearest llm-agent-design", () => []],
		])(
			"a gh comment's inline %s body, its closing quote no part of it",
			(_, line, writes) => {
				const comment = toolUse("Bash", {
					command: `gh issue comment 12 --body "**Practice:** ${line()}"`,
				});
				expect(stop([wrote(code()), ...writes(), comment])).toBeNull();
			},
		);

		it("a declaration ending a sentence", () => {
			expect(stop([wrote(code()), declared(`covered — ${fresh}.`)])).toBeNull();
		});

		it("a none-fits line whose nearest opens a sentence", () => {
			const line = declared("none-fits — Nearest llm-agent-design.");
			expect(stop([wrote(code()), line])).toBeNull();
		});

		it("past a transcript line that is not JSON", () => {
			expect(stop(['{"type":"assist', wrote(code())])).toContain(
				"no **Practice:** line",
			);
		});

		it("but not a later line quoting the forms", () => {
			const quoted = text("Forms: `**Practice:** ran — <note>`, and so on.");
			expect(
				stop([wrote(code()), declared("skipped — revert"), quoted]),
			).toBeNull();
		});

		const markerProse = [
			{
				where: "mid-line",
				prose: "The hook reads the latest **Practice:** line.",
				ticket: "",
			},
			{
				where: "in quotes",
				prose: 'It reads a line like "**Practice:** skipped — big change".',
				ticket: " (#2656)",
			},
		];

		it.each(markerProse)(
			"but not prose that names the marker $where$ticket",
			({ prose }) => {
				expect(
					stop([wrote(code()), declared("skipped — revert"), text(prose)]),
				).toBeNull();
			},
		);

		it.each(markerProse)(
			"but not body-file prose that names the marker $where (#2601)",
			({ prose }) => {
				const close = closeWith(
					`Shipped.\n\n**Practice:** skipped — revert\n\n${prose}\n`,
				);
				expect(stop([wrote(code()), close])).toBeNull();
			},
		);

		it("but not an inline body quoting the marker mid-line (#2806)", () => {
			const comment = toolUse("Bash", {
				command:
					"gh issue comment 5 --body \"The hook takes a line like '**Practice:** skipped — big change' as the declaration.\"",
			});
			expect(
				stop([wrote(code()), declared("skipped — revert"), comment]),
			).toBeNull();
		});

		it.each([
			"--comment '**Practice:** skipped — revert'",
			'-b "**Practice:** skipped — revert"',
			'-c "**Practice:** skipped — revert"',
			'--body="**Practice:** skipped — revert"',
			'--comment "**Practice:** skipped — revert" --reason "not planned"',
			'--comment "Shipped.\n\n**Practice:** skipped — revert" --reason "not planned"',
			"--body 'It'\\''s done.\n\n**Practice:** skipped — revert'",
			'--comment "Fixed \\"x\\".\n\n**Practice:** skipped — revert" --reason "not planned"',
			"--body-file - <<'EOF'\nDone.\n\n**Practice:** skipped — revert\nEOF",
			"--body \"$(cat <<'EOF'\nDone.\n\n**Practice:** skipped — revert\nEOF\n)\"",
		])("an inline body under %s", (body) => {
			const close = toolUse("Bash", { command: `gh issue close 12 ${body}` });
			expect(stop([wrote(code()), close])).toBeNull();
		});

		it.each([
			[
				"an inline body",
				"--body \"Use --body '**Practice:** skipped — big change' to declare.\"",
			],
			[
				"a heredoc body",
				"--body-file - <<'EOF'\nUse --body '**Practice:** skipped — big change' to declare.\nEOF",
			],
		])(
			"but not %s whose prose quotes a marker after a body flag (#3077)",
			(_, body) => {
				const comment = toolUse("Bash", {
					command: `gh issue comment 5 ${body}`,
				});
				expect(
					stop([wrote(code()), declared("skipped — revert"), comment]),
				).toBeNull();
			},
		);

		it("but not a line in a command that writes no tracker", () => {
			const grep = toolUse("Bash", {
				command: "grep '**Practice:** skipped — revert' notes.md",
			});
			expect(stop([wrote(code()), grep])).toContain("no **Practice:** line");
		});
	});
});
