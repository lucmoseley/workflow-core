import path from "node:path";
import base from "../../vitest.config";

const ROOT = path.resolve(__dirname, "../..");

export default {
	...base,
	root: ROOT,
	test: {
		...base.test,
		setupFiles: [
			...((base.test?.setupFiles as string[]) ?? []),
			`${ROOT}/scripts/census/git-spawn-wrapper.setup.ts`,
		],
		reporters: ((base.test?.reporters ?? []) as unknown[]).filter(
			(r) => !(typeof r === "string" && r.includes("vitest-pass-reporter")),
		),
	},
};
