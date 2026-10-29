/*
 * new-repo-testkit.ts — the fixture every new-repo.js suite stands on: the
 * stateful `gh` stub and its server, `sandbox`, the source repo a copy run
 * starts from, and the clean run and part-way worlds the --resume cases
 * rebuild. new-repo.test.ts's header says how a run is driven.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { withIgnoreBlock } from "../../../../scripts/lib/adopter-skeleton.js";
import {
	type GhStubServer,
	serveGhStub,
	stubGhScript,
} from "../../../../scripts/lib/gh-stub";
import { installPathFor } from "../../../../scripts/lib/plugin-state.js";
import { requiredGroup } from "../../../../scripts/lib/regex-group.js";

const SCRIPT = path.join(__dirname, "new-repo.js");
export const IDEA =
	"A tide-table app for surfers.\n\n## It has a heading\n\nAnd a second paragraph, kept as written.";

/** A block in the shape the founder's `~/.bashrc` carries, unlike what the script writes. */
export const buildLiveBlock = (repo: string, p: string) =>
	[
		`# --- ${repo}, one alias per plan ---`,
		`# Mirrors fb1/fb2/fb3 but pointed at ~/${repo}.`,
		...["", "2", "3"].map(
			(d, i) =>
				`alias ${p}${i + 1}='(cd ~/${repo} && CLAUDE_CONFIG_DIR=$HOME/.claude${d} WFC_CLAUDE_BIN=$_CAU claude agents)'`,
		),
		`# --- end ${repo} block ---`,
	].join("\n");
const EXISTING_BLOCKS = [
	buildLiveBlock("fantasy-books", "fb"),
	buildLiveBlock("workflow-core", "wc"),
	buildLiveBlock("design-vault", "dv"),
].join("\n\n");
export const BASHRC = `# ~/.bashrc\nexport EDITOR=vi\n\n${EXISTING_BLOCKS}\n`;

/** What the script writes for tides/td. */
export const TIDES_BLOCK = [
	"# --- tides, one alias per plan ---",
	"alias td1='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude claude agents)'",
	"alias td2='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude2 claude agents)'",
	"alias td3='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude3 claude agents)'",
	"# --- end tides block ---",
].join("\n");

const made: string[] = [];

/**
 * The stub `gh`. State lives under `<sb>/github`: `<owner>/<name>.git` is the
 * bare repo, `<owner>/<name>.json` its labels, issues and privacy, an issue's
 * `parent` its sub-issue link. A file
 * `<sb>/fail/<key>` makes that call fail; `issue-create` lands the issue and
 * still reports failure, as GitHub can. Every argv is logged to `<sb>/gh-calls`.
 * A `repo clone` ignores the git arguments after `--`. One server answers the
 * whole file (`serveGhStub`), reading each call's sandbox from its
 * NEW_REPO_SB (#2877).
 */
const STUB = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const SB = env.NEW_REPO_SB;
const a = argv;
fs.appendFileSync(path.join(SB, "gh-calls"), JSON.stringify(a) + "\n");
const joined = a.join(" ");
const failing = (k) => fs.existsSync(path.join(SB, "fail", k));
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const flags = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const die = (m) => { err(m + "\n"); exit(1); };
const print = (v) => { out(typeof v === "string" ? v + "\n" : JSON.stringify(v) + "\n"); exit(0); };
const statePath = (r) => path.join(SB, "github", r + ".json");
const read = (r) => fs.existsSync(statePath(r)) ? JSON.parse(fs.readFileSync(statePath(r), "utf8")) : null;
const write = (r, s) => fs.writeFileSync(statePath(r), JSON.stringify(s, null, 2));
const need = (r) => read(r) ?? die("GraphQL: Could not resolve to a Repository with the name '" + r + "'. (repository)");
const shape = (i, fields) => Object.fromEntries(fields.split(",").map((f) => [f, f === "labels" ? i.labels.map((name) => ({ name })) : i[f]]));

