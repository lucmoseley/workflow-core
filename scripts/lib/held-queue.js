/*
 * held-queue.js — the one issue the lander keeps open while it holds the
 * landing queue (workflow-core#2406, spec workflow-core#2261), filed as lib/queue-issue.js files it.
 */

const { short } = require("./lander.js");
const { failingList, queueIssueFiler } = require("./queue-issue.js");

const TITLE = "Landing queue held: the lander cannot clear a batch";

/**
 * @param {import("./lander.js").Held} h
 * @returns {string}
 */
function buildHeldQueueBody({ batch, reason, files }) {
	return `## What to build

The lander (workflow-core#2261) holds the landing queue: nothing on \`landing\` reaches \`main\` until this clears.

- Batch: ${batch === null ? "(none read)" : `\`${batch}\``}
- Reason: ${reason.replaceAll("`", "'")}

Failing:
${failingList(files)}

## Acceptance criteria

- [ ] A commit pushed to \`landing\` fixes or reverts what holds the batch, and the lander lands the new tip on \`main\`.
`;
}

/**
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @returns {Pick<import("./lander.js").LanderTracker, "holdQueue">}
 */
function heldQueueFiler(deps) {
	const file = queueIssueFiler(deps);
	return {
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
