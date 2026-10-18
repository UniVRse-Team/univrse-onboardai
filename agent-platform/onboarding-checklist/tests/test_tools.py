"""The two tools against an in-memory Firestore: identity from session state
only, the F1 completion rules, the exact onboardingProgress write and the
confirmation predicate."""

from types import SimpleNamespace

from conftest import ACCOUNT, BRIEFED_AT, NOW, OTHER, TEMPLATE, briefed, make_store
from onboarding_checklist import rules
from onboarding_checklist.tools import ACCOUNT_KEY, TRACK_KEY, build_tools


def context(account=ACCOUNT, track="employee"):
    return SimpleNamespace(state={ACCOUNT_KEY: account, TRACK_KEY: track})


def tools(documents=None):
    db, store = make_store(documents)
    get_progress, mark = build_tools(store)
    return db, get_progress, mark


def progress_doc(db, account=ACCOUNT):
    return db.documents.get(f"onboardingProgress/{account}")


def test_tool_declarations_take_no_account_track_or_status():
    _db, get_progress, mark = tools()
    assert get_progress.name == "get_onboarding_progress"
    assert mark.name == "mark_step"
    declared = mark._get_declaration().model_dump(exclude_none=True)
    assert declared["parameters_json_schema"]["properties"] == {
        "step_id": {"title": "Step Id", "type": "string"}
    }
    assert declared["parameters_json_schema"]["required"] == ["step_id"]
    progress_declared = get_progress._get_declaration().model_dump(exclude_none=True)
    assert "parameters_json_schema" not in progress_declared
    assert "parameters" not in progress_declared


def test_progress_reads_the_template_and_the_account_from_state():
    db, get_progress, _mark = tools(
        {
            f"onboardingProgress/{ACCOUNT}": {
                "accountId": ACCOUNT,
                "steps": {"team-support.meet-manager": {"status": "done"}},
            },
            f"onboardingProgress/{OTHER}": {
                "accountId": OTHER,
                "steps": {"team-support.meet-buddy": {"status": "done"}},
            },
        }
    )
    result = get_progress.func(tool_context=context())
    statuses = {step["step_id"]: step["status"] for step in result["steps"]}
    assert statuses["team-support.meet-manager"] == "done"
    assert statuses["team-support.meet-buddy"] == "todo"  # another account's progress
    optional = next(s for s in result["steps"] if s["step_id"] == "team-support.working-preferences")
    assert optional["completion"] == "optional"
    assert result["next_step"]["step_id"] == "documentation.contract"
    assert result["complete"] is False
    assert [path for path, _tx in db.reads] == [
        "onboardingTemplates/employee",
        f"onboardingProgress/{ACCOUNT}",
    ]


def test_without_a_usable_account_in_state_nothing_is_read_or_written():
    for state in ({}, {ACCOUNT_KEY: "PC-0001"}, {ACCOUNT_KEY: 42}):
        db, get_progress, mark = tools()
        ctx = SimpleNamespace(state=state)
        assert get_progress.func(tool_context=ctx) == {
            "error": "The onboarding checklist is unavailable right now."
        }
        assert mark._require_confirmation(step_id="team-support.meet-buddy", tool_context=ctx) is False
        assert mark.func(step_id="team-support.meet-buddy", tool_context=ctx)["result"] == "unknown_step"
        assert db.reads == [] and db.transactions == []


def test_a_self_step_becomes_done_with_the_contract_shape_in_a_transaction():
    db, _get, mark = tools(
        {
            f"onboardingProgress/{ACCOUNT}": {
                "accountId": ACCOUNT,
                "updatedAt": "2026-10-15T01:00:00.000Z",
                "steps": {
                    "alignment.mission-values": {
                        "status": "done",
                        "updatedAt": "2026-10-15T01:00:00.000Z",
                        "source": "employee",
                        "actorId": ACCOUNT,
                    },
                    "team-support.meet-buddy": {"briefedAt": BRIEFED_AT, "briefedBy": "read"},
                },
            }
        }
    )
    result = mark.func(step_id="team-support.meet-buddy", tool_context=context())
    assert result["result"] == "marked"
    assert result["status"] == "done"
    assert result["waiting_on_hr"] is False
    assert result["next_step"]["step_id"] == "documentation.contract"
    assert progress_doc(db) == {
        "accountId": ACCOUNT,
        "updatedAt": NOW,
        "steps": {
            "alignment.mission-values": {
                "status": "done",
                "updatedAt": "2026-10-15T01:00:00.000Z",
                "source": "employee",
                "actorId": ACCOUNT,
            },
            "team-support.meet-buddy": {
                "status": "done",
                "updatedAt": NOW,
                "source": "alya-agent",
                "actorId": ACCOUNT,
                "briefedAt": BRIEFED_AT,
                "briefedBy": "read",
            },
        },
    }
    # Read and written inside one transaction.
    assert len(db.transactions) == 1
    tx = db.transactions[0]
    assert (f"onboardingProgress/{ACCOUNT}", tx) in db.reads
    assert [path for path, _ in tx.writes] == [f"onboardingProgress/{ACCOUNT}"]


