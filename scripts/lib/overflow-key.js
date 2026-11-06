/*
 * overflow-key.js — an overflow seat's key, for a launch's `apiKeyHelper`
 * (#3699, spec #3691).
 *
 * The launch hands the child `--settings '{"apiKeyHelper": <buildKeyHelper()>}'`,
 * so the key is read from the secrets file each time `claude` calls the
 * helper, and is in neither the caller's environment nor the child's: no Bash
 * call or hook in the session sees it (#2604 (b)). lib/launch-auth.js admits
 * a launch's helper only where it is buildKeyHelper() for an overflow seat
 * declared on the launch's config dir.
 *
 * THE HELPER'S PATH outlives the code that launched it (#4392). Run
 * from one of the refill loop's code worktrees, which the loop removes once
 * it adopts a newer tip (lib/refill-code.js), the helper names this file
 * through the boot link, which always names the worktree the loop last ran.
 * Run from any other linked git worktree, a session's among them (#4425), it
 * names the main checkout's copy.
 * Moving or renaming this file strands every live overflow session, as does
 * removing a plugin version a loop ran from.
 *
 * Residual (#4425): a session launched from a linked worktree runs the main
 * checkout's copy, so one whose command line lags fails its helper.
 *
 *   node scripts/lib/overflow-key.js <key var> <secrets file>
 *     prints the variable's value; a missing file or variable exits 1 naming
 *     the variable and the file, never a value; bad usage exits 2.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const {
	readEnvFileValue,
	readSecretKeepingIgnore,
	secretsFile,
} = require("./env-file.js");
const { checkoutOfCommonDir } = require("./main-checkout.js");
const { throughBootLink } = require("./refill-control-code.js");
const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");
const { writeFd } = require("./write-fd.js");

/**
 * The variable's value read through `read`, or why it cannot be.
 * @param {string} keyVar
 * @param {string} file
 * @param {(name: string) => string|null} read
 * @returns {{value: string}|{why: string}}
 */
function readKey(keyVar, file, read) {
	const fix = `set it with \`node ${scriptPath("write-secret.js")} ${keyVar}\``;
	try {
		const value = read(keyVar);
		return value === null
			? { why: `${keyVar} is not set in ${file}: ${fix}` }
			: { value };
	} catch (err) {
		return caught(err).code === "ENOENT"
			? { why: `no ${file} to read ${keyVar} from: ${fix}` }
			: {
					why: `cannot read ${file} for ${keyVar}: ${caught(err).message}`,
				};
	}
}

/**
 * The secrets file a launch's helper reads `keyVar` from, or why it cannot,
 * checked before the launch since the helper runs only after it.
 * @param {string} keyVar
 * @returns {{file: string}|{why: string}}
 */
function keyCheck(keyVar) {
	const file = secretsFile();
	const read = readKey(keyVar, file, readSecretKeepingIgnore);
	return "why" in read ? read : { file };
}

/**
 * The main checkout's copy of `file` where `file` sits in a linked git
 * worktree, read off its `.git` file (`gitdir: <common dir>/worktrees/<name>`)
 * as a hook-path caller (lib/launch-auth.js) spawns no git; null where it
 * sits in a main checkout, a worktree whose common dir names no checkout, a
 * submodule or no checkout.
 * @param {string} file a real path
 */
function throughMainCheckout(file) {
	const found = readGitFile(path.dirname(file));
	if (!found) return null;
	const gitDir = /^gitdir: (.+)$/m.exec(found.text)?.[1];
	if (!gitDir) return null;
	const registration = path.resolve(found.dir, gitDir.trim());
	if (path.basename(path.dirname(registration)) !== "worktrees") return null;
	const main = checkoutOfCommonDir(path.dirname(path.dirname(registration)));
	return main && path.join(main, path.relative(found.dir, file));
}

/**
 * The nearest `.git` file at or above `start`, and the directory holding it;
 * null where the nearest `.git` is a directory, or there is none.
 * @param {string} start
 * @returns {{dir: string, text: string}|null}
 */
function readGitFile(start) {
	for (let dir = start; ; dir = path.dirname(dir)) {
		try {
			return { dir, text: fs.readFileSync(path.join(dir, ".git"), "utf8") };
		} catch (err) {
			const { code } = caught(err);
			if (code === "EISDIR") return null;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			if (path.dirname(dir) === dir) return null;
		}
	}
}

/**
 * The program a helper names, one no worktree's removal takes with it, and
 * the route that named it.
 * @returns {{program: string, via: "boot link"|"main checkout"|"own path"}}
 */
function helperRoute() {
	const booted = throughBootLink(__filename);
	if (booted) return { program: booted, via: "boot link" };
	const main = throughMainCheckout(__filename);
	if (main) return { program: main, via: "main checkout" };
	return { program: __filename, via: "own path" };
}

/**
 * @param {string} program
 * @param {string} keyVar
 * @param {string} file
 */
const buildHelperCommand = (program, keyVar, file) =>
	[process.execPath, program, keyVar, file].map(shellQuote).join(" ");

/**
 * The `apiKeyHelper` command printing `keyVar` from `file`.
 * @param {string} keyVar
 * @param {string} file
 */
function buildKeyHelper(keyVar, file) {
	return buildHelperCommand(helperRoute().program, keyVar, file);
}

/**
 * The `--settings` JSON a launch on `keyVar` passes, or why its key cannot be
 * read.
 * @param {string} keyVar
 * @returns {{settings: string}|{why: string}}
 */
function buildKeySettings(keyVar) {
	const key = keyCheck(keyVar);
	if ("why" in key) return key;
	const { program, via } = helperRoute();
	if (!fs.existsSync(program))
		return {
			why:
				via === "main checkout"
					? `no key helper at ${program} for ${keyVar}: this runs from a linked worktree, whose removal would strand the helper, so it names the main checkout's copy, which is not there. Update the main checkout, or let the refill loop launch overflow sessions`
					: `no key helper at ${program} for ${keyVar}: the refill loop's boot link names no worktree holding it. Before the loop's first tick, the tick points it and the next tick launches; otherwise the tip it names has moved this file`,
		};
	return {
		settings: JSON.stringify({
			apiKeyHelper: buildHelperCommand(program, keyVar, key.file),
		}),
	};
}

/**
 * The variables an overflow launch's child runs without: any key, which
 * would outrank the helper, and the caller's session id, which would make the
 * child claim to be the caller.
 * @param {string} keyVar
 */
const overflowUnset = (keyVar) => [
	"ANTHROPIC_API_KEY",
	keyVar,
	"CLAUDE_CODE_SESSION_ID",
];

module.exports = { buildKeyHelper, buildKeySettings, overflowUnset };

if (require.main === module) {
	/** @type {string[]} */
	let positionals = [];
	try {
		({ positionals } = parseArgs({ allowPositionals: true }));
	} catch {
		/* an unknown option: bad usage, below */
	}
	const [keyVar, file] = positionals;
	if (positionals.length !== 2 || !keyVar || !file) {
		writeFd(
			2,
			`usage: node ${scriptPath("lib/overflow-key.js")} <key var> <secrets file>\n`,
		);
		process.exitCode = 2;
	} else {
		const read = readKey(keyVar, file, (name) => readEnvFileValue(file, name));
		if ("value" in read) writeFd(1, `${read.value}\n`);
		else {
			writeFd(2, `${read.why}\n`);
			process.exitCode = 1;
		}
	}
}
