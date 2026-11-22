import fs from "node:fs";
import path from "node:path";

export const readGuardErrorsLog = (configDir: string): string => {
	const projects = path.join(configDir, "projects");
	if (!fs.existsSync(projects)) return "";
	return fs
		.readdirSync(projects)
		.map((p) => path.join(projects, p, "guard-errors.log"))
		.filter((f) => fs.existsSync(f))
		.map((f) => fs.readFileSync(f, "utf8"))
		.join("");
};
