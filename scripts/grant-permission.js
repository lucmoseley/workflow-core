#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { caught } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");

const LOCAL = ".claude/settings.local.json";
const CLAUDE_CODE_INDENT = "  ";
const INDENT = /\n([ \t]+)\S/;
const PROJECT = ".claude/settings.json";

const RULE = /^[A-Za-z][A-Za-z0-9_*-]*(\([^\S\n]*\S[^\n]*\))?$/;

const USAGE = `usage: grant-permission.js '<rule>' [--project]
  <rule>     a tool name, optionally with a parenthesised specifier: 'Bash(git status *)'
  --project  write the committed .claude/settings.json instead of .claude/settings.local.json`;

/**
 * @param {string} text
 * @returns {string}
 */
function detectIndent(text) {
	if (!text.trimEnd().includes("\n")) return "";
	const m = text.match(INDENT);
	return m ? requiredGroup(m, 1, INDENT) : CLAUDE_CODE_INDENT;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {boolean}
 */
function isGitIgnored(root, rel) {
	try {
		execGit(["check-ignore", "-q", rel], {
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
 * @param {string} file
 * @returns {{settings: Record<string, unknown>, indent: string, trailingNewline: boolean} | {exit: number}}
 */
function readSettings(file) {
	if (!fs.existsSync(file))
		return { settings: {}, indent: CLAUDE_CODE_INDENT, trailingNewline: true };
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
 * @returns {number}
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
