// @vitest-environment node
/*
 * new-repo.js, driven from outside end to end, asserting the world it leaves —
 * GitHub-side state, the clone, its files and the report — never a step's
 * internals (#707 Q2: the script carries no test hook).
 *
 * HOME is a temporary folder, so `~/<name>` is a fixture. GitHub is a STATEFUL
 * `gh` stub keeping repos, labels and issues as files: `repo create` makes a
 * bare repo, and HOME's gitconfig rewrites https://github.com/ onto it, so the
 * clone's origin reads as GitHub while every push lands locally. The real
 * init-adopter.js and file-issue.js run against it, the former with
 * --no-plugin-install. No network call (#707 Q1).
 *
 * SPAWNED, NOT RUN IN PROCESS (§X3's timeout shape): a run commits through the
 * new repo's real hook stack, so each carries a 170 s timeout of its own. A
 * case that reaches that commit is skipped without gitleaks, whose secret scan
 * the stack runs. The two --resume groups resume with the hooks off, save the
 * hook-refusal case, and reach a hooked clean run's end state (#1150).
 *
 * The founder runs the script through /new-repo and approves one confirmed
 * run: loosen a case and that run can leave a GitHub repo, clone or
 * `~/.bashrc` block half-made, or a resume that cannot finish it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initPaths } from "../../../../scripts/init-adopter.js";
import {
	HOOKS,
	renderHookShim,
	withIgnoreBlock,
} from "../../../../scripts/lib/adopter-skeleton.js";
import {
	type GhStubServer,
	serveGhStub,
	stubGhScript,
} from "../../../../scripts/lib/gh-stub";
import { installPathFor } from "../../../../scripts/lib/plugin-state.js";

const SCRIPT = path.join(__dirname, "new-repo.js");
const IDEA =
	"A tide-table app for surfers.\n\n## It has a heading\n\nAnd a second paragraph, kept as written.";

/** A block in the shape the founder's `~/.bashrc` carries, unlike what the script writes. */
const buildLiveBlock = (repo: string, p: string) =>
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
const BASHRC = `# ~/.bashrc\nexport EDITOR=vi\n\n${EXISTING_BLOCKS}\n`;

/** What the script writes for tides/td, with the cross-plan wrapper present. */
const TIDES_BLOCK = [
	"# --- tides, one alias per plan ---",
	"alias td1='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude  WFC_CLAUDE_BIN=$HOME/.local/bin/claude-agents-union claude agents)'",
	"alias td2='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude2 WFC_CLAUDE_BIN=$HOME/.local/bin/claude-agents-union claude agents)'",
	"alias td3='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude3 WFC_CLAUDE_BIN=$HOME/.local/bin/claude-agents-union claude agents)'",
	"# --- end tides block ---",
].join("\n");

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

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
		if (!is[3]) print(flag("--jq") === ".id" ? String(1000 + issue.number) : rest(issue));
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
beforeAll(async () => {
	ghServer = await serveGhStub(STUB);
});
afterAll(async () => {
	await ghServer?.close();
});

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
const MAINTENANCE_OFF: Record<string, string> = {
	"maintenance.auto": "false",
	"gc.auto": "0",
};

