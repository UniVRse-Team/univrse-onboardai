"""The agent's two tools.

The employee's account id and track come ONLY from the session state the
OnboardAi API sets when it creates the session (ACCOUNT_KEY, TRACK_KEY). No
tool takes an account id, track or status from the model: mark_step takes a
step id only, and the server-side rules decide what marking it means.

mark_step needs the employee's approval (ADK tool confirmation) whenever it
could change something: for every step of the employee's template that is not
a scenario check and does not still need Alya's briefing (contract v1.5). The
API shows that request as an Approve / Not yet card and resumes the run with
the employee's answer. A check step, a step that needs its briefing first or
an unknown id runs without a confirmation and changes nothing.
"""

from __future__ import annotations

import re
from typing import Any

from google.adk.tools import FunctionTool, ToolContext

from . import rules
from .store import ChecklistStore

ACCOUNT_KEY = "onboardai_account_id"
TRACK_KEY = "onboardai_track"
TEMPLATE_KEY = "onboardai_template_id"
TRACKS = ("employee", "intern", "contractor")
_ACCOUNT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_TEMPLATE = re.compile(r"^(?:starter\.)?(?:employee|intern|contractor)$")


def identity(tool_context: ToolContext) -> tuple[str | None, str]:
    """(account id, template_id) from the session state; (None, ...) when unusable."""
    state = tool_context.state
    account = state.get(ACCOUNT_KEY)
    track = state.get(TRACK_KEY)
    template_id = state.get(TEMPLATE_KEY)
    if not isinstance(account, str) or not _ACCOUNT.fullmatch(account):
        account = None
    if isinstance(template_id, str) and _TEMPLATE.fullmatch(template_id):
        resolved_template = template_id
    elif track in TRACKS:
        resolved_template = track
    else:
        resolved_template = "employee"
    return account, resolved_template


UNAVAILABLE = {"error": "The onboarding checklist is unavailable right now."}


def briefing_first(title: str) -> str:
    return (
        f"Before I mark it, please listen to Alya's briefing for {title} on your "
        "dashboard."
    )


def build_tools(store: ChecklistStore) -> list[FunctionTool]:
    def get_onboarding_progress(tool_context: ToolContext) -> dict[str, Any]:
        """Reads the employee's onboarding checklist.

        Returns every step (step_id, title, area, completion: self, hr_verify,
        check or optional; status: todo, submitted or done), the progress per
        area and the next step.
        """
        account, track = identity(tool_context)
        if not account:
            return UNAVAILABLE
        template = store.template(track)
        if not template:
            return UNAVAILABLE
        return rules.summary(template, store.progress(account))

    def _step(step_id: str, tool_context: ToolContext) -> rules.Step | None:
        account, track = identity(tool_context)
        if not account or not isinstance(step_id, str):
            return None
        template = store.template(track)
        return rules.find_step(template, step_id) if template else None

    def needs_confirmation(step_id: str, tool_context: ToolContext) -> bool:
        step = _step(step_id, tool_context)
        # A check step or an unknown id never asks; no progress read for them.
        if step is None or rules.target_status(step) is None:
            return False
        account, _track = identity(tool_context)
        return rules.can_propose(step, store.progress(account) if account else None)

    def mark_step(step_id: str, tool_context: ToolContext) -> dict[str, Any]:
        """Marks one onboarding step that the employee says they have finished.

        Only call it with a step_id from get_onboarding_progress, for one step
        the employee clearly named. The employee must approve before anything
        changes. A self or optional step becomes done; a step HR verifies
        becomes submitted (HR still checks it); a scenario check step is never
        marked, and neither is a step whose briefing_needed is true.
        """
        account, _track = identity(tool_context)
        step = _step(step_id, tool_context)
        if not account or step is None:
            return {"result": "unknown_step", "step_id": step_id}
        new_status = rules.target_status(step)
        if new_status is not None and rules.needs_briefing(step, store.progress(account)):
            return {
                "result": "briefing_required",
                "step_id": step.id,
                "title": step.title,
                "message": briefing_first(step.title) + " Nothing was marked.",
            }
        if new_status is None:
            return {
                "result": "check_required",
                "step_id": step.id,
                "title": step.title,
                "message": (
                    "This step is a short scenario check. Nothing was marked: the "
                    "employee completes it by taking the check on their onboarding "
                    "dashboard."
                ),
            }
        outcome, progress = store.mark(
            account, step.id, new_status, require_briefing=step.briefing_required
        )
        if outcome == "briefing_required":
            return {
                "result": "briefing_required",
                "step_id": step.id,
                "title": step.title,
                "message": briefing_first(step.title) + " Nothing was marked.",
            }
        template = store.template(_track) or {}
        after = rules.summary(template, progress)
        return {
            "result": outcome,
            "step_id": step.id,
            "title": step.title,
            "status": rules.status_of(progress, step.id),
            "waiting_on_hr": new_status == rules.SUBMITTED,
            "next_step": after["next_step"],
            "complete": after["complete"],
        }

    return [
        FunctionTool(get_onboarding_progress),
        FunctionTool(mark_step, require_confirmation=needs_confirmation),
    ]
