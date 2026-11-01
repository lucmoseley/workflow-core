/*
 * background-start.js — whether this session start is a background job's,
 * whether a founder notice waits past it (#3707, #3772), and whether a job
 * record is his own launch, which lib/founder-typing.js reads too (#3783).
 *
 * FOUNDER_NOTICES are the once-a-day notices for the founder held back at a
 * start no one is watching, by the producer and by the replay alike, through
 * isFounderNoticeHeld: a notice's delivery stamp is per machine, and with
 * the refill loop launching about 120 jobs a day, a job would otherwise spend
 * it almost every day before his own session started.
 *
 * BACKGROUND: `CLAUDE_JOB_DIR` set, as in every `claude --bg` job, or a
 * print-mode run (`CLAUDE_CODE_ENTRYPOINT` `sdk-cli`, `claude -p`).
 *
 * HIS OWN JOB: the job's state.json reads a `template` other than `bg`. The
 * agents view launches through `--agent claude`, which the harness records as
 * `claude`; every dispatcher and refill-loop launch is a plain `claude --bg`,
 * recorded as `bg` (#3772; read at the hook on 2.1.316). The field is the
 * harness's own and undocumented. A record that will not read, or carries no `template`,
 * holds; `npm run status` still shows the idle alarm. RESIDUAL: were the harness
 * to rename `bg`, every loop job would spend his stamp.
 *
 * A WAKE IS NOT HIS LAUNCH: `claude --bg --resume` wakes his job in place, its
 * template still `claude`, its `SessionStart` source `resume` (measured on
 * 2.1.316), and the refill loop wakes a parked job whoever launched it (#3709).
 * So a job's `resume` holds, his own included.
 *
 * BLIND SPOT: he types `claude --bg` himself: held, as a dispatcher's is.
 */

const { readJobRecordIn } = require("./job-paths.js");

/** @param {NodeJS.ProcessEnv} env */
const isPrintMode = (env) => env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli";

/** @param {NodeJS.ProcessEnv} env */
const isBackgroundStart = (env) =>
	Boolean(env.CLAUDE_JOB_DIR) || isPrintMode(env);

/**
 * Whether a job record is one the founder launched from the agents view. No
 * readable record proves nothing of his (#3772).
 * @param {ReturnType<typeof readJobRecordIn>} record
 */
function isHisJobRecord(record) {
	const template = record?.template;
	return typeof template === "string" && template !== "bg";
}

/**
 * Whether this job is his own. False for a print-mode run inside his job,
 * which inherits `CLAUDE_JOB_DIR`.
 * @param {NodeJS.ProcessEnv} env
 */
function isHisOwnJob(env) {
	const jobDir = env.CLAUDE_JOB_DIR;
	if (!jobDir || isPrintMode(env)) return false;
	return isHisJobRecord(readJobRecordIn(jobDir));
}

const FOUNDER_NOTICES = new Set(["idle-efforts", "refill-loop-stop"]);

/**
 * Whether this start holds back the founder notice `checker` reports: a
 * compaction, or a background start that is not his job's own launch.
 * @param {string} checker
 * @param {string} [source] the hook payload's, where a caller read it
 * @param {NodeJS.ProcessEnv} [env]
 */
const isFounderNoticeHeld = (checker, source, env = process.env) => {
	if (!FOUNDER_NOTICES.has(checker)) return false;
	if (source === "compact") return true;
	return isBackgroundStart(env) && (source === "resume" || !isHisOwnJob(env));
};

/** What a `--notify` founder notice ends on: `SessionStart` stdout reaches the model. */
const RELAY_LINE =
	"Tell the founder this in your next reply: it reaches only you.";

/** @param {boolean} notifying */
const relayLines = (notifying) => (notifying ? [RELAY_LINE] : []);

module.exports = {
	isHisJobRecord,
	isFounderNoticeHeld,
	relayLines,
};
