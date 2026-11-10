/*
 * drop-evidence.js — why the queue lander dropped a member, as text: the one
 * builder its fix ticket's body and the owning session's landing status both
 * read (#4950, spec #4947), so the two never say different things of a drop.
 */

const { QUEUE_PREFIX } = require("./landing-refs.js");

/** @param {readonly string[]} files */
const buildFileList = (files) => files.map((f) => `- \`${f}\``).join("\n");

/* A gate's output, fenced so no reader takes it for the text around it, its
 * backtick runs broken so none closes the fence. */
const quoteBlock = (/** @type {string} */ text) =>
	`\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\``;

const NO_RUN =
	"no CI run fired for this tree, twice, where `main` passes, so its workflow's push triggers likely miss the lander's `lander/*` refs";

/**
 * @param {Pick<import("./lander-records.js").Drop, "onto" | "cause">} d
 * @returns {string}
 */
function buildDropEvidence({ onto, cause }) {
	const alone = `merged alone onto \`main\` at ${onto}`;
	switch (cause.kind) {
		case "conflict":
			return `${alone}, it conflicts with \`main\` in:\n${buildFileList(cause.files)}`;
		case "refused":
			return `${alone}, its merge was refused, the refusal ending:\n\n${quoteBlock(cause.reason)}`;
		case "red":
			return `${alone} as ${cause.iso}, ${cause.noRun ? NO_RUN : `it failed ${cause.files.length > 0 ? `these files twice, which pass on \`main\` there:\n${buildFileList(cause.files)}` : "the whole suite twice, naming no file, where `main` passes it"}`}`;
		case "unrecorded":
			return `why is unknown, as the lander's drop record lost its entry; its commits are read off \`main\` at ${onto}`;
		case "collision": {
			const after = cause.after.map((n) => `\`${QUEUE_PREFIX}${n}\``);
			const failed =
				cause.files.length > 0
					? `failed twice:\n${buildFileList(cause.files)}`
					: "failed the whole suite twice, naming no file";
			return `each member of its batch passed alone, but merged onto \`main\` at ${onto}${after.length > 0 ? ` after ${after.join(", ")} landed,` : ""} as ${cause.step}, ${cause.noRun ? NO_RUN : `it ${failed}`}`;
		}
	}
}

module.exports = { buildDropEvidence, buildFileList };
