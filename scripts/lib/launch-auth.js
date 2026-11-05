/*
 * launch-auth.js — refuses a model launch whose auth would bill per token
 * instead of the subscription (#2236, ruled at #2203). `claude -p` takes an
 * ANTHROPIC_API_KEY over the logged-in seat without asking.
 *
 * Every launch site calls launchAuthRefusal() with the binary, environment
 * and working directory its child gets. It reads `claude auth status` under
 * them, which makes no model call, so a project's or seat's `apiKeyHelper`
 * counts. It admits:
 *   - `claude.ai`, a logged-in seat;
 *   - `oauth_token` where CLAUDE_CODE_OAUTH_TOKEN is set and
 *     ANTHROPIC_AUTH_TOKEN is not: both report `oauth_token`, and only the
 *     first bills the subscription;
 *   - on a launch passing `settings` whose `apiKeyHelper` is
 *     lib/overflow-key.js's helper for an overflow seat lib/refill-seats.js
 *     declares on the launch's config dir (#3699), `none` as well: the helper
 *     hands the child its key, and `auth status` does not take `--settings`,
 *     so it reports the dir's own login. `api_key` still refuses there, since
 *     a key already in force outranks the helper. Any other `apiKeyHelper` in
 *     `settings` refuses, whatever the dir reports.
 * A seat file that refuses declares no overflow seat.
 * Everything else refuses: `api_key`, `api_key_helper`, `third_party` (a
 * CLAUDE_CODE_USE_* provider; ANTHROPIC_PROFILE and the rest reach it through
 * `auth status`), `none`, and a status that will not read. ANTHROPIC_BASE_URL
 * refuses before the read, since `auth status` does not report it.
 *
 * KNOWN LIMIT: it judges the environment the launch site hands over. A
 * background supervisor started earlier with a key in its own environment,
 * such as the daemon a `claude --bg` hands its session to, is not seen from
 * the dispatch site.
 *
 *   node scripts/lib/launch-auth.js   checks this process's own launch, for
 *     a shell or spawning caller: exits 0 silent, or 2 printing `REFUSED:`
 *     and why.
 */

const { spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { claudeBin } = require("./claude-bin.js");
const { secretsFile } = require("./env-file.js");
const { buildKeyHelper } = require("./overflow-key.js");
const { readDeclaredSeats, seatOfLaunch } = require("./refill-seats.js");
const { writeFd } = require("./write-fd.js");

/* Untraced: `auth status` answers in ~0.4 s idle; CLI starts on a loaded
 * machine have taken several seconds. */
const STATUS_TIMEOUT_MS = 30_000;

const RULE =
	"a workflow-core model launch bills the subscription seat, never per token (#2236)";

/* A provider flag at one of these reads off; `0` measured, the rest
 * untraced. */
const OFF = ["0", "false", "no", "off"];

/**
 * @param {string|undefined} v
 * @returns {v is string}
 */
const isSet = (v) => v !== undefined && v !== "";

/**
 * Why `auth status` could not be read, or its parsed JSON.
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {{why: string}|{status: {authMethod?: string, apiProvider?: string}}}
 */
function readAuthStatus(bin, env, cwd) {
	const r = spawnSync(bin, ["auth", "status", "--json"], {
		env,
		cwd,
		encoding: "utf8",
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
 * The `apiKeyHelper` the launch's `--settings` sets, null where it sets none,
 * or why it cannot be read: `claude` takes a `--settings` that is not JSON as
 * a file path, whose helper this guard would never see.
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
 * Whether `helper` is lib/overflow-key.js's helper for an overflow seat
 * declared on the launch's config dir.
 * @param {unknown} helper
 * @param {NodeJS.ProcessEnv} env
 */
function isSeatHelper(helper, env) {
	const dir = env.CLAUDE_CONFIG_DIR;
	if (typeof helper !== "string" || !isSet(dir)) return false;
	const list = readDeclaredSeats();
	if (list.errors.length > 0) return false;
	const file = secretsFile();
	return list.seats.some(
		(s) =>
			s.kind === "overflow" &&
			helper === buildKeyHelper(s.keyVar, file) &&
			!("why" in seatOfLaunch(list, { dir, keyVar: s.keyVar })),
	);
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
			const flags = Object.keys(env).filter(
				(k) =>
					k.startsWith("CLAUDE_CODE_USE_") &&
					isSet(env[k]) &&
					!OFF.includes(String(env[k]).toLowerCase()),
			);
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
 * Why a model launch of `bin` under `env` in `cwd` would not bill the
 * subscription, or null where it would.
 * @param {{bin: string, env: NodeJS.ProcessEnv, cwd: string,
 *   settings?: string}} launch `settings`: the JSON the launch passes as
 *   `--settings`
 * @returns {string|null}
 */
function launchAuthRefusal({ bin, env, cwd, settings }) {
	const refused = (/** @type {string} */ why) =>
		`this model launch would not bill the subscription: ${why}. Rule: ${RULE}. Unset what set it, or launch from a shell without it.`;
	if (isSet(env.ANTHROPIC_BASE_URL))
		return refused("ANTHROPIC_BASE_URL is set");
	const parsed = parseSettingsHelper(settings);
	if ("why" in parsed) return refused(parsed.why);
	const { helper } = parsed;
	const seatHelper = helper !== null && isSeatHelper(helper, env);
	if (helper !== null && !seatHelper)
		return refused(
			"an apiKeyHelper in --settings is in force, and is no declared overflow seat's on this config dir",
		);
	const read = readAuthStatus(bin, env, cwd);
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

module.exports = { launchAuthRefusal };
