import { randomUUID } from 'node:crypto';
import { ChatError } from './chat-errors.mjs';
import { createStorageCall } from './firestore-client.mjs';
import { asProfileStorageError } from './employee-profiles.mjs';
import { journeyCollections } from './onboarding-collections.mjs';
import { alyaAssessmentReply, parseChatAiAssessment } from './ai-proficiency.mjs';
import { findStep, needsDocument } from './onboarding-progress.mjs';

// Proposed checklist changes (#51). When an employee tells Alya they finished
// an onboarding activity, the checklist agent proposes marking one step (ADK
// tool confirmation). The api keeps that proposal in agentActions/{id}:
//
//   { id, accountId, conversationId, messageId, stepId,
//     newStatus: "done" | "submitted",
//     status: "pending" | "approved" | "declined" | "expired",
//     agentSessionId, confirmationCallId, createdAt, expiresAt, decidedAt }
//
// Nothing changes until the employee decides (POST /api/me/agent-actions/:id):
// only the owner, only while pending and unexpired, once (a Firestore
// transaction). The agent is then resumed with the answer and writes the step
// itself; its reply becomes a new assistant message in the same chat, and the
// original message's proposedAction shows the new status. The agent session
// (which holds the employee's message) is deleted once the action resolves or
// expires.
export const ACTION_TTL_MS = 30 * 60 * 1000;
export const checklistSource = 'Your onboarding checklist';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export const agentActionErrors = {
  notPending: () =>
    new ChatError(409, 'ACTION_NOT_PENDING', 'This change is no longer waiting for your answer.'),
  decisionInvalid: () =>
    new ChatError(400, 'ACTION_DECISION_INVALID', 'Choose approve or decline.'),
  agentUnavailable: () =>
    new ChatError(
      502,
      'CHECKLIST_AGENT_UNAVAILABLE',
      'Alya could not update your checklist right now. Please try again, or mark the step on your dashboard.',
    ),
};

// What marking a step means (onboarding-progress.mjs rules): self and optional
// steps become done, hr_verify steps submitted, check steps never.
export function newStatusOf(step, areaId = null) {
  // A document step is finished by uploading the document, never by chat.
  if (areaId && needsDocument(areaId, step)) return null;
  if (step.required === false || step.completion === 'self') return 'done';
  if (step.completion === 'hr_verify') return 'submitted';
  return null;
}

// The ProposedAction of contract v1.3.
export function proposedActionView(doc, template) {
  const found = template ? findStep(template, doc.stepId) : null;
  return {
    id: doc.id,
    stepId: doc.stepId,
    stepTitle: found?.step.title ?? doc.stepId,
    areaTitle: found?.area.title ?? '',
    newStatus: doc.newStatus,
    status: doc.status,
    expiresAt: doc.expiresAt,
  };
}

export const proposalText = (view) =>
  view.newStatus === 'submitted'
    ? `Shall I mark “${view.stepTitle}” as submitted? HR then verifies it.`
    : `Shall I mark “${view.stepTitle}” as done?`;
// The agent's reply when a step still needs Alya's briefing (contract v1.5).
export const briefingFirstText = (title) =>
  `Before I mark it, please listen to Alya’s briefing for “${title}” on your dashboard.`;
const fallbackReply = {
  approved: 'Done. Your onboarding checklist is updated.',
  declined: 'Okay, I left your onboarding checklist unchanged.',
};