const HAS_GITLEAKS = (() => {
	try {
		execFileSync(process.env.WFC_GITLEAKS || "gitleaks", ["version"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();

const SOURCE = "octo/surf-lib";
/** The source repo's .gitignore in the clean copy: it hides one of init's files. */
const SOURCE_IGNORE = "node_modules/\nCLAUDE.md\n";
const SOURCE_AGENTS =
	"# surf-lib\n\nOpen a pull request from a feature branch.\n";
/**
 * Annotated, so the core's wiring gate passes it as `.husky/pre-commit.local`,
 * and shebang-less, as husky v9 writes hooks (#1870).
 */
const SOURCE_HOOK =
	"# IMPLICIT: runs surf-lib's own check on every commit\n# JUSTIFIED: fail-safe — a missing library refuses the commit\n# DEFEAT: none\ntest -f lib/tide.js\n";
/** SOURCE_HOOK set aside: given the shell directive shellcheck needs. */
const SET_ASIDE_HOOK = `# shellcheck shell=sh\n${SOURCE_HOOK}`;

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
 * `bashrc` seeds ~/.bashrc, `union` the cross-plan wrapper beside it.
 * `failBashN` puts a `bash` first on PATH whose `-n` refuses any file holding
 * the tides block, as a write that broke the file's syntax would read — on
 * PATH, not through an env var, because the script carries no test hook
 * (#707 Q2). `source` makes the run a copy of a source repo holding that
 * .gitignore, and `sourceFiles` beside its own. `globalIgnore` is HOME's
 * git ignore file, as the founder's hides .claude/settings.local.json.
 * `hooks: false` runs every git call with no hooks.
 */
function sandbox({
	tags = ["v1.9.3", "v1.10.0", "nightly", "v0.99.0"],
	bashrc = BASHRC as string | null,
	union = true,
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
	if (union) {
		fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
		fs.writeFileSync(path.join(home, ".local/bin/claude-agents-union"), "", {
			mode: 0o755,
		});
	}
	const stub = stubGhScript(sb, ghServer.script);
	let searchPath = stub.PATH;
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
const pinned = (home: string, tag: string) =>
	installPathFor(
		path.join(home, ".claude2"),
		"workflow-core",
		"workflow-core",
		tag,
	);

/** The status column of the report line for `step`. */
const statusOf = (stdout: string, step: string) =>
	stdout
		.split("\n")
		.find((l) => l.startsWith(`${step.padEnd(14)} `))
		?.slice(15)
		.split(" — ")[0];

describe("new-repo.js on an empty project", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"takes it from nothing to a pushed, adopted private repo holding one unassigned map, and a second run finds every step done (#2460)",
		() => {
			const s = sandbox();
			const r = s.run();
			expect(r.stderr).toBe("");
			expect(r.status, r.stdout).toBe(0);

			for (const step of [
				"preflight",
				"github repo",
				"clone",
				"bashrc",
				"init-adopter",
				"first map",
				"project",
				"plugin reads",
				"commit",
				"push",
			])
				expect(statusOf(r.stdout, step), step).toBe("done");
			// The newest vX.Y.Z by semver, not by string order.
			expect(r.stdout).toContain("core v1.10.0");
			// init-adopter's probe lines, on a tracker with no issue yet (#734).
			expect(
				r.stdout.slice(
					r.stdout.indexOf("init-adopter   done — pinned to v1.10.0"),
					r.stdout.indexOf("first map "),
				),
			).toContain(
				[
					"  probe    sub-issues, dependencies: not probed — the tracker has no issue yet",
					"  probe    repos/lucmoseley/tides/actions/runs?per_page=1: reachable",
					"  probe    repos/lucmoseley/tides/pulls?per_page=1: reachable",
					"",
				].join("\n"),
			);
			// The gates and rules run the pin, not the core's checkout (#736).
			const pin = pinned(s.home, "v1.10.0");
			expect(
				fs.readFileSync(path.join(s.clone, ".claude/workflow-core.md"), "utf8"),
			).toContain(`node ${pin}/scripts/`);
			// The hooks name no pin at all: each resolves the core at run time (#1839).
			for (const hook of HOOKS)
				expect(
					fs.readFileSync(path.join(s.clone, ".husky", hook), "utf8"),
				).toBe(renderHookShim(hook));

			// Appended after the three existing blocks, which are left as they were.
			expect(fs.readFileSync(s.rc, "utf8")).toBe(`${BASHRC}\n${TIDES_BLOCK}\n`);
			const start = `${BASHRC}\n`.split("\n").length;
			const [backup] = s.readBackups();
			expect(s.readBackups()).toHaveLength(1);
			expect(fs.readFileSync(path.join(s.home, backup), "utf8")).toBe(BASHRC);
			expect(r.stdout).toContain(
				`bashrc         done — ${s.rc} lines ${start}-${start + 4}, backed up to ${path.join(s.home, backup)}\n${TIDES_BLOCK.replace(/^/gm, "  ")}\n`,
			);
			expect(r.stdout).not.toContain("warning:");

			const gh = s.readState();
			expect(gh.private).toBe(true);
			expect(gh.issues).toHaveLength(1);
			const [map] = gh.issues;
			expect(map.number).toBe(1);
			expect(map.title).toBe("tides: a tide-table app");
			expect(map.labels.sort()).toEqual(["takes:wayfinder", "wayfinder:map"]);
			expect(map.assignees).toEqual([]);
			expect(map.body).toMatch(
				/## Destination\n\nNot named yet — the first session grills it\n/,
			);
			expect(map.body).toContain(IDEA);
			expect(map.body).toContain(
				"/wayfinder Chart the map on #1. It holds my idea and no destination yet: fill that issue as the map rather than creating a new one.",
			);
			expect(map.body).not.toContain("commands.test");
			expect(map.body).toMatch(/^Standalone: /m);

			// The report ends on the new-tab line for this plan and the prompt.
			const tail = r.stdout.trimEnd().split("\n").slice(-4);
			expect(tail[0]).toBe("Open a new terminal tab and run: td2");
			// Not a workflow-core checkout, so no self-plugin setup (#2440).
			expect(r.stdout).not.toContain("Once per machine");
			expect(tail[3]).toBe(
				"/wayfinder Chart the map on #1. It holds my idea and no destination yet: fill that issue as the map rather than creating a new one.",
			);

			expect(s.git("config", "--get", "remote.origin.url")).toBe(
				"https://github.com/lucmoseley/tides.git",
			);
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
			// Whole-tree, so a path init writes outside the skeleton pathspec shows here.
			expect(s.git("status", "--porcelain", "--untracked-files=all")).toBe(
				"?? .claude/settings.local.json",
			);
			expect(readIgnoredScratch(s)).toBe(
				"private/x\n.claude/tmp/x\n.claude/worktrees/x\n",
			);
			expect(s.git("show", "HEAD:.gitignore")).toBe(IGNORE_BLOCK.trimEnd());

			const config = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, ".claude/workflow-core.json"),
					"utf8",
				),
			);
			expect(config.modules ?? []).toEqual([]);
			expect(config.commands ?? {}).toEqual({});
			const claude = fs.readFileSync(path.join(s.clone, "CLAUDE.md"), "utf8");
			expect(claude).toContain(
				"tides — A tide-table app for surfers, for the founder's own surf trips. Founder: Test Founder.",
			);
			expect(claude).toContain(
				"State: pre-launch — the way is being charted on #1 (tides: a tide-table app).",
			);

			// The Read rules are this machine's: written, never committed.
			const local = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, ".claude/settings.local.json"),
					"utf8",
				),
			);
			expect(local.permissions.allow).toEqual(
				[".claude", ".claude2", ".claude3"].map(
					(d) => `Read(/${s.home}/${d}/plugins/cache/**)`,
				),
			);
			expect(s.git("ls-files", ".claude/settings.local.json")).toBe("");
			const saved = JSON.parse(
				fs.readFileSync(path.join(s.clone, ".git/new-repo.json"), "utf8"),
			);
			expect(saved.repo).toBe("lucmoseley/tides");
			expect(saved.idea).toBe(IDEA);
			expect(s.git("ls-files", ".git")).toBe("");

			for (const again of [s.run(), s.resume()]) {
				expect(again.status, again.stdout).toBe(0);
				for (const step of [
					"github repo",
					"clone",
					"bashrc",
					"first map",
					"project",
					"plugin reads",
					"commit",
					"push",
				])
					expect(statusOf(again.stdout, step), step).toBe("skipped");
			}
			expect(s.readState().issues).toHaveLength(1);
			expect(fs.readFileSync(s.rc, "utf8")).toBe(`${BASHRC}\n${TIDES_BLOCK}\n`);
			expect(s.readBackups()).toHaveLength(1);
		},
		340_000,
	);

	it.skipIf(!HAS_GITLEAKS)(
		"commits the skeleton where a global gitignore hides .claude/settings.local.json, which stopped the #725 live trial",
		() => {
			const s = sandbox({ globalIgnore: "**/.claude/settings.local.json\n" });
			const r = s.run();
			expect(r.status, r.stdout + r.stderr).toBe(0);
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(s.git("ls-files", ".claude/settings.local.json")).toBe("");
			expect(s.git("status", "--porcelain", "--untracked-files=all")).toBe("");
		},
		340_000,
	);

	it("--dry-run runs every preflight check, prints each planned step, and writes nothing", () => {
		const s = sandbox({ union: false });
		const r = s.run("--dry-run");
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(statusOf(r.stdout, "preflight")).toBe("done");
		for (const step of [
			"github repo",
			"clone",
			"bashrc",
			"init-adopter",
			"first map",
			"project",
			"plugin reads",
			"commit",
			"push",
		])
			expect(statusOf(r.stdout, step), step).toBe("would");
		expect(r.stdout).toContain(
			`--marketplace-ref v1.10.0 --plugin-root ${pinned(s.home, "v1.10.0")}`,
		);
		expect(r.stdout).toMatch(/^modules {8}none$/m);
		expect(r.stdout).toContain(
			[
				"  # --- tides, one alias per plan ---",
				"  alias td1='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude claude agents)'",
				"  alias td2='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude2 claude agents)'",
				"  alias td3='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude3 claude agents)'",
				"  # --- end tides block ---",
				"  warning: ~/.local/bin/claude-agents-union is absent, so the block leaves out WFC_CLAUDE_BIN",
			].join("\n"),
		);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(BASHRC);
		expect(s.readBackups()).toEqual([]);
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(s.clone)).toBe(false);
		expect(fs.readdirSync(path.join(s.sb, "github"))).toEqual([]);
		expect(
			s
				.readCalls()
				.map((c) => c.slice(0, 2).join(" "))
				.sort(),
		).toEqual([
			"api repos/lucmoseley/workflow-core/tags",
			"auth status",
			"repo view",
		]);
	});
});

/**
 * What git resolves for the settings `setHooks` must leave intact or toggle,
 * run with `env`; "" is unset. The sandbox's ~/.gitconfig goes unread, so
 * only the env's pairs answer.
 */
const gitConfig = (env: NodeJS.ProcessEnv) =>
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

describe("new-repo.js test sandbox", () => {
	it("keeps the suite's maintenance switch-off with the hooks off and on (#1655)", () => {
		expect(gitConfig(sandbox({ hooks: false }).env)).toEqual({
			...MAINTENANCE_OFF,
			"core.hooksPath": "/dev/null",
		});
		expect(gitConfig(sandbox({ hooks: true }).env)).toEqual({
			...MAINTENANCE_OFF,
			"core.hooksPath": "",
		});
	});

	it("keeps maintenance switched off on the receiving side of a local push (#1655)", () => {
		const s = sandbox({ hooks: false });
		const bare = path.join(s.sb, "github/probe.git");
		const git = (cwd: string, ...a: string[]) =>
			execFileSync("git", a, { cwd, encoding: "utf8", env: s.env });
		git(s.sb, "init", "-q", "--bare", bare);
		// The bare repo's own hook runs, the env's hooksPath being stripped too.
		fs.writeFileSync(
			path.join(bare, "hooks/pre-receive"),
			`#!/bin/sh\nfor k in ${Object.keys(MAINTENANCE_OFF).join(" ")}; do echo "$k=$(git config --get $k)" >&2; done\nexit 1\n`,
			{ mode: 0o755 },
		);
		const work = path.join(s.sb, "probe");
		git(s.sb, "init", "-q", work);
		git(work, "commit", "-q", "--allow-empty", "-m", "probe");
		const r = spawnSync("git", ["push", bare, "main"], {
			cwd: work,
			encoding: "utf8",
			env: s.env,
		});
		for (const [k, v] of Object.entries(MAINTENANCE_OFF))
			expect(r.stderr).toMatch(new RegExp(`^remote: ${k}=${v} *$`, "m"));
	});
});

