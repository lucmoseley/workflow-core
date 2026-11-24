const { RESEND_ONLY, lastRefusal } = require("./refusal-limb");

/** @typedef {(block: {number: string, lines: string[]}) => string[]} ShapeFaults */

/** @typedef {{ line: string, shape: string[], shapeOnly: boolean }} Flag */

/**
 * @param {string} line
 * @param {string[]} shape
 * @returns {Flag}
 */
const buildRuleFlag = (line, shape) => ({
	line:
		shape.length > 0
			? `${line} Its shape is wrong too: ${shape.join("; ")}.`
			: line,
	shape,
	shapeOnly: false,
});

/**
 * @param {string} round
 * @param {string[]} shape
 * @returns {Flag}
 */
const buildMisshapenFlag = (round, shape) => ({
	line: `Q${round}: re-sent since this check refused it, its shape still wrong: ${shape.join("; ")}.`,
	shape,
	shapeOnly: true,
});

/** @param {Flag[]} flags */
const isMisshapen = (flags) => flags.some((flag) => flag.shape.length > 0);

const SHAPE_HELD =
	"The shape check is silent this turn, so this check holds a question's " +
	"shape where it names it wrong: that question passes only once its shape " +
	"is right.";

/**
 * @param {Flag[]} flags
 * @param {boolean} isLastRefusal
 * @returns {string | null}
 */
const buildShapeOnlyReason = (flags, isLastRefusal) =>
	flags.every((flag) => flag.shapeOnly)
		? [
				"This turn re-sends a question this check refused with its shape " +
					"still wrong. The shape check is silent this turn, so this check " +
					"refuses it on shape:",
				flags.map((flag) => flag.line).join("\n"),
				isLastRefusal
					? lastRefusal("", true)
					: "It passes on its next send once its shape is right.",
				RESEND_ONLY,
			].join("\n\n")
		: null;

module.exports = {
	SHAPE_HELD,
	isMisshapen,
	buildRuleFlag,
	buildMisshapenFlag,
	buildShapeOnlyReason,
};