if (joined === "auth status") failing("auth") ? die("You are not logged into any GitHub hosts.") : print("Logged in");
if (a[0] === "api") {
	const p = a.find((x) => x.startsWith("repos/"));
	const m = /^repos\/([^/]+\/[^/]+)\/(tags|labels)$/.exec(p);
	if (m && m[2] === "tags") print([JSON.parse(fs.readFileSync(path.join(SB, "tags"), "utf8")).map((name) => ({ name }))]);
	if (m && m[2] === "labels") print([need(m[1]).labels.map((name) => ({ name }))]);
	// init-adopter's feature probes.
	if (/^repos\/[^/]+\/[^/]+\/(actions\/runs|pulls)\?/.test(p)) print({});
	if (/\/dependencies\/blocked_by$/.test(p)) print([]);
	const is = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/sub_issues)?$/.exec(p);
	if (is) {
		const s = need(is[1]);
		const find = (n) => s.issues.find((x) => x.number === n) ?? die("HTTP 404: Not Found");
		const rest = (i) => ({ id: 1000 + i.number, number: i.number, title: i.title, state: i.state.toLowerCase(), body: i.body, labels: i.labels.map((name) => ({ name })), parent_issue_url: i.parent ? "https://api.github.com/repos/" + is[1] + "/issues/" + i.parent : null });
		const issue = find(Number(is[2]));
		if (!is[3]) print(flag("--jq") === ".id" ? String(1000 + issue.number) : flag("--jq") === ".state" ? rest(issue).state : rest(issue));
		if (flag("--method") === "POST") {
			const child = find(Number(flag("-F").split("=")[1]) - 1000);
			if (child.parent) die("HTTP 422: Sub issue may only have one parent");
			child.parent = issue.number;
			write(is[1], s);
			print(rest(child));
		}
		const kids = s.issues.filter((x) => x.parent === issue.number).map(rest);
		if (flag("--jq") === ".[].number") print(kids.map((k) => k.number).join("\n"));
		print(a.includes("--slurp") ? [kids] : kids);
	}
	die("HTTP 404: Not Found");
}
if (a[0] === "repo") {
	const r = a[2];
	if (a[1] === "view") {
		const s = need(r);
		let empty = true;
		// A bare repo git cannot read is reported empty, as GitHub reports one with no refs.
		try { empty = !execFileSync("git", ["-C", path.join(SB, "github", r + ".git"), "for-each-ref"], { cwd, env, encoding: "utf8" }).trim(); } catch {}
		print({ isEmpty: empty, isPrivate: s.private, owner: { login: r.split("/")[0] }, defaultBranchRef: empty ? null : { name: s.defaultBranch ?? "main" }, licenseInfo: s.license ?? null });
	}
	if (a[1] === "create") {
		if (failing("repo-create")) die("HTTP 502: Bad Gateway");
		fs.mkdirSync(path.dirname(statePath(r)), { recursive: true });
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", path.join(SB, "github", r + ".git")], { cwd, env });
		write(r, { private: a.includes("--private"), labels: [], issues: [] });
		print("https://github.com/" + r);
	}
	if (a[1] === "clone") {
		need(r);
		execFileSync("git", ["clone", "-q", "https://github.com/" + r + ".git", a[3]], { cwd, env, stdio: "ignore" });
		exit(0);
	}
	if (a[1] === "set-default") exit(0);
}
if (a[0] === "label" && a[1] === "create") {
	const r = flag("--repo"), s = need(r);
	if (!s.labels.includes(a[2])) s.labels.push(a[2]);
	s.labelMeta = { ...s.labelMeta, [a[2]]: { color: flag("--color"), description: flag("--description") ?? "" } };
	write(r, s);
	exit(0);
}
if (a[0] === "label" && a[1] === "list") {
	const s = need(flag("--repo"));
	print(s.labels.map((name) => ({ name, color: "", description: "", ...s.labelMeta?.[name] })));
}
if (a[0] === "issue") {
	const r = flag("--repo"), s = need(r);
	if (a[1] === "list") {
		const label = flag("--label"), state = (flag("--state") ?? "open").toUpperCase();
		const listed = s.issues.filter((i) => (!label || i.labels.includes(label)) && (state === "ALL" || i.state === state));
		// init-adopter's probe reads the newest issue's number.
		if (flag("--jq") === ".[0].number") print(String(listed.at(-1)?.number ?? ""));
		print(listed.map((i) => shape(i, flag("--json"))));
	}
	if (a[1] === "create") {
		const file = flag("--body-file");
		const body = file === "-" ? stdin : fs.readFileSync(path.resolve(cwd, file), "utf8");
		const labels = flags("--label");
		const unknown = labels.filter((l) => !s.labels.includes(l));
		if (unknown.length) die("could not add label: '" + unknown[0] + "' not found");
		const number = s.issues.length + 1;
		s.issues.push({ number, title: flag("--title"), body, labels, state: "OPEN", assignees: [], comments: [] });
		write(r, s);
		if (failing("issue-create")) die("HTTP 502: Bad Gateway");
		print("https://github.com/" + r + "/issues/" + number);
	}
	const i = s.issues.find((x) => x.number === Number(a[2])) ?? die("issue " + a[2] + " not found");
	if (a[1] === "view") print(shape(i, flag("--json")));
	if (a[1] === "edit" && flag("--body-file")) { i.body = fs.readFileSync(path.resolve(cwd, flag("--body-file")), "utf8"); write(r, s); exit(0); }
	if (a[1] === "close") { i.state = "CLOSED"; if (flag("--comment")) i.comments.push(flag("--comment")); write(r, s); exit(0); }
}
die("stub gh: unmodelled call: " + joined);
`;

let ghServer: GhStubServer;

/** Register the file's one gh stub server and the afterEach that removes
 * every sandbox a case made. */
export function newRepoSuite(): void {
	beforeAll(async () => {
		ghServer = await serveGhStub(STUB);
	});
	afterAll(async () => {
		await ghServer?.close();
	});
	afterEach(() => {
		for (const dir of made.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});
}

/**
 * Turns `env`'s git hooks off by appending `core.hooksPath=/dev/null` as the
 * last git environment config pair, or on by removing that pair, keeping every
 * pair before it: the suite's maintenance switch-off is among them (#1655).
 */
function setHooks(env: NodeJS.ProcessEnv, hooks: boolean) {
	const n = Number(env.GIT_CONFIG_COUNT ?? 0);
	const off =
		n > 0 &&
		env[`GIT_CONFIG_KEY_${n - 1}`] === "core.hooksPath" &&
		env[`GIT_CONFIG_VALUE_${n - 1}`] === "/dev/null";
	if (hooks && off) {
		delete env[`GIT_CONFIG_KEY_${n - 1}`];
		delete env[`GIT_CONFIG_VALUE_${n - 1}`];
		env.GIT_CONFIG_COUNT = String(n - 1);
	} else if (!hooks && !off) {
		env[`GIT_CONFIG_KEY_${n}`] = "core.hooksPath";
		env[`GIT_CONFIG_VALUE_${n}`] = "/dev/null";
		env.GIT_CONFIG_COUNT = String(n + 1);
	}
}

/**
 * The suite's maintenance switch-off (`vitest.setup.ts`, #806), restated in
 * the sandbox's ~/.gitconfig because git strips the suite's environment config
 * from the receiving side of a local push, which would otherwise start
 * maintenance in the bare remote (#1655).
 */
export const MAINTENANCE_OFF: Record<string, string> = {
	"maintenance.auto": "false",
	"gc.auto": "0",
};

export const HAS_GITLEAKS = (() => {
	try {
		execFileSync(process.env.WFC_GITLEAKS || "gitleaks", ["version"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();

export const SOURCE = "octo/surf-lib";
/** The source repo's .gitignore in the clean copy: it hides one of init's files. */
export const SOURCE_IGNORE = "node_modules/\nCLAUDE.md\n";
export const SOURCE_AGENTS =
	"# surf-lib\n\nOpen a pull request from a feature branch.\n";
/**
 * Annotated, so the core's wiring gate passes it as `.husky/pre-commit.local`,
 * and shebang-less, as husky v9 writes hooks (#1870).
 */
export const SOURCE_HOOK =
	"# IMPLICIT: runs surf-lib's own check on every commit\n# JUSTIFIED: fail-safe — a missing library refuses the commit\n# DEFEAT: none\ntest -f lib/tide.js\n";
/** SOURCE_HOOK set aside: given the shell directive shellcheck needs. */
export const SET_ASIDE_HOOK = `# shellcheck shell=sh\n${SOURCE_HOOK}`;

