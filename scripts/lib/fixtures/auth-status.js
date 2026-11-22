const fs = require("node:fs");
const path = require("node:path");

const env = process.env;
const isSet = (/** @type {string|undefined} */ v) =>
	v !== undefined && v !== "";
const OFF = ["0", "false", "no", "off"];

/** @param {string} file */
function hasHelper(file) {
	try {
		return "apiKeyHelper" in JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return false;
	}
}

const provider = ["BEDROCK", "VERTEX", "FOUNDRY"].find((p) => {
	const v = env[`CLAUDE_CODE_USE_${p}`];
	return isSet(v) && !OFF.includes(String(v).toLowerCase());
});
const helper = [
	path.join(process.cwd(), ".claude", "settings.json"),
	path.join(process.cwd(), ".claude", "settings.local.json"),
	...(isSet(env.CLAUDE_CONFIG_DIR)
		? [
				path.join(
					/** @type {string} */ (env.CLAUDE_CONFIG_DIR),
					"settings.json",
				),
			]
		: []),
].some(hasHelper);

const PRECEDENCE = /** @type {[boolean, string][]} */ ([
	[provider !== undefined, "third_party"],
	[isSet(env.ANTHROPIC_AUTH_TOKEN), "oauth_token"],
	[helper, "api_key_helper"],
	[isSet(env.ANTHROPIC_API_KEY), "api_key"],
	[isSet(env.CLAUDE_CODE_OAUTH_TOKEN), "oauth_token"],
	[!isSet(env.WFC_FAKE_AUTH_NO_LOGIN), "claude.ai"],
	[true, "none"],
]);
const authMethod = PRECEDENCE.find(([holds]) => holds)?.[1];

process.stdout.write(
	`${JSON.stringify({
		loggedIn: authMethod !== "none",
		authMethod,
		apiProvider: provider ? provider.toLowerCase() : "firstParty",
	})}\n`,
);
process.exit(authMethod === "none" ? 1 : 0);
