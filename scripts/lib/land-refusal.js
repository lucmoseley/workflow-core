const {
	FETCH_FIRST,
	NON_FAST_FORWARD,
	REJECTED,
} = require("./divergence-row.js");
const { escapeRe } = require("./regex-group.js");

const MOVED = new RegExp(
	`${escapeRe(REJECTED)}[^\\n]*\\((?:${escapeRe(FETCH_FIRST)}|${escapeRe(NON_FAST_FORWARD)})\\)`,
);

const MOVED_LINE =
	"the push is no fast-forward: your queue ref holds a commit HEAD lacks, so HEAD was rewritten after a push";

module.exports = { MOVED, MOVED_LINE };
