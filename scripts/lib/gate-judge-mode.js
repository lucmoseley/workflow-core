/*
 * gate-judge-mode.js — the gate judge's launch (#4964): the answer's schema
 * and the flags claude-child.js's `judge` mode passes, which
 * record-gate-judge-reply.js re-reads to record the installed binary's side.
 */

const WAIT_ON = /** @type {const} */ (["time", "data"]);
const BASIS_CLASSES = /** @type {const} */ ([
	"derived",
	"inherited",
	"restated",
	"asserted",
]);

/* The answer `--json-schema` holds the child to. */
const JUDGE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["waits", "bases"],
	properties: {
		waits: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["sentence", "on", "window", "basisNamesWindow"],
				properties: {
					sentence: { type: "string" },
					on: { enum: WAIT_ON },
					window: { type: "string" },
					basisNamesWindow: { type: "boolean" },
				},
			},
		},
		bases: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["basis", "class"],
				properties: {
					basis: { type: "string" },
					class: { enum: BASIS_CLASSES },
				},
			},
		},
	},
};

/*
 * No tools, no setting sources (so no plugin and none of its hooks), no MCP
 * server, no slash command and no transcript; the prompt arrives on stdin.
 */
const JUDGE_ARGS = [
	"-p",
	"--model",
	"haiku",
	"--tools",
	"",
	"--setting-sources",
	"",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--no-session-persistence",
	"--output-format",
	"json",
	"--json-schema",
	JSON.stringify(JUDGE_SCHEMA),
];

module.exports = { BASIS_CLASSES, JUDGE_ARGS, JUDGE_SCHEMA, WAIT_ON };
