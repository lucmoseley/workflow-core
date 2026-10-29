/*
 * open-children.js — the refusal of a close that leaves a sub-issue open
 * (#3637). One module, because guard-issue-close, resolve-ticket.js and
 * promote-spec.js each refuse that close, and three copies would drift.
 */

/**
 * @typedef {{ number: string, title: string, url: string, open: boolean }}
 *   Child `url` its html URL
 */

/**
 * The refusal over `kids`' open ones, cited `#N` beside a parent in its own
 * repository, else `owner/repo#N`; "" where none is open.
 * @param {string} n
 * @param {string} home the parent repository's issues URL, ending `/issues/`
 * @param {Child[]} kids
 */
function openChildrenRefusal(n, home, kids) {
	const children = kids
		.filter((k) => k.open)
		.map((k) => ({
			ref: k.url.startsWith(home)
				? `#${k.number}`
				: k.url.replace(
						/^https:\/\/github\.com\/(.*)\/issues\/([0-9]+)$/,
						"$1#$2",
					),
			title: k.title,
		}));
	if (children.length === 0) return "";
	return `#${n} has ${children.length} open sub-issue${children.length === 1 ? "" : "s"}:
${children.map((c) => `  - ${c.ref} (${c.title})`).join("\n")}

A parent closes only once every child has — pick-next passes its urgent, bug and goal tiers to its open children, which lose them the moment it closes. Either leave #${n} open, labelled takes:children (scripts/retire-stale-containers.js moves it to takes:triage when the last child closes), or close each child first. A not-planned close is refused the same way.`;
}

module.exports = { openChildrenRefusal };
