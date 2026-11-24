const PARENT_WAIT =
	"the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845)";

const SUBAGENT_WAIT =
	"wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it.";

const WAIT_SLOT = "@WAIT@";

// guess, #5712: one notification turn's tokens against the seconds a session sits blocked
const SNAPSHOT_RUN_TIMEOUT_MS = 30_000;

/** @param {string} template @param {string} wait */
const withWait = (template, wait) => template.replace(WAIT_SLOT, () => wait);

module.exports = {
	PARENT_WAIT,
	SNAPSHOT_RUN_TIMEOUT_MS,
	SUBAGENT_WAIT,
	WAIT_SLOT,
	withWait,
};
