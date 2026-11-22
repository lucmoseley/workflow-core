import path from "node:path";
import type { TreePorts } from "./guard-host-ports.js";
import { relativeUnder } from "./is-under.js";

export function treePortsFake(
	files: Record<string, string | Error>,
	over: Partial<Pick<TreePorts, "git">> = {},
): TreePorts {
	return {
		root: "/repo",
		git: () => ({ ok: true, out: "" }),
		repoRel: (f) =>
			path.isAbsolute(f) ? relativeUnder("/repo", f) || null : null,
		read: (rel) => {
			const got = files[rel];
			if (got === undefined) return { state: "absent" };
			if (got instanceof Error)
				return { state: "unreadable", error: got, message: got.message };
			return { state: "read", data: got };
		},
		...over,
	};
}