/**
 * A public source repo on the stub's GitHub: default branch `trunk`, a stale
 * branch beside it, a lightweight and an annotated tag, a test script, a
 * workflow and `gitignore` as its .gitignore. `extra` adds files; a `{link}` value is a symlink, and
 * `null` leaves that file out.
 */
function makeSource(
	sb: string,
	gitignore: string,
	extra: Record<string, string | { link: string } | null>,
) {
	const bare = path.join(sb, "github", `${SOURCE}.git`);
	fs.mkdirSync(path.dirname(bare), { recursive: true });
	execFileSync("git", ["init", "-q", "--bare", "-b", "trunk", bare]);
	const work = path.join(sb, "source-work");
	execFileSync("git", ["init", "-q", "-b", "trunk", work]);
	const g = (...a: string[]) =>
		execFileSync(
			"git",
			["-C", work, "-c", "user.name=Octo", "-c", "user.email=o@o", ...a],
			{ stdio: "ignore" },
		);
	const files: Record<string, string | { link: string } | null> = {
		".gitignore": gitignore,
		"README.md": "# surf-lib\n",
		"package.json": `${JSON.stringify({ name: "surf-lib", scripts: { test: "node --test" } }, null, 2)}\n`,
		"lib/tide.js": "module.exports = () => 1;\n",
		".github/workflows/ci.yml": "on: push\njobs: {}\n",
		"AGENTS.md": SOURCE_AGENTS,
		".husky/pre-commit": SOURCE_HOOK,
		"docs/tides.md": "# Tides\n\nHow the table is computed.\n",
		...extra,
	};
	for (const [f, body] of Object.entries(files)) {
		if (body === null) continue;
		fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
		if (typeof body === "string") fs.writeFileSync(path.join(work, f), body);
		else fs.symlinkSync(body.link, path.join(work, f));
	}
	g("add", "-A");
	g("commit", "-q", "-m", "surf-lib");
	g("tag", "v1");
	fs.writeFileSync(
		path.join(work, "lib/tide.js"),
		"module.exports = () => 2;\n",
	);
	g("commit", "-q", "-am", "tides rise");
	g("tag", "-a", "v2", "-m", "v2");
	g("checkout", "-q", "-b", "stale");
	g("commit", "-q", "--allow-empty", "-m", "stale work");
	g("checkout", "-q", "trunk");
	g("push", "-q", bare, "trunk", "stale", "v1", "v2");
	fs.writeFileSync(
		path.join(sb, "github", `${SOURCE}.json`),
		JSON.stringify({
			private: false,
			labels: [],
			issues: [],
			defaultBranch: "trunk",
			license: { name: "MIT License" },
		}),
	);
}

