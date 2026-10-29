/*
 * The environment of a session start for a script under test (#3707): an
 * interactive one, or a background job's where `jobDir` names one. Every
 * variable lib/background-start.js reads is set, so a suite run inside a
 * background job tests the same start as one run in a terminal or CI.
 */
export const startEnv = (jobDir = "") => ({
	CLAUDE_JOB_DIR: jobDir,
	CLAUDE_CODE_ENTRYPOINT: "cli",
});
