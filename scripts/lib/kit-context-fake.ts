import { fakeTreeClassifier } from "./git-tree-fake.js";
import type { KitContext } from "./kit-context.js";
import { readRuleText } from "./rule-text.js";

export function kitContextFake<P extends object = object>(
	over: Partial<KitContext> & P = {} as P,
): KitContext & P {
	return {
		cwd: undefined,
		fallbackCwd: "/repo",
		vars: {},
		isDir: () => false,
		statKind: () => "absent",
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