describe("new-repo.js preflight: a run that will fail creates nothing", () => {
	it("refuses, exit 2, where the core has no release tag, offering a release cut as the manual step, and never falls back to a directory", () => {
		const s = sandbox({ tags: ["nightly", "v2"] });
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toMatch(
			/^preflight {6}STOPPED — lucmoseley\/workflow-core has no vX\.Y\.Z release tag/m,
		);
		expect(r.stdout).toContain(
			"Manual step: cut a workflow-core release first",
		);
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(s.clone)).toBe(false);
	});

	it("refuses, exit 2, a name that belongs to a repo this script did not make", () => {
		const s = sandbox();
		fs.mkdirSync(path.join(s.sb, "github/lucmoseley"), { recursive: true });
		const bare = path.join(s.sb, "github/lucmoseley/tides.git");
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
		const seed = path.join(s.sb, "seed");
		execFileSync("git", ["init", "-q", "-b", "main", seed]);
		execFileSync("git", [
			"-C",
			seed,
			"-c",
			"user.name=x",
			"-c",
			"user.email=x@x",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"theirs",
		]);
		execFileSync("git", ["-C", seed, "push", "-q", bare, "main"]);
		fs.writeFileSync(
			path.join(s.sb, "github/lucmoseley/tides.json"),
			JSON.stringify({ private: true, labels: [], issues: [] }),
		);
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toContain(
			"Manual step: that name belongs to a repo this script did not make — pick another name or delete it on GitHub yourself\nThen start again: /new-repo",
		);
		expect(fs.existsSync(s.clone)).toBe(false);
		expect(
			s.readCalls().some((c) => c[0] === "repo" && c[1] === "create"),
		).toBe(false);
	});

	it("refuses, exit 2, where ~/<name> is taken by something that is not its clone", () => {
		const s = sandbox();
		fs.mkdirSync(s.clone);
		fs.writeFileSync(path.join(s.clone, "notes.txt"), "mine\n");
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toMatch(
			/STOPPED — ~\/tides exists and is not this script's clone/,
		);
		expect(r.stdout).toContain(
			"Manual step: move ~/tides aside, or pick another name",
		);
		expect(s.readState()).toBeNull();
		expect(fs.readFileSync(path.join(s.clone, "notes.txt"), "utf8")).toBe(
			"mine\n",
		);
	});

	it("refuses, exit 2, with gh logged out, before reading anything else, naming gh auth login as the way out", () => {
		const s = sandbox();
		fs.writeFileSync(path.join(s.sb, "fail/auth"), "");
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toContain(
			"Manual step: log gh in: run `gh auth login` in a terminal",
		);
		expect(s.readCalls()).toEqual([["auth", "status"]]);
	});
});

