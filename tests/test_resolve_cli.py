"""The resolve CLI, driven through main() with injected streams. No live LLM or network."""

import io
import json

import pytest

from pipeline.agents import settings as agent_settings
from pipeline.resolve import apply, cli
from pipeline.resolve.models import CandidatePair, Evidence, MergeDecision
from tests.resolve_helpers import count, org
from tests.test_resolve_agent import (
    _division_orgs,
    _merge_script,
    final,
    http_client,
    provider,
    scripted,
)

pytestmark = pytest.mark.db


def run_cli(db, argv, *, answers="", model=None):
    """Returns (exit code, stdout text, stderr text)."""
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(
        argv,
        conn=db,
        stdin=io.StringIO(answers),
        stdout=out,
        stderr=err,
        provider=provider(model) if model is not None else None,
        http=http_client(),
    )
    return code, out.getvalue(), err.getvalue()


def pending(db, left_name, right_name, *, decision="merge", confidence=0.7, canonical="left"):
    """Two orgs and an open pending_merges row about them. Returns (pending_id, left, right)."""
    left = org(db, left_name, uei="LEFTUEI00001")
    right = org(db, right_name)
    pair = CandidatePair(
        left_org_id=left, right_org_id=right, left_name=left_name, right_name=right_name
    )
    keep = {"left": left, "right": right, None: None}[canonical]
    d = MergeDecision(
        decision=decision,
        canonical_org_id=keep if decision == "merge" else None,
        confidence=confidence,
        evidence=[
            Evidence(
                source="usaspending",
                url="https://www.usaspending.gov/recipient/abc-C/latest",
                snippet="listed as an alternate name of the other record",
                supports="merge",
            )
        ],
        reasoning="Probably the same company, but only one source says so.",
    )
    assert apply.apply_decision(db, pair, d, agent_run_id=None) == "pending"
    db.commit()
    pid = db.execute(
        "SELECT id FROM pending_merges WHERE left_org_id = %s AND right_org_id = %s",
        (left, right),
    ).fetchone()[0]
    return pid, left, right


def reviewed(db, pid):
    return db.execute(
        "SELECT reviewer_action FROM pending_merges WHERE id = %s", (pid,)
    ).fetchone()[0]


def merged_into(db, org_id):
    return db.execute("SELECT merged_into FROM organizations WHERE id = %s", (org_id,)).fetchone()[
        0
    ]


# --- run ---------------------------------------------------------------------------


def test_run_dry_run_writes_no_merges_and_emits_stats(db, capsys, tmp_path, monkeypatch):
    stats_file = tmp_path / "stats.jsonl"
    monkeypatch.setenv("FLOCK_STATS_FILE", str(stats_file))
    lm, mfc = _division_orgs(db)
    code, _, err = run_cli(
        db, ["run", "--limit", "5", "--dry-run"], model=scripted(_merge_script(lm, mfc))
    )
    assert code == 0
    assert count(db, "org_merges") == 0 and merged_into(db, mfc) is None
    assert count(db, "pending_merges") == 0 and count(db, "org_non_matches") == 0
    assert count(db, "agent_runs") == 1  # the agent did run: that is the cost measurement

    line = json.loads(capsys.readouterr().out.strip())  # stdout is exactly the stats line
    assert line == json.loads(stats_file.read_text())
    assert line["step"] == "resolve" and line["dry_run"] is True
    assert line["merged"] == 1 and line["candidates"] == 1 and line["tool_calls"] == 2

    assert "DRY RUN: nothing was merged" in err and "would be merged: 1" in err
    assert f"per decision: {line['total_tokens']} tokens, 2.0 tool calls, 2.0 requests" in err


def test_run_applies_merges(db, capsys):
    lm, mfc = _division_orgs(db)
    code, _, err = run_cli(db, ["run"], model=scripted(_merge_script(lm, mfc)))
    assert code == 0 and merged_into(db, mfc) == lm
    assert json.loads(capsys.readouterr().out)["merged"] == 1
    assert "DRY RUN" not in err and "  merged: 1" in err and "open pending merges: 0" in err


