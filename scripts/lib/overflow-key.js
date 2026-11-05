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
 * Moving or renaming this file strands every live overflow session, as does
 * removing a session worktree or plugin version a loop ran from.
 *
 *   node scripts/lib/overflow-key.js <key var> <secrets file>
 *     prints the variable's value; a missing file or variable exits 1 naming
 *     the variable and the file, never a value; bad usage exits 2.
 */

const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const {
	readEnvFileValue,
	readSecretKeepingIgnore,
	secretsFile,
} = require("./env-file.js");
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

/** The program a helper names, through the boot link where there is one. */
const helperProgram = () => throughBootLink(__filename) ?? __filename;

/**
 * @param {string} program
 * @param {string} keyVar
 * @param {string} file
 */
const helperCommand = (program, keyVar, file) =>
	[process.execPath, program, keyVar, file].map(shellQuote).join(" ");

/**
 * The `apiKeyHelper` command printing `keyVar` from `file`.
 * @param {string} keyVar
 * @param {string} file
 */
function buildKeyHelper(keyVar, file) {
	return helperCommand(helperProgram(), keyVar, file);
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
	const program = helperProgram();
	if (!fs.existsSync(program))
		return {
			why: `no key helper at ${program} for ${keyVar}: the refill loop's boot link names no worktree holding it; the loop points it after its first tick, so the next tick launches`,
		};
	return {
		settings: JSON.stringify({
			apiKeyHelper: helperCommand(program, keyVar, key.file),
		}),
	};
}

module.exports = { buildKeyHelper, buildKeySettings };

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