/**
 * `bashrc` seeds ~/.bashrc.
 * `failBashN` puts a `bash` first on PATH whose `-n` refuses any file holding
 * the tides block, as a write that broke the file's syntax would read — on
 * PATH, not through an env var, because the script carries no test hook
 * (#707 Q2). `source` makes the run a copy of a source repo holding that
 * .gitignore, and `sourceFiles` beside its own. `globalIgnore` is HOME's
 * git ignore file, as the founder's hides .claude/settings.local.json.
 * `hooks: false` runs every git call with no hooks.
 */
export function sandbox({
	tags = ["v1.9.3", "v1.10.0", "nightly", "v0.99.0"],
	bashrc = BASHRC as string | null,
	failBashN = false,
	source = null as string | null,
	sourceFiles = {} as Record<string, string | { link: string } | null>,
	globalIgnore = null as string | null,
	hooks = true,
} = {}) {
	const sb = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "new-repo-")),
	);
	made.push(sb);
	const home = path.join(sb, "home");
	fs.mkdirSync(path.join(sb, "github"), { recursive: true });
	fs.mkdirSync(path.join(sb, "fail"));
	fs.mkdirSync(home);
	const maintenanceOff = Object.entries(MAINTENANCE_OFF)
		.map(([k, v]) => k.replace(/^(\w+)\.(.+)$/, `[$1]\n\t$2 = ${v}\n`))
		.join("");
	fs.writeFileSync(
		path.join(home, ".gitconfig"),
		`[user]\n\tname = Test Founder\n\temail = founder@example.invalid\n[init]\n\tdefaultBranch = main\n${maintenanceOff}[url "${path.join(sb, "github")}/"]\n\tinsteadOf = https://github.com/\n`,
	);
	if (globalIgnore !== null) {
		fs.mkdirSync(path.join(home, ".config/git"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config/git/ignore"), globalIgnore);
	}
	fs.writeFileSync(path.join(sb, "tags"), JSON.stringify(tags));
	/* Each tag's cache copy, where --no-plugin-install leaves init to find the
	 * pin installed (#736): a link to this checkout. */
	for (const tag of tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t))) {
		const at = pinned(home, tag);
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.symlinkSync(path.resolve(__dirname, "../../../.."), at);
	}
	if (source !== null) makeSource(sb, source, sourceFiles);
	// The scratch clone of the source repo lands here, where a test can see it gone.
	fs.mkdirSync(path.join(sb, "tmp"));
	if (bashrc !== null) fs.writeFileSync(path.join(home, ".bashrc"), bashrc);
	const stub = stubGhScript(sb, ghServer.script);
	let searchPath = process.env.PATH ?? "";
	if (failBashN) {
		const realBash = execFileSync("sh", ["-c", "command -v bash"], {
			encoding: "utf8",
		}).trim();
		fs.mkdirSync(path.join(sb, "bash-bin"));
		fs.writeFileSync(
			path.join(sb, "bash-bin/bash"),
			`#!/bin/sh\nif [ "$1" = -n ] && grep -q '^# --- tides, one alias per plan ---$' "$2"; then echo "$2: line 9: syntax error near unexpected token" >&2; exit 2; fi\nexec ${realBash} "$@"\n`,
			{ mode: 0o755 },
		);
		searchPath = `${path.join(sb, "bash-bin")}${path.delimiter}${searchPath}`;
	}
	const inputs = path.join(sb, "inputs");
	fs.mkdirSync(inputs);
	fs.writeFileSync(path.join(inputs, "idea"), `${IDEA}\n`);
	fs.writeFileSync(
		path.join(inputs, "one-liner"),
		"A tide-table app for surfers, for the founder's own surf trips.\n",
	);
	fs.writeFileSync(path.join(inputs, "title"), "tides: a tide-table app\n");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...stub.env,
		PATH: searchPath,
		HOME: home,
		NEW_REPO_SB: sb,
		CLAUDE_CONFIG_DIR: path.join(home, ".claude2"),
		TMPDIR: path.join(sb, "tmp"),
		/* Run as a session runs /new-repo, whoever runs the suite: the map it
		 * files is still unassigned (#2460). */
		CLAUDE_CODE_SESSION_ID: "new-repo-test-session",
	};
	setHooks(env, hooks);
	for (const k of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"XDG_CONFIG_HOME",
	])
		delete env[k];
	const args = (...extra: string[]) => [
		"--name",
		"tides",
		"--prefix",
		"td",
		"--idea-file",
		path.join(inputs, "idea"),
		"--one-liner-file",
		path.join(inputs, "one-liner"),
		"--title-file",
		path.join(inputs, "title"),
		"--no-plugin-install",
		...(source === null ? [] : ["--source", SOURCE]),
		...extra,
	];
	const spawn = (argv: string[]) =>
		spawnSync(process.execPath, [SCRIPT, ...argv], {
			cwd: path.resolve(__dirname, "../../../.."),
			encoding: "utf8",
			env,
			timeout: 170_000,
		});
	const run = (...extra: string[]) => spawn(args(...extra));
	const resume = (...extra: string[]) =>
		spawn(["--resume", "tides", "--no-plugin-install", ...extra]);
	const readState = (repo = "lucmoseley/tides") => {
		const f = path.join(sb, "github", `${repo}.json`);
		return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
	};
	const readCalls = () =>
		fs.existsSync(path.join(sb, "gh-calls"))
			? fs
					.readFileSync(path.join(sb, "gh-calls"), "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l) as string[])
			: [];
	const git = (...a: string[]) =>
		execFileSync("git", a, {
			cwd: path.join(home, "tides"),
			encoding: "utf8",
			env,
		}).trim();
	const rc = path.join(home, ".bashrc");
	const readBackups = () =>
		fs.readdirSync(home).filter((f) => f.startsWith(".bashrc.bak-new-repo-"));
	return {
		sb,
		home,
		env,
		inputs,
		clone: path.join(home, "tides"),
		run,
		resume,
		readState,
		readCalls,
		git,
		rc,
		readBackups,
	};
}

