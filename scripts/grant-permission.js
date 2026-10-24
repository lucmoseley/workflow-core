#!/usr/bin/env node
/*
 * grant-permission.js — adds one permission rule to a Claude Code settings
 * file's allow list, so a founder hand-over can grant a permission in one
 * pasted line rather than a walk through `/permissions` (workflow-core#596, spec workflow-core#525).
 *
 * Usage:
 *   node grant-permission.js '<rule>' [--project]
 *
 * <rule> is Claude Code's permission syntax: a tool name, optionally with a
 * parenthesised specifier — `Read`, `Bash(git status *)`,
 * `mcp__github__get_issue`, `WebFetch(domain:example.com)`.
 *
 * TARGET: the host repository's `.claude/settings.local.json` — the founder's
 * own, uncommitted file (workflow-core#479 Q3) — or, with `--project`, the committed
 * `.claude/settings.json`. The host root is `lib/host-root.js`'s, so an
 * install writes into the adopter's tree, never the plugin cache.
 *
 * NO FAMILY (§N3): a founder-run writer, not a generator — exit 2 separates
 * a mistyped paste from a settings file needing a hand fix. 0 when the rule
 * was added or was already there (the file is then not rewritten); 1 when the
 * file will not parse or its `permissions`/`allow` is not the shape Claude
 * Code reads; 2 on a malformed rule or bad arguments. Every refusal leaves the
 * file untouched.
 *
 * THE REWRITE keeps every other key, the existing entries' order, the file's
 * indentation and its trailing newline, and lands by rename, so a reader never
 * sees half a file. Three things do not survive the JSON round-trip: comments
 * refuse as unparseable, a duplicate key collapses to its last value, and an
 * integer-like key such as `"10"` moves to the front of its object.
 *
 * NO FILE CLAIM (spec workflow-core#525). `--project`'s target is tracked, so a session
 * holding it is not consulted and its unsaved edit can be written over — the
 * founder's paste has no session of its own to claim with.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { execFileSync } = require("node:child_process");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { caught } = require("./lib/caught.js");

const LOCAL = ".claude/settings.local.json";
/** The first indented line's leading whitespace. */
const INDENT = /\n([ \t]+)\S/;
const PROJECT = ".claude/settings.json";

/* A name as Claude Code spells tools, MCP ones and their wildcard included
 * (`mcp__srv__tool`, `mcp__srv__*`), then an optional non-blank specifier
 * running to the rule's last character. Parentheses inside it are not paired:
 * `Bash(echo ")")` is one specifier to the harness. */
const RULE = /^[A-Za-z][A-Za-z0-9_*-]*(\([^\n]*\S[^\n]*\))?$/;

const USAGE = `usage: grant-permission.js '<rule>' [--project]
  <rule>     a tool name, optionally with a parenthesised specifier: 'Bash(git status *)'
  --project  write the committed .claude/settings.json instead of .claude/settings.local.json`;

/**
 * The indent unit of the first indented line; none for a one-line file; two
 * spaces — Claude Code's own — for any other.
 * @param {string} text
 * @returns {string}
 */
function detectIndent(text) {
	if (!text.trimEnd().includes("\n")) return "";
	const m = text.match(INDENT);
	return m ? requiredGroup(m, 1, INDENT) : "  ";
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Whether git ignores `rel` under `root`. check-ignore exits 1 for "not
 * ignored" and 128 outside a repository; both mean nothing keeps the file out
 * of a commit.
 * @param {string} root
 * @param {string} rel
 * @returns {boolean}
 */
function isGitIgnored(root, rel) {
	try {
		execFileSync("git", ["check-ignore", "-q", rel], {
			cwd: root,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} why
 * @param {number} status
 * @returns {number}
 */
function refuse(why, status) {
	process.stderr.write(
		`grant-permission: refused, settings untouched — ${why}\n`,
	);
	return status;
}

/**
 * The settings file's object and the layout its rewrite keeps — an absent file
 * reads as an empty object at Claude Code's two-space indent — or the exit
 * status of a refusal already said.
 * @param {string} file
 * @returns {{settings: Record<string, unknown>, indent: string, trailingNewline: boolean} | {exit: number}}
 */
function readSettings(file) {
	if (!fs.existsSync(file))
		return { settings: {}, indent: "  ", trailingNewline: true };
	const text = fs.readFileSync(file, "utf8");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return {
			exit: refuse(
				`${file} will not parse as JSON (${caught(e).message}). Fix it by hand, then re-run.`,
				1,
			),
		};
	}
	if (!isPlainObject(parsed)) {
		return {
			exit: refuse(`${file} holds no JSON object at its top level.`, 1),
		};
	}
	return {
		settings: parsed,
		indent: detectIndent(text),
		trailingNewline: text.endsWith("\n"),
	};
}

/**
 * @param {string[]} argv
 * @returns {number} exit status
 */
function main(argv) {
	const { flags, positionals } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--project": "boolean" },
		min: 1,
	});
	const project = flags["--project"] === true;
	const [rule] = positionals;
	if (rule === undefined)
		throw new Error("parseOrExit's min: 1 let a missing <rule> through");
	if (!RULE.test(rule)) {
		return refuse(
			`${JSON.stringify(rule)} is not a permission rule. Give a tool name, optionally with a non-empty parenthesised specifier, e.g. 'Bash(git status *)'.`,
			2,
		);
	}

	const root = hostRoot();
	const rel = project ? PROJECT : LOCAL;
	const file = path.join(root, rel);

	const read = readSettings(file);
	if ("exit" in read) return read.exit;
	const { settings, indent, trailingNewline } = read;

	const permissions = settings.permissions ?? {};
	if (!isPlainObject(permissions)) {
		return refuse(`"permissions" in ${file} is not an object.`, 1);
	}
	const allow = permissions.allow ?? [];
	if (!Array.isArray(allow)) {
		return refuse(`"permissions.allow" in ${file} is not a list.`, 1);
	}

	if (allow.includes(rule)) {
		process.stdout.write(
			`grant-permission: ${rule} is already allowed in ${file} — left unchanged\n`,
		);
	} else {
		permissions.allow = [...allow, rule];
		settings.permissions = permissions;
		const body = JSON.stringify(settings, null, indent);
		writeFileAtomic(file, trailingNewline ? `${body}\n` : body, {
			mkdir: true,
		});
		process.stdout.write(`grant-permission: added ${rule} to ${file}\n`);
	}

	if (!project && !isGitIgnored(root, rel)) {
		process.stderr.write(
			`grant-permission: warning — git does not ignore ${rel} in ${root}, so it could be committed. Add it to .gitignore.\n`,
		);
	}
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
