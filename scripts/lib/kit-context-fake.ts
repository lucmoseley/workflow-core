/*
 * The one fake of lib/kit-context.js's KitContext, the context `run` and the
 * dispatcher hand every core, held to the kit's own by
 * lib/kit-context.contract.test.ts (#3018).
 */

import { fakeTreeClassifier } from "./git-tree-fake.js";
import type { KitContext } from "./kit-context.js";
import { readRuleText } from "./rule-text.js";

/**
 * A core's module-case context: every port the kit hands a core, `over` laid
 * on top.
 */
export function kitContextFake<P extends object = object>(
	over: Partial<KitContext> & P = {} as P,
): KitContext & P {
	return {
		cwd: undefined,
		fallbackCwd: "/repo",
		vars: {},
		isDir: () => false,
		moduleOn: () => false,
		treeClass: fakeTreeClassifier({}),
		log: () => undefined,
		told: () => false,
		readLatch: () => null,
		input: {},
		tool: "Bash",
		response: undefined,
		key: { agent: "main", sid: "s-fake" },
		agent: "",
		agentLabel: "main",
		permissionMode: undefined,
		ruleText: readRuleText,
		corePaths: (text) => text,
		scriptPath: (name) => `scripts/${name}`,
		docPath: (name) => `docs/${name}`,
		...over,
	};
}
