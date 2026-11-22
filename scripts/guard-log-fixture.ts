import fs from "node:fs";
import { createRequire } from "node:module";
import { withStubbedEnv } from "./lib/scoped-env-testkit";

const { errorLog } = createRequire(import.meta.url)("./lib/arbiter-store.js");

const asChild = <T>(config: string, project: string, fn: () => T): T =>
	withStubbedEnv(
		{ CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project },
		fn,
	);

export const failOpenLogPath = (config: string, project: string): string =>
	asChild(config, project, () => errorLog());

export const readFailOpenLog = (config: string, project: string): string => {
	const at = failOpenLogPath(config, project);
	return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
};

export const readFailOpenRecords = (
	config: string,
	project: string,
): string[][] =>
	readFailOpenLog(config, project)
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