def test_an_hr_verify_step_becomes_submitted_and_an_optional_step_done():
    # The optional step has no briefing; the contract step had its briefing.
    db, _get, mark = tools(briefed("documentation.contract"))
    contract = mark.func(step_id="documentation.contract", tool_context=context())
    assert (contract["result"], contract["status"], contract["waiting_on_hr"]) == (
        "marked",
        "submitted",
        True,
    )
    optional = mark.func(step_id="team-support.working-preferences", tool_context=context())
    assert (optional["result"], optional["status"]) == ("marked", "done")
    steps = progress_doc(db)["steps"]
    assert steps["documentation.contract"]["status"] == "submitted"
    assert steps["team-support.working-preferences"]["status"] == "done"
    # A submission again, or a step already done, writes nothing.
    again = mark.func(step_id="documentation.contract", tool_context=context())
    assert again["result"] == "already_submitted"
    assert mark.func(step_id="team-support.working-preferences", tool_context=context())[
        "result"
    ] == "already_done"
    assert len([t for t in db.transactions if t.writes]) == 2


def test_a_step_without_its_briefing_is_never_proposed_or_marked():
    db, get_progress, mark = tools()
    needs = mark._require_confirmation
    assert needs(step_id="team-support.meet-buddy", tool_context=context()) is False
    refused = mark.func(step_id="team-support.meet-buddy", tool_context=context())
    assert refused == {
        "result": "briefing_required",
        "step_id": "team-support.meet-buddy",
        "title": "Meet your buddy",
        "message": "Before I mark it, please listen to Alya's briefing for Meet your buddy on "
        "your dashboard. Nothing was marked.",
    }
    assert db.transactions == [] and progress_doc(db) is None
    # The checklist tells the model which steps still need their briefing.
    view = {s["step_id"]: s["briefing_needed"] for s in get_progress.func(tool_context=context())["steps"]}
    assert view["team-support.meet-buddy"] is True
    assert view["team-support.working-preferences"] is False  # optional: no briefing
    # After the briefing (written by the API in the same document) it is proposed.
    db.documents.update(briefed("team-support.meet-buddy"))
    assert needs(step_id="team-support.meet-buddy", tool_context=context()) is True
    view = {s["step_id"]: s["briefing_needed"] for s in get_progress.func(tool_context=context())["steps"]}
    assert view["team-support.meet-buddy"] is False
    assert mark.func(step_id="team-support.meet-buddy", tool_context=context())["result"] == "marked"


def test_the_store_checks_the_briefing_inside_its_transaction():
    db, store = make_store()
    outcome, _progress = store.mark(
        ACCOUNT, "team-support.meet-buddy", "done", require_briefing=True
    )
    assert outcome == "briefing_required"
    assert progress_doc(db) is None
    # Without the requirement (an optional step) it marks, keeping no briefing.
    outcome, progress = store.mark(ACCOUNT, "team-support.working-preferences", "done")
    assert outcome == "marked"
    assert set(progress["steps"]["team-support.working-preferences"]) == {
        "status",
        "updatedAt",
        "source",
        "actorId",
    }


def test_an_hr_verified_step_is_never_moved_back_to_submitted():
    db, _get, mark = tools(
        {
            f"onboardingProgress/{ACCOUNT}": {
                "accountId": ACCOUNT,
                "steps": {"documentation.contract": {"status": "done", "source": "hr"}},
            }
        }
    )
    assert mark.func(step_id="documentation.contract", tool_context=context())["result"] == (
        "already_done"
    )
    assert progress_doc(db)["steps"]["documentation.contract"]["source"] == "hr"


def test_check_steps_and_unknown_ids_are_never_marked_and_need_no_confirmation():
    db, _get, mark = tools()
    check = mark.func(step_id="policies.responsible-ai", tool_context=context())
    assert check["result"] == "check_required"
    assert "scenario check" in check["message"]
    assert mark.func(step_id="policies.nope", tool_context=context())["result"] == "unknown_step"
    assert db.transactions == []
    needs = mark._require_confirmation
    db.documents.update(briefed("team-support.meet-buddy", "documentation.contract"))
    assert needs(step_id="team-support.meet-buddy", tool_context=context()) is True
    assert needs(step_id="documentation.contract", tool_context=context()) is True
    assert needs(step_id="team-support.working-preferences", tool_context=context()) is True
    assert needs(step_id="policies.employee-handbook", tool_context=context()) is False
    assert needs(step_id="policies.nope", tool_context=context()) is False


def test_the_track_in_state_picks_the_template():
    intern = {
        **TEMPLATE,
        "track": "intern",
        "areas": [
            {**TEMPLATE["areas"][0], "steps": [dict(TEMPLATE["areas"][0]["steps"][0], title="Sign your internship agreement")]},
            *TEMPLATE["areas"][1:],
        ],
    }
    db, get_progress, _mark = tools({"onboardingTemplates/intern": intern})
    result = get_progress.func(tool_context=context(track="intern"))
    assert result["steps"][0]["title"] == "Sign your internship agreement"
    # An unknown track is employee.
    result = get_progress.func(tool_context=context(track="manager"))
    assert result["steps"][0]["title"] == "Sign your employment contract"


