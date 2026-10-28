// @vitest-environment node
/*
 * The three routes that name the review-axis Artefact paths must spell them
 * alike (mantahostels#3458): a review dispatched on one route's name and read back on
 * another's finds nothing. They name the axes' subagent type too, which must
 * be one the host has (#741). The inject-review-tier core's focus and attack
 * paths take the same suffix (#1621).
 *
 * Each route's real script runs black-box against a scratch host directory,
 * with a session id that needs sanitising, since the fault is the routes
 * disagreeing and only their own output shows it. One route is the
 * `guard-review-rules` core, run through the PreToolUse dispatcher's entry;
 * loosen a case and a `/code-review` pass reads back no axis report at all.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./git-fixture";
import { runInProcess } from "./run-in-process.js";

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");
// No `/`: concision-backstop.sh also names a file on the full id, and bails on one.
const ID = "ab.cd:e+fgh-99";
const EXPECTED = "-ab_cd_e_";

let dir: string;

beforeEach(() => {
	dir = mkScratchDir("review-suffix-");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The dispatcher's stdout for one core, run on `payload` in `env`; a non-zero
 * exit fails the case, as execFileSync's throw would. */
const dispatch = (
	core: string,
	payload: object,
	env: Record<string, string | undefined>,
) => {
	const r = runInProcess(
		path.join(SCRIPTS, "guard-dispatch.js"),
		["--only", core],
		{ stdin: JSON.stringify(payload), env },
	);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout;
};