def test_run_exits_2_when_every_agent_run_failed(db, capsys, monkeypatch):
    monkeypatch.setenv("RESOLVE_TOOL_CALLS_LIMIT", "1")
    agent_settings.reset_settings()
    lm, mfc = _division_orgs(db)
    # the script's first step makes two tool calls: over budget, so the run fails
    code, _, err = run_cli(db, ["run"], model=scripted(_merge_script(lm, mfc)))
    assert code == cli.EXIT_ALL_FAILED
    assert json.loads(capsys.readouterr().out)["failed"] == 1
    assert f"failed org:{lm}:{mfc}" in err and "UsageLimitExceeded" in err
    assert count(db, "org_merges") == 0 and merged_into(db, mfc) is None


def test_run_over_the_monthly_budget_skips_the_agent_and_exits_0(db, capsys, monkeypatch):
    from datetime import UTC, datetime

    from tests.test_costs import SONNET, spend

    org(db, "Skydio Inc")
    org(db, "Skydio, Inc.")
    twin_a = org(db, "Shield AI Inc", uei="UEI000000001")
    twin_b = org(db, "Shield AI", uei="UEI000000001")
    db.commit()
    spend(db, "classifier", SONNET, 1_000_000, 0, at=datetime.now(UTC))  # $2 this month
    monkeypatch.setenv("MONTHLY_LLM_BUDGET_USD", "1.5")
    agent_settings.reset_settings()

    def model(messages, info):
        raise AssertionError("the model must not be called over budget")

    code, _, err = run_cli(db, ["run"], model=model)
    assert code == 0  # skipped, not failed: the nightly step stays green
    assert "agent not run: monthly LLM budget reached" in err
    assert "pairs sent to the agent: 0" in err
    st = json.loads(capsys.readouterr().out)
    assert st["candidates"] == 0 and st["failed"] == 0 and st["runs"] == 0
    assert "budget $1.50" in st["over_budget"]
    # UEI auto-merges need no model, so they still happen.
    assert st["auto_merged"] == 1
    assert {merged_into(db, twin_a), merged_into(db, twin_b)} != {None}
    assert count(db, "pending_merges") == 0


def test_run_with_nothing_to_do_exits_0_without_a_model(db, capsys):
    code, _, err = run_cli(db, ["run"])
    assert code == 0 and "pairs sent to the agent: 0" in err and "per decision" not in err
    assert json.loads(capsys.readouterr().out)["candidates"] == 0


# --- review ------------------------------------------------------------------------


def test_review_list_shows_the_key_fields(db):
    pid, left, right = pending(db, "Acme Robotics Inc", "Acme Robotics LLC")
    code, out, _ = run_cli(db, ["review", "--list"])
    assert code == 0
    for expected in (
        f"pending #{pid}",
        "agent says: merge",
        "confidence 0.70",
        f"#{left}",
        f"#{right}",
        "Acme Robotics Inc",
        "Acme Robotics LLC",
        "UEI LEFTUEI00001",
        "UEI -",
        "<- agent would keep",
        "reasoning: Probably the same company",
        "[usaspending, supports merge] listed as an alternate name",
        "https://www.usaspending.gov/recipient/abc-C/latest",
        "1 pending merge(s) to review.",
    ):
        assert expected in out, expected
    assert reviewed(db, pid) is None  # listing changes nothing


def test_review_list_when_empty(db):
    assert run_cli(db, ["review", "--list"])[1] == "No pending merges.\n"
    assert "No pending merges." in run_cli(db, ["review"])[1]