/** The plugin copy a run pins, as the CLI caches it for plan 2. */
export const pinned = (home: string, tag: string) =>
	installPathFor(
		path.join(home, ".claude2"),
		"workflow-core",
		"workflow-core",
		tag,
	);

/** The status column of the report line for `step`. */
export const statusOf = (stdout: string, step: string) =>
	stdout
		.split("\n")
		.find((l) => l.startsWith(`${step.padEnd(14)} `))
		?.slice(15)
		.split(" — ")[0];

/**
 * What git resolves for the settings `setHooks` must leave intact or toggle,
 * run with `env`; "" is unset. The sandbox's ~/.gitconfig goes unread, so
 * only the env's pairs answer.
 */
export const gitConfig = (env: NodeJS.ProcessEnv) =>
	Object.fromEntries(
		[...Object.keys(MAINTENANCE_OFF), "core.hooksPath"].map((key) => [
			key,
			spawnSync("git", ["config", "--get", key], {
				cwd: os.tmpdir(),
				encoding: "utf8",
				env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" },
			}).stdout.trim(),
		]),
	);

/** What a run saves for tides/td once its clone exists. */
export const SAVED = {
	name: "tides",
	repo: "lucmoseley/tides",
	prefix: "td",
	idea: IDEA,
	oneLiner: "A tide-table app for surfers, for the founder's own surf trips",
	title: "tides: a tide-table app",
	corpus: [],
	specUrl: null,
	source: null,
};

/** What a clean run leaves, to rebuild its steps from and compare against. */
interface Golden {
	issue: unknown;
	claude: string;
	local: string;
	ignore: string;
	classes: string;
	docMap: string;
}

