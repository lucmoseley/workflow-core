const REPLAY_MARKERS = [
	/marked over cap by ruling grew in/,
	/look like an over-cap marker but do not parse as one:$/,
	/lost the marker the baseline carried:$/,
];

const UNTRACKED_BLOCKS = [
	{
		marker: /register entr.* not yet tracked by git:$/,
		noun: "Section A row(s)",
		fix: "name the file in this commit's pathspec too, or drop the row until it lands.",
	},
	{
		marker: /Section C route path.* not yet tracked by git:$/,
		noun: "Section C route(s)",
		fix: "name the file in this commit's pathspec too, or drop the route until it lands.",
	},
];

module.exports = { REPLAY_MARKERS, UNTRACKED_BLOCKS };
