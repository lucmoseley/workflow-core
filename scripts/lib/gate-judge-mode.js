const WAIT_ON = /** @type {const} */ (["time", "data"]);
const BASIS_CLASSES = /** @type {const} */ ([
	"derived",
	"inherited",
	"restated",
	"asserted",
]);

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

const JUDGE_TIMEOUT_EXIT = /** @type {const} */ (124);

module.exports = { BASIS_CLASSES, JUDGE_ARGS, JUDGE_TIMEOUT_EXIT, WAIT_ON };