describe("new-repo.js after a part-way stop", () => {
	it("refuses, exit 2, where ~/<name> is its clone but the GitHub repo is gone", () => {
		const s = sandbox();
		fs.mkdirSync(path.join(s.clone, ".git"), { recursive: true });
		fs.writeFileSync(
			path.join(s.clone, ".git/new-repo.json"),
			JSON.stringify({ repo: "lucmoseley/tides" }),
		);
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toMatch(
			/^preflight {6}STOPPED — ~\/tides holds this script's clone, but lucmoseley\/tides is gone from GitHub$/m,
		);
		expect(r.stdout).toContain(
			"Manual step: delete ~/tides too and start fresh\nThen start again: /new-repo",
		);
		expect(r.stdout).not.toContain("--resume");
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(path.join(s.clone, ".git/new-repo.json"))).toBe(true);
	});

	it.skipIf(!HAS_GITLEAKS)(
		"stops at exit 1 when an issue create lands but reports failure, and --resume keeps the lowest map, closing every duplicate",
		() => {
			const s = sandbox();
			fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
			const r = s.run();
			expect(r.status, r.stdout).toBe(1);
			expect(statusOf(r.stdout, "first map")).toBe("STOPPED");
			expect(r.stdout).toContain(
				"Re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			expect(r.stdout).not.toContain("Manual step:");
			expect(s.readState().issues).toHaveLength(1);

			/* Two more failed runs each filed a map before this one. */
			fs.rmSync(path.join(s.sb, "fail/issue-create"));
			const gh = s.readState();
			gh.issues.push(
				{ ...gh.issues[0], number: 2 },
				{ ...gh.issues[0], number: 3 },
			);
			fs.writeFileSync(
				path.join(s.sb, "github/lucmoseley/tides.json"),
				JSON.stringify(gh),
			);

			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			expect(again.stdout).toMatch(/^first map {6}repaired — #1$/m);
			const [kept, ...dups] = s.readState().issues;
			expect(kept.state).toBe("OPEN");
			expect(kept.body).toContain("/wayfinder Chart the map on #1.");
			for (const dup of dups) {
				expect(dup.state).toBe("CLOSED");
				expect(dup.comments).toEqual([
					"duplicate of #1, filed by a failed new-repo run",
				]);
			}
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
		},
		340_000,
	);
});

/** What a run saves for tides/td once its clone exists. */
const SAVED = {
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

type Sandbox = ReturnType<typeof sandbox>;

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

/**
 * A flow's steps as report lines, each with a fixture leaving the world as
 * that step would — half-finished states built directly, never by stopping
 * the script (#720). `copy` is the flow copying SOURCE.
 */
const steps = (copy: boolean): Step[] => [
	[
		"github repo",
		(s) =>
			execFileSync("gh", ["repo", "create", "lucmoseley/tides", "--private"], {
				env: s.env,
				stdio: "ignore",
			}),
	],
	[
		"clone",
		(s) => {
			execFileSync("gh", ["repo", "clone", "lucmoseley/tides", s.clone], {
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
const STEPS = steps(false);
const stepIndex = (step: string, copy = false) =>
	steps(copy).findIndex(([n]) => n === step);
const reported = (copy = false) => [
	...steps(copy).map(([step]) => step),
	...(copy ? ["reconcile"] : []),
];

/**
 * The world as left after `step`, short of the steps needing a clean run's
 * output; `opts` replaces the copy's sandbox.
 */
function builtThrough(
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
function worlds(golden: Golden, copy: boolean) {
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
			const [meta, rel] = l.split("\t");
			const mode = meta.split(" ")[0];
			return `${mode} ${rel}\n${readBody(rel, mode).replaceAll(s.home, "<HOME>")}`;
		});
	return createHash("sha1").update(files.join("\0")).digest("hex");
}

/** Everything a finished run leaves, save the backup's timestamped name. */
function readEndState(s: Sandbox) {
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

function cleanRun(copy: boolean) {
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
function readWorld(s: Sandbox) {
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
function resumeFinishes(
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

describe("new-repo.js checks its arguments against the saved ones", () => {
	it("refuses, exit 2, an argument differing from the saved one, naming each difference, and acts on nothing", () => {
		const s = builtThrough("clone");
		const before = s.readCalls().length;
		fs.writeFileSync(path.join(s.inputs, "title"), "tides: something else\n");
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`preflight      STOPPED — the arguments differ from those ~/tides/.git/new-repo.json saved: --title-file gives "tides: something else" where "tides: a tide-table app" was saved\n`,
		);
		expect(r.stdout).toContain(
			"Manual step: drop the differing arguments — `--resume tides` alone reuses every saved one\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
		);

		fs.writeFileSync(path.join(s.inputs, "other-idea"), "Something else.\n");
		const beside = s.resume(
			"--prefix",
			"tx",
			"--idea-file",
			path.join(s.inputs, "other-idea"),
		);
		expect(beside.status, beside.stdout).toBe(2);
		expect(beside.stdout).toContain(
			`saved: --prefix gives "tx" where "td" was saved; --idea-file's text differs from the saved idea\n`,
		);
		expect(s.readCalls()).toHaveLength(before);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(BASHRC);

		const same = s.resume("--prefix", "td", "--dry-run");
		expect(same.status, same.stdout).toBe(0);
	});

	it("refuses, exit 2, --resume into a clone renamed by hand, whose saved name is another", () => {
		const s = builtThrough("clone");
		fs.writeFileSync(
			path.join(s.clone, ".git/new-repo.json"),
			JSON.stringify({ ...SAVED, name: "tides-old" }),
		);
		const r = s.resume("--dry-run");
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`saved: --resume gives "tides" where "tides-old" was saved\n`,
		);
	});

	it("refuses, exit 2, --resume where the run never reached its clone, and sends the founder back to /new-repo", () => {
		const s = sandbox();
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"preflight      STOPPED — there is nothing to resume: ~/tides/.git/new-repo.json is missing or incomplete\n",
		);
		expect(r.stdout).toContain(
			"Manual step: a run that stopped before its clone existed saved nothing — start it again with every argument\nThen start again: /new-repo\n",
		);
		expect(s.readCalls()).toEqual([]);
	});
});

describe.skipIf(!HAS_GITLEAKS)(
	"new-repo.js --resume after a part-way stop",
	() => {
		let goldenEnd: ReturnType<typeof readEndState>;
		let world: ReturnType<typeof worlds>;
		beforeAll(() => {
			const clean = cleanRun(false);
			goldenEnd = clean.goldenEnd;
			world = worlds(clean.golden, false);
		}, 340_000);
		afterAll(() => world?.drop());

		it("keeps the suite's maintenance switch-off as a world's hooks go off and back on (#1655)", () => {
			const s = world.at("clone");
			expect(gitConfig(s.env)).toEqual({
				...MAINTENANCE_OFF,
				"core.hooksPath": "/dev/null",
			});
			world.at("clone", { hooks: true });
			expect(gitConfig(s.env)).toEqual({
				...MAINTENANCE_OFF,
				"core.hooksPath": "",
			});
		});

		it("leaves the same end state from a clean run with the hooks off as with them on, as every case below relies on", () => {
			const s = sandbox({ hooks: false });
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			expect(readEndState(s)).toEqual(goldenEnd);
		}, 170_000);

		it.each(STEPS.map(([step]) => step))(
			"finishes from the world as left after %s, reaching a clean run's end state, as its dry run foretold",
			(step) => {
				const { s, r, past } = resumeFinishes(
					world.at(step),
					step,
					goldenEnd,
					false,
				);
				expect(r.stdout).toContain("Open a new terminal tab and run: td2\n");
				expect(s.readBackups()).toHaveLength(
					past >= stepIndex("bashrc") ? 0 : 1,
				);
			},
			170_000,
		);

		it("stops, exit 2, on a hook refusing the skeleton commit, printing its output word for word, and --resume finishes once it is fixed", () => {
			const s = world.at("plugin reads", { hooks: true });
			/* A copied repo's own gate (#694 item 6), which the core's wiring
			 * gate refuses until its header says what it does. */
			const gate = path.join(s.clone, ".husky/pre-commit.local");
			fs.writeFileSync(gate, ":\n");
			const r = s.resume();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toMatch(
				/^commit {9}STOPPED — a hook refused the skeleton commit$/m,
			);
			expect(r.stdout).toContain(
				"UNANNOTATED  .husky/pre-commit.local:1\n  wiring:  wired at git\n",
			);
			expect(r.stdout).toContain("FAIL: 1 fault(s) this commit adds\n");
			expect(r.stdout).toContain(
				"Manual step: open a new tab, run `td1`, fix it in that session, then re-run from workflow-core: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			expect(() => s.git("rev-parse", "--verify", "-q", "HEAD")).toThrow();

			fs.writeFileSync(
				gate,
				"# shellcheck shell=sh\n# IMPLICIT: runs tides's own checks on every commit\n# JUSTIFIED: fail-safe — the source repo's checks keep running\n# DEFEAT: none\n:\n",
			);
			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			expect(statusOf(again.stdout, "commit")).toBe("done");
			expect(statusOf(again.stdout, "push")).toBe("done");
			expect(s.git("ls-files", ".husky/pre-commit.local")).toBe(
				".husky/pre-commit.local",
			);
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
		}, 340_000);

		it("foretells a commit and a push where the core has changed init's output since the skeleton commit, as the resume then makes them (#762)", () => {
			const s = world.at("push");
			/* A skeleton an older core rendered: init rewrites this core-owned
			 * file on every run, from this checkout. */
			const rules = path.join(s.clone, ".claude/workflow-core.md");
			fs.appendFileSync(rules, "\nA line an older core rendered.\n");
			s.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", "older");
			s.git("-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "main");
			const before = readWorld(s);
			const dry = s.resume("--dry-run");
			expect(dry.status, dry.stdout).toBe(0);
			expect(readWorld(s)).toEqual(before);
			expect(fs.readdirSync(path.join(s.sb, "tmp"))).toEqual([]);
			expect(statusOf(dry.stdout, "commit")).toBe("would");
			expect(statusOf(dry.stdout, "push")).toBe("would");
			const r = s.resume();
			expect(r.status, r.stdout).toBe(0);
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(statusOf(r.stdout, "push")).toBe("done");
			expect(fs.readFileSync(rules, "utf8")).not.toContain("an older core");
		}, 340_000);

		it("finishes from the #725 trial's index: every skeleton path intent-added but the settings file a global gitignore hides", () => {
			const s = world.at("plugin reads");
			fs.mkdirSync(path.join(s.home, ".config/git"), { recursive: true });
			fs.writeFileSync(
				path.join(s.home, ".config/git/ignore"),
				"**/.claude/settings.local.json\n",
			);
			s.git(
				"add",
				"-N",
				"--",
				"CLAUDE.md",
				"AGENTS.md",
				".claude",
				"docs",
				".husky",
			);
			const r = s.resume();
			expect(r.status, r.stdout).toBe(0);
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(s.git("ls-files", ".claude/settings.local.json")).toBe("");
			expect(s.git("status", "--porcelain", "--untracked-files=all")).toBe("");
		}, 340_000);

		it("stops, exit 2, where git add refuses the skeleton paths, printing git's message and the manual step", () => {
			const s = world.at("plugin reads");
			const lock = path.join(s.clone, ".git/index.lock");
			fs.writeFileSync(lock, "");
			const r = s.resume();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toMatch(
				/^commit {9}STOPPED — git add refused the skeleton paths$/m,
			);
			expect(r.stdout).toContain("index.lock");
			expect(r.stdout).toContain(
				"Manual step: open a new tab, run `td1`, fix it in that session, then re-run from workflow-core: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			fs.rmSync(lock);
			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			expect(statusOf(again.stdout, "commit")).toBe("done");
		}, 340_000);

		it("stops, exit 2, on a rejected push, naming the manual step and the --resume command", () => {
			const s = world.at("commit");
			fs.writeFileSync(
				path.join(s.sb, "github/lucmoseley/tides.git/hooks/pre-receive"),
				'#!/bin/sh\necho "tides server: main is closed to pushes" >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			const r = s.resume();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toMatch(/^push {11}STOPPED — the push was rejected$/m);
			expect(r.stdout).toContain("tides server: main is closed to pushes");
			expect(r.stdout).toContain(
				"Manual step: read the rejection above and settle it in ~/tides\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			expect(() =>
				s.git("rev-parse", "--verify", "-q", "origin/main"),
			).toThrow();
		}, 170_000);
	},
);

describe("new-repo.js and the ~/.bashrc launch block", () => {
	it.each([
		["an alias", `${BASHRC}alias td2='ls'\n`, "td2 is taken (alias)"],
		["a function", `${BASHRC}td3() { :; }\n`, "td3 is taken (function)"],
		[
			"a file on PATH",
			`${BASHRC}export PATH="$HOME/bin:$PATH"\n`,
			"td1 is taken (file)",
		],
	])(
		"refuses, exit 2, a prefix whose alias would shadow %s, and creates nothing",
		(_, bashrc, clash) => {
			const s = sandbox({ bashrc });
			fs.mkdirSync(path.join(s.home, "bin"));
			fs.writeFileSync(path.join(s.home, "bin/td1"), "#!/bin/sh\n", {
				mode: 0o755,
			});
			const r = s.run();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toContain(
				`preflight      STOPPED — the prefix "td" clashes: ${clash}`,
			);
			expect(r.stdout).toContain("Manual step: pick another prefix");
			expect(s.readState()).toBeNull();
			expect(fs.existsSync(s.clone)).toBe(false);
			expect(fs.readFileSync(s.rc, "utf8")).toBe(bashrc);
			expect(s.readBackups()).toEqual([]);
		},
	);

	it("checks the numbered aliases only, never the bare prefix", () => {
		const s = sandbox({ bashrc: `${BASHRC}alias td='ls'\n` });
		const r = s.run("--dry-run");
		expect(r.status, r.stdout).toBe(0);
		expect(statusOf(r.stdout, "bashrc")).toBe("would");
	});

	it("refuses, exit 2, where ~/.bashrc already fails bash -n, and creates nothing", () => {
		const s = sandbox({ bashrc: `${BASHRC}if true; then\n` });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`preflight      STOPPED — ${s.rc} fails \`bash -n\``,
		);
		expect(r.stdout).toContain(
			`Manual step: fix ${s.rc} until \`bash -n ~/.bashrc\` passes`,
		);
		expect(s.readState()).toBeNull();
		expect(s.readBackups()).toEqual([]);
	});

	it("refuses, exit 2, a block whose opening marker is never closed, naming the file and line and offering the end marker as the way out", () => {
		const bashrc = `${BASHRC}# --- tides, one alias per plan ---\nalias td1='ls'\n`;
		const s = sandbox({ bashrc });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`STOPPED — ${s.rc} opens the tides block at line ${BASHRC.split("\n").length} and never closes it`,
		);
		expect(r.stdout).toContain(
			"Manual step: add `# --- end tides block ---` below that block's last alias, or delete its opening line",
		);
		expect(s.readState()).toBeNull();
	});

	it("backs ~/.bashrc up before writing, and restores it and stops, exit 2, when bash -n fails after, quoting the complaint of bash -n and naming the backup", () => {
		const s = sandbox({ failBashN: true });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(statusOf(r.stdout, "bashrc")).toBe("STOPPED");
		expect(r.stdout).toContain("syntax error near unexpected token");
		const [backup] = s.readBackups();
		expect(s.readBackups()).toHaveLength(1);
		expect(r.stdout).toContain(`is restored from ${path.join(s.home, backup)}`);
		expect(r.stdout).toContain(
			`Manual step: read \`bash -n\`'s complaint above and settle ${s.rc} by hand`,
		);
		expect(fs.readFileSync(path.join(s.home, backup), "utf8")).toBe(BASHRC);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(BASHRC);
		// Stopped before init: the clone holds no skeleton.
		expect(fs.existsSync(path.join(s.clone, "CLAUDE.md"))).toBe(false);
	});

	it("leaves a block already present untouched, warning where it differs with the block it would write, and never checks its own aliases as clashes", () => {
		const old = buildLiveBlock("tides", "td");
		const bashrc = `${BASHRC}\n${old}\n`;
		const s = sandbox({ bashrc });
		// Stop the run once the step is past, at the map, short of the commit.
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.run();
		expect(r.status, r.stdout).toBe(1);
		const start = `${BASHRC}\n`.split("\n").length;
		expect(r.stdout).toContain(
			`bashrc         skipped — kept as found — ${s.rc} lines ${start}-${start + 5}\n${old.replace(/^/gm, "  ")}\n  warning: the tides block in ${s.rc} differs from what this run would write, and is kept. This run would write:\n${TIDES_BLOCK.replace(/^/gm, "  ")}\n`,
		);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(bashrc);
		expect(s.readBackups()).toEqual([]);
	}, 170_000);

	it("reads a block differing only by trailing whitespace as already written", () => {
		const s = sandbox({
			bashrc: `${BASHRC}\n${TIDES_BLOCK.replace(/\n/g, "  \n")}\n`,
		});
		const r = s.run("--dry-run");
		expect(r.status, r.stdout).toBe(0);
		expect(r.stdout).toMatch(/^bashrc {9}skipped — already done — /m);
		expect(r.stdout).not.toContain("warning:");
	});

	it.skipIf(!HAS_GITLEAKS)(
		"never names a launch alias that a block kept as found does not define",
		() => {
			const old = [
				"# --- tides, one alias per plan ---",
				"alias td1='(cd ~/tides && claude agents)'",
				"# --- end tides block ---",
			].join("\n");
			const s = sandbox({ bashrc: `${BASHRC}\n${old}\n` });
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			expect(r.stdout).toContain(
				"Open a new terminal tab and start a session in ~/tides: the kept ~/.bashrc block defines no td2",
			);
			expect(r.stdout).not.toContain("and run: td2");
		},
		170_000,
	);
});

/** Scratch clones of the source repo left in TMPDIR, where the hook stack keeps files of its own. */
const readScratchLeft = (s: Sandbox) =>
	fs
		.readdirSync(path.join(s.sb, "tmp"))
		.filter((f) => f.startsWith("new-repo-source-"));

/** What init-adopter appends to every new repo's .gitignore (#737). */
const IGNORE_BLOCK = withIgnoreBlock("") as string;

/** `git check-ignore`'s verdict on a path under each ignored directory. */
const readIgnoredScratch = (s: Sandbox) =>
	spawnSync(
		"git",
		["check-ignore", "private/x", ".claude/tmp/x", ".claude/worktrees/x"],
		{
			cwd: s.clone,
			encoding: "utf8",
			env: s.env,
		},
	).stdout;

const KEEP_BLOCK =
	"# --- workflow-core: keep the core's files trackable (new-repo.js) ---\n!/CLAUDE.md\n# --- end workflow-core block ---\n";

describe("new-repo.js copying a source repo", () => {
	it("--dry-run names the source repo's licence and workflows, suites with the test command, and the negations, and writes nothing", () => {
		const s = sandbox({ source: SOURCE_IGNORE });
		const r = s.run("--dry-run");
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(r.stdout).toContain(
			"source repo    would — push octo/surf-lib's trunk to lucmoseley/tides as main, with its tags; upstream fetch-only\n  licence: MIT License\n  workflows: .github/workflows/ci.yml — GitHub Actions runs them in lucmoseley/tides on their own triggers\n",
		);
		expect(r.stdout).toContain("--modules suites ");
		expect(r.stdout).toContain(
			"modules        suites\n  commands: test: npm run test (package.json)\n",
		);
		expect(r.stdout).toContain(
			"set aside      would — move AGENTS.md to docs/source/AGENTS.source.md, move .husky/pre-commit to .husky/pre-commit.local\n",
		);
		expect(r.stdout).toContain(
			"gitignore      would — append negations to .gitignore for CLAUDE.md\n",
		);
		expect(r.stdout).toContain(
			'source docs    would — register the source repo\'s docs in docs/doc-map.md §A under "Source repo docs (octo/surf-lib)", class source-of-truth\n',
		);
		expect(r.stdout).toContain(
			`reconcile      would — "Reconcile octo/surf-lib's agent instructions with the core's" under the first map, labelled wayfinder:grilling + takes:wayfinder, unassigned\n`,
		);
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(s.clone)).toBe(false);
		expect(readScratchLeft(s)).toEqual([]);
		expect(
			s
				.readCalls()
				.some((c) => c.join(" ").startsWith(`repo clone ${SOURCE} `)),
		).toBe(true);
	});

	it("refuses, exit 2, a source repo whose .gitignore hides a parent directory of init's files, naming its line, and creates nothing", () => {
		const s = sandbox({ source: "node_modules/\n.claude/\n" });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toMatch(
			/^preflight {6}STOPPED — the source repo's \.gitignore:2 \("\.claude\/"\) hides \.claude\/workflow-core\.json, .*, and no negation can undo it$/m,
		);
		expect(r.stdout).toContain(
			"Manual step: pick another source repo: the core's files cannot be kept trackable past that line\nThen start again: /new-repo\n",
		);
		expect(s.readState()).toBeNull();
		expect(readScratchLeft(s)).toEqual([]);
	});

	it("refuses, exit 2, a source repo with a hook the core's would overwrite, other than pre-commit, and creates nothing", () => {
		const s = sandbox({
			source: SOURCE_IGNORE,
			sourceFiles: { ".husky/pre-push": "npm test\n" },
		});
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"preflight      STOPPED — the source repo has .husky/pre-push, which the core's hook of the same name would overwrite\n\nManual step: pick another source repo: only a source pre-commit can be kept, as .husky/pre-commit.local\nThen start again: /new-repo\n",
		);
		expect(s.readState()).toBeNull();
		expect(readScratchLeft(s)).toEqual([]);
	});

	it("refuses, exit 2, a source repo gh cannot reach, naming it and how to start again, and records no state", () => {
		const s = sandbox();
		const r = s.run("--source", "octo/nowhere");
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"STOPPED — the source repo octo/nowhere is not reachable\n\nManual step: check its owner/name, and that gh's account can read it\nThen start again: /new-repo\n",
		);
		expect(s.readState()).toBeNull();
	});

	it("gives the same git check-ignore verdict on init's paths before init writes them as after, and init writes no path outside that list", () => {
		const s = sandbox();
		const repo = path.join(s.sb, "verdict");
		execFileSync("git", ["init", "-q", "-b", "main", repo], { env: s.env });
		fs.writeFileSync(
			path.join(repo, ".gitignore"),
			".husky/\ndocs/*.json\n/AGENTS.md\n*.md\n!README.md\n.claude/*.json\n!/.claude/settings.json\n",
		);
		const paths: string[] = initPaths(["roadmap"]);
		const readIgnoreVerdict = () =>
			spawnSync("git", ["check-ignore", "-v", "-n", "--stdin"], {
				cwd: repo,
				input: `${paths.join("\n")}\n`,
				encoding: "utf8",
				env: s.env,
			}).stdout;
		const before = readIgnoreVerdict();
		expect(before).toMatch(/\.husky\/\t\.husky\/pre-commit$/m);
		expect(before).toMatch(
			/:!\/\.claude\/settings\.json\t\.claude\/settings\.json$/m,
		);
		expect(before).toMatch(/^::\tscripts\/browse\.py$/m);
		const init = spawnSync(
			process.execPath,
			[
				path.resolve(__dirname, "../../../../scripts/init-adopter.js"),
				"--root",
				repo,
				"--founder",
				"Test Founder",
				"--modules",
				"roadmap",
				"--no-tracker",
				"--no-plugin-install",
			],
			{
				cwd: repo,
				encoding: "utf8",
				env: { ...s.env, CLAUDE_PROJECT_DIR: repo },
			},
		);
		expect(init.status, init.stdout + init.stderr).toBe(0);
		expect(readIgnoreVerdict()).toBe(before);
		const written = execFileSync(
			"git",
			["ls-files", "--others", "--exclude-standard", "--ignored", "-o"],
			{ cwd: repo, encoding: "utf8", env: s.env },
		);
		const untracked = execFileSync("git", ["ls-files", "--others"], {
			cwd: repo,
			encoding: "utf8",
			env: s.env,
		});
		const all = [...new Set(`${written}${untracked}`.split("\n"))].filter(
			Boolean,
		);
		expect(all.filter((f) => !paths.includes(f))).toEqual([]);
	}, 60_000);

	it.skipIf(!HAS_GITLEAKS)(
		"mirrors the default branch as main with its tags, keeps the source as a fetch-only upstream, keeps init's files trackable, starts with suites, and a second run finds every step done",
		() => {
			const s = sandbox({ source: SOURCE_IGNORE });
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			for (const step of reported(true))
				expect(statusOf(r.stdout, step), step).toBe("done");
			expect(r.stdout).toContain(
				"source repo    done — octo/surf-lib's trunk pushed as main, 2 tags pushed, upstream fetch-only\n  licence: MIT License\n  workflows: .github/workflows/ci.yml",
			);
			expect(r.stdout).toContain(
				"gitignore      done — negations appended to .gitignore for CLAUDE.md\n",
			);
			expect(r.stdout).toContain(
				"set aside      done — AGENTS.md → docs/source/AGENTS.source.md, .husky/pre-commit → .husky/pre-commit.local, # shellcheck shell=sh added to .husky/pre-commit.local\n",
			);
			expect(r.stdout).toContain(
				'source docs    done — 2 registered in docs/doc-map.md §A under "Source repo docs (octo/surf-lib)"\n',
			);
			expect(r.stdout).toContain("reconcile      done — #2 under #1\n");
			expect(r.stdout).toMatch(/^init-adopter {3}done — .*, modules suites$/m);

			// The default branch and tags only: never the stale branch, never a fork.
			expect(readEndState(s).originRefs).toEqual([
				"refs/heads/main",
				"refs/tags/v1",
				"refs/tags/v2",
			]);
			expect(s.readCalls().some((c) => c.includes("fork"))).toBe(false);
			expect(s.git("rev-list", "--count", "HEAD")).toBe("3");
			expect(s.git("show", "HEAD:lib/tide.js")).toBe(
				"module.exports = () => 2;",
			);
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
			expect(s.git("config", "--get", "remote.upstream.url")).toBe(
				`https://github.com/${SOURCE}.git`,
			);
			expect(s.git("config", "--get", "remote.upstream.pushurl")).toBe(
				"no-push",
			);

			expect(fs.readFileSync(path.join(s.clone, ".gitignore"), "utf8")).toBe(
				`${SOURCE_IGNORE}${IGNORE_BLOCK}${KEEP_BLOCK}`,
			);
			// The negations follow the block and reach none of its paths.
			expect(readIgnoredScratch(s)).toBe(
				"private/x\n.claude/tmp/x\n.claude/worktrees/x\n",
			);
			expect(s.git("ls-files", "CLAUDE.md", "AGENTS.md", ".gitignore")).toBe(
				".gitignore\nAGENTS.md\nCLAUDE.md",
			);
			// settings.local.json is this machine's, left untracked as in the empty flow.
			expect(s.git("status", "--porcelain")).toBe(
				"?? .claude/settings.local.json",
			);

			const config = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, ".claude/workflow-core.json"),
					"utf8",
				),
			);
			expect(config.modules).toEqual(["suites"]);
			expect(config.commands.test).toBe("npm run test");

			expect(s.git("show", "HEAD:docs/source/AGENTS.source.md")).toBe(
				SOURCE_AGENTS.trim(),
			);
			expect(s.git("show", "HEAD:.husky/pre-commit.local")).toBe(
				SET_ASIDE_HOOK.trim(),
			);
			expect(s.git("show", "HEAD:AGENTS.md")).not.toContain(
				"Open a pull request",
			);
			const classes = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, "docs/doc-map-classes.json"),
					"utf8",
				),
			);
			const route = "Path-scoped cherry-pick from `upstream` only";
			expect(classes["docs/tides.md"]).toEqual({
				section: "Source repo docs (octo/surf-lib)",
				class: "source-of-truth",
				classQualifier: null,
				role: "From the source repo octo/surf-lib, kept as copied",
				route,
				consumes: null,
				reader: "both",
			});
			expect(classes["docs/source/AGENTS.source.md"]).toMatchObject({
				section: "Source repo docs (octo/surf-lib)",
				class: "source-of-truth",
				role: "The source repo's AGENTS.md, set aside where no session loads it",
				route,
				reader: "agent",
			});
			expect(
				fs.readFileSync(path.join(s.clone, "docs/doc-map.md"), "utf8"),
			).toContain("### Source repo docs (octo/surf-lib)\n");

			const [, ticket] = s.readState().issues;
			expect(ticket.title).toBe(
				"Reconcile octo/surf-lib's agent instructions with the core's",
			);
			expect(ticket.labels.sort()).toEqual([
				"takes:wayfinder",
				"wayfinder:grilling",
			]);
			expect(ticket.parent).toBe(1);
			expect(ticket.assignees).toEqual([]);
			expect(ticket.body).toContain(
				"- `docs/source/AGENTS.source.md` — the source repo's `AGENTS.md`",
			);
			expect(readScratchLeft(s)).toEqual([]);

			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			for (const step of reported(true).filter((n) => n !== "init-adopter"))
				expect(statusOf(again.stdout, step), step).toBe("skipped");
			expect(again.stdout).toContain("  licence: MIT License\n");
			expect(s.readState().issues).toHaveLength(2);
			expect(readEndState(s).originRefs).toHaveLength(3);
		},
		340_000,
	);

	it("stops, exit 2, where origin's main is not an ancestor of the clone's main, offering a hand settle and a --resume re-run as the way out", () => {
		const s = builtThrough("source repo", true);
		s.git(
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"pushed from elsewhere",
		);
		s.git("push", "-q", "origin", "main");
		s.git("reset", "-q", "--hard", "HEAD~1");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toMatch(
			/^source repo {4}STOPPED — lucmoseley\/tides's main is not an ancestor of ~\/tides's main: the two have diverged$/m,
		);
		expect(r.stdout).toContain(
			"Manual step: settle ~/tides's main against origin/main by hand\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
		);
		expect(fs.existsSync(path.join(s.clone, "CLAUDE.md"))).toBe(false);
	}, 60_000);

	it("leaves a tag the source repo moved after the copy at origin's sha, and a re-run carries on past it", () => {
		const s = builtThrough("source repo", true);
		const v1 = s.git("rev-parse", "refs/tags/v1");
		execFileSync("git", [
			"-C",
			path.join(s.sb, "github", `${SOURCE}.git`),
			"tag",
			"-f",
			"v1",
			"trunk",
		]);
		// Stop the run at the map, past the copy and short of the commit.
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toMatch(/^source repo {4}skipped — already done — /m);
		expect(
			execFileSync("git", ["ls-remote", "--tags", "--refs", "origin", "v1"], {
				cwd: s.clone,
				encoding: "utf8",
				env: s.env,
			}).split("\t")[0],
		).toBe(v1);
	}, 60_000);

	it("stops, exit 2, where a line in the clone's .gitignore defeats the negations, naming it, and a re-run only re-checks the block", () => {
		const s = builtThrough("init-adopter", true);
		const ignore = path.join(s.clone, ".gitignore");
		fs.appendFileSync(ignore, ".husky/\n");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		// The appended `.husky/` is the line after every line those two end.
		const line = `${SOURCE_IGNORE}${IGNORE_BLOCK}`.split("\n").length;
		expect(r.stdout).toMatch(
			new RegExp(
				`^gitignore {6}STOPPED — \\.gitignore:${line} \\("\\.husky/"\\) hides \\.husky/prepare-commit-msg, .*, and no negation can undo it$`,
				"m",
			),
		);
		expect(r.stdout).toContain(
			"Manual step: narrow or remove that line in ~/tides — a pattern hiding a parent directory, such as `.claude/`, defeats any negation\n",
		);
		const written = fs.readFileSync(ignore, "utf8");
		// Every hidden path is negated, the hooks too, though no negation reaches them;
		// the source repo's own pre-commit is tracked, so git hides it from nothing.
		expect(written).toBe(
			`${SOURCE_IGNORE}${IGNORE_BLOCK}.husky/\n${KEEP_BLOCK.replace(
				"# --- end",
				`${[...HOOKS.filter((h) => h !== "pre-commit"), "pre-commit.local"]
					.map((h) => `!/.husky/${h}\n`)
					.join("")}# --- end`,
			)}`,
		);

		const again = s.resume();
		expect(again.status, again.stdout).toBe(2);
		expect(statusOf(again.stdout, "gitignore")).toBe("STOPPED");
		expect(fs.readFileSync(ignore, "utf8")).toBe(written);
	}, 120_000);

	it("stops, exit 2, where the source repo's file and a different set-aside copy are both present, naming which to keep, and a re-run finishes the move once one is deleted", () => {
		const s = builtThrough("source repo", true);
		const copy = path.join(s.clone, "docs/source/AGENTS.source.md");
		fs.mkdirSync(path.dirname(copy), { recursive: true });
		fs.writeFileSync(copy, `${SOURCE_AGENTS}Kept: the tide notes.\n`);
		// Stop the run at the map, past the step and short of the commit.
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"set aside      STOPPED — ~/tides holds both the source repo's AGENTS.md and a different docs/source/AGENTS.source.md\n\nManual step: keep the text you mean in ~/tides/docs/source/AGENTS.source.md, then delete ~/tides/AGENTS.md\n",
		);
		expect(fs.readFileSync(path.join(s.clone, "AGENTS.md"), "utf8")).toBe(
			SOURCE_AGENTS,
		);
		expect(fs.existsSync(path.join(s.clone, "CLAUDE.md"))).toBe(false);

		fs.rmSync(path.join(s.clone, "AGENTS.md"));
		const again = s.resume();
		expect(again.status, again.stdout).toBe(1);
		expect(again.stdout).toContain(
			"set aside      done — .husky/pre-commit → .husky/pre-commit.local, # shellcheck shell=sh added to .husky/pre-commit.local\n",
		);
		expect(statusOf(again.stdout, "first map")).toBe("STOPPED");
		expect(fs.readFileSync(copy, "utf8")).toBe(
			`${SOURCE_AGENTS}Kept: the tide notes.\n`,
		);
	}, 120_000);

	it("finishes a move whose copy was made but whose original was left, and removes a CLAUDE.md that only links to AGENTS.md", () => {
		const s = builtThrough("source repo", true, {
			source: "node_modules/\n",
			sourceFiles: { "CLAUDE.md": { link: "AGENTS.md" } },
		});
		fs.mkdirSync(path.join(s.clone, ".husky"), { recursive: true });
		// A copy already holding its shell directive (#1870).
		fs.writeFileSync(
			path.join(s.clone, ".husky/pre-commit.local"),
			SET_ASIDE_HOOK,
		);
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toContain(
			"set aside      done — CLAUDE.md, a link to AGENTS.md, removed, AGENTS.md → docs/source/AGENTS.source.md\n",
		);
		expect(fs.lstatSync(path.join(s.clone, "CLAUDE.md")).isSymbolicLink()).toBe(
			false,
		);
		expect(
			fs.readFileSync(
				path.join(s.clone, "docs/source/AGENTS.source.md"),
				"utf8",
			),
		).toBe(SOURCE_AGENTS);
		expect(
			fs.existsSync(path.join(s.clone, "docs/source/CLAUDE.source.md")),
		).toBe(false);
		// The core's hook, init's own, where the source repo's was.
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit"), "utf8"),
		).not.toBe(SOURCE_HOOK);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit.local"), "utf8"),
		).toBe(SET_ASIDE_HOOK);
	}, 120_000);

	it("finishes a move whose byte-for-byte copy was made but whose original was left, adding the shell directive the copy lacks (#1870)", () => {
		const s = builtThrough("source repo", true);
		fs.writeFileSync(
			path.join(s.clone, ".husky/pre-commit.local"),
			SOURCE_HOOK,
		);
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit.local"), "utf8"),
		).toBe(SET_ASIDE_HOOK);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit"), "utf8"),
		).not.toBe(SOURCE_HOOK);
	}, 120_000);

	it("moves a source hook that names its shell byte for byte, adding nothing (#1870)", () => {
		const hook = `#!/bin/sh\n${SOURCE_HOOK}`;
		const s = builtThrough("source repo", true, {
			source: SOURCE_IGNORE,
			sourceFiles: { ".husky/pre-commit": hook },
		});
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toContain(
			"set aside      done — AGENTS.md → docs/source/AGENTS.source.md, .husky/pre-commit → .husky/pre-commit.local\n",
		);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit.local"), "utf8"),
		).toBe(hook);
	}, 120_000);

	it("warns where the source repo's AGENTS.md was edited before the move, and leaves it where it is", () => {
		const s = builtThrough("source repo", true);
		const agents = path.join(s.clone, "AGENTS.md");
		fs.writeFileSync(agents, `${SOURCE_AGENTS}Edited in the clone.\n`);
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toContain(
			"set aside      done — .husky/pre-commit → .husky/pre-commit.local, # shellcheck shell=sh added to .husky/pre-commit.local\n  warning: AGENTS.md differs from the source repo's and was left where it is\n",
		);
		expect(fs.readFileSync(agents, "utf8")).toBe(
			`${SOURCE_AGENTS}Edited in the clone.\n`,
		);
		expect(
			fs.existsSync(path.join(s.clone, "docs/source/AGENTS.source.md")),
		).toBe(false);
	}, 120_000);
});

