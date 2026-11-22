import type { TreePorts } from "./guard-host-ports.js";
import { treeReads } from "./guard-host-ports.js";

export function treePortsFake(
	files: Record<string, string | Error>,
	over: Partial<TreePorts> = {},
): TreePorts {
	return {
		root: "/repo",
		git: () => ({ ok: true, out: "" }),
		repoRel: (f) => f,
		...treeReads((rel) => {
			const got = files[rel];
			if (got === undefined) return { state: "absent" };
			if (got instanceof Error)
				return { state: "unreadable", error: got, message: got.message };
			return { state: "read", data: got };
		}),
		...over,
	};
}