def test_interactive_accept_reject_skip_quit(db):
    p1, l1, r1 = pending(db, "Alpha Dynamics Inc", "Alpha Dynamics LLC", confidence=0.8)
    p2, l2, r2 = pending(db, "Bravo Systems Inc", "Bravo Systems LLC", confidence=0.7)
    p3, _, r3 = pending(db, "Charlie Aero Inc", "Charlie Aero LLC", confidence=0.6)
    p4, _, r4 = pending(db, "Delta Marine Inc", "Delta Marine LLC", confidence=0.5)
    # highest confidence first: accept, (bad answer then) reject, skip, quit
    code, out, _ = run_cli(db, ["review"], answers="a\nx\nr\ns\nq\n")
    assert code == 0
    assert reviewed(db, p1) == "accepted" and merged_into(db, r1) == l1
    assert reviewed(db, p2) == "rejected" and merged_into(db, r2) is None
    assert count(db, "org_non_matches", "left_org_id = %s AND right_org_id = %s", (l2, r2)) == 1
    assert reviewed(db, p3) is None and reviewed(db, p4) is None
    assert merged_into(db, r3) is None and merged_into(db, r4) is None
    assert "Please answer a, r, s or q." in out
    assert "(4/4)" in out and "Done: 1 accepted, 1 rejected, 1 skipped." in out
    assert db.execute("SELECT decision_source FROM org_merges").fetchall() == [("review",)]


def test_interactive_accept_on_unsure_row_asks_which_to_keep(db):
    pid, left, right = pending(db, "Echo Labs Inc", "Echo Labs LLC", decision="unsure")
    code, out, _ = run_cli(db, ["review"], answers="a\n2\n")
    assert code == 0 and "Keep which record" in out
    assert reviewed(db, pid) == "accepted" and merged_into(db, left) == right


def test_interactive_accept_without_a_choice_skips(db):
    pid, left, right = pending(db, "Echo Labs Inc", "Echo Labs LLC", decision="unsure")
    _, out, _ = run_cli(db, ["review"], answers="a\n\n")
    assert reviewed(db, pid) is None and count(db, "org_merges") == 0
    assert "Skipped (no record chosen)." in out and "0 accepted, 0 rejected, 1 skipped" in out


def test_interactive_stops_cleanly_at_end_of_input(db):
    pid, _, _ = pending(db, "Echo Labs Inc", "Echo Labs LLC")
    code, out, _ = run_cli(db, ["review"], answers="")
    assert code == 0 and "Stopped." in out and reviewed(db, pid) is None


def test_interactive_stops_cleanly_on_ctrl_c(db):
    pid, _, _ = pending(db, "Echo Labs Inc", "Echo Labs LLC")

    def interrupted(prompt):
        raise KeyboardInterrupt

    out = io.StringIO()
    counts = cli.review_interactive(db, read=interrupted, out=out)
    assert counts == {"accepted": 0, "rejected": 0, "skipped": 0}
    assert "Stopped." in out.getvalue() and reviewed(db, pid) is None


def test_interactive_moves_past_rows_closed_by_an_earlier_merge(db):
    a, b, c = org(db, "Foxtrot Corp"), org(db, "Foxtrot Inc"), org(db, "Foxtrot LLC")

    def queue(left, right, confidence):
        pair = CandidatePair(left_org_id=left, right_org_id=right, left_name="l", right_name="r")
        d = MergeDecision(
            decision="merge",
            canonical_org_id=left,
            confidence=confidence,
            evidence=[],
            reasoning="r",
        )
        apply.apply_decision(db, pair, d, agent_run_id=None)

    queue(a, b, 0.8)  # asked first; accepting merges b away...
    queue(b, c, 0.6)  # ...which closes this question about b
    db.commit()
    code, out, _ = run_cli(db, ["review"], answers="a\na\n")
    assert code == 0 and "was closed by an earlier merge" in out
    assert count(db, "org_merges") == 1 and merged_into(db, b) == a and merged_into(db, c) is None