describe.skipIf(!HAS_GITLEAKS)(
	"new-repo.js --resume after a part-way copy",
	() => {
		let goldenEnd: ReturnType<typeof readEndState>;
		let world: ReturnType<typeof worlds>;
		beforeAll(() => {
			const clean = cleanRun(true);
			goldenEnd = clean.goldenEnd;
			world = worlds(clean.golden, true);
		}, 340_000);
		afterAll(() => world?.drop());

		it.each([
			"clone",
			"source repo",
			"set aside",
			"init-adopter",
			"gitignore",
			"source docs",
			"push",
		])(
			"finishes from the world as left after %s, reaching a clean copy's end state, as its dry run foretold",
			(step) => {
				resumeFinishes(world.at(step), step, goldenEnd, true);
			},
			170_000,
		);

		it("commits the skeleton where an earlier run set the shebang-less hook aside byte for byte and shellcheck refused it, adding the shell directive (#1870)", () => {
			const s = world.at("source docs", { hooks: true });
			fs.writeFileSync(
				path.join(s.clone, ".husky/pre-commit.local"),
				SOURCE_HOOK,
			);
			const r = s.resume();
			expect(r.status, r.stdout).toBe(0);
			expect(statusOf(r.stdout, "set aside")).toBe("repaired");
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(s.git("show", "HEAD:.husky/pre-commit.local")).toBe(
				SET_ASIDE_HOOK.trim(),
			);
		}, 340_000);

		it("moves a linked pre-commit beside itself, and files the reconcile ticket for a CLAUDE.md that was only a link", () => {
			const s = sandbox({
				source: "node_modules/\n",
				sourceFiles: {
					"AGENTS.md": null,
					"CLAUDE.md": { link: "docs/tides.md" },
					".husky/pre-commit": { link: "../scripts/hook.sh" },
					"scripts/hook.sh": SET_ASIDE_HOOK,
				},
			});
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			expect(r.stdout).toContain(
				"set aside      done — CLAUDE.md, a link to docs/tides.md, removed, .husky/pre-commit → .husky/pre-commit.local\n",
			);
			expect(
				fs.readlinkSync(path.join(s.clone, ".husky/pre-commit.local")),
			).toBe("../scripts/hook.sh");
			expect(r.stdout).toContain("reconcile      done — #2 under #1\n");
			const [, ticket] = s.readState().issues;
			expect(ticket.body).toContain(
				"- the source repo's `CLAUDE.md` was a link to `docs/tides.md`",
			);
			expect(ticket.body).not.toContain("AGENTS.source.md");
		}, 170_000);

		it("prints the self-plugin's once-per-machine setup before the first session, for a copy of a workflow-core checkout (#2440)", () => {
			const s = sandbox({
				source: "node_modules/\n",
				sourceFiles: { "self-plugin/hooks/hooks.json": '{"hooks":{}}\n' },
			});
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			expect(r.stdout).toContain(
				`This is a workflow-core checkout. Once per machine, first run:\nclaude plugin marketplace add '${s.clone}/self-plugin' --scope user\n\nOpen a new terminal tab`,
			);
		}, 170_000);

		it("keeps the lowest reconcile ticket, links it under the map where a failed run left it unlinked, and closes every other", () => {
			const s = world.at("push");
			const gh = s.readState();
			const [map] = gh.issues;
			const ticket = {
				...map,
				title: "Reconcile octo/surf-lib's agent instructions with the core's",
				labels: ["wayfinder:grilling", "takes:wayfinder"],
				body: "filed by a failed run",
			};
			gh.issues.push(
				{ ...ticket, number: 2 },
				{ ...ticket, number: 3, parent: 1 },
			);
			fs.writeFileSync(
				path.join(s.sb, "github/lucmoseley/tides.json"),
				JSON.stringify(gh),
			);
			const r = s.resume();
			expect(r.status, r.stdout).toBe(0);
			expect(r.stdout).toContain("reconcile      repaired — #2 under #1\n");
			const [, kept, dup] = s.readState().issues;
			expect(kept.state).toBe("OPEN");
			expect(kept.parent).toBe(1);
			expect(dup.state).toBe("CLOSED");
			expect(dup.comments).toEqual([
				"duplicate of #2, filed by a failed new-repo run",
			]);
		}, 170_000);
	},
);
