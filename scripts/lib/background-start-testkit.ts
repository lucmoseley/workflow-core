import fs from "node:fs";
import path from "node:path";

export const buildStartEnv = (jobDir = "") => ({
	CLAUDE_JOB_DIR: jobDir,
	CLAUDE_CODE_ENTRYPOINT: "cli",
});

export const writeJobRecord = (
	jobDir: string,
	template: string,
	fields: Record<string, unknown> = {},
) => {
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "state.json"),
		JSON.stringify({ ...fields, template }),
	);
	return jobDir;
};
