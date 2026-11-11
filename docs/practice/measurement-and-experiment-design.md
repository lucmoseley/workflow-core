# measurement-and-experiment-design

Researched: 2026-11-10

## Window size

- Size the window by a count of independent events, not by the clock: "The higher the processing rate, the less time is required to get a representative sample", and a canary ended "after receiving just a handful of queries doesn't provide a useful signal". SRE Workbook, "Canarying Releases"; "Alerting on SLOs" §Low-traffic services [named expert]; Spinnaker canary best practices (at least 50 data points per metric) [named expert]
- Add a time floor only where the rate depends on time, and name the cycle: one work unit (SRE Workbook), a full week for day-of-week effects, longer for novelty or learning effects. Li and Yu, "Setting the duration of online A/B experiments", arXiv 2408.02830 (2024); Deng, "Causal Inference and Its Applications in Online Industry" ch. 7 [named expert]. Kohavi, Tang and Xu (2020) is paywalled, unread.
- Tools set the window in time and do not check the count in it: Flagger minimum time `interval * (maxWeight / stepWeight)`; Argo Rollouts `count` x `interval`; Spinnaker lifetime and interval (start 3 h by 1 h); Kayenta judges each metric by Mann-Whitney U at `confLevel = 0.98`. Each for its own product [standard or field body]

## Zero-event bounds

- For a zero-event check, size n from the exact binomial bound: 0 events in n trials bounds the rate below p at confidence C when n >= ln(1 - C) / ln(1 - p), about 3/p at 95% (the rule of three) and 2.3/p at 90%. Eypasch et al., BMJ 1995;311:619 [named expert]; NIST/SEMATECH e-Handbook §7.2.4.1 (exact interval for few failures) and §8.3.1.1 (zero-failure factor 3.00 at 95%) [standard or field body]. Hanley and Lippman-Hand, JAMA 1983, is paywalled, unread.
- The bound holds only for independent trials at one rate. Attempts in bursts from one cause count as fewer trials. NIST e-Handbook §8.3.1.1 ("constant failure rate") [standard or field body]
- A plan that fails at the first event can fail a good fix: at n = 3/p a fix whose true rate is p passes only 5% of the time. Where a good fix must pass, allow r failures and take the longer n. NIST e-Handbook §8.3.1.1 ("iterate on r") [standard or field body]

## Stopping rules

- Fix the sample size and the stopping rule before the window starts. A look that is not planned inflates false positives ("peek ... ten times" turns 1% into 5%). Miller, "How Not To Run an A/B Test" [named expert]
- To stop early with a pass, use a sequential test fixed in advance: a group sequential test where the maximum n is known, an always-valid test (mSPRT) where it is not. Johari, Pekelis and Walsh, "Always Valid Inference", arXiv 1512.04922; Spotify Engineering, "Choosing a Sequential Testing Framework" (2023); Miller, "Simple Sequential A/B Testing" (2015) [named expert]
- Stop early with a fail at the first failure the plan does not allow: Argo `failureLimit`, Flagger `threshold`, a Spinnaker critical metric. Each for its own product [standard or field body]
- Extend only by a planned maximum (truncate a sequential plan at about three times the fixed-plan n) or by a human decision on an inconclusive result, which then gives up the stated confidence. NIST e-Handbook §6.2.6 [standard or field body]; Argo Rollouts (Inconclusive pauses for a human), for its own product [standard or field body]

## Controls and the stated plan

- Compare against a control in the same period where one exists; a before/after window is weaker, because "time is one of the biggest sources of change in observed metrics". SRE Workbook, "Canarying Releases"; Spinnaker (baseline deployed at the same time) [named expert]
- A defended window states the question, the baseline as k/N with its source, the target bound, the confidence, the method, the resulting n with its expected time at the observed rate, and the stopping rule. Full survey: #4926.