def test_rules_match_the_api():
    steps = {step.id: step for step in rules.steps_of(TEMPLATE)}
    # v1.5: required steps with a briefing need it; a briefing record alone is todo.
    assert steps["team-support.meet-buddy"].briefing_required is True
    assert steps["team-support.working-preferences"].briefing_required is False
    progress = briefed("team-support.meet-buddy")[f"onboardingProgress/{ACCOUNT}"]
    assert rules.status_of(progress, "team-support.meet-buddy") == "todo"
    assert rules.briefed(progress, "team-support.meet-buddy") is True
    assert rules.needs_briefing(steps["team-support.meet-buddy"], progress) is False
    assert rules.needs_briefing(steps["team-support.meet-buddy"], None) is True
    assert rules.can_propose(steps["team-support.meet-buddy"], None) is False
    assert rules.can_propose(steps["team-support.meet-buddy"], progress) is True
    # A step already done or submitted needs no briefing to be left alone.
    done_before = {"steps": {"documentation.contract": {"status": "submitted"}}}
    assert rules.needs_briefing(steps["documentation.contract"], done_before) is False
    assert rules.target_status(steps["alignment.mission-values"]) == "done"
    assert rules.target_status(steps["documentation.contract"]) == "submitted"
    assert rules.target_status(steps["policies.data-protection"]) is None
    assert rules.target_status(steps["team-support.working-preferences"]) == "done"
    done = lambda ids: {"steps": {i: {"status": "done"} for i in ids}}  # noqa: E731
    # 3 of 4 required steps in every area: complete; the optional step does not count.
    three = [a["steps"][i]["id"] for a in TEMPLATE["areas"] for i in range(3)]
    view = rules.summary(TEMPLATE, done(three))
    assert view["complete"] is True
    assert all(a["done"] == 3 and a["total"] == 4 for a in view["areas"])
    # The next step is in the first area below the threshold.
    fewer = [i for i in three if i != "alignment.org-structure"]
    view = rules.summary(TEMPLATE, done(fewer))
    assert view["complete"] is False
    assert view["next_step"]["step_id"] == "alignment.org-structure"
    # Every area at the threshold: the first required todo step anywhere.
    view = rules.summary(TEMPLATE, done(three))
    assert view["next_step"]["step_id"] == "documentation.emergency-contact"


def test_ai_readiness_training_step_syncs_with_ai_proficiency():
    # Status of role-tools.ai-readiness-training is done iff aiProficiency.trainingCompleted is True.
    assert (
        rules.status_of(
            {
                "steps": {"role-tools.ai-readiness-training": {"status": "done"}},
                "aiProficiency": {"status": "assessed", "level": 4, "trainingCompleted": False},
            },
            rules.AI_READINESS_STEP_ID,
        )
        == "todo"
    )
    assert (
        rules.status_of(
            {
                "steps": {},
                "aiProficiency": {"status": "assessed", "level": 4, "trainingCompleted": True},
            },
            rules.AI_READINESS_STEP_ID,
        )
        == "done"
    )
    db, store = make_store(
        {
            f"onboardingProgress/{ACCOUNT}": {
                "accountId": ACCOUNT,
                "steps": {
                    rules.AI_READINESS_STEP_ID: {"briefedAt": BRIEFED_AT, "briefedBy": "read"}
                },
                "aiProficiency": {
                    "status": "assessed",
                    "level": 5,
                    "learningPathId": "intermediate",
                    "assessedAt": BRIEFED_AT,
                    "updatedAt": BRIEFED_AT,
                    "trainingCompleted": False,
                    "trainingCompletedAt": None,
                },
            }
        }
    )
    outcome, progress = store.mark(
        ACCOUNT, rules.AI_READINESS_STEP_ID, "done", require_briefing=True
    )
    assert outcome == "marked"
    assert progress["steps"][rules.AI_READINESS_STEP_ID]["status"] == "done"
    assert progress["aiProficiency"]["trainingCompleted"] is True
    assert progress["aiProficiency"]["trainingCompletedAt"] == NOW
    assert progress["aiProficiency"]["learningPathId"] == "intermediate"
    assert progress["aiProficiency"]["level"] == 5


def test_template_id_from_session_state():
    from onboarding_checklist.tools import TEMPLATE_KEY

    db, get_progress, _mark = tools(
        {
            "onboardingTemplates/starter.employee": TEMPLATE,
            f"onboardingProgress/{ACCOUNT}": {
                "accountId": ACCOUNT,
                "steps": {},
            },
        }
    )
    ctx = SimpleNamespace(
        state={ACCOUNT_KEY: ACCOUNT, TRACK_KEY: "employee", TEMPLATE_KEY: "starter.employee"}
    )
    result = get_progress.func(tool_context=ctx)
    assert result != UNAVAILABLE
    assert [path for path, _tx in db.reads] == [
        "onboardingTemplates/starter.employee",
        f"onboardingProgress/{ACCOUNT}",
    ]


