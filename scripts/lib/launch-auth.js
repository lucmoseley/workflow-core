const { parseArgs } = require("node:util");
const { spawnRaw } = require("./child-spawn.js");
const { claudeBin } = require("./claude-bin.js");
const { secretsFile } = require("./env-file.js");
const { buildKeyHelper } = require("./overflow-key.js");
const { readEnviron } = require("./proc-environ.js");
const {
	overflowSeatsOf,
	readDeclaredSeats,
	seatOfLaunch,
} = require("./refill-seats.js");
const { writeFd } = require("./write-fd.js");

// guess, #2236
const STATUS_TIMEOUT_MS = 30_000;

const RULE =
	"a workflow-core model launch bills the subscription seat, never per token (#2236)";

// guess, #2236
const OFF = ["0", "false", "no", "off"];

/**
 * @param {string|undefined} v
 * @returns {v is string}
 */
const isSet = (v) => v !== undefined && v !== "";

/**
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {typeof spawnRaw} spawn
 * @returns {{why: string}|{status: {authMethod?: string, apiProvider?: string}}}
 */
function readAuthStatus(bin, env, cwd, spawn) {
	const r = spawn(bin, ["auth", "status", "--json"], {
		env,
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: STATUS_TIMEOUT_MS,
	});
	if (r.error)
		return { why: `\`${bin} auth status\` failed: ${r.error.message}` };
	try {
		return { status: JSON.parse(r.stdout) };
	} catch {
		const said = (r.stderr || r.stdout || "").trim().split("\n")[0];
		return {
			why: `\`${bin} auth status\` printed no JSON (exit ${r.status}${said ? `: ${said}` : ""})`,
		};
	}
}

/**
 * @param {string|undefined} settings
 * @returns {{helper: unknown}|{why: string}}
 */
function parseSettingsHelper(settings) {
	if (settings === undefined) return { helper: null };
	try {
		return { helper: JSON.parse(settings)?.apiKeyHelper ?? null };
	} catch {
		return {
			why: "--settings is not inline JSON, so its apiKeyHelper cannot be read",
		};
	}
}

/**
 * @param {unknown} helper
 * @param {NodeJS.ProcessEnv} env
 */
function isSeatHelper(helper, env) {
	const dir = env.CLAUDE_CONFIG_DIR;
	if (typeof helper !== "string" || !isSet(dir)) return false;
	const list = readDeclaredSeats();
	if (list.errors.length > 0) return false;
	const file = secretsFile();
	return overflowSeatsOf(list.seats).some(
		(s) =>
			helper === buildKeyHelper(s.keyVar, file) &&
			!("why" in seatOfLaunch(list, { dir, keyVar: s.keyVar })),
	);
}

/** @param {NodeJS.ProcessEnv} env */
const providerFlags = (env) =>
	Object.keys(env).filter(
		(k) =>
			k.startsWith("CLAUDE_CODE_USE_") &&
			isSet(env[k]) &&
			!OFF.includes(String(env[k]).toLowerCase()),
	);

/**
 * @param {string} out
 * @returns {string|null|undefined}
 */
function daemonPidOf(out) {
	if (out.split("\n")[0]?.trim() === "not running") return null;
	return /^pid:[ \t]+(\d+)[ \t]*$/m.exec(out)?.[1];
}

/**
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {typeof spawnRaw} spawn
 * @returns {string|null}
 */
function daemonRefusal(bin, env, cwd, spawn) {
	const r = spawn(bin, ["daemon", "status"], {
		env,
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: STATUS_TIMEOUT_MS,
	});
	if (r.error) return `\`${bin} daemon status\` failed: ${r.error.message}`;
	const out = String(r.stdout ?? "");
	const pid = daemonPidOf(out);
	if (pid === null) return null;
	if (pid === undefined) {
		const said = (String(r.stderr ?? "") || out).trim().split("\n")[0];
		return `\`${bin} daemon status\` named no daemon pid (exit ${r.status}${said ? `: ${said}` : ""})`;
	}
	const daemon = `the Claude daemon (pid ${pid}) this --bg launch hands its session to`;
	const read = readEnviron(pid);
	if (!read.ok) return `${daemon} has an environment that will not read`;
	const set = [
		...[
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
		].filter((k) => isSet(read.env[k])),
		...providerFlags(read.env),
	];
	if (set.length === 0) return null;
	return `${daemon} has ${set.join(", ")} set in its environment`;
}

/**
 * @param {{authMethod?: string, apiProvider?: string}} status
 * @param {NodeJS.ProcessEnv} env
 */
function sourceOf(status, env) {
	switch (status.authMethod) {
		case "api_key":
			return isSet(env.ANTHROPIC_API_KEY)
				? "ANTHROPIC_API_KEY is set"
				: "an API key is stored in the seat's config";
		case "oauth_token":
			return "ANTHROPIC_AUTH_TOKEN is set";
		case "api_key_helper":
			return "an apiKeyHelper setting is in force";
		case "third_party": {
			const flags = providerFlags(env);
			return flags.length > 0
				? `${flags.join(", ")} ${flags.length > 1 ? "are" : "is"} set`
				: `the API provider is ${status.apiProvider}`;
		}
		case "none":
			return "the seat is not logged in";
		default:
			return `\`auth status\` reports authMethod ${JSON.stringify(status.authMethod)}`;
	}
}

/**
 * @param {{bin: string, env: NodeJS.ProcessEnv, cwd: string,
 *   settings?: string, bg?: boolean, spawn?: typeof spawnRaw}} launch
 * @returns {string|null}
 */
function launchAuthRefusal({
	bin,
	env,
	cwd,
	settings,
	bg = false,
	spawn = spawnRaw,
}) {
	const refused = (/** @type {string} */ why) =>
		`this model launch would not bill the subscription: ${why}. Rule: ${RULE}. Unset what set it, or launch from a shell without it.`;
	if (isSet(env.ANTHROPIC_BASE_URL))
		return refused("ANTHROPIC_BASE_URL is set");
	if (bg) {
		const why = daemonRefusal(bin, env, cwd, spawn);
		if (why) return refused(why);
	}
	const parsed = parseSettingsHelper(settings);
	if ("why" in parsed) return refused(parsed.why);
	const { helper } = parsed;
	const seatHelper = helper !== null && isSeatHelper(helper, env);
	if (helper !== null && !seatHelper)
		return refused(
			"an apiKeyHelper in --settings is in force, and is no declared overflow seat's on this config dir",
		);
	const read = readAuthStatus(bin, env, cwd, spawn);
	if ("why" in read) return refused(read.why);
	const { status } = read;
	const method = status.authMethod;
	if (method === "claude.ai") return null;
	if (seatHelper && method === "none") return null;
	if (
		method === "oauth_token" &&
		isSet(env.CLAUDE_CODE_OAUTH_TOKEN) &&
		!isSet(env.ANTHROPIC_AUTH_TOKEN)
	)
		return null;
	return refused(sourceOf(status, env));
}

if (require.main === module) {
	parseArgs({});
	const why = launchAuthRefusal({
		bin: claudeBin(),
		env: process.env,
		cwd: process.cwd(),
	});
	if (why) {
		writeFd(2, `REFUSED: ${why}\n`);
		process.exitCode = 2;
	}
}

module.exports = { daemonPidOf, launchAuthRefusal };
