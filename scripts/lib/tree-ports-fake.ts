import type { TreePorts } from "./guard-host-ports.js";

export function treePortsFake(
	files: Record<string, string | Error>,
	over: Partial<Pick<TreePorts, "git">> = {},
): TreePorts {
	return {
		root: "/repo",
		git: () => ({ ok: true, out: "" }),
		repoRel: (f) => f,
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