/** Every review-spec path suffix in `text`; `""` for a bare name. */
const suffixes = (text: string) =>
	[...text.matchAll(/review-spec(-[^.`\s]*)?\.md/g)].map((m) => m[1] ?? "");

/** Every review subagent type named in backticks in `text`. */
const agentTypes = (text: string) =>
	[...text.matchAll(/`((?:workflow-core:)?code-reviewer)`/g)].map((m) => m[1]);

/** Gives `host` a code-reviewer definition of its own, as the core has. */
const ownReviewer = (host: string) => {
	fs.mkdirSync(path.join(host, ".claude", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(host, ".claude", "agents", "code-reviewer.md"),
		"---\nname: code-reviewer\n---\n",
	);
};

/** Called bare, as in the core, so the host carries the core's own skill (#1165). */
const guardReviewRules = () => {
	const skill = path.join(dir, ".claude", "skills", "code-review");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(
		path.join(skill, "SKILL.md"),
		"---\nname: code-review\n---\n",
	);
	const out = dispatch(
		"guard-review-rules",
		{
			hook_event_name: "PreToolUse",
			tool_name: "Skill",
			tool_input: { skill: "code-review" },
			session_id: ID,
		},
		{ ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: dir },
	);
	return JSON.parse(out).hookSpecificOutput.additionalContext as string;
};

const injectTrackerDocs = (host = ROOT) => {
	const out = execFileSync(path.join(SCRIPTS, "inject-tracker-docs.sh"), {
		input: JSON.stringify({
			prompt: "/code-review 3458",
			hook_event_name: "UserPromptSubmit",
			session_id: ID,
		}),
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_JOB_DIR: "",
			CLAUDE_CODE_SESSION_ID: "",
			CLAUDE_PROJECT_DIR: host,
			TMPDIR: dir,
		},
	});
	return JSON.parse(out).hookSpecificOutput.additionalContext as string;
};

/** The Stop nag, provoked by a code change this session's ledger owns. */
const concisionBackstop = (
	prepare = (_repo: string) => {
		/* no setup beyond the code change */
	},
) => {
	const repo = path.join(dir, "repo");
	const hooks = path.join(dir, "no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(repo, hooks);
	prepare(repo);

	const env = {
		...process.env,
		CLAUDE_PROJECT_DIR: repo,
		CLAUDE_CONFIG_DIR: path.join(dir, "config"),
		TMPDIR: dir,
	};
	const hook = (mode: string) =>
		spawnSync(path.join(SCRIPTS, "concision-backstop.sh"), [mode], {
			cwd: repo,
			encoding: "utf8",
			input: JSON.stringify({ session_id: ID }),
			env,
		}).stdout;
	hook("start");
	fs.mkdirSync(path.join(repo, "scripts"));
	fs.writeFileSync(
		path.join(repo, "scripts", "mine.ts"),
		Array.from({ length: 30 }, (_, i) => `export const x${i} = ${i};`).join(
			"\n",
		),
	);
	const recorded = runInProcess(
		path.join(SCRIPTS, "session-arbiter.js"),
		["record", "scripts/mine.ts", ID],
		{ cwd: repo, env, stdin: "" },
	);
	expect(recorded.status, recorded.stderr).toBe(0);
	return JSON.parse(hook("stop")).reason as string;
};

/** The tier core's envelope, on a staged change to a declared sensitive glob (#1621). */
const injectReviewTier = () => {
	const repo = path.join(dir, "tier");
	const hooks = path.join(dir, "tier-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(repo, hooks);
	const skill = path.join(repo, ".claude", "skills", "code-review");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(
		path.join(skill, "SKILL.md"),
		"---\nname: code-review\n---\n",
	);
	fs.writeFileSync(
		path.join(repo, ".claude", "workflow-core.json"),
		JSON.stringify({
			sensitivePaths: [
				{ name: "secrets", description: "secret handling", globs: ["s.js"] },
			],
		}),
	);
	fs.writeFileSync(path.join(repo, "s.js"), "x\n");
	execFileSync("git", ["add", "s.js"], { cwd: repo });
	const out = dispatch(
		"inject-review-tier",
		{
			hook_event_name: "PreToolUse",
			tool_name: "Skill",
			tool_input: { skill: "code-review" },
			session_id: ID,
		},
		{ ...process.env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CONFIG_DIR: dir },
	);
	return JSON.parse(out).hookSpecificOutput.additionalContext as string;
};

describe("the review-axis session suffix (mantahostels#3458)", () => {
	it("is spelled alike by all three routes, for an id needing sanitising", () => {
		const routes = {
			"guard-review-rules": suffixes(guardReviewRules()),
			"inject-tracker-docs.sh": suffixes(injectTrackerDocs()),
			"concision-backstop.sh": suffixes(concisionBackstop()),
		};
		for (const [route, found] of Object.entries(routes)) {
			expect(found, route).not.toEqual([]);
			expect(new Set(found), route).toEqual(new Set([EXPECTED]));
		}
	});

	it("is spelled alike on the focus and attack paths the tier core names (#1621)", () => {
		const found = [
			...injectReviewTier().matchAll(
				/review-(?:focus|attack)(-[^.`\s]*)?\.md/g,
			),
		].map((m) => m[1] ?? "");
		expect(found).toHaveLength(2);
		expect(new Set(found)).toEqual(new Set([EXPECTED]));
	});

	it("is what write-review-marker.js reads the artefacts back by (#2040)", () => {
		const repo = path.join(dir, "marker-host");
		const hooks = path.join(dir, "marker-hooks");
		fs.mkdirSync(hooks);
		initGitRepo(repo, hooks);
		fs.mkdirSync(path.join(repo, ".claude", "tmp"), { recursive: true });
		for (const axis of ["standards", "spec"])
			fs.writeFileSync(
				path.join(repo, ".claude", "tmp", `review-${axis}${EXPECTED}.md`),
				"- none\n",
			);
		const r = runInProcess(
			path.join(SCRIPTS, "write-review-marker.js"),
			["--base", "HEAD", "--findings", "0"],
			{
				cwd: repo,
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: repo,
					CLAUDE_CODE_SESSION_ID: ID,
				},
			},
		);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("is empty for an empty id, leaving the bare name", () => {
		const out = execFileSync(
			"bash",
			[
				"-c",
				'source "$1"; printf "[%s][%s]" "$(review_suffix "")" "$(review_suffix "$2")"',
				"_",
				path.join(__dirname, "review-suffix.sh"),
				ID,
			],
			{ encoding: "utf8" },
		);
		expect(out).toBe(`[][${EXPECTED}]`);
	});
});

describe("the review subagent type (#741)", () => {
	// A plugin agent is offered namespaced, and the bare name is refused as not found.
	it("is the plugin's spelling on every route where the host has no definition", () => {
		const routes = {
			"guard-review-rules": agentTypes(guardReviewRules()),
			"inject-tracker-docs.sh": agentTypes(injectTrackerDocs(dir)),
			"concision-backstop.sh": agentTypes(concisionBackstop()),
		};
		for (const [route, found] of Object.entries(routes)) {
			expect(found, route).toEqual(["workflow-core:code-reviewer"]);
		}
	});

	it("is the bare name on every route where the host has its own", () => {
		ownReviewer(dir);
		const routes = {
			"guard-review-rules": agentTypes(guardReviewRules()),
			"inject-tracker-docs.sh": agentTypes(injectTrackerDocs(dir)),
			"concision-backstop.sh": agentTypes(concisionBackstop(ownReviewer)),
		};
		for (const [route, found] of Object.entries(routes)) {
			expect(found, route).toEqual(["code-reviewer"]);
		}
	});
});
