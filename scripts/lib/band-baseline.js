// measured, #487
const BAND_BASELINE = {
	overlapShare: 39 / 170,
	medianHalfWidth: 10,
	questions: 1682,
	band: 170,
	window: "13–27 Sep 2026",
	date: "27 Sep 2026",
};

// guess, #487
const MIN_BAND_SAMPLE = 100;

const TOP_BASELINE = {
	atLine: 527,
	passingTops: 1817,
	window: "5–19 Oct 2026",
};

// guess, #2260
const MIN_TOP_SAMPLE = 300;

module.exports = {
	BAND_BASELINE,
	MIN_BAND_SAMPLE,
	TOP_BASELINE,
	MIN_TOP_SAMPLE,
};
