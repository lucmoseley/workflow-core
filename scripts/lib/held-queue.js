/*
 * held-queue.js — the one issue the lander keeps open while it holds the
 * landing queue (#2406, spec #2261), `takes:implement`.
 *
 * Found by its fixed title among the open issues. Residual: a retitled open
 * issue is not found, and the next hold files a second.
 */

const { firstLine } = require("./first-line.js");
const { short } = require("./lander.js");
const { takesLabel } = require("./takes-label.js");

const TITLE = "Landing queue held: the lander cannot clear a batch";

/** @param {string[]} files */
const failingList = (files) =>
	files.length > 0
		? files.map((f) => `- \`${f}\``).join("\n")
		: "- the whole suite (the tester named no failing file)";

/**
 * @param {import("./lander.js").Held} h
 * @returns {string}
 */
function heldQueueBody({ batch, reason, files }) {
	return `## What to build

The lander (#2261) holds the landing queue: nothing on \`landing\` reaches \`main\` until this clears.

- Batch: ${batch === null ? "(none read)" : `\`${batch}\``}
- Reason: ${reason.replaceAll("`", "'")}

Failing:
${failingList(files)}

## Acceptance criteria

- [ ] A commit pushed to \`landing\` fixes or reverts what holds the batch, and the lander lands the new tip on \`main\`.
`;
}

/**
 * @typedef {object} HeldQueueDeps
 * @property {(title: string) => number|null} openNumber the open issue with
 *   exactly `title`, throwing where the tracker cannot be read
 * @property {(title: string) => {number: number}[]} similar
 * @property {(args: string[], input: string) =>
 *   import("./fix-ticket.js").Ran} fileIssue
 * @property {(n: number, body: string) => string} refresh replaces the
 *   issue's body where it differs, returning what it did
 */

/**
 * @param {HeldQueueDeps} deps
 * @returns {Pick<import("./lander.js").LanderTracker, "holdQueue">}
 */
function heldQueueFiler({ openNumber, similar, fileIssue, refresh }) {
	return {
		holdQueue(h) {
			const body = heldQueueBody(h);
			const open = openNumber(TITLE);
			if (open !== null) return refresh(open, body);
			const listed = similar(TITLE);
			const ran = fileIssue(
				[
					"--title",
					TITLE,
					"--label",
					takesLabel("implement"),
					"--label",
					"kind:ticket",
					"--standalone",
					"The held-queue issue tracks the landing queue, not one ticket's work.",
					...(listed.length > 0
						? ["--distinct-from", listed.map((c) => c.number).join(",")]
						: []),
					"--body-file",
					"-",
				],
				body,
			);
			if (ran.status === 0) return ran.stdout.trim();
			throw new Error(
				`file-issue refused it for ${h.batch === null ? "the queue" : short(h.batch)}: ${firstLine(ran.stderr)}`,
			);
		},
	};
}

module.exports = { heldQueueFiler };