// A conservative check for "I finished an onboarding activity" in the modes
// without the Gemini plan step (document search, sample answers). Questions,
// plans, negations, and AI proficiency rating/skip statements are never matched.
export function reportsCompletion(question) {
  if (parseChatAiAssessment(question)) return false;
  const text = String(question || '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .trim();
  if (!text || text.length > 200 || /\?\s*$/.test(text)) return false;
  if (
    /^(how|what|where|when|who|which|why|can|could|should|shall|do|does|did|is|are|am|will|would|may|please|tell|explain)\b/.test(
      text,
    )
  )
    return false;
  if (
    /\b(not yet|haven't|have not|hasn't|didn't|did not|don't|do not|can't|cannot|couldn't|won't|unable|still need|need to|going to|will|want to|plan to|about to|trying to)\b/.test(
      text,
    )
  )
    return false;
  return (
    /\b(i|i've|i have|i just|i already|we|we've|we have)\b[^.!?]{0,40}\b(finished|completed|done|signed|submitted|met|set up|read|uploaded|sent|added|returned|attended|collected|joined|agreed|taken|took|accepted|created|linked|connected|opened|shared|studied|updated|checked|practiced)\b/.test(
      text,
    ) || /^(done|finished|completed)\b/.test(text)
  );
}

export function createAgentActions({
  // A Firestore instance, or an async function returning one.
  firestore,
  // The checklist agent (checklist-agent-client.mjs).
  agent,
  // The onboarding journey service (onboarding-journey.mjs).
  journey,
  // () => the saved-chat store holding account chats.
  chatMemory,
  now = () => new Date(),
  ttlMs = ACTION_TTL_MS,
  timeoutMs,
  log = (line) => console.warn(line),
}) {
  let client = null;
  const database = async () =>
    (client ??= await (typeof firestore === 'function' ? firestore() : firestore));
  const call = createStorageCall({ timeoutMs, log });
  const guarded = async (operation, fn) => {
    try {
      return await call(operation, fn);
    } catch (error) {
      throw asProfileStorageError(error);
    }
  };
  const collection = async () => (await database()).collection(journeyCollections.agentActions);
  const owner = (accountId) => `account:${accountId}`;
  const forget = (doc) =>
    agent.remove({ accountId: doc.accountId, sessionId: doc.agentSessionId }).catch(() => {});

  // Pending actions of this account that are past their time become expired,
  // and their agent sessions are deleted. Best effort.
  async function expireOld(accountId) {
    try {
      const at = now().toISOString();
      const found = await guarded('read agent actions', async () =>
        (await collection()).where('accountId', '==', accountId).get(),
      );
      for (const snapshot of found.docs) {
        const doc = snapshot.data();
        if (doc.status !== 'pending' || doc.expiresAt > at) continue;
        await guarded('expire agent action', async () => {
          await snapshot.ref.set({ ...doc, status: 'expired', decidedAt: at });
        });
        await forget(doc);
        await chatMemory()
          .amendMessage(owner(accountId), doc.conversationId, doc.messageId, {
            proposedAction: { ...(await viewOf(doc, accountId)), status: 'expired' },
          })
          .catch(() => {});
      }
    } catch {
      log('Checklist agent: expiring old proposals failed.');
    }
  }
  async function viewOf(doc, accountId) {
    const account = { id: accountId, role: 'employee' };
    const track = await journey.trackFor(account);
    return proposedActionView(doc, await journey.template(track));
  }

  // A chat turn the plan (or the heuristic) routed to the agent. Resolves to
  // { answer, proposedAction } for the turn's assistant message.
  async function propose({ account, conversationId, messageId, text, signal }) {
    const assessment = parseChatAiAssessment(text);
    if (assessment && typeof journey.saveAiProficiency === 'function') {
      const saved = await journey.saveAiProficiency(account, assessment);
      return {
        answer: alyaAssessmentReply(saved.aiProficiency),
        proposedAction: null,
      };
    }
    await expireOld(account.id);
    const track = await journey.trackFor(account);
    let outcome;
    try {
      outcome = await agent.start({
        accountId: account.id,
        track,
        text,
        signal,
        companyId: account.companyId,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      log(
        `Checklist agent: ${JSON.stringify({ operation: 'start', outcome: error?.code || error?.name })}`,
      );
      return {
        answer:
          'I couldn’t update your onboarding checklist just now. You can mark the step on your onboarding dashboard.',
        proposedAction: null,
      };
    }
    const session = { accountId: account.id, agentSessionId: outcome.sessionId };
    if (!outcome.confirmation) {
      await forget(session);
      return {
        answer:
          outcome.text || 'I couldn’t find that step on your checklist. Which step did you finish?',
        proposedAction: null,
      };
    }
    const template = await journey.template(track);
    const found = findStep(template, outcome.confirmation.stepId);
    const newStatus = found ? newStatusOf(found.step, found.area.id) : null;
    const documentStep = Boolean(found) && needsDocument(found.area.id, found.step);
    // A step that still needs its briefing is never proposed, even when the
    // agent asks (the agent itself refuses such steps; this is the backstop).
    const unbriefed = Boolean(newStatus) && (await journey.briefingNeeded(account, found.step.id));
    if (!newStatus || unbriefed) {
      // The agent asked about a step it may not mark: answer no for the
      // employee, so nothing can change, and give its reply.
      let reply = null;
      try {
        reply = await agent.resume({
          accountId: account.id,
          sessionId: outcome.sessionId,
          callId: outcome.confirmation.callId,
          confirmed: false,
          signal,
        });
      } catch {
        // The fixed text below.
      }
      await forget(session);
      return {
        answer: unbriefed
          ? briefingFirstText(found.step.title)
          : documentStep
            ? `Please upload your document for “${found.step.title}” under Documentation on your dashboard. It counts as submitted once it is saved there; telling me is not enough.`
            : reply?.text ||
              'That step is completed on your onboarding dashboard, for example with its scenario check.',
        proposedAction: null,
      };
    }
    const at = now();
    const doc = {
      id: randomUUID(),
      accountId: account.id,
      conversationId,
      messageId,
      stepId: found.step.id,
      newStatus,
      status: 'pending',
      agentSessionId: outcome.sessionId,
      confirmationCallId: outcome.confirmation.callId,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
      decidedAt: null,
    };
    try {
      await guarded('save agent action', async () => {
        await (await collection()).doc(doc.id).create(doc);
      });
    } catch (error) {
      await forget(doc);
      throw error;
    }
    const proposedAction = proposedActionView(doc, template);
    return { answer: outcome.text || proposalText(proposedAction), proposedAction };
  }

  // POST /api/me/agent-actions/:id { decision } -> { action, reply, onboarding }.
  async function decide(account, id, body) {
    const decision = isPlainObject(body) ? body.decision : undefined;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some((key) => key !== 'decision') ||
      !['approve', 'decline'].includes(decision)
    )
      throw agentActionErrors.decisionInvalid();
    if (typeof id !== 'string' || !idPattern.test(id)) throw agentActionErrors.notPending();
    const status = decision === 'approve' ? 'approved' : 'declined';
    // Approving needs the step's briefing first (v1.5); the action stays
    // pending, so the employee can listen to it and approve after.
    if (status === 'approved') {
      const pending = await guarded('read agent action', async () => {
        const snapshot = await (await collection()).doc(id).get();
        return snapshot.exists ? snapshot.data() : null;
      });
      if (pending?.accountId === account.id && pending.status === 'pending')
        await journey.requireBriefed(account, pending.stepId);
    }
    const decidedAt = now().toISOString();
    // Claim it once, in a transaction: owner only, pending and unexpired.
    const claimed = await guarded('decide agent action', async () => {
      const db = await database();
      const ref = db.collection(journeyCollections.agentActions).doc(id);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const doc = snapshot.exists ? snapshot.data() : null;
        if (!doc || doc.accountId !== account.id || doc.status !== 'pending')
          return { outcome: 'not_pending' };
        if (doc.expiresAt <= decidedAt) {
          const expired = { ...doc, status: 'expired', decidedAt };
          tx.set(ref, expired);
          return { outcome: 'expired', doc: expired };
        }
        const next = { ...doc, status, decidedAt };
        tx.set(ref, next);
        return { outcome: 'claimed', doc: next, before: doc };
      });
    });
    if (claimed.outcome === 'expired') {
      await forget(claimed.doc);
      await chatMemory()
        .amendMessage(owner(account.id), claimed.doc.conversationId, claimed.doc.messageId, {
          proposedAction: await viewOf(claimed.doc, account.id),
        })
        .catch(() => {});
    }
    if (claimed.outcome !== 'claimed') throw agentActionErrors.notPending();
    const doc = claimed.doc;
    let outcome;
    try {
      outcome = await agent.resume({
        accountId: account.id,
        sessionId: doc.agentSessionId,
        callId: doc.confirmationCallId,
        confirmed: status === 'approved',
      });
    } catch (error) {
      // Put the action back so the employee can try again.
      log(
        `Checklist agent: ${JSON.stringify({ operation: 'resume', outcome: error?.code || error?.name })}`,
      );
      await guarded('reopen agent action', async () => {
        const db = await database();
        const ref = db.collection(journeyCollections.agentActions).doc(id);
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(ref)).data();
          if (current?.status === status && current.decidedAt === decidedAt)
            tx.set(ref, claimed.before);
        });
      }).catch(() => {});
      throw agentActionErrors.agentUnavailable();
    }
    await forget(doc);
    const action = await viewOf(doc, account.id);
    const reply = outcome.text || fallbackReply[status];
    const memory = chatMemory();
    try {
      await memory.amendMessage(owner(account.id), doc.conversationId, doc.messageId, {
        proposedAction: action,
      });
      await memory.appendMessage(owner(account.id), doc.conversationId, {
        id: `${doc.id}-reply`,
        requestId: null,
        role: 'assistant',
        text: reply,
        result: {
          answer: reply,
          mode: 'checklist-agent',
          passages: [],
          source: checklistSource,
          card: null,
          coverage: null,
          category: 'onboarding',
          quickQuestionId: null,
          reexplainOf: null,
          proposedAction: null,
        },
        coverage: null,
        category: 'onboarding',
        quickQuestionId: null,
        reexplainOf: null,
        proposedAction: null,
      });
    } catch (error) {
      log(
        `Checklist agent: ${JSON.stringify({ operation: 'save reply', outcome: error?.code || error?.name })}`,
      );
    }
    return {
      action,
      reply,
      onboarding: status === 'approved' ? await journey.myOnboarding(account) : null,
    };
  }

  // The employee is being deleted (#51): delete every agent session of the
  // account, which may hold their messages. Never throws: when the agent
  // cannot be reached the deletion goes on, and the sessions' TTL (Agent
  // Engine, 24 hours) or a restart (the local server keeps them in memory)
  // removes them.
  async function forgetAccount(accountId) {
    try {
      const removed = await agent.removeUser({ accountId });
      return { removed };
    } catch (error) {
      log(
        'Checklist agent: ' +
          JSON.stringify({
            operation: 'delete employee sessions',
            outcome: error?.code || error?.name || 'UNKNOWN',
          }),
      );
      return { removed: null };
    }
  }

  return { propose, decide, expireOld, forgetAccount };
}
