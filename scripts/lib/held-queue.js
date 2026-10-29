/*
 * held-queue.js — the one issue the lander keeps open while it holds the
 * landing queue (#2406, spec #2261), filed as lib/queue-issue.js files it and
 * closed by the lander once `main` holds its batch (#3636).
 */

const { failingList, short } = require("./lander.js");
const { queueIssueCloser, queueIssueFiler } = require("./queue-issue.js");

const TITLE = "Landing queue held: the lander cannot clear a batch";
const BATCH_LINE = /^- Batch: `([0-9a-f]{40})`$/m;

/**
 * @param {import("./lander.js").Held} h
 * @returns {string}
 */
function buildHeldQueueBody({ batch, reason, failing }) {
	return `## What to build

The lander (#2261) holds the landing queue: nothing on \`landing\` reaches \`main\` until this clears.

- Batch: ${batch === null ? "(none read)" : `\`${batch}\``}
- Reason: ${reason.replaceAll("`", "'")}
${failing === null ? "" : `\nFailing:\n${failingList(failing)}\n`}
## Acceptance criteria

- [ ] A commit pushed to \`landing\` fixes or reverts what holds the batch, and the lander lands the new tip on \`main\`.
`;
}

/**
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @returns {Pick<import("./lander.js").LanderTracker, "holdQueue" | "releaseQueue">}
 */
function heldQueueFiler(deps) {
	const file = queueIssueFiler(deps);
	const close = queueIssueCloser(deps);
	return {
		/* A body naming no batch is closed on any move of `main`: nothing in
		 * it says what the move must pass. */
		releaseQueue: (sha, holds) => {
			const closed = close(TITLE, (body) => {
				const batch = BATCH_LINE.exec(body)?.[1];
				if (batch === undefined)
					return `The lander moved \`main\` to \`${sha}\`.`;
				return holds(batch)
					? `The lander moved \`main\` to \`${sha}\`, past the held batch \`${short(batch)}\`.`
					: null;
			});
			return closed === null ? null : `held-queue issue: closed #${closed}.`;
		},
		holdQueue: (h) =>
			file(
				{
					title: TITLE,
					standalone:
						"The held-queue issue tracks the landing queue, not one ticket's work.",
					noun: "held-queue issue",
					subject: h.batch === null ? "the queue" : short(h.batch),
				},
				buildHeldQueueBody(h),
			),
	};
}

module.exports = { heldQueueFiler };
