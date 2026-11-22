const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught, orFallback } = require("./caught.js");
const {
	readEnvFileValue,
	readSecretKeepingIgnore,
	secretsFile,
} = require("./env-file.js");
const {
	parseGitFileTarget,
	readGitFile,
	readRegistrationCommonDir,
} = require("./git-file.js");
const { checkoutOfCommonDir } = require("./main-checkout.js");
const { throughBootLink } = require("./refill-control-code.js");
const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");
const { writeFd } = require("./write-fd.js");

/**
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
 * @param {string} keyVar
 * @returns {{file: string}|{why: string}}
 */
function keyCheck(keyVar) {
	const file = secretsFile();
	const read = readKey(keyVar, file, readSecretKeepingIgnore);
	return "why" in read ? read : { file };
}

/** @param {string} file */
function throughMainCheckout(file) {
	const found = readGitFile(path.dirname(file));
	if (!found) return null;
	const registration = parseGitFileTarget(found.dir, found.text);
	const common = registration && readRegistrationCommonDir(registration);
	const main = common && checkoutOfCommonDir(common);
	return main && path.join(main, path.relative(found.dir, file));
}

/** @returns {{program: string, via: "boot link"|"main checkout"|"own path"}} */
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
 * @param {string} keyVar
 * @param {string} file
 */
function buildKeyHelper(keyVar, file) {
	return buildHelperCommand(helperRoute().program, keyVar, file);
}

/**
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
 * @param {string} keyVar
 * @param {NodeJS.ProcessEnv} env
 * @returns {{settings: string, unset: string[], env: NodeJS.ProcessEnv}
 *   |{why: string}}
 */
function buildOverflowLaunch(keyVar, env) {
	const built = buildKeySettings(keyVar);
	if ("why" in built) return built;
	const unset = ["ANTHROPIC_API_KEY", keyVar, "CLAUDE_CODE_SESSION_ID"];
	const stripped = { ...env };
	for (const name of unset) delete stripped[name];
	return { settings: built.settings, unset, env: stripped };
}

module.exports = { buildKeyHelper, buildOverflowLaunch };

if (require.main === module) {
	const positionals = orFallback(
		() => parseArgs({ allowPositionals: true }).positionals,
		/** @type {string[]} */ ([]),
	);
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
