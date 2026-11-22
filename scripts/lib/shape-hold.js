/*
 * shape-hold.js — what the close-rivals and round-check limbs say where they
 * hold the shape of a question they refused, the shape limb being silent that
 * turn (workflow-core#1730, workflow-core#1742). One copy, so the two limbs' wording cannot drift.
 */

const { RESEND_ONLY, lastRefusal } = require("./refusal-limb");

/**
 * The guard's shape check, passed in since a lib cannot require the guard
 * program.
 * @typedef {(block: {number: string, lines: string[]}) => string[]} ShapeFaults
 */

/**
 * One refused question's line in a limb's refusal: `shape`, its shape faults;
 * `shapeOnly`, whether shape alone refuses it. Built only here, by
 * `buildRuleFlag` and `buildMisshapenFlag`.
 * @typedef {{ line: string, shape: string[], shapeOnly: boolean }} Flag
 */

/**
 * The flag of a question the limb's own rule refuses, its shape faults
 * appended.
 * @param {string} line the rule's line for it
 * @param {string[]} shape its shape faults
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
 * The flag of a refused question re-sent still misshapen.
 * @param {string} round
 * @param {string[]} shape its shape faults
 * @returns {Flag}
 */
const buildMisshapenFlag = (round, shape) => ({
	line: `Q${round}: re-sent since this check refused it, its shape still wrong: ${shape.join("; ")}.`,
	shape,
	shapeOnly: true,
});

/** @param {Flag[]} flags */
const isMisshapen = (flags) => flags.some((flag) => flag.shape.length > 0);

/* The paragraph a refusal short of its last carries where a flag its limb's
 * rule refuses also names a shape fault. */
const SHAPE_HELD =
	"The shape check is silent this turn, so this check holds a question's " +
	"shape where it names it wrong: that question passes only once its shape " +
	"is right.";

/**
 * The refusal where every flag holds a re-send on shape alone, which owes none
 * of the limb's own rule; null where one does.
 * @param {Flag[]} flags
 * @param {boolean} isLastRefusal whether this refusal spends the limb's cap
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
