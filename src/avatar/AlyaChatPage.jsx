import React, { useEffect, useId, useRef, useState } from 'react';
import AlyaPresentationStage from './AlyaPresentationStage';
import OnboardingChecklist, { useOnboardingChecklist } from './OnboardingChecklist';
import Icon from '../portal/Icon';
import { createServerSpeech } from './answer-audio-player';
import { answerReply, presentAnswer } from './chat-answer-presentation.mjs';
import { replySentences } from './short-answer.mjs';
import { answerSpeech, plainSpeech } from './spoken-answer.mjs';
import {
  backupVoiceNote,
  configuredVoiceLabel,
  naturalPaceLine,
  showsSpeedControl,
  usingBackupVoice,
} from './voice-label.mjs';
import AnswerStyleSettings, { learningFormats } from './AnswerStyleSettings';
import SupportRequestDialog from './SupportRequestDialog';
import ProposedActionCard from './ProposedActionCard';
import QuickQuestionChips from './QuickQuestionChips';
import BriefingEntry from './BriefingEntry';
import {
  briefingAction,
  briefingErrorMessage,
  briefingMessage,
  findBriefing,
  listenedCompletion,
  readButtonLabel,
} from './briefing-flow.mjs';
import { findStep, stepErrorMessage } from '../access/onboarding-view.mjs';
import { ensureSession, reportAccountResponse } from '../access/account-api.mjs';
import { journeyApi } from '../access/journey-api.mjs';
import {
  actionDecisionError,
  answerExtras,
  askHrLabels,
  askHrOffer,
  chatExtras,
  helpfulStepId,
  noAnswerNote,
  reexplainForward,
  requestStatusWord,
  takeHandoff,
  peekHandoffStepId,
  visibleChips,
} from '../access/support-flow.mjs';
import './employee-support.css';
import './answer-support-controls.css';
import './alya-chat.css';
import './alya-workspace.css';
import './alya-presentation.css';
import './clothing-presentation.css';
import './automatic-presentation.css';
import './alya-mobile.css';

export { presentAnswer } from './chat-answer-presentation.mjs';

