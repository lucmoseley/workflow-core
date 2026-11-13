/*
 * file-issue's link fake (#5150): what lib/file-issue-host.js's `link`
 * answers for the link of `child` under `parent` on file-issue's gh fake; a
 * landing link warns, since the fake's reads never reach the child.
 * file-issue-link.contract.test.ts holds every answer to the real adapter.
 */

/**
 * @param postErr  the POST's stderr, or null where it lands
 */
export function answerLink(
	parent: number,
	child: number,
	postErr: string | null,
): { ok: string; warning?: string } | { error: string } {
	if (postErr === null)
		return {
			ok: `linked #${child} as a sub-issue of #${parent}`,
			warning: `warning — the loop check was partial: could not read #${child} (HTTP 404: Not Found); linking anyway, and check-issue-cycles.js is the backstop.`,
		};
	if (/7 layers/.test(postErr))
		return {
			error: `#${parent} is 7 layers deep — give #${child} the SAME parent as #${parent} instead, and say in its body why it is a peer (docs/agents/issue-tracker.md)`,
		};
	return { error: `POST failed: ${postErr.trim()}` };
}
