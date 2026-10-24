// @vitest-environment node
/*
 * The practice guard hands a session the craft list (#2324) and the
 * evidence-rung ranking (#2637) on its first touch of docs/practice/, and
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
/** The clause of the evidence-rung ranking a note writer most often gets wrong (#2637). */
const RANKING =
	"A company's docs earn the top rung only for how its own product behaves or is configured";

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
		])("skipped — %s, an exempt kind (#2601)", (kind) => {
			expect(stop([wrote(code()), declared(`skipped — ${kind}`)])).toBeNull();
		});

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
			...[
				"typography system overhaul",
				"reverting nothing; built the new hook",
				"reply-driven feature build",
			].map((kind) => [
				`skipped — a word an exempt kind's stem opens: ${kind} (#2601)`,
				[declared(`skipped — ${kind}`)],
				"no exempt kind",
			]),
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

		it("refuses each session apart", () => {
			expect(stop([wrote(code())])).not.toBeNull();
			expect(stop([wrote(code())], { session: "s2" })).not.toBeNull();
		});

		it("refuses only a first stop where the session id latches nothing", () => {
			const odd = { session: "../x" };
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

		it("but not prose that names the marker mid-line", () => {
			const prose = text("The hook reads the latest **Practice:** line.");
			expect(
				stop([wrote(code()), declared("skipped — revert"), prose]),
			).toBeNull();
		});

		it.each([
			["mid-line", "The hook reads the latest **Practice:** line."],
			[
				"in quotes",
				'It reads a line like "**Practice:** skipped — big change".',
			],
		])(
			"but not body-file prose that names the marker %s (#2601)",
			(_, prose) => {
				const close = closeWith(
					`Shipped.\n\n**Practice:** skipped — revert\n\n${prose}\n`,
				);
				expect(stop([wrote(code()), close])).toBeNull();
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