const preferenceKey = 'univrse-alya-voice-v1';
const activeChatKey = 'univrse-alya-active-chat-v1';
function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey));
    return {
      enabled: value?.enabled !== false,
      voiceURI: typeof value?.voiceURI === 'string' ? value.voiceURI : '',
      rate: [0.85, 0.95, 1.05].includes(value?.rate) ? value.rate : 0.95,
      reducedMotion: value?.reducedMotion === true,
    };
  } catch {
    return { enabled: true, voiceURI: '', rate: 0.95, reducedMotion: false };
  }
}
const greeting = {
  id: 'welcome',
  role: 'assistant',
  text: 'Hi, I’m Alya. Welcome to OnboardAi. Ask me about your company or any onboarding task.',
  intro: true,
};
function Message({
  message,
  onRetry,
  onCopy,
  onFeedback,
  onSupport,
  onHumanHelp,
  onOpenSupport,
  disabled,
  memoryEnabled,
  formatsEnabled = true,
  onAskHr,
  onDecide,
  actionBusy = false,
  actionError = '',
}) {
  const offer = askHrOffer(message);
  const forward = reexplainForward(message);
  const [fullOpen, setFullOpen] = useState(false);
  const fullId = useId();
  if (message.role === 'user')
    return (
      <article className="alya-message user">
        <span>You</span>
        <p>{message.text}</p>
      </article>
    );
  // The visible short reply is exactly what Alya speaks and what the stage shows.
  const reply =
    message.intro || message.error || message.plain ? [] : replySentences(answerReply(message));
  const sentences = reply.length ? reply : [message.text];
  return (
    <article
      className={'alya-message assistant ' + (message.error ? 'error' : '')}
      data-message-id={message.id}
      tabIndex={-1}
    >
      <div className="alya-message-author">
        <span className="alya-message-mark">A</span>
        <strong>Alya</strong>
        {!message.intro && !message.error && (
          <small>
            {message.mode === 'document-search'
              ? 'DOCUMENT SEARCH'
              : message.mode === 'demo'
                ? 'SAMPLE ANSWER'
                : 'COMPANY ASSISTANT'}
          </small>
        )}
      </div>
      <div className="alya-answer-body">
        {message.plain ? (
          <p>{message.text}</p>
        ) : message.error ? (
          <>
            <p>{message.error}</p>
            <button className="alya-retry" onClick={() => onRetry(message)}>
              <Icon name="arrow" size={15} />
              Try again
            </button>
          </>
        ) : (
          <>
            {!message.intro && reply.length > 0 && message.replyHeading && (
              <p className="alya-reply-heading">{message.replyHeading}</p>
            )}
            {message.intro ? (
              <p>{message.text}</p>
            ) : message.learning?.format === 'steps' ? (
              <ol className="alya-short-steps" aria-label="Explanation in smaller steps">
                {sentences.map((sentence, index) => (
                  <li key={index}>{sentence}</li>
                ))}
              </ol>
            ) : (
              <div className="alya-short-reply">
                <p className="alya-answer-lead">{sentences[0]}</p>
                {sentences.length > 1 && <p>{sentences.slice(1).join(' ')}</p>}
              </div>
            )}
            {!message.intro && message.replyNote && (
              // A hint for the reader. It is not part of the reply, so it is never spoken.
              <p className="alya-reply-note">{message.replyNote}</p>
            )}
            {!message.intro && (
              <div className={'alya-full-reply' + (fullOpen ? ' is-open' : '')}>
                <button
                  type="button"
                  className="alya-full-toggle"
                  aria-expanded={fullOpen}
                  aria-controls={fullId}
                  onClick={() => setFullOpen(!fullOpen)}
                >
                  {message.passages?.length ? 'Full answer and sources' : 'Full answer'}
                  <Icon name="down" size={13} />
                </button>
                <div className="alya-full-body" id={fullId} hidden={!fullOpen}>
                  <p>{message.text}</p>
                  {message.passages?.length > 0 && (
                    <details className="alya-source-group">
                      <summary>
                        <Icon name="book" size={13} />
                        Company sources ({message.passages.length})
                        <Icon name="down" size={13} />
                      </summary>
                      {message.passages.map((passage, index) => (
                        <section key={index}>
                          <h4>{passage.heading || passage.title}</h4>
                          <small>{passage.title}</small>
                          <p>{passage.text}</p>
                        </section>
                      ))}
                    </details>
                  )}
                </div>
              </div>
            )}
            {!message.intro && !message.error && memoryEnabled && (
              <details className="alya-help-controls" open={forward ? true : undefined}>
                <summary>
                  {formatsEnabled ? 'Need another explanation?' : 'Need human support?'}
                  <Icon name="down" size={13} />
                </summary>
                <div className="alya-answer-tools" aria-label="Answer support options">
                  {formatsEnabled && (
                    <>
                      <button disabled={disabled} onClick={() => onSupport(message, 'steps')}>
                        <Icon name="checklist" size={13} />
                        Smaller steps
                      </button>
                      <button disabled={disabled} onClick={() => onSupport(message, 'example')}>
                        <Icon name="spark" size={13} />
                        Show example
                      </button>
                      <button disabled={disabled} onClick={() => onSupport(message, 'brief')}>
                        Keep it brief
                      </button>
                    </>
                  )}
                  <button
                    disabled={disabled || message.humanHelpRequested || !!message.supportRequest}
                    onClick={() => onHumanHelp(message)}
                  >
                    <Icon name="people" size={13} />I need a person
                  </button>
                </div>
              </details>
            )}
            {!message.intro && memoryEnabled && (
              <div className="alya-answer-feedback" aria-label="Feedback on this answer">
                <span>Did this help?</span>
                <button
                  disabled={disabled}
                  aria-pressed={message.feedback === 'helpful'}
                  onClick={() =>
                    onFeedback(message, message.feedback === 'helpful' ? null : 'helpful')
                  }
                >
                  <Icon name="check" size={13} />
                  Helpful
                </button>
                <button
                  disabled={disabled}
                  aria-pressed={message.feedback === 'unclear'}
                  onClick={() =>
                    onFeedback(message, message.feedback === 'unclear' ? null : 'unclear')
                  }
                >
                  <Icon name="help" size={13} />
                  Still unclear
                </button>
              </div>
            )}
            {offer && !message.supportRequest && (
              <div className="alya-ask-hr">
                <p>
                  {offer === 'no-answer'
                    ? noAnswerNote(message)
                    : 'Still not clear after a second explanation? HR can follow up with you.'}
                </p>
                <button type="button" disabled={disabled} onClick={() => onAskHr(message)}>
                  {askHrLabels[offer]}
                </button>
              </div>
            )}
            {message.supportRequest && (
              <p
                className="alya-ask-hr-sent"
                role="status"
                tabIndex={-1}
                data-ask-hr-status={message.id}
              >
                Sent to HR. Status: {requestStatusWord(message.supportRequest.status)}.
              </p>
            )}
            {message.proposedAction && (
              <ProposedActionCard
                action={message.proposedAction}
                busy={actionBusy}
                error={actionError}
                onDecide={(decision) => onDecide(message, decision)}
              />
            )}
            {message.learning && (
              <span className="alya-answer-format">
                {learningFormats[message.learning.format] || learningFormats.standard}
              </span>
            )}
            {!message.intro && (
              <div className="alya-answer-footer">
                <span>
                  <Icon name={message.mode === 'demo' ? 'info' : 'book'} size={12} />
                  {message.mode === 'document-search'
                    ? message.passages?.length
                      ? 'From your connected company documents'
                      : 'No matching company passage'
                    : message.source || 'Company assistant'}
                </span>
                <button aria-label="Copy answer" onClick={() => onCopy(message.text)}>
                  <Icon name="copy" size={14} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

export default function AlyaChatPage({ navigate }) {
  const checklist = useOnboardingChecklist();
  // Alya's briefing on a step (v1.5): { stepId, step, messageId, phase, completion, error }.
  //   phase: loading | presenting | recording | done | acting | completed
  const [briefing, setBriefing] = useState(null);
  const briefingRef = useRef(null);
  briefingRef.current = briefing;
  const savedChatKey = activeChatKey;
  const [preferences, setPreferences] = useState(readPreferences),
    [speechState, setSpeechState] = useState({ state: 'idle', error: '' }),
    [config, setConfig] = useState(null),
    [connectionError, setConnectionError] = useState(''),
    [messages, setMessages] = useState([greeting]),
    [question, setQuestion] = useState(''),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [copied, setCopied] = useState(false);
  const [conversations, setConversations] = useState([]),
    [conversationId, setConversationId] = useState(''),
    [historyOpen, setHistoryOpen] = useState(false),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState(''),
    [deleteConfirm, setDeleteConfirm] = useState(false);
  const [learning, setLearning] = useState(null),
    [learningOpen, setLearningOpen] = useState(false),
    [learningBusy, setLearningBusy] = useState(false);
  const [supportBusy, setSupportBusy] = useState(false),
    [supportError, setSupportError] = useState('');
  const [selectedAnswerId, setSelectedAnswerId] = useState('');
  const [chips, setChips] = useState([]),
    [sentRequests, setSentRequests] = useState({}),
    [supportDialog, setSupportDialog] = useState(null),
    [actionBusy, setActionBusy] = useState(''),
    [actionErrors, setActionErrors] = useState({});
  const handoffTaken = useRef(false);
  // The task Alya was opened from: her suggested questions follow it.
  const contextStepId = useRef(null);
  if (contextStepId.current === null)
    contextStepId.current = (() => {
      try {
        return peekHandoffStepId(window.sessionStorage) || '';
      } catch {
        return '';
      }
    })();
  // The voice settings popover closes on Escape (focus back to its toggle) and
  // on a click outside it, so it never blocks the question box (QA E-1).
  const settingsButton = useRef(null),
    settingsPanel = useRef(null);
  useEffect(() => {
    if (!settings) return;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setSettings(false);
      settingsButton.current?.focus();
    };
    const onPointer = (event) => {
      if (
        settingsPanel.current?.contains(event.target) ||
        settingsButton.current?.contains(event.target)
      )
        return;
      setSettings(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [settings]);
  // The answer whose voice is playing; only that answer's scenes follow the audio.
  const [spokenAnswerId, setSpokenAnswerId] = useState(''),
    [voiceSupported, setVoiceSupported] = useState(true),
    [voiceUsed, setVoiceUsed] = useState('');
  const speechRef = useRef(null),
    preferencesRef = useRef(preferences),
    request = useRef(null),
    sequence = useRef(0),
    chatLog = useRef(null),
    inputRef = useRef(null),
    configAbort = useRef(null),
    copyTimer = useRef(null),
    historyAbort = useRef(null),
    learningAbort = useRef(null);
  preferencesRef.current = preferences;
  useEffect(() => {
    const speech = createServerSpeech({ onStatus: setSpeechState, onVoice: setVoiceUsed });
    speechRef.current = speech;
    setVoiceSupported(speech.supported);
    if (!speech.supported)
      setSpeechState({
        state: 'unavailable',
        error: 'Audio playback is unavailable in this browser. Text chat still works.',
      });
    const cancelOnLeave = () => speech.stop();
    window.addEventListener('pagehide', cancelOnLeave);
    return () => {
      sequence.current++;
      request.current?.abort();
      configAbort.current?.abort();
      historyAbort.current?.abort();
      learningAbort.current?.abort();
      clearTimeout(copyTimer.current);
      speech.dispose();
      window.removeEventListener('pagehide', cancelOnLeave);
      speechRef.current = null;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    } catch {}
  }, [preferences]);
  async function connect() {
    configAbort.current?.abort();
    const abort = new AbortController();
    configAbort.current = abort;
    setConnectionError('');
    setConfig(null);
    try {
      const data = await jsonRequest('/api/config', { signal: abort.signal });
      if (!Array.isArray(data.tasks) || !data.tasks.length) throw new Error();
      if (data.conversationMemory) {
        const list = await jsonRequest('/api/conversations', { signal: abort.signal });
        let active;
        try {
          active = localStorage.getItem(savedChatKey);
        } catch {}
        const selected = list.conversations.find((c) => c.id === active) || list.conversations[0];
        const chat = selected
          ? await jsonRequest('/api/conversations/' + selected.id, { signal: abort.signal })
          : await jsonRequest('/api/conversations', { method: 'POST', signal: abort.signal });
        abort.signal.throwIfAborted();
        applyChat(chat);
        setConversations(selected ? list.conversations : [chat]);
      }
      setConfig(data);
      loadChips();
      loadSentRequests();
    } catch (error) {
      if (error.name !== 'AbortError')
        setConnectionError(
          error.message || 'The assistant connection is unavailable. Please try reconnecting.',
        );
    }
  }
  useEffect(() => {
    connect();
  }, []);
  // Suggested questions for a signed-in employee. Failing quietly is fine: the
  // composer still works without them.
  // Requests already sent keep their "Sent to HR" line after a reload.
  async function loadSentRequests() {
    try {
      const data = await journeyApi.mySupportRequests();
      setSentRequests(
        Object.fromEntries(
          (data.requests || []).filter((r) => r.messageId).map((r) => [r.messageId, r]),
        ),
      );
    } catch {}
  }
  async function loadChips() {
    try {
      setChips(
        visibleChips(
          await journeyApi.quickQuestions(
            contextStepId.current ? { stepId: contextStepId.current } : {},
          ),
        ),
      );
    } catch {
      setChips([]);
    }
  }
  // From the dashboard: "Ask Alya" sends a step's question as its chip, and
  // "Ask Alya" on a step with a briefing presents it here (no chat request).
  useEffect(() => {
    if (handoffTaken.current || !config) return;
    if (config.conversationMemory && !conversationId) return;
    handoffTaken.current = true;
    const handoff = takeHandoff(window.sessionStorage, ['chip', 'briefing']);
    if (handoff?.kind === 'briefing') startBriefing(handoff.stepId);
    else if (handoff) ask(handoff.question, null, null, { quickQuestionId: handoff.id });
  }, [config, conversationId]);
  async function startBriefing(stepId) {
    stopVoice();
    setBriefing({ stepId, phase: 'loading', error: '' });
    try {
      const found = findBriefing(await journeyApi.onboarding(), stepId);
      if (found.missing) {
        setBriefing(null);
        setMessages((previous) => [
          ...previous,
          { id: 'briefing-missing-' + stepId, role: 'assistant', plain: true, text: found.missing },
        ]);
        return;
      }
      const message = briefingMessage(found.step);
      const earlier = found.step.briefed === true;
      setMessages((previous) => [...previous.filter((m) => m.id !== message.id), message]);
      setSelectedAnswerId(message.id);
      setBriefing({
        stepId,
        step: found.step,
        messageId: message.id,
        phase: earlier ? 'done' : 'presenting',
        completion: earlier ? 'earlier' : null,
        error: '',
      });
      if (preferencesRef.current.enabled) speakBriefing(message);
    } catch (error) {
      setBriefing(null);
      setMessages((previous) => [
        ...previous,
        {
          id: 'briefing-error-' + stepId,
          role: 'assistant',
          plain: true,
          text: briefingErrorMessage(error),
        },
      ]);
    }
  }
  // Only playback that reaches its natural end counts as "listened"; a stop,
  // an interruption or leaving the page resolves differently and records nothing.
  async function speakBriefing(message) {
    const speech = answerSpeech(message);
    if (!speech.text) return;
    setSpokenAnswerId(message.id);
    const outcome = await speechRef.current?.speak(speech.text, {
      ...preferencesRef.current,
      segments: speech.segments,
    });
    const completion = listenedCompletion(outcome);
    if (completion && briefingRef.current?.messageId === message.id) recordBriefing(completion);
  }
  async function recordBriefing(completion) {
    const current = briefingRef.current;
    if (!current || current.phase !== 'presenting') return;
    const same = (b) => b && b.stepId === current.stepId;
    setBriefing({ ...current, phase: 'recording', error: '', lastCompletion: completion });
    try {
      const found = findStep(
        await journeyApi.recordBriefing(current.stepId, completion),
        current.stepId,
      );
      setBriefing((b) =>
        same(b) ? { ...b, phase: 'done', completion, step: found?.step || b.step } : b,
      );
      loadChips();
    } catch (error) {
      setBriefing((b) =>
        same(b) ? { ...b, phase: 'presenting', error: briefingErrorMessage(error) } : b,
      );
    }
  }
  // The card after the briefing (#66): Mark as completed or Mark as submitted
  // completes the step here; a check step's question is answered in the card.
  async function actOnBriefing() {
    const current = briefingRef.current;
    if (!current) return;
    const action = briefingAction(current.step);
    if (action.kind !== 'complete' || current.phase === 'acting') return;
    const same = (b) => b && b.stepId === current.stepId;
    setBriefing({ ...current, phase: 'acting', error: '' });
    try {
      const found = findStep(await journeyApi.completeStep(current.stepId), current.stepId);
      setBriefing((b) =>
        same(b)
          ? { ...b, phase: 'completed', step: found?.step || b.step, doneText: action.done }
          : b,
      );
      loadChips();
    } catch (error) {
      setBriefing((b) => (same(b) ? { ...b, phase: 'done', error: stepErrorMessage(error) } : b));
    }
  }
  // A pass on Alya's question completes the check step.
  function briefingCheckPassed(onboarding) {
    const current = briefingRef.current;
    if (!current) return;
    const action = briefingAction(current.step);
    const found = onboarding ? findStep(onboarding, current.stepId) : null;
    setBriefing((b) =>
      b && b.stepId === current.stepId
        ? { ...b, phase: 'completed', step: found?.step || b.step, doneText: action.done }
        : b,
    );
    loadChips();
  }
  const lastMessageId = messages.at(-1)?.id;
  useEffect(() => {
    const log = chatLog.current;
    if (!log) return;
    // Wait for the memory toolbar and pane sizing before positioning the reply.
    // Only the chat transcript moves; the page and visual guide stay in place.
    let frame;
    let followingReply = true;
    const revealReply = () => {
      if (!followingReply || !log.getClientRects().length) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const latest = log.querySelector('.alya-message:last-of-type');
        if (!busy && messages.at(-1)?.role === 'assistant' && latest)
          log.scrollTop = Math.max(0, log.scrollHeight - latest.offsetHeight - 34);
        else log.scrollTop = log.scrollHeight;
      });
    };
    // Keep the reply in view while the window/fonts settle, until the reader
    // starts navigating the transcript themselves.
    const pauseFollowing = () => {
      followingReply = false;
      cancelAnimationFrame(frame);
    };
    const resize = new ResizeObserver(revealReply);
    resize.observe(log);
    const readingEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown'];
    readingEvents.forEach((event) =>
      log.addEventListener(event, pauseFollowing, { passive: true }),
    );
    revealReply();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      readingEvents.forEach((event) => log.removeEventListener(event, pauseFollowing));
    };
  }, [lastMessageId, busy, conversationId, Boolean(config)]);
  function stopVoice() {
    speechRef.current?.stop();
  }
  // Alya says only the answer's own sentences (spoken-answer.mjs). Scene
  // boundaries are sent as audio boundaries, so the stage changes scene exactly
  // when the voice reaches the next sentence (Kokoro or Gemini alike).
  function speakAnswer(message) {
    const speech = answerSpeech(message);
    if (!speech.text) return stopVoice();
    setSpokenAnswerId(message.id);
    speechRef.current?.speak(speech.text, { ...preferencesRef.current, segments: speech.segments });
  }
  function replay(message) {
    if (busy || !preferencesRef.current.enabled) return;
    if (message.briefing) speakBriefing(message);
    else speakAnswer(message);
  }
  function mute() {
    const enabled = !preferences.enabled;
    setPreferences({ ...preferences, enabled });
    if (!enabled) stopVoice();
  }
  function cancelRequest() {
    sequence.current++;
    request.current?.abort();
    setBusy(false);
    stopVoice();
  }
  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (response.status === 204) return null;
    const data = await response.json();
    if (!response.ok) {
      // A signed-in chat can learn the session ended or a password change is due.
      reportAccountResponse(response.status, data);
      throw new Error(
        data.error || 'The server could not complete that request. Please try again.',
      );
    }
    return data;
  }
  function applyChat(chat) {
    setSelectedAnswerId('');
    setBriefing(null);
    setConversationId(chat.id);
    setLearning(chat.learning || null);
    setLearningOpen(false);
    try {
      localStorage.setItem(savedChatKey, chat.id);
    } catch {}
    setMessages([
      greeting,
      ...chat.messages.map((m, i) =>
        m.role === 'assistant'
          ? {
              ...m,
              ...presentAnswer(m.result, chat.messages[i - 1]?.text),
              ...answerExtras(m, m.result),
            }
          : m,
      ),
    ]);
    setQuestion('');
    setDeleteConfirm(false);
  }
  async function changeChat(id = null, erase = false) {
    if (historyBusy || learningBusy || supportBusy) return;
    cancelRequest();
    historyAbort.current?.abort();
    const abort = new AbortController();
    historyAbort.current = abort;
    const token = sequence.current;
    setHistoryBusy(true);
    setHistoryError('');
    setDeleteConfirm(false);
    try {
      if (erase)
        await jsonRequest('/api/conversations/' + conversationId, {
          method: 'DELETE',
          signal: abort.signal,
        });
      const chat = id
        ? await jsonRequest('/api/conversations/' + id, { signal: abort.signal })
        : await jsonRequest('/api/conversations', { method: 'POST', signal: abort.signal });
      const list = await jsonRequest('/api/conversations', { signal: abort.signal });
      if (token !== sequence.current) return;
      applyChat(chat);
      setConversations(list.conversations);
      setHistoryOpen(false);
      inputRef.current?.focus();
    } catch (error) {
      if (error.name !== 'AbortError') setHistoryError(error.message);
    } finally {
      if (token === sequence.current) setHistoryBusy(false);
    }
  }
  function newChat() {
    if (config?.conversationMemory) {
      changeChat();
      return;
    }
    cancelRequest();
    setMessages([greeting]);
    setSelectedAnswerId('');
    setBriefing(null);
    setQuestion('');
    inputRef.current?.focus();
  }
  async function changeLearning(patch) {
    if (busy || historyBusy || learningBusy || supportBusy || !conversationId) return false;
    const abort = new AbortController(),
      token = sequence.current;
    learningAbort.current = abort;
    setLearningBusy(true);
    setHistoryError('');
    try {
      const result = await jsonRequest('/api/conversations/' + conversationId + '/learning', {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify(patch),
      });
      if (token === sequence.current) {
        setLearning(result.learning);
      }
      return true;
    } catch (error) {
      if (error.name !== 'AbortError') setHistoryError(error.message);
      return false;
    } finally {
      if (token === sequence.current) setLearningBusy(false);
    }
  }
  async function ask(text, retryId = null, retryRequestId = null, extras = {}) {
    const trimmed = text.trim();
    if (
      !trimmed ||
      trimmed.length > 1600 ||
      busy ||
      historyBusy ||
      learningBusy ||
      supportBusy ||
      !config ||
      (config.conversationMemory && !conversationId)
    )
      return;
    request.current?.abort();
    speechRef.current?.stop();
    if (preferencesRef.current.enabled) speechRef.current?.prime();
    const token = ++sequence.current,
      abort = new AbortController(),
      requestId = retryRequestId || crypto.randomUUID();
    request.current = abort;
    setBusy(true);
    setQuestion('');
    setLearningOpen(false);
    setHistoryOpen(false);
    setMessages((previous) =>
      retryId
        ? previous.filter((message) => message.id !== retryId)
        : [...previous, { id: requestId + '-u', role: 'user', text: trimmed }],
    );
    const timeout = setTimeout(() => abort.abort('timeout'), 65000);
    try {
      // Signed-in browsers must still have a session; otherwise the question
      // would be answered anonymously and never saved to the account.
      if (!(await ensureSession())) return;
      const task = config.tasks.find((task) => task.id === 'company-resources') || config.tasks[0];
      // Alya's voice is requested separately, sentence by sentence, from /api/voice.
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          question: trimmed,
          taskId: task.id,
          style: 'simple',
          speechEnabled: false,
          conversationId,
          requestId,
          ...chatExtras(extras),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        reportAccountResponse(response.status, result);
        throw new Error(result.error || 'The assistant could not answer. Please try again.');
      }
      // The API sends no searchQuery, so the question itself guides the short reply.
      const answer = presentAnswer(result, trimmed);
      if (sequence.current !== token) return;
      const reply = {
        id: requestId + '-a',
        role: 'assistant',
        ...answer,
        ...answerExtras(result, null),
      };
      setMessages((previous) => [...previous, reply]);
      setSelectedAnswerId(reply.id);
      if (result.learning) setLearning(result.learning);
      if (config.conversationMemory)
        setConversations((previous) => [
          {
            ...(previous.find((c) => c.id === conversationId) || {}),
            id: conversationId,
            title:
              previous.find((c) => c.id === conversationId)?.title === 'New conversation'
                ? trimmed.slice(0, 65)
                : previous.find((c) => c.id === conversationId)?.title || trimmed.slice(0, 65),
            updated: Date.now(),
          },
          ...previous.filter((c) => c.id !== conversationId),
        ]);
      if (preferencesRef.current.enabled) speakAnswer(reply);
      loadChips();
    } catch (error) {
      if (sequence.current !== token) return;
      if (error.name === 'AbortError' && abort.signal.reason !== 'timeout') return;
      const errorText =
        abort.signal.reason === 'timeout'
          ? 'The answer took too long. Please try again.'
          : error instanceof TypeError
            ? 'The server connection was interrupted. Please try again.'
            : error.message;
      setMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          error: errorText,
          question: trimmed,
          requestId,
          extras,
        },
      ]);
    } finally {
      clearTimeout(timeout);
      if (sequence.current === token) setBusy(false);
    }
  }
  async function feedback(message, rating) {
    if (busy || supportBusy || historyBusy) return;
    setSupportBusy(true);
    setSupportError('');
    const id = conversationId,
      token = sequence.current;
    try {
      const result = await jsonRequest('/api/conversations/' + id + '/feedback', {
        method: 'POST',
        body: JSON.stringify({ messageId: message.id, rating }),
      });
      if (token !== sequence.current) return;
      setMessages((previous) =>
        previous.map((m) => (m.id === message.id ? { ...m, feedback: result.rating } : m)),
      );
      if (result.rating === 'helpful') {
        const stepId = helpfulStepId(message, messages) || briefingRef.current?.stepId || null;
        if (stepId) {
          setActionErrors({});
          if (
            briefingRef.current?.stepId === stepId &&
            briefingRef.current.phase === 'presenting'
          ) {
            stopVoice();
            recordBriefing('helpful');
          } else {
            journeyApi
              .recordBriefing(stepId, 'helpful')
              .then(() => loadChips())
              .catch(() => {});
          }
        }
      }
    } catch (error) {
      setSupportError(error.message);
    } finally {
      setSupportBusy(false);
    }
  }
  async function requestSupport(message, format) {
    const changed = await changeLearning({ preference: format });
    if (!changed) return;
    const requestText = {
      steps: 'Please explain this step by step',
      example: 'Please give me a worked example',
      brief: 'Please keep the answer brief',
    }[format];
    ask(
      requestText +
        (message.referenceQuestion ? ' for this question: ' + message.referenceQuestion : '.'),
      null,
      null,
      { reexplainOf: message.id },
    );
  }
  function askHr(message) {
    if (busy || historyBusy || learningBusy || supportBusy) return;
    setSupportDialog(message);
  }
  // After "Send to HR" and Close, focus goes to that answer's "Sent to HR"
  // line (QA D-1), or to the answer itself; Cancel and Escape keep the dialog's
  // own focus return to the Ask HR button.
  const sentFor = useRef('');
  function closeSupportDialog() {
    const id = sentFor.current;
    sentFor.current = '';
    setSupportDialog(null);
    if (!id) return;
    let tries = 0;
    const focusSent = () => {
      const line = document.querySelector(`[data-ask-hr-status="${CSS.escape(id)}"]`);
      if (line?.getClientRects().length) return line.focus({ preventScroll: false });
      if (++tries < 10) return setTimeout(focusSent, 50);
      document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.focus();
    };
    setTimeout(focusSent, 0);
  }
  function supportSent(messageId, request) {
    sentFor.current = messageId;
    setSentRequests((current) => ({ ...current, [messageId]: request }));
  }
  // F5: the employee approves or declines a change Alya proposed.
  async function decide(message, decision) {
    const action = message.proposedAction;
    if (!action || actionBusy) return;
    if (preferencesRef.current.enabled) speechRef.current?.prime();
    setActionBusy(action.id);
    setActionErrors((current) => ({ ...current, [action.id]: '' }));
    try {
      const result = await journeyApi.decideAction(action.id, decision);
      const reply = typeof result.reply === 'string' ? result.reply.trim() : '';
      const replyId = 'action-' + action.id + '-reply';
      setMessages((previous) => [
        ...previous.map((m) => (m.id === message.id ? { ...m, proposedAction: result.action } : m)),
        ...(reply
          ? [{ id: replyId, role: 'assistant', plain: true, text: reply, spoken: reply }]
          : []),
      ]);
      const speech = plainSpeech(reply);
      if (speech.text && preferencesRef.current.enabled) {
        // A plain reply has no scenes, so no answer's guide follows this audio.
        setSpokenAnswerId(replyId);
        speechRef.current?.speak(speech.text, preferencesRef.current);
      }
      loadChips();
    } catch (error) {
      const failure = actionDecisionError(error);
      setActionErrors((current) => ({ ...current, [action.id]: failure.message }));
      if (failure.expired)
        setMessages((previous) =>
          previous.map((m) =>
            m.id === message.id ? { ...m, proposedAction: { ...action, status: 'expired' } } : m,
          ),
        );
    } finally {
      setActionBusy('');
    }
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }
  const speaking = speechState.state === 'speaking',
    voicing = speaking || speechState.state === 'starting';
  // Without a voice to listen to, a briefing is read: step through it, then confirm.
  const voiceAvailable =
    preferences.enabled && voiceSupported && speechState.state !== 'unavailable';
  return (
    <div className="alya-page alya-live-page">
      <div className="alya-conversation-shell alya-live-shell">
        <AlyaPresentationStage
          checklist={checklist}
          navigate={navigate}
          messages={messages.filter((m) => !m.plain)}
          selectedAnswerId={selectedAnswerId}
          onSelectAnswer={(id) => {
            stopVoice();
            setSelectedAnswerId(id);
          }}
          speechRef={speechRef}
          speaking={speaking}
          voicing={voicing}
          thinking={busy}
          spokenAnswerId={spokenAnswerId}
          reducedMotion={preferences.reducedMotion}
          voiceEnabled={preferences.enabled && voiceSupported}
          onReplay={replay}
          finishReading={
            briefing?.messageId &&
            !voiceAvailable &&
            ['presenting', 'recording'].includes(briefing.phase)
              ? {
                  answerId: briefing.messageId,
                  label: readButtonLabel,
                  busy: briefing.phase === 'recording',
                  onConfirm: () => recordBriefing('read'),
                }
              : null
          }
        />
        <OnboardingChecklist checklist={checklist} navigate={navigate} variant="collapsible" />
        <div className="alya-answer-space">
          <div className="alya-view-panels">
            <section className="alya-chat-panel" id="alya-chat-view" aria-label="Chat with Alya">
              <header className="alya-chat-heading">
                <div>
                  <h2>Conversation.</h2>
                </div>
                <button
                  className="alya-new-chat"
                  disabled={!config || historyBusy || learningBusy || supportBusy}
                  onClick={newChat}
                >
                  <Icon name="chat" size={14} />
                  New chat
                </button>
              </header>
              {!config && !connectionError && (
                <p className="alya-connect-pending" role="status">
                  Getting Alya ready…
                </p>
              )}
              {config?.conversationMemory && (
                <div className="alya-memory-control">
                  <div className="alya-memory-bar">
                    <button
                      onClick={() => {
                        setHistoryOpen(!historyOpen);
                        setLearningOpen(false);
                        setDeleteConfirm(false);
                      }}
                      aria-expanded={historyOpen}
                      aria-controls="alya-saved-chats"
                    >
                      <Icon name="clock" size={13} />
                      Saved chats <span>{conversations.length}</span>
                      <Icon name="down" size={12} />
                    </button>
                    {config.adaptiveLearning ? (
                      <button
                        className="alya-learning-toggle"
                        aria-expanded={learningOpen}
                        aria-controls="alya-learning-options"
                        onClick={() => {
                          setLearningOpen(!learningOpen);
                          setHistoryOpen(false);
                        }}
                      >
                        <Icon name="book" size={13} />
                        {learningBusy ? 'Saving…' : 'Answer style'}
                        <Icon name="down" size={12} />
                      </button>
                    ) : (
                      <span>{historyBusy ? 'Loading conversation…' : 'Saved conversations'}</span>
                    )}
                  </div>
                  {learningOpen && (
                    <AnswerStyleSettings
                      learning={learning}
                      disabled={busy || historyBusy || learningBusy || supportBusy}
                      onSettings={changeLearning}
                      onClose={() => setLearningOpen(false)}
                    />
                  )}
                  {historyOpen && (
                    <div className="alya-saved-chats" id="alya-saved-chats">
                      <p>
                        Reopen a saved chat to continue. Chats expire after 30 days without
                        activity.
                      </p>
                      <div className="alya-chat-list">
                        {conversations.map((chat) => (
                          <button
                            key={chat.id}
                            className={chat.id === conversationId ? 'selected' : ''}
                            disabled={historyBusy}
                            onClick={() => changeChat(chat.id)}
                          >
                            <Icon name="chat" size={13} />
                            <span>{chat.title}</span>
                            <small>
                              {chat.id === conversationId
                                ? 'Current'
                                : new Date(chat.updated).toLocaleDateString()}
                            </small>
                          </button>
                        ))}
                      </div>
                      {deleteConfirm ? (
                        <div className="alya-delete-confirm">
                          <p>Delete this chat and its saved memory?</p>
                          <button disabled={historyBusy} onClick={() => changeChat(null, true)}>
                            Delete chat
                          </button>
                          <button onClick={() => setDeleteConfirm(false)}>Keep chat</button>
                        </div>
                      ) : (
                        <button
                          className="alya-delete-chat"
                          disabled={busy || historyBusy}
                          onClick={() => setDeleteConfirm(true)}
                        >
                          Delete current chat
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {historyError && (
                <div className="alya-inline-error" role="alert">
                  <p>{historyError}</p>
                  <button onClick={() => setHistoryError('')}>Dismiss</button>
                </div>
              )}
              {supportError && (
                <div className="alya-inline-error" role="alert">
                  <p>{supportError}</p>
                  <button onClick={() => setSupportError('')}>Dismiss</button>
                </div>
              )}
              <div
                className="alya-chat-log"
                ref={chatLog}
                role="log"
                tabIndex={0}
                aria-label="Conversation with Alya"
                aria-live="polite"
                aria-relevant="additions text"
              >
                {messages.map((message) =>
                  message.briefing ? (
                    <BriefingEntry
                      key={message.id}
                      message={message}
                      briefing={briefing?.messageId === message.id ? briefing : null}
                      voiceAvailable={voiceAvailable}
                      onAction={actOnBriefing}
                      onCheckPassed={briefingCheckPassed}
                      onDashboard={() => navigate('/onboarding')}
                      onHelpful={() => {
                        stopVoice();
                        recordBriefing('helpful');
                      }}
                      onRetry={
                        briefing?.lastCompletion
                          ? () => recordBriefing(briefing.lastCompletion)
                          : undefined
                      }
                    />
                  ) : (
                    <Message
                      message={
                        sentRequests[message.id]
                          ? { ...message, supportRequest: sentRequests[message.id] }
                          : message
                      }
                      key={message.id}
                      onRetry={(item) => ask(item.question, item.id, item.requestId, item.extras)}
                      onCopy={copy}
                      onFeedback={feedback}
                      onSupport={requestSupport}
                      onHumanHelp={askHr}
                      onAskHr={askHr}
                      onDecide={decide}
                      actionBusy={!!actionBusy && actionBusy === message.proposedAction?.id}
                      actionError={actionErrors[message.proposedAction?.id] || ''}
                      onOpenSupport={() => navigate('/support')}
                      disabled={busy || historyBusy || learningBusy || supportBusy}
                      memoryEnabled={config?.conversationMemory}
                      formatsEnabled={config?.answerFormatsAvailable !== false}
                    />
                  ),
                )}
                {busy && (
                  <div className="alya-chat-thinking" role="status">
                    <span className="alya-message-mark">A</span>
                    <span>Alya is finding your answer</span>
                    <i />
                    <i />
                    <i />
                  </div>
                )}
              </div>
              {connectionError && (
                <div className="alya-inline-error" role="alert">
                  <p>{connectionError}</p>
                  <button onClick={connect}>Reconnect</button>
                </div>
              )}
              {speechState.error && preferences.enabled && (
                <p className="alya-voice-error" role="status">
                  <Icon name="info" size={14} />
                  {speechState.error}
                </p>
              )}
            </section>
          </div>
          <div className="alya-composer-area">
            <QuickQuestionChips
              chips={chips}
              disabled={busy || historyBusy || learningBusy || supportBusy || !config}
              onPick={(chip) => ask(chip.question, null, null, { quickQuestionId: chip.id })}
            />
            <form
              className="alya-composer"
              onSubmit={(event) => {
                event.preventDefault();
                ask(question);
              }}
            >
              <label className="alya-question-label" htmlFor="alya-question">
                Your question
              </label>
              <textarea
                id="alya-question"
                ref={inputRef}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={2}
                maxLength={1600}
                placeholder="Ask about your company or onboarding…"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    ask(question);
                  }
                }}
              />
              <div className="alya-composer-bottom">
                <span>
                  {question.length
                    ? `${question.length} / 1600`
                    : 'Enter to send · Shift + Enter for a new line'}
                </span>
                {busy ? (
                  <button
                    type="button"
                    className="alya-send cancel"
                    aria-label="Cancel answer"
                    onClick={cancelRequest}
                  >
                    <Icon name="stop" size={17} />
                  </button>
                ) : (
                  <button
                    className="alya-send"
                    aria-label="Send question"
                    disabled={
                      !question.trim() || !config || historyBusy || learningBusy || supportBusy
                    }
                  >
                    <Icon name="arrow" size={21} />
                  </button>
                )}
              </div>
            </form>
            <div className="alya-voice-toolbar">
              <button
                className={'alya-voice-toggle ' + (preferences.enabled ? 'on' : '')}
                aria-pressed={preferences.enabled}
                onClick={mute}
              >
                <Icon name={preferences.enabled ? 'volume' : 'mute'} size={16} />
                {preferences.enabled ? 'Voice on' : 'Voice off'}
              </button>
              {speechState.state === 'starting' && (
                <span className="alya-voice-preparing">Preparing voice…</span>
              )}
              {voicing && (
                <button className="alya-stop-voice" onClick={stopVoice}>
                  <Icon name="stop" size={13} />
                  Stop voice
                </button>
              )}
              <button
                className="alya-voice-settings"
                ref={settingsButton}
                aria-label="Voice settings"
                aria-expanded={settings}
                aria-controls="alya-voice-options"
                onClick={() => setSettings(!settings)}
              >
                <Icon name="settings" size={16} />
              </button>
            </div>
            {settings && (
              <div className="alya-voice-options" id="alya-voice-options" ref={settingsPanel}>
                <div className="alya-shared-voice-label">
                  <strong>{configuredVoiceLabel(config)}</strong>
                  <p>Alya’s English voice. Everyone hears the same voice.</p>
                  {usingBackupVoice(config, voiceUsed) && (
                    <p className="alya-backup-voice">{backupVoiceNote}</p>
                  )}
                </div>
                {showsSpeedControl(config) ? (
                  <label>
                    Speaking speed
                    <select
                      value={preferences.rate}
                      onChange={(event) => {
                        stopVoice();
                        setPreferences({ ...preferences, rate: Number(event.target.value) });
                      }}
                    >
                      <option value={0.85}>Slower</option>
                      <option value={0.95}>Natural</option>
                      <option value={1.05}>Faster</option>
                    </select>
                  </label>
                ) : (
                  <p className="alya-natural-pace">{naturalPaceLine}</p>
                )}
                <label className="alya-motion-option">
                  <input
                    type="checkbox"
                    checked={preferences.reducedMotion}
                    onChange={(e) =>
                      setPreferences({ ...preferences, reducedMotion: e.target.checked })
                    }
                  />
                  Reduce movement
                </label>
                <p>
                  {showsSpeedControl(config) && 'Speed applies to the next answer. '}Reduced
                  movement stops scene animations and calms Alya’s head and body. Her mouth and the
                  visual guide still follow her voice.
                </p>
              </div>
            )}
            <p className="alya-chat-caption">
              Keep passwords and private employee details out of chat.
              {config?.conversationMemory && <> Saved to your account for up to 30 days.</>}
            </p>
          </div>
        </div>
      </div>
      <div className="alya-page-footnote">
        <span>
          <Icon name="shield" size={14} />
          Company guidance · answers are not HR approval
        </span>
      </div>
      {supportDialog && (
        <SupportRequestDialog
          conversationId={conversationId}
          message={supportDialog}
          onClose={closeSupportDialog}
          onSent={supportSent}
        />
      )}
      {copied && (
        <div className="alya-copy-toast" role="status">
          <Icon name="check" size={16} />
          Answer copied
        </div>
      )}
    </div>
  );
}