export type Sandbox = ReturnType<typeof sandbox>;

/** The copy step done by hand, as new-repo.js does it. */
function copyByHand(s: Sandbox) {
	s.git("remote", "add", "upstream", `https://github.com/${SOURCE}.git`);
	s.git("remote", "set-url", "--push", "upstream", "no-push");
	s.git(
		"fetch",
		"-q",
		"--no-tags",
		"upstream",
		"+refs/heads/trunk:refs/remotes/upstream/trunk",
	);
	s.git("fetch", "-q", "upstream", "+refs/tags/*:refs/tags/*");
	s.git("checkout", "-q", "--no-track", "-B", "main", "upstream/trunk");
	s.git("push", "-q", "origin", "main", "v1", "v2");
}

/** The set-aside step done by hand: the source repo's own files moved. */
function asideByHand(s: Sandbox) {
	fs.mkdirSync(path.join(s.clone, "docs/source"), { recursive: true });
	fs.renameSync(
		path.join(s.clone, "AGENTS.md"),
		path.join(s.clone, "docs/source/AGENTS.source.md"),
	);
	fs.writeFileSync(
		path.join(s.clone, ".husky/pre-commit.local"),
		SET_ASIDE_HOOK,
	);
	fs.rmSync(path.join(s.clone, ".husky/pre-commit"));
}

type Step = [string, (s: Sandbox, g: Golden) => void];

/** The sandbox's `gh` stub, which a fixture step drives as the script does. */
const ghOf = (s: Sandbox) => s.env.WFC_GH ?? "";

/**
 * A flow's steps as report lines, each with a fixture leaving the world as
 * that step would — half-finished states built directly, never by stopping
 * the script (#720). `copy` is the flow copying SOURCE.
 */
const steps = (copy: boolean): Step[] => [
	[
		"github repo",
		(s) =>
			execFileSync(
				ghOf(s),
				["repo", "create", "lucmoseley/tides", "--private"],
				{ env: s.env, stdio: "ignore" },
			),
	],
	[
		"clone",
		(s) => {
			execFileSync(ghOf(s), ["repo", "clone", "lucmoseley/tides", s.clone], {
				env: s.env,
				stdio: "ignore",
			});
			fs.writeFileSync(
				path.join(s.clone, ".git/new-repo.json"),
				JSON.stringify({ ...SAVED, source: copy ? SOURCE : null }),
			);
		},
	],
	...(copy ? [["source repo", copyByHand] as Step] : []),
	["bashrc", (s) => fs.appendFileSync(s.rc, `\n${TIDES_BLOCK}\n`)],
	...(copy ? [["set aside", asideByHand] as Step] : []),
	[
		"init-adopter",
		(s) =>
			execFileSync(
				process.execPath,
				[
					path.resolve(__dirname, "../../../../scripts/init-adopter.js"),
					"--root",
					s.clone,
					"--founder",
					"Test Founder",
					"--project",
					"tides",
					"--modules",
					copy ? "suites" : "",
					"--marketplace-ref",
					// The sandbox's newest tag, which the script passes too.
					"v1.10.0",
					"--plugin-root",
					pinned(s.home, "v1.10.0"),
					"--no-plugin-install",
				],
				{
					cwd: s.clone,
					env: { ...s.env, CLAUDE_PROJECT_DIR: s.clone },
					stdio: "ignore",
				},
			),
	],
	...(copy
		? [
				[
					"gitignore",
					(s, g) =>
						fs.writeFileSync(path.join(s.clone, ".gitignore"), g.ignore),
				] as Step,
				[
					"source docs",
					(s, g) => {
						fs.writeFileSync(
							path.join(s.clone, "docs/doc-map-classes.json"),
							g.classes,
						);
						fs.writeFileSync(path.join(s.clone, "docs/doc-map.md"), g.docMap);
					},
				] as Step,
			]
		: []),
	[
		"first map",
		(s, g) => {
			const gh = s.readState();
			gh.issues.push(g.issue);
			fs.writeFileSync(
				path.join(s.sb, "github/lucmoseley/tides.json"),
				JSON.stringify(gh),
			);
		},
	],
	[
		"project",
		(s, g) => fs.writeFileSync(path.join(s.clone, "CLAUDE.md"), g.claude),
	],
	[
		"plugin reads",
		(s, g) =>
			fs.writeFileSync(
				path.join(s.clone, ".claude/settings.local.json"),
				g.local.replaceAll("<HOME>", s.home),
			),
	],
	[
		"commit",
		(s) => {
			s.git("add", "-A", "--", ".", ":(exclude).claude/settings.local.json");
			s.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "skeleton");
		},
	],
	[
		"push",
		(s) =>
			s.git(
				"-c",
				"core.hooksPath=/dev/null",
				"push",
				"-q",
				"-u",
				"origin",
				"main",
			),
	],
];
export const STEPS = steps(false);
export const stepIndex = (step: string, copy = false) =>
	steps(copy).findIndex(([n]) => n === step);
