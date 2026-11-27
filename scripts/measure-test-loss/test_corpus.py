import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import corpus  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def test_a_root_that_will_not_list_is_skipped_and_counted(tmp_path, capsys):
    gone = str(tmp_path / "gone")
    tally = Counter()
    assert list(corpus.transcripts([gone], 0, tally, repos=["workflow-core"])) == []
    assert tally[corpus.tc.UNREADABLE] == 1
    assert capsys.readouterr().err == ""


def test_a_file_that_will_not_stat_is_skipped_and_counted(tmp_path, capsys):
    proj = tmp_path / "-home-x-workflow-core"
    proj.mkdir()
    (proj / "s1.jsonl").symlink_to(tmp_path / "missing")
    tally = Counter()
    assert (
        list(corpus.transcripts([str(tmp_path)], 0, tally, repos=["workflow-core"]))
        == []
    )
    assert tally[corpus.tc.UNREADABLE] == 1
    assert capsys.readouterr().err == ""


NAMES = ["workflow-core", "design-vault", "design-vault-proto-26", "health-and-fitness"]


def test_a_project_is_tagged_with_its_checkout_by_the_longest_name():
    m = corpus.repo_matcher(NAMES)
    assert corpus.repo_of("-home-x-health-and-fitness", m) == "health-and-fitness"
    assert corpus.repo_of("-home-x-design-vault", m) == "design-vault"
    assert corpus.repo_of("-home-x-design-vault-proto-26", m) == "design-vault-proto-26"


def test_a_worktree_slug_naming_another_repo_keeps_its_checkout():
    m = corpus.repo_matcher(NAMES)
    proj = "-home-x-workflow-core--claude-worktrees-design-vault-fix"
    assert corpus.repo_of(proj, m) == "workflow-core"


def test_a_name_inside_a_longer_word_is_no_match():
    m = corpus.repo_matcher(NAMES)
    assert corpus.repo_of("-home-x-workflow-core2", m) is None


def test_every_checkout_with_a_config_is_an_adopter(tmp_path):
    for name, cfg in (("a", True), ("b", False), ("c", True)):
        (tmp_path / name / ".claude").mkdir(parents=True)
        if cfg:
            (tmp_path / name / ".claude" / "workflow-core.json").write_text("{}")
    assert corpus.adopter_checkouts(str(tmp_path)) == {
        "a": str(tmp_path / "a"),
        "c": str(tmp_path / "c"),
    }
