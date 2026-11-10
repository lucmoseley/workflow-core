/*
 * A fake of GitHub's run-list and issue-comment endpoints for the
 * off-machine alarm relay's tests (#4939), behind lib/actions-api.js's
 * get/post port. A post appends a comment stamped `clock` hours before NOW,
 * so a later relay run reads it back.
 */

export const NOW = Date.parse("2026-11-10T12:00:00Z");
export const at = (hoursAgo: number) =>
	new Date(NOW - hoursAgo * 3_600_000).toISOString();

export type Conclusion = "success" | "failure" | "cancelled";
/* One alarm's finished runs, newest first: [conclusion, hours ago]. */
export type Runs = [Conclusion, number][];
export type AlarmFile = "landing-quiet.yml" | "main-lag.yml";
export interface Comment {
	created_at: string;
	body: string;
	user: { login: string };
}

export const fakeGitHub = (code: string, tracker: string, issue: number) => {
	const runs: Partial<Record<AlarmFile, Runs>> = {};
	const comments: Comment[] = [];
	const state = { runs, comments, clock: 0 };
	const commentsPath = `/repos/${tracker}/issues/${issue}/comments`;
	const get = async (p: string): Promise<unknown> => {
		const r = new RegExp(
			`^/repos/${code}/actions/workflows/([\\w.-]+)/runs\\?branch=main&status=completed&per_page=100$`,
		).exec(p);
		if (r)
			return {
				workflow_runs: (runs[r[1] as AlarmFile] ?? []).map(
					([conclusion, h], i) => ({
						id: i + 1,
						conclusion,
						updated_at: at(h),
						html_url: `https://github.com/${code}/actions/runs/${i + 1}`,
					}),
				),
			};
		const c = new RegExp(
			`^${commentsPath}\\?per_page=100&page=1(?:&since=([^&]+))?$`,
		).exec(p);
		if (c) {
			const since =
				c[1] === undefined
					? Number.NEGATIVE_INFINITY
					: Date.parse(decodeURIComponent(c[1]));
			return comments.filter((x) => Date.parse(x.created_at) >= since);
		}
		throw new Error(`unstubbed ${p}`);
	};
	const post = async (p: string, body: unknown): Promise<unknown> => {
		if (p !== commentsPath) throw new Error(`unstubbed post ${p}`);
		comments.push({
			created_at: at(state.clock),
			body: (body as { body: string }).body,
			user: { login: "github-actions[bot]" },
		});
		return {};
	};
	return { state, get, post };
};