export const reported = (copy = false) => [
	...steps(copy).map(([step]) => step),
	...(copy ? ["reconcile"] : []),
];

/**
 * The world as left after `step`, short of the steps needing a clean run's
 * output; `opts` replaces the copy's sandbox.
 */
export function builtThrough(
	step: string,
	copy = false,
	opts: Parameters<typeof sandbox>[0] = { source: SOURCE_IGNORE },
) {
	const s = sandbox(copy ? opts : {});
	for (const [, build] of steps(copy).slice(0, stepIndex(step, copy) + 1))
		build(s, undefined as unknown as Golden);
	return s;
}

/**
 * Every step's world, built once in one sandbox and snapshotted after each
 * step. `at` restores a snapshot to that same path rather than copying it into
 * a new sandbox, since the committed hooks and rules file carry its HOME in
 * blobs no rewrite reaches (#1150). Cases in a file run one at a time, so they
 * can share the path, which afterEach removes between them.
 */
export function worlds(golden: Golden, copy: boolean) {
	const s = sandbox(copy ? { source: SOURCE_IGNORE } : {});
	const snaps = fs.mkdtempSync(path.join(os.tmpdir(), "new-repo-worlds-"));
	const drop = () => fs.rmSync(snaps, { recursive: true, force: true });
	const cp = {
		recursive: true,
		verbatimSymlinks: true,
		preserveTimestamps: true,
	};
	try {
		steps(copy).forEach(([, build], i) => {
			build(s, golden);
			fs.cpSync(s.sb, path.join(snaps, String(i)), cp);
		});
	} catch (e) {
		drop();
		throw e;
	}
	return {
		at(step: string, { hooks = false } = {}) {
			fs.rmSync(s.sb, { recursive: true, force: true });
			fs.cpSync(path.join(snaps, String(stepIndex(step, copy))), s.sb, cp);
			made.push(s.sb);
			setHooks(s.env, hooks);
			return s;
		},
		drop,
	};
}

const readGolden = (s: Sandbox): Golden => ({
	issue: s.readState().issues[0],
	claude: fs.readFileSync(path.join(s.clone, "CLAUDE.md"), "utf8"),
	local: fs
		.readFileSync(path.join(s.clone, ".claude/settings.local.json"), "utf8")
		.replaceAll(s.home, "<HOME>"),
	ignore: fs.existsSync(path.join(s.clone, ".gitignore"))
		? fs.readFileSync(path.join(s.clone, ".gitignore"), "utf8")
		: "",
	classes: fs.readFileSync(
		path.join(s.clone, "docs/doc-map-classes.json"),
		"utf8",
	),
	docMap: fs.readFileSync(path.join(s.clone, "docs/doc-map.md"), "utf8"),
});

/** A `git ls-files -s` line: mode, object, stage, then the path. */
const LS_FILES_LINE = /^(\d{6}) \S+ \d\t(.+)$/;

/**
 * The committed tree with HOME masked, since the hooks and rules file carry
 * the pin's cache path under it (#736); the anchors hash those hooks, so only
 * their keys count.
 */
function readMaskedTree(s: Sandbox) {
	const readBody = (rel: string, mode: string) => {
		const at = path.join(s.clone, rel);
		if (mode === "120000") return fs.readlinkSync(at);
		const text = fs.readFileSync(at, "utf8");
		return rel === ".claude/guard-registry-anchors.json"
			? Object.keys(JSON.parse(text)).join()
			: text;
	};
	const files = s
		.git("ls-files", "-s")
		.split("\n")
		.map((l) => {
			const m = LS_FILES_LINE.exec(l);
			if (!m) throw new Error(`git ls-files -s printed an unparsed line: ${l}`);
			const mode = requiredGroup(m, 1, LS_FILES_LINE);
			const rel = requiredGroup(m, 2, LS_FILES_LINE);
			return `${mode} ${rel}\n${readBody(rel, mode).replaceAll(s.home, "<HOME>")}`;
		});
	return createHash("sha1").update(files.join("\0")).digest("hex");
}

