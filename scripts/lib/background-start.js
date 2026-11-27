const {
	isBackgroundJob,
	readJobDir,
	readJobRecordIn,
} = require("./job-paths.js");

/** @param {NodeJS.ProcessEnv} env */
const isPrintMode = (env) => env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli";

/** @param {NodeJS.ProcessEnv} env */
const isBackgroundStart = (env) => isBackgroundJob(env) || isPrintMode(env);

/** @param {ReturnType<typeof readJobRecordIn>} record */
function isHisJobRecord(record) {
	const template = record?.template;
	return typeof template === "string" && template !== "bg";
}

/** @param {NodeJS.ProcessEnv} env */
function isHisOwnJob(env) {
	const jobDir = readJobDir(env);
	if (!jobDir || isPrintMode(env)) return false;
	return isHisJobRecord(readJobRecordIn(jobDir));
}

const FOUNDER_NOTICES = new Set(["idle-efforts", "refill-loop-stop"]);

/** @param {string} checker */
const isFounderNotice = (checker) => FOUNDER_NOTICES.has(checker);

/**
 * @param {string} checker
 * @param {string} [source]
 * @param {NodeJS.ProcessEnv} [env]
 */
const isFounderNoticeHeld = (checker, source, env = process.env) => {
	if (!isFounderNotice(checker)) return false;
	if (source === "compact") return true;
	return isBackgroundStart(env) && (source === "resume" || !isHisOwnJob(env));
};

module.exports = {
	isHisJobRecord,
	isFounderNotice,
	isFounderNoticeHeld,
};
