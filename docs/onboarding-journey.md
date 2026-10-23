# Onboarding journey and support (issues #47-#52)

Signed-in employees get a server-backed **onboarding footprint**, quick-question chips in Alya's
chat, personal first-day answers, and a consent-based way to ask HR for help. HR verifies
paperwork, enters first-day details, works confirmed support requests, and sees team-level
insights and anonymous knowledge gaps. Everything here is for signed-in accounts only (see
[Account access](account-access.md)); there is no guest access (issue #55).

The binding API contract is "Contract v1.5". Issue #47's first comment holds v1.3; issue #63
adds v1.4 (shuffled and written policy checks) and v1.5 (Alya's briefing before each required
step). This page describes how the server implements it.

| Module                                                        | Role                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `server/onboarding-content.mjs`                               | The built-in templates per track, the policy scenario checks and the quick-question chips |
| `server/onboarding-progress.mjs`                              | Pure rules: template validation, the `Onboarding` view, step transitions, chip selection  |
| `server/onboarding-journey.mjs`                               | Firestore reads and writes for templates, progress, chips and first-day details           |
| `server/support-requests.mjs`                                 | Support request preview, creation, HR workflow and team insights                          |
| `server/team-insights.mjs`                                    | The team-level aggregate (at least 3 employees with data)                                 |
| `server/knowledge-gaps.mjs`, `server/pii-redaction.mjs`       | Anonymous knowledge gaps and best-effort personal data removal                            |
| `server/onboarding-routes.mjs`                                | The HTTP routes, mounted on the account routers of `account-routes.mjs`                   |
| `server/migrations/firestore/001_onboarding_templates.mjs`    | Seeds `onboardingTemplates/{track}`                                                       |
| `server/migrations/firestore/002_quick_questions.mjs`         | Seeds `config/quickQuestions`                                                             |
| `server/migrations/firestore/003_onboarding_templates_v2.mjs` | Upgrades `onboardingTemplates/{track}` to version 2 (v1.4 checks, v1.5 briefings)         |
| `server/check-grader.mjs`                                     | Grades written policy checks with Gemini; the server decides the pass (v1.4)              |
| `server/checklist-agent-client.mjs`                           | The checklist agent (#51): local ADK API server or Agent Engine                           |
| `server/agent-actions.mjs`                                    | Proposed checklist changes (`agentActions`) and the employee's decision                   |
| `server/gemini-voice.mjs`                                     | Gemini text to speech for `/api/voice` (#52), with Kokoro as the fallback                 |
| `server/voice-guard.mjs`                                      | The duration guard: rejects a Gemini clip too long for its sentence                       |
| `scripts/check-gemini-voice.mjs`                              | `npm run check:voice`: the live check that Gemini speaks the sentence and nothing else    |
| `agent-platform/onboarding-checklist/`                        | The checklist agent itself (Python, ADK; see its README)                                  |

## Data model (Firestore, Admin SDK only)

| Document                              | Holds                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboardingTemplates/{track}`         | `{ track, version: 2, threshold: 70, areas: [{ id, icon, title, description, steps: [Step] }] }`. Seeded by 001, upgraded by 003; built-in fallback. Luna Digital's (and `univrse`'s) only                                |
| `onboardingTemplates/starter.{track}` | The same shape, `version: 1` (`starterTemplateVersion`), for every other company. Seeded by 011; `starterTemplate` fallback                                                                                               |
| `onboardingProgress/{accountId}`      | `{ accountId, updatedAt, steps: { [stepId]: { status?: "submitted" \| "done", updatedAt, source, actorId, briefedAt?, briefedBy?: "listened" \| "read" } } }`. No status means "todo"                                     |
| `config/quickQuestions`               | `{ employee: [Chip], intern: [Chip], contractor: [Chip] }`. Seeded by migration 002; built-in fallback. An optional `"starter.<track>"` list is the starter companies' (none is seeded; `starterQuickQuestions` fallback) |
| `employeeFirstDay/{accountId}`        | `{ location, arrivalTime, hostName, hostContact, notes, updatedAt, updatedBy }`, entered by HR                                                                                                                            |
| `supportRequests/{id}`                | One confirmed request per employee and answer (see [Support requests](#support-requests-d1-option-a))                                                                                                                     |
| `knowledgeGaps/{id}`                  | `{ questionRedacted, topic, track, nearestSource, createdDay }`, with no account id, conversation id or time of day                                                                                                       |
| `agentActions/{id}`                   | A proposed checklist change (see [Checklist agent](#checklist-agent-51)); ids and status only, never message text                                                                                                         |

- The track is the profile's `job.track` (`employee`, `intern` or `contractor`, stored in lower
  case; empty means `employee`). HR sets it in Add employee and Edit profile.
- Every query filters on a single field (`accountId` or `status`); sorting and grouping happen
  in memory, so no composite index is needed.
- **The template follows the employee's company (issue #126).** `templateDocId(companyId, track)`
  (`server/companies.mjs`) names the document: `<track>` for `luna-digital` and `univrse`,
  `starter.<track>` for every other company; a missing `companyId` is `luna-digital`. The
  employee routes use the signed-in account's company; HR's views of an employee (detail, the
  employee list's percent, step verification, tool-access confirmation) and a document
  submission's sync use the employee's company. A stored template must reach its own pack's
  version (`templateVersion` for Luna Digital, `starterTemplateVersion` for the starter pack);
  older, missing or malformed ones fall back to `builtInTemplate` or `starterTemplate`. The cache
  is keyed by the document id, so the packs never share an entry. The checklist agent's proposals
  are matched against the same template (`onboardai_template_id` in its session state).
- Templates and the chip config are cached for 60 seconds per server. A stored document that is
  missing or malformed (wrong area order, an area without a required step, an unknown completion
  type, a check missing on a `check` step) is replaced by the built-in seed, and a log line says
  so without any document content.
- Migrations 001 and 002 create the documents only when they are missing, so re-running them
  changes nothing and never overwrites a later edit.
- **Content changes need a version bump and a migration.** The migrations are forward-only, and
  one that already ran never runs again. So a stack seeded with old content keeps it until a new
  migration replaces it. This is why the c, a, b, c answer fix never reached stacks where 001 had
  run, which kept the all-"b" content. Any change to `server/onboarding-content.mjs` templates
  needs two things:
  - raise `templateVersion`;
  - add a Firestore migration that writes the new version wherever the stored `version` is lower,
    like `003_onboarding_templates_v2.mjs`. That migration is idempotent, keeps a template already
    at or above the version, and never touches `onboardingProgress`, because step ids are stable.
- The api also never serves a stored template older than the built-in one. It uses the built-in
  version and logs `Onboarding template <document id> is version N; the built-in version M is used`.
  This way the api has the new content even before the migration runs. The checklist agent reads
  the stored template, so it needs the migration.
- Log lines name the operation and Firestore status only. Storage failures on these routes
  answer `503 PROFILE_STORAGE_UNAVAILABLE` or `504 PROFILE_STORAGE_TIMEOUT`, like the other
  employee data.

## The footprint

Five areas, in this order. Since template version 4 (Firestore migration
`006_onboarding_templates_v4`), every track has the same checklist: Documentation 3, Policies 3,
Alignment 4, Role, Tools & AI Readiness 10 and People & Workplace Support 4 **required** steps,
plus two optional ones that never count. The 70% rule means every step in the three-step areas,
3 of 4 in alignment and team support and 7 of 10 in `role-tools`.

| Area            | Icon, title                    | Steps (completion)                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentation` | 📄 Documentation               | copy of your IC (front and back), details for the Employees/Interns Record, Employee Information Form (all `hr_verify`: finished by saving the document; HR review is separate)                                                                                                                                                                           |
| `policies`      | 🛡️ Policies & Safe Practices   | Employee Handbook (`check`), company SOPs & policies (`self`), SOP for internal meetings (`self`)                                                                                                                                                                                                                                                         |
| `alignment`     | 🎯 Company Purpose & Alignment | Vision & Core Values, company social media accounts (`self`), Onboarding Quiz Part 1 and Part 2 (quizzes: team structure and role contribution; finished through their activity)                                                                                                                                                                          |
| `role-tools`    | 🛠️ Role, Tools & AI Readiness  | GSheet account, Individual GSheet, GSheet training & SOP (`check`), shared Drive folders, Gmail & Google Chat, Gmail profile picture, professional email, official email linked to Gmail, email signature, daily GSheet updates (`check`); plus the optional AI Readiness self-assessment ([AI proficiency](#ai-proficiency-self-assessment-template-v3)) |
| `team-support`  | 🤝 People & Workplace Support  | company chat groups, department chat group, Talent Personality Test, MBTI Personality Test (all `self`); plus the optional "Share your working preferences or support needs (optional)"                                                                                                                                                                   |

Steps no longer in the checklist (employment contract, emergency contact, the NDA, workplace
conduct, PDPA, responsible AI, "what the company does") keep their approved content in the code
(`additionalPolicySteps`, `additionalAlignmentSteps`) so HR can add them to a stored template.
Step ids (`<areaId>.<slug>`) are shared across tracks for the same structural step, so changing
an employee's track keeps the progress that still applies.

### Rules

- **Completion types.** `self`: the employee confirms (done). `hr_verify`: the employee submits
  and HR verifies (submitted, then done). `check`: a short scenario check; a correct answer
  marks the step done, a wrong one explains why and stores nothing.
- **Alya's briefing first** (v1.5, see [Briefings](#briefings-v15)). Until a required step has
  its briefing, the following answer `409 BRIEFING_REQUIRED`:
  - completing it;
  - its check (`GET` and `POST`);
  - approving Alya's proposal for it.

  HR verification is not gated.

- **Optional steps** (`required: false`) complete and reopen like `self` steps and never count.
- **Reopen.** An employee may undo a self-done step or their own submission. An HR-verified step
  or a passed check is `409 STEP_LOCKED`.
- **HR** may set only required `hr_verify` steps to `done` or `todo` (`409 STEP_NOT_HR_VERIFIED`
  otherwise), with an `onboarding_step_verified` audit row holding `{ stepId, status }`.
- **Maths.** An area's percent is round(required done ÷ required total × 100). An area
  `meetsThreshold` when the exact ratio is at least 70%. Onboarding is `complete` when every area
  meets it. The overall percent is the mean of the area percents, for display only. A submitted
  step waits on HR and is not done; `waitingOnHr` counts submitted steps.
- **Next step.** The first required todo step of the first area (in order) below the threshold
  that still has a todo step; otherwise the first required todo step anywhere; otherwise null.
  Submitted and optional steps are never the next step.
- **Personal disclosures never affect completion.** Answer style, Helpful / Still unclear,
  support requests and check attempts never change progress; wrong check answers are not stored.
- Onboard AI records only whether paperwork was submitted and verified. It never stores the
  contract, IC or bank documents.

### Policy scenario checks (v1.4)

Each policy step has one scenario grounded in the company's Employee Handbook (`sourceTitle`
"UniVRse - Employee Handbook"). Only short paraphrases are kept in the code, never the document
text. A check is one of two types.

- **`choice`**: company rules (the Casual Friday dress code) and workplace conduct (a phishing
  email asking for a password).
  - The step holds `{ type, scenario, options: [{ id, text }], correctOptionId, explanation,
sourceTitle }`.
  - Option ids are opaque and stable (`h8t3`, `w5n1`), so an id says nothing about position.
  - `GET …/check` answers `{ stepId, type: "choice", scenario, options, sourceTitle }`, with the
    options **shuffled on every request**.
  - `POST …/check { optionId }` answers `{ correct, explanation, onboarding }`.
- **`written`**: data protection (copying a customer list to a personal drive) and responsible
  AI use (a free chatbot for UniVRse source code).
  - The step holds `{ type, scenario, keyPoints: [{ id, text }], mustNot: [{ id, text }],
modelAnswer, explanation, sourceTitle, maxLength: 600 }`, with 2 key points and 2 must-nots
    each.
  - `GET …/check` answers `{ stepId, type: "written", scenario, sourceTitle, maxLength }`.
  - `POST …/check { answer }` (1 to 600 characters) answers
    `{ correct, feedback, explanation|null, onboarding }`. `explanation` is set only when the
    answer is correct.
- **Never returned to the browser:** `correctOptionId`, `keyPoints`, `mustNot`, `modelAnswer`,
  and the `explanation` in a GET.
- **Errors:**
  - `400 CHECK_ANSWER_INVALID`: an empty or too-long answer, or the wrong field for the type
    (exactly one field);
  - `503 CHECK_GRADER_UNAVAILABLE`: no Gemini (no `GOOGLE_CLOUD_PROJECT`, or
    `AI_MODE=document-search`), or Gemini failed.

  Neither changes anything.

**Grading a written answer** (`server/check-grader.mjs`)

- **The model.** Gemini on Vertex AI (`CHECK_GRADER_MODEL`, default `gemini-3.8-flash`,
  temperature 0, 20-second timeout) returns structured output:
  `{ covered: [{ keyPointId, evidence }], violations: [{ mustNotId, evidence }], feedback }`.
- **Thinking LOW** (`CHECK_GRADER_THINKING=low`, the default) sends
  `thinkingConfig: { thinkingLevel: "LOW" }`; `default` sends none and is the rollback.
  - **Measured** on the live answer set (good, weak, injection and subtle-injection answers to
    both written checks, 6 runs per mode): LOW gave the same pass or fail on every graded answer.
  - **Latency:** the median model call was 2.1 s against 4.4–4.6 s. The slowest call was 14.4 s
    against 15.7 s.
  - **Timeouts:** one LOW call timed out at 20 s, in 36 calls.
  - **Gemini 2.5 models** reject `thinkingLevel`: use `default` with them.
- **The server decides.** An answer passes when three things hold:
  - every key point is covered by evidence that really is in the answer;
  - no must-not item is violated by evidence that really is in the answer;
  - the answer does not address the grader.

  Evidence is checked as a substring of the answer, ignoring case, quote style and whitespace.
  Evidence shorter than 4 characters, or that can't be found, is ignored. So an invented quote
  can neither pass nor fail an answer.

- **The answer is untrusted data.** The system instruction says so and never to follow
  instructions in it, and the answer is fenced in the request. An answer that talks to the grader
  fails before any model call, with "Please answer the scenario in your own words." For example:
  "rubric", "grader", "mark this correct", "ignore the previous instructions", or the output's
  JSON keys.
- **Feedback.** At most two plain sentences, kind, with no Markdown. It is replaced by a fixed
  sentence in three cases:
  - it is empty;
  - it repeats 5 or more consecutive words of the model answer;
  - the model claimed every point with evidence that is not in the answer, so its praise would
    contradict the result.
- **Privacy.** The written answer is never stored and never logged, right or wrong. Only the
  step's status changes, and only on a pass. A grader failure logs its error code and HTTP status
  only.

## AI proficiency self-assessment (template v3)

The `role-tools.ai-readiness-training` step (`server/ai-proficiency.mjs`). The employee rates their
AI use from 1 to 10, or answers `not_sure`, or skips; that picks a learning path and a practice
task. The step is done only when the employee completes the practice task. The record is
`onboardingProgress/{accountId}.aiProficiency`:
`{ status: "unanswered" | "assessed" | "not_sure" | "skipped", level: 1-10 | null, learningPathId: "beginner" | "intermediate" | "advanced", assessedAt, updatedAt, trainingCompleted, trainingCompletedAt }`.

- **Paths.** Levels 1-3, `not_sure`, `skipped` and unanswered are `beginner`; 4-6 `intermediate`;
  7-10 `advanced`.
- **A rating never completes the step**, and a new rating keeps a completed practice task.
  Completing or reopening the step through the normal step route sets or clears
  `trainingCompleted` and keeps the rating.
- `GET /api/me/ai-proficiency` (employee): `{ aiProficiency, levels, learningPaths }`, where
  `aiProficiency` adds `levelDescription`, `learningPath` and `practiceTask`.
- `PUT /api/me/ai-proficiency` (employee) with `{ status: "assessed", level }`, `{ level }`,
  `{ status: "not_sure" }` or `{ status: "skipped" }`: the `GET` answer plus `onboarding` (the
  updated Onboarding view). Any other key or value is `400 AI_PROFICIENCY_INVALID`.
- `POST /api/me/ai-proficiency/complete-training` (employee), optionally `{ practiceNote }` (a
  string of at most 2,000 characters, checked but not stored): the same response, with the step
  done. A step without a briefing gets one recorded as read.
- `GET /api/hr/employees/:id/ai-proficiency` (HR): `{ aiProficiency, levels, learningPaths }`.
- A `userId`, `accountId` or `companyId` (query or body) that is not the caller's own is
  `403 FORBIDDEN`.
- **In chat**, an employee's statement (not a question) such as "I rated my AI proficiency 5" or
  "I want to skip the AI assessment" is saved the same way, and Alya answers with the path and
  practice task (`parseChatAiAssessment`, `alyaAssessmentReply`). It is never read as a finished
  step, and the checklist agent marks the step only when the employee says they finished the
  practice task.

## Briefings (v1.5)

Every **required** step has Alya's briefing:

- The template step holds `briefing: { text, sourceTitle|null }`. The text is 2 to 4 plain
  sentences, at most 400 characters, with no links, lists or headings, so it reads well aloud.
- It is grounded in the company documents: the Employee Handbook, the New Staff Checklist, the
  Orientation & Office Tour Guide and Signing Your Employment Contract.
- The company documents don't describe contractor agreements. Those few briefings have
  `sourceTitle: null` and state no company facts.
- The optional step has `briefing: null`.

How it works:

- **Recording it.** `POST /api/me/onboarding/steps/:stepId/briefing` with body
  `{ completion: "listened" | "read" | "helpful" }` answers `Onboarding`.
  - It stores `briefedAt` and `briefedBy` in the step's progress record, once: a second call
    keeps the first time and completion.
  - Clicking **Helpful** on a briefing or on a step's chat answer (from "Ask Alya", a step chip or
    its re-explanation) records the briefing with `briefedBy: "helpful"`, unlocking the step's
    check, completion and checklist proposal.
  - Errors: `404 STEP_NOT_FOUND` for an unknown step, `404 BRIEFING_NOT_FOUND` for a step without
    a briefing (the optional one), and `400 BRIEFING_COMPLETION_INVALID` for a bad body.
  - The server records what the employee confirmed. It cannot prove they listened.
- **Records.** A record with `briefedAt` but no `status` is still "todo".
  - Completing, reopening or HR's changes keep `briefedAt`, and the delete cascade removes it with
    the progress document.
  - A step that was already done or submitted before briefings existed is not affected.
- **The `Onboarding` view.** Each step adds `briefing` (`{ text, sourceTitle }` or null),
  `briefingRequired` (required and has a briefing) and `briefed`.
- **The gate.** While `briefingRequired && !briefed`, each of these answers
  `409 BRIEFING_REQUIRED`:
  - `POST …/complete`, for self → done and hr_verify → submitted;
  - `GET` and `POST …/check`, unless the check is already passed;
  - `POST /api/me/agent-actions/:id` with `approve`. The action stays pending, so the employee can
    listen to the briefing and approve it then. Declining is never gated.

  A check step's `…/complete` is still `409 CHECK_REQUIRED`. HR's
  `PATCH /api/hr/employees/:id/onboarding/steps/:stepId` is not gated.

- **The checklist agent** never proposes `mark_step` for such a step. `get_onboarding_progress`
  lists `briefing_needed` for each step. `mark_step` answers `briefing_required` with "Before I
  mark it, please listen to Alya's briefing for <step> on your dashboard.", and its store checks
  `briefedAt` again inside the write transaction. As a backstop, the api turns down any
  confirmation the agent still asks for on such a step: it resumes with `confirmed: false` and
  replies with the same sentence.

## Quick questions and first-day details (issue #50)

`GET /api/me/quick-questions` returns at most three chips: the next-step chip (`step:<stepId>`,
asking the step's `askAlya` question), then the track's general chips: personal ones ("Where and
what time do I report on day 1?", "Who will meet me on my first day?") up to the day after the
start date, or when there is none, and knowledge ones ("Explain the company background", "What
are the working hours?", "What's the dress code?") after that, filled from the other kind. Days
are company calendar days (Asia/Kuala_Lumpur). A general chip asking the same question as the
next-step chip is skipped.

Chips follow the company's content pack too (issue #126). Starter companies get
`starterQuickQuestions()`: the knowledge chips `company-overview`, `company-rules` and
`who-to-ask`, whose questions are exactly the `askAlya` of the starter steps
`alignment.company-overview`, `policies.company-rules` and `team-support.who-to-ask` (so a helpful
answer still records that step's briefing), and the same two personal chips. A task's chips
(`?stepId=`) add Luna Digital's related questions (`stepQuestions`) only for Luna Digital; a
starter task offers its own question only. A chat turn's `quickQuestionId` resolves only against
the employee's own pack.

A chat turn names its chip with `quickQuestionId`. Only an employee's own chips count; anything
else is an ordinary question with `quickQuestionId: null`. Knowledge and step chips take the
normal answer path. **Personal chips are answered from `employeeFirstDay` and `job.startDate`
only, never from the documents**: the source reads "Your first-day details from HR", coverage is
`full`, or `none` with a reply that HR hasn't added the details yet.

HR enters the details with `PUT /api/hr/employees/:id/first-day`, a full replacement (left-out
optional fields become null): `location` (≤120), `arrivalTime` (`HH:MM`), `hostName` (≤80),
`hostContact` (≤120) and `notes` (≤300, may span lines). Each save writes a `first_day_updated`
audit row. Problems are `400 FIRST_DAY_INVALID` with `fields: [{ field, problem }]`.

## Chat fields

Account chat turns (every answer mode) carry `coverage`, `category`, `quickQuestionId`,
`reexplainOf` and `proposedAction` in the answer and at the top level of the saved assistant
message (`GET /api/conversations/:id`, next to `feedback`; null for answers saved before them).

- **gemini-chat**: the plan step's structured output adds `category` (`onboarding` or
  `off_topic`) and a short `topic`; the answer step adds `coverage` (`full`, `partial`, `none`).
  Empty retrieval and an answer withheld for having no citations are `none`; clarify and
  conversation turns are null. An invalid coverage with citations is `partial`.
- **document-search**: a match is `full`, none is `none`; category is null.
- **Demo and single-turn Gemini**: both null.
- `reexplainOf` names the assistant message being re-explained (the "Need another
  explanation?" follow-up); it must be an assistant message of the same chat, otherwise
  `404 ANSWER_NOT_FOUND`.
- `proposedAction` is the checklist agent's proposal (see [Checklist agent](#checklist-agent-51)),
  null otherwise.

The "Keep it brief" button's text ("Please keep the answer brief …") now counts as a brief
request in the support observations (`answer-style-preferences.mjs`).

## Checklist agent (#51)

When an employee tells Alya that they finished an onboarding activity, a Google ADK agent
(`agent-platform/onboarding-checklist`) proposes marking the matching step. Nothing changes until
the employee approves.

- **Routing.** Only for employee accounts, and only when `CHECKLIST_AGENT_URL` (the local ADK API
  server, `npm run checklist-agent`) or `CHECKLIST_AGENT_ENGINE` (Vertex AI Agent Engine) is set;
  with neither the feature is off and `proposedAction` is always null.
  - gemini-chat: the plan step has a kind `checklist` for "the employee reports finishing an
    onboarding activity"; its standalone sentence goes to the agent. Without the agent (or for HR)
    that kind is answered as a company question.
  - Other modes: a conservative heuristic (`reportsCompletion` in `server/agent-actions.mjs`): a
    first-person "finished, signed, met, set up, read …" statement; questions, plans and negations
    never match.
  - Personal chips never go to the agent.
- **The agent.** The api creates the session with the employee's account id and track in its
  **state** (`onboardai_account_id`, `onboardai_track`); the tools read them only from there and
  never from the model. `mark_step(step_id)` uses ADK tool confirmation. The rules are F1's (self
  and optional → done, hr_verify → submitted, check → never, pointing to the scenario check;
  already done → said so; unclear → one question). A required step without Alya's briefing is
  never marked (see [Briefings](#briefings-v15)).
  - **The rules are ordered** and the first that applies wins: unclear, already done (a passed
    check included), check, submitted, briefing needed, otherwise propose. Before this ordering,
    "I've read the employee handbook" for a passed check set "check" against "done". Gemini then
    thought for about 7,700 tokens and the run passed the api's 45-second limit, so the employee
    got the "couldn't update your checklist" reply. It now answers "already done" in 4–17 s.
  - **Output cap.** The agent's output is capped at 1,024 tokens (thinking counts), so a run
    cannot think for minutes.
  - **Thinking.** `CHECKLIST_AGENT_THINKING` is `default` (the default) or `low`. Measured on five
    messages × 3 runs, LOW gave the same replies and proposals, with a median of 6.6 s against
    6.8 s. LOW is not adopted: no gain, since a run is several model turns plus tool calls. The write is one Firestore transaction with the
    contract's `onboardingProgress` shape and `source: "alya-agent"`.
- **The proposal.** When the run stops with an `adk_request_confirmation` call, the api stores
  `agentActions/{id}` (`{ id, accountId, conversationId, messageId, stepId, newStatus, status:
"pending", agentSessionId, confirmationCallId, createdAt, expiresAt (+30 minutes), decidedAt:
null }`), answers with the agent's text (or "Shall I mark “…” as done?") and returns
  `proposedAction` (`{ id, stepId, stepTitle, areaTitle, newStatus, status, expiresAt }`), saved
  on the assistant message. A proposal for a step the employee may not mark (a check, an unknown
  id) is answered "no" for them at once, so no card appears.
- **The decision.** `POST /api/me/agent-actions/:id { decision: "approve" | "decline" }`:
  - the owner only, while pending and unexpired, once (a Firestore transaction); anything else,
    another account's action included, is `409 ACTION_NOT_PENDING`; a bad body is
    `400 ACTION_DECISION_INVALID`; an HR account is `403 EMPLOYEE_ROLE_REQUIRED`;
  - the api resumes the agent with the confirmation (`confirmed: true | false`); the agent writes
    the step on approval and replies;
  - the reply is saved as a new assistant message in the same chat, the original message's
    `proposedAction.status` becomes `approved` or `declined`, and the answer is
    `{ action, reply, onboarding }` (`onboarding` is null on decline);
  - when the agent cannot be reached the action goes back to pending
    (`502 CHECKLIST_AGENT_UNAVAILABLE`) and the employee can try again.
- **Expiry and sessions.** A proposal not answered within 30 minutes is shown as `expired` and is
  closed (status set, session deleted) the next time the employee decides or proposes. The agent
  session, which holds the employee's message, is deleted as soon as an action resolves or
  expires, and right away when a run proposes nothing. Agent Engine sessions also get the shortest
  TTL the Sessions API allows (24 hours) in case a delete fails; the local ADK server keeps them in
  memory only.
- `agentActions` hold ids, the step and the status, never message text. Deleting an employee
  deletes them, and also every agent session of that employee: the api lists them by the
  employee's agent user id and deletes each (local ADK server and Agent Engine). When the agent
  cannot be reached the deletion still succeeds and logs the error code; the 24-hour session TTL
  is the backstop.

## Alya's voice: Gemini text to speech (#52)

`VOICE_PROVIDER=gemini` makes `POST /api/voice` call Vertex AI `generateContent` on
`GEMINI_TTS_MODEL` (default `gemini-3.8-flash-tts`, a Preview model) at `GEMINI_TTS_LOCATION`
(default `global`) with `responseModalities: ["AUDIO"]` and the prebuilt voice `GEMINI_TTS_VOICE`
(default **Sulafat**, a warm female voice), with the api's Application Default Credentials. The
route's contract is unchanged: a sentence and a rate in, `audio/wav` out.

- **The prompt is the transcript alone** (prompt format version 2). The request's only text is the
  sentence: no notes, heading, style or pace words.
  - **Why.** Version 1 put "director's notes" (style and pace) before a `TRANSCRIPT` heading in the
    same text. The model read the notes aloud: 9 of 32 clips in the repro, and the user's recording
    ("Director's notes: Style, calm, warm and clear…", 19.4 s for a 4 s sentence). Once it invented
    an opener ("Hi, yeah, just got word on the schedule for the shoot…"). Earlier, a plain
    "Say calmly: …" prefix was also read aloud.
  - **No separate place for style.** `gemini-3.8-flash-tts` answers 400 to a `systemInstruction`,
    and `speechConfig` has no pace field (`speakingRate` is an unknown field). The Cloud
    Text-to-Speech API, which has a separate `prompt` field, is not enabled in the project.
  - **Trade-off.** Gemini speaks in its own natural, even delivery, and the voice rate (0.85, 0.95,
    1, 1.05) has no effect on a Gemini clip. Slower/Faster still changes Kokoro. Measured with the
    transcript alone: 0 extra words and 0 guard trips in 468 clips across 5 live runs (420 of the
    fixed set, 48 longer chunks of up to 210 characters). The acceptance runs were 120 clips direct
    and 120 through the api with `VOICE_PROVIDER=gemini`. Clips of one sentence vary by about 10%
    in length.
- **Pronunciation map** (`server/speech-pronunciation.mjs`). `/api/voice` respells a few names in
  the text it gives the voice, for Gemini and Kokoro alike. The text on screen never changes.
  - **UniVRse** is said "Uni V R se", so the VR is heard.
  - **Alya** is said "Ahl-yuh": two syllables, AHL-yah. As spelled, Gemini mostly said three
    (AH-lee-uh); "Ahl-yuh" came out in two syllables in 5 of 6 trial clips.
  - **Matching.** Only whole words with that exact spelling are respelled, possessives included
    ("UniVRse's"); "universe" and "Kalya" are left alone.
  - **Each entry also lists how a transcriber may write the respelled word** ("Uni VR se",
    "Ahl-yah", "Aaliyah"), so `check:voice` reads it back as the name.
  - **The map has a version** (`pronunciationVersion`) in the Gemini cache key. Raise it whenever
    an entry changes.
  - **Listening samples and the trials** are in `worktrees/qa-evidence/47-onboarding-journey/voice-samples/`
    (never committed).
- **The duration guard** (`server/voice-guard.mjs`) checks every Gemini clip before it is used.
  - **Expected length.** `0.5 s + 0.062 s × units`. Units are the spoken letters (numbers and times
    written out as words, so 08:45 counts as "eight forty five"), plus 3 for each acronym letter
    (HR, CTO), plus 2 more for each letter of capitals inside a word (the VR of UniVRse), 4 for a
    lone capital letter (the B of Tower B, the V and R of "Uni V R se"; not the article "A"), and 6
    for each comma, colon or sentence end. The guard measures the respelled text (below).
  - **Limit.** A clip is rejected when it runs longer than `1.35 × expected + 1 s`.
  - **Calibration.** All 468 transcript-only clips were accepted. The longest ran 1.40 × expected,
    which is 81% of its limit. All 29 clean clips of the repro were accepted, including the slower ones made with the old pace notes
    (at most 1.50 ×). All 11 leaked clips were rejected; the mildest, the invented opener, ran
    1.64 × (8.36 s against a limit of 7.87 s). Kelvin Ong's sentence has a limit of 6.70 s; its
    leaks ran 19.40 s and 15.08 s, and its clean clips 3.72–5.04 s.
  - **On rejection.** The api logs
    `voice_guard_rejected {"model","durationSeconds","expectedSeconds","maxSeconds","attempt"}` (no
    text) and synthesises once more. If the second clip is rejected too, the voice fails with
    `GUARD_REJECTED`: Kokoro speaks the sentence, or, without Kokoro, `/api/voice` answers the
    usual 503 `VOICE_UNAVAILABLE`. A rejected clip is never cached.
  - **Limits of the guard.** A clip with only a word or two too many can pass it. The live check
    below is the test for that.
- **Audio.** `audio/wav` is passed through; raw PCM (`audio/L16;rate=24000`) is wrapped in a WAV
  header, so the player's lip sync keeps scaling to the audio's length.
- **Fallback.** On a Gemini error, a missing token or a 15-second timeout, the api uses the Kokoro
  voice (in process or the tts service). `X-Alya-Voice` names the voice actually used:
  `gemini-sulafat` or `kokoro-af-heart`. The log line names the error code and HTTP status only.
- **Cache.** The last 32 accepted clips are kept in memory, keyed by the prompt version
  (`prompt-v2`), the pronunciation map version (`pron-v1`), model, voice, rate and the respelled
  text. The same sentence requested twice at once is
  synthesised once. The cache lives in the api process only, so a new deploy (a new Cloud Run
  revision, with all traffic sent to it) starts empty. The prompt version in the key also stops a
  clip of another prompt format from being served.
- **Live check: `npm run check:voice`** (`scripts/check-gemini-voice.mjs`).
  - **What it does.** It synthesises 15 fixed, realistic sentences at the 4 rates, in 2 rounds (120
    clips), through `server/gemini-voice.mjs` with ADC. It transcribes each clip with
    `gemini-3.5-transcribe` (global) and prints a table.
  - **When it fails.** On any extra word, any guard trip, or any clip it could not check.
  - **Matching rules.** The comparison ignores case and punctuation, writes out numbers and times
    ("8:45" = "08:45") and contractions, and accepts near spellings. A name or acronym the
    transcriber spells differently ("Universe" or "Una VR" for UniVRse, "CTL" for CTO) is reported
    as heard-as, not as extra. Missing words are reported but do not fail.
  - **Against a running server** (QA, staging):
    `npm run check:voice -- --base-url https://… --cookie-file jar.txt`. The cookie file is a
    signed-in session (a curl cookie jar or a `name=value` line). The check calls `POST /api/voice`,
    and fails on a Kokoro clip unless `--allow-fallback` is given.
  - **Other options.** `--rounds N`, `--sentences FILE`, `--save DIR` (the WAVs and `results.json`)
    and `--concurrency N`. It makes about 240 paid model calls by default.
- `/api/voice` needs a signed-in account (#55), so the paid model is never called anonymously.
- **`/api/config` names the configured voice** (QA F-3) in
  `voice: { id, label, provider }`:
  - `id` is exactly the `X-Alya-Voice` value of a clip in that voice;
  - with `VOICE_PROVIDER=gemini` it is `{ id: "gemini-sulafat", label: "Alya · Sulafat (Gemini)",
provider: "gemini" }`;
  - otherwise it is `{ id: "kokoro-af-heart", label: "Alya · Heart", provider: "kokoro" }`.

  When a clip's `X-Alya-Voice` differs from `voice.id`, the Kokoro fallback spoke.
  `sharedVoiceName` stays as it was (`Alya · Heart (English)`), for compatibility.

## Support requests (D1 Option A)

HR sees an individual's struggles only when that employee confirms a support request.

1. `POST /api/me/support-requests/preview { conversationId, messageId }` returns exactly what HR
   will see: the question, Alya's answer and its sources, never the rest of the chat. The message
   must be an assistant message of the caller's own chat (404 otherwise). Previewing stores
   nothing. For a re-explained answer (saved with `reexplainOf`), the question is the employee's
   original one: the chain of re-explanations is followed back to the first answer without
   `reexplainOf`, never the app's "Please explain this step by step…" prompt. The answer and
   sources are those of the message the employee chose.
2. `POST /api/me/support-requests { conversationId, messageId, note? }` (note ≤500) creates the
   request (201). The id is derived from the account, chat and message, so the same answer again
   returns the existing request (200). It also records the chat's existing "I need a person"
   observation, so team insights count it.
3. `GET /api/me/support-requests` shows the employee's requests with status and briefing time,
   never HR's note.
4. HR lists them (`GET /api/hr/support-requests`, open first, then newest first, with the
   employee's ID and display name) and works them with `PATCH /api/hr/support-requests/:id`:
   `status` (`open`, `briefing_scheduled`, `resolved`), `hrNote` (≤1000), `briefingAt` (ISO 8601
   with a time zone; required while `briefing_scheduled`, `400 BRIEFING_TIME_REQUIRED`),
   `docNeedsUpdate` and `docToUpdate` (one of the request's source titles; setting it marks
   `docNeedsUpdate`, and clearing `docNeedsUpdate` clears it). Each change writes a
   `support_request_updated` audit row with the request id and status.

The named per-employee automatic summaries (`GET /api/hr/support-summaries`) were removed.
`GET /api/hr/team-insights` sums every employee's support observations (turns, feedback,
delivered formats, explicit requests, human-help requests and the period as calendar days) and
returns them only when at least 3 employees have recorded activity; with fewer it says only how
many have data. `openSupportRequests` is always given. Each employee's recording choice
(`POST /api/support-summary/settings`) is respected.

## Knowledge gaps (issue #49)

A fresh employee turn is logged as a gap only when its category is `onboarding`, its coverage is
`none`, it is not a personal chip and not a re-explanation of an earlier answer. Repeated
requests are not logged twice, and HR accounts' own questions are not logged. The gap holds:

- `questionRedacted`: the question with emails, phone numbers (Malaysian `+60`, `01x` and
  landline formats, and other international numbers), Malaysian IC numbers (with or without
  dashes) and Employee IDs such as `PC-0001` replaced by `[email]`, `[phone]`, `[IC number]` and
  `[employee ID]`;
- `topic` (redacted, lower case), `track`, `nearestSource` (the top retrieved passage, or null)
  and `createdDay` (the company calendar day).

Redaction is regular-expression based and best-effort (MVP); names are not removed. A gap never
holds an account id, a conversation id or a time of day. Firestore itself records each
document's write time as metadata; the API never exposes it. `GET /api/hr/knowledge-gaps` groups
gaps by topic, highest count first, with at most three recent examples, the tracks and the
nearest sources. A failed gap write never fails the answer.

## Deletion

Deleting an employee (`DELETE /api/hr/employees/:id`) also deletes their `onboardingProgress`,
`employeeFirstDay`, `supportRequests` and `agentActions` (in `employee-profiles.mjs`, before the
profile and the account), and the checklist agent's sessions of that employee (best effort).
Knowledge gaps stay: they are anonymous.