/** Everything a finished run leaves, save the backup's timestamped name. */
export function readEndState(s: Sandbox) {
	const gh = s.readState();
	return {
		private: gh.private,
		labels: [...gh.labels].sort(),
		issues: gh.issues.map((i: { labels: string[] }) => ({
			...i,
			labels: [...i.labels].sort(),
		})),
		bashrc: fs.readFileSync(s.rc, "utf8"),
		tree: readMaskedTree(s),
		commits: s.git("rev-list", "--count", "HEAD"),
		pushed: s.git("rev-parse", "origin/main") === s.git("rev-parse", "HEAD"),
		status: s.git("status", "--porcelain", "--untracked-files=all"),
		// Raw config: `remote -v` resolves the sandbox path HOME's insteadOf maps onto.
		remotes: s.git("config", "--get-regexp", "^remote\\."),
		// Names only: a source repo's shas differ between sandboxes.
		originRefs: s
			.git("ls-remote", "--refs", "origin")
			.split("\n")
			.map((l) => l.split("\t")[1]),
		local: fs
			.readFileSync(path.join(s.clone, ".claude/settings.local.json"), "utf8")
			.replaceAll(s.home, "<HOME>"),
		saved: JSON.parse(
			fs.readFileSync(path.join(s.clone, ".git/new-repo.json"), "utf8"),
		),
	};
}

export function cleanRun(copy: boolean) {
	const s = sandbox(copy ? { source: SOURCE_IGNORE } : {});
	const r = s.run();
	expect(r.status, r.stdout).toBe(0);
	return { golden: readGolden(s), goldenEnd: readEndState(s) };
}

/** Every file under `dir` but `.git`'s, by path, with its text or link target. */
function readFilesUnder(dir: string, rel = ""): Record<string, string> {
	if (!fs.existsSync(dir)) return {};
	const found: Record<string, string> = {};
	for (const e of fs.readdirSync(path.join(dir, rel), {
		withFileTypes: true,
	})) {
		const at = path.join(rel, e.name);
		if (at === ".git") continue;
		if (e.isDirectory()) Object.assign(found, readFilesUnder(dir, at));
		else
			found[at] = e.isSymbolicLink()
				? fs.readlinkSync(path.join(dir, at))
				: fs.readFileSync(path.join(dir, at), "utf8");
	}
	return found;
}

/** What a dry run must leave as it found it. */
export function readWorld(s: Sandbox) {
	const cloned = fs.existsSync(s.clone);
	return {
		github: s.readState(),
		bashrc: fs.readFileSync(s.rc, "utf8"),
		backups: s.readBackups(),
		files: readFilesUnder(s.clone),
		refs: cloned ? s.git("for-each-ref") : null,
		index: cloned ? s.git("ls-files", "-s") : null,
		origin: s.readState()
			? execFileSync("git", ["for-each-ref"], {
					cwd: path.join(s.sb, "github/lucmoseley/tides.git"),
					encoding: "utf8",
				})
			: null,
	};
}

/**
 * Re-runs from the world as left after `step`, asserting each step's report
 * line and a clean run's end state — after a dry run that writes nothing and
 * reports `would` wherever the re-run acts, `skipped` wherever it skips (#733).
 */
export function resumeFinishes(
	s: Sandbox,
	step: string,
	goldenEnd: ReturnType<typeof readEndState>,
	copy: boolean,
) {
	const past = stepIndex(step, copy);
	// Before the clone nothing is saved, so the re-run is the full form.
	const again = (...extra: string[]) =>
		past === 0 ? s.run(...extra) : s.resume(...extra);
	const before = readWorld(s);
	const dry = again("--dry-run");
	expect(dry.status, dry.stdout).toBe(0);
	expect(readWorld(s)).toEqual(before);
	const r = again();
	expect(r.status, r.stdout).toBe(0);
	reported(copy).forEach((name, i) => {
		expect(statusOf(r.stdout, name), name).toBe(
			i <= past && name !== "init-adopter" ? "skipped" : "done",
		);
		expect(statusOf(dry.stdout, name), `${name}, dry`).toBe(
			statusOf(r.stdout, name) === "skipped" ? "skipped" : "would",
		);
	});
	expect(r.stdout).not.toContain("warning:");
	expect(readEndState(s)).toEqual(goldenEnd);
	return { s, r, past };
}

/** What init-adopter appends to every new repo's .gitignore (#737). */
export const IGNORE_BLOCK = withIgnoreBlock("") as string;

/** `git check-ignore`'s verdict on a path under each ignored directory. */
export const readIgnoredScratch = (s: Sandbox) =>
	spawnSync(
		"git",
		["check-ignore", "private/x", ".claude/tmp/x", ".claude/worktrees/x"],
		{
			cwd: s.clone,
			encoding: "utf8",
			env: s.env,
		},
	).stdout;
