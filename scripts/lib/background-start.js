/*
 * background-start.js — whether this session start is a background job's,
 * which no one is watching (#3707).
 *
 * FOUNDER_NOTICES are the once-a-day notices for the founder held back at
 * such a start, by the producer and by the replay alike, through
 * isHeldAtBackgroundStart: a notice's delivery stamp is per machine, and with the refill loop
 * launching about 120 jobs a day, a job would otherwise spend it almost every
 * day before his own session started.
 *
 * BACKGROUND: `CLAUDE_JOB_DIR` set, as in every `claude --bg` job, or a
 * print-mode run (`CLAUDE_CODE_ENTRYPOINT` `sdk-cli`, `claude -p`).
 *
 * BLIND SPOT: a session the founder launches from the agents view is a
 * background job too, and nothing on the job tells it from a dispatcher's
 * (lib/founder-typing.js), so the notice waits for his next terminal start.
 */

/** @param {NodeJS.ProcessEnv} [env] */
const isPrintMode = (env = process.env) =>
	env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli";

/** @param {NodeJS.ProcessEnv} [env] */
const isBackgroundStart = (env = process.env) =>
	Boolean(env.CLAUDE_JOB_DIR) || isPrintMode(env);

const FOUNDER_NOTICES = new Set(["idle-efforts", "refill-loop-stop"]);

/**
 * Whether this start holds back the notice `checker` reports.
 * @param {string} checker
 * @param {NodeJS.ProcessEnv} [env]
 */
const isHeldAtBackgroundStart = (checker, env = process.env) =>
	FOUNDER_NOTICES.has(checker) && isBackgroundStart(env);

module.exports = { isBackgroundStart, isHeldAtBackgroundStart };