def test_accept_flag_uses_the_proposal_or_canonical_override(db):
    p1, l1, r1 = pending(db, "Golf Avionics Inc", "Golf Avionics LLC")
    code, out, _ = run_cli(db, ["review", "--accept", str(p1)])
    assert code == 0 and merged_into(db, r1) == l1 and f"Accepted #{p1}: merged (merge " in out

    p2, l2, r2 = pending(db, "Hotel Optics Inc", "Hotel Optics LLC")
    code, _, _ = run_cli(db, ["review", "--accept", str(p2), "--canonical", str(r2)])
    assert code == 0 and merged_into(db, l2) == r2


def test_accept_flag_refusals_exit_1_and_change_nothing(db):
    pid, left, right = pending(db, "India Sensors Inc", "India Sensors LLC", decision="unsure")
    code, out, _ = run_cli(db, ["review", "--accept", str(pid)])
    assert code == cli.EXIT_REFUSED and "no proposed canonical organization" in out
    code, out, _ = run_cli(db, ["review", "--accept", str(pid), "--canonical", "999999"])
    assert code == cli.EXIT_REFUSED and "canonical_org_id must be" in out
    assert reviewed(db, pid) is None and count(db, "org_merges") == 0

    code, out, _ = run_cli(db, ["review", "--accept", "424242"])
    assert code == cli.EXIT_REFUSED and "no pending merge with id 424242" in out

    code, _, err = run_cli(db, ["review", "--list", "--canonical", str(left)])
    assert code == cli.EXIT_REFUSED and "--canonical only applies with --accept" in err


def test_reject_flag_records_a_non_match_and_refuses_a_second_time(db):
    pid, left, right = pending(db, "Juliet Propulsion Inc", "Juliet Propulsion LLC")
    code, out, _ = run_cli(db, ["review", "--reject", str(pid)])
    assert code == 0 and "recorded as different organizations" in out
    assert reviewed(db, pid) == "rejected" and count(db, "org_non_matches") == 1
    code, out, _ = run_cli(db, ["review", "--reject", str(pid)])
    assert code == cli.EXIT_REFUSED and "already reviewed" in out


def test_accept_and_reject_are_mutually_exclusive(db):
    with pytest.raises(SystemExit):
        run_cli(db, ["review", "--accept", "1", "--reject", "2"])


# --- merges / undo -------------------------------------------------------------------


def test_merges_lists_and_undo_reverses(db):
    assert run_cli(db, ["merges"])[1] == "No merges recorded.\n"
    pid, left, right = pending(db, "Kilo Composites Inc", "Kilo Composites LLC")
    run_cli(db, ["review", "--accept", str(pid)])
    merge_id = db.execute("SELECT id FROM org_merges").fetchone()[0]

    code, out, _ = run_cli(db, ["merges", "--limit", "5"])
    assert code == 0 and "review" in out and "active" in out and "0.70" in out
    assert f"Kilo Composites LLC (#{right}) -> Kilo Composites Inc (#{left})" in out

    code, out, _ = run_cli(db, ["undo", str(merge_id)])
    assert code == 0 and f"Merge {merge_id} undone" in out and merged_into(db, right) is None
    assert "undone" in run_cli(db, ["merges"])[1]

    code, out, _ = run_cli(db, ["undo", str(merge_id)])
    assert code == cli.EXIT_REFUSED and "already undone" in out
    code, out, _ = run_cli(db, ["undo", "424242"])
    assert code == cli.EXIT_REFUSED and "no merge with id 424242" in out


def test_undo_refused_while_a_later_merge_is_in_the_way(db):
    a, b, c = org(db, "Lima Corp"), org(db, "Lima Inc"), org(db, "Lima LLC")
    first = apply.merge(db, a, b, confidence=1.0, source="review")
    second = apply.merge(db, a, c, confidence=1.0, source="review")
    db.commit()
    code, out, _ = run_cli(db, ["undo", str(first)])
    assert code == cli.EXIT_REFUSED and f"later merge(s) {second}" in out
    assert merged_into(db, b) == a


def test_final_helper_matches_the_pending_shape():
    # guards the shared test helper this file leans on
    assert MergeDecision.model_validate(final("unsure", 0.4)).decision == "unsure"
