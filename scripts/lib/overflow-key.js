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
 *   node scripts/lib/overflow-key.js <key var> <secrets file>
 *     prints the variable's value; a missing file or variable exits 1 naming
 *     the variable and the file, never a value; bad usage exits 2.
 *   node scripts/lib/overflow-key.js --settings <key var>
 *     prints the `--settings` JSON a launch on that key passes, or exits 1
 *     naming why the key cannot be read, checked before the launch since the
 *     helper runs only after it.
 */

const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const {
	readEnvFileValue,
	readSecretKeepingIgnore,
	secretsFile,
} = require("./env-file.js");
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
 * The `apiKeyHelper` command printing `keyVar` from `file`.
 * @param {string} keyVar
 * @param {string} file
 */
function buildKeyHelper(keyVar, file) {
	return [process.execPath, __filename, keyVar, file].map(shellQuote).join(" ");
}

/**
 * The `--settings` JSON a launch on `keyVar` passes, or why its key cannot be
 * read.
 * @param {string} keyVar
 * @returns {{settings: string}|{why: string}}
 */
function buildKeySettings(keyVar) {
	const key = keyCheck(keyVar);
	return "why" in key
		? key
		: {
				settings: JSON.stringify({
					apiKeyHelper: buildKeyHelper(keyVar, key.file),
				}),
			};
}

module.exports = { buildKeyHelper, buildKeySettings, keyCheck };

if (require.main === module) {
	/** @type {{positionals: string[], settings?: string}} */
	let args = { positionals: [] };
	try {
		const parsed = parseArgs({
			allowPositionals: true,
			options: { settings: { type: "string" } },
		});
		args = { positionals: parsed.positionals, ...parsed.values };
	} catch {
		/* an unknown option: bad usage, below */
	}
	const [keyVar, file] = args.positionals;
	if (args.settings !== undefined && args.positionals.length === 0) {
		const built = buildKeySettings(args.settings);
		if ("settings" in built) writeFd(1, `${built.settings}\n`);
		else {
			writeFd(2, `${built.why}\n`);
			process.exitCode = 1;
		}
	} else if (
		args.settings !== undefined ||
		args.positionals.length !== 2 ||
		!keyVar ||
		!file
	) {
		writeFd(
			2,
			`usage: node ${scriptPath("lib/overflow-key.js")} <key var> <secrets file>\n` +
				`       node ${scriptPath("lib/overflow-key.js")} --settings <key var>\n`,
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
