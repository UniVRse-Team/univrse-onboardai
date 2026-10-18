import React, { useEffect, useReducer, useRef, useState } from 'react';
import { isAnswered } from './activity-model.mjs';
import { answeredCount, feedbackDelayMs, quizReducer, startQuiz } from './quiz-flow.mjs';

// One question at a time with the answer checked at once. The server holds the
// answer key: each answer is sent, checked, locked and saved before its feedback
// shows, then the quiz moves on by itself. The score and the pass are only ever
// the server's result (finish), never computed here.
const labelOf = (question, id) => question.options?.find((option) => option.id === id)?.text || id;

function Question({ question, value, onChange, disabled, feedback }) {
  const picked = [].concat(feedback ? feedback.selected : (value ?? [])).filter(Boolean);
  if (question.type === 'match') {
    const given = feedback ? feedback.selected || {} : value || {};
    return (
      <div className="qr-match">
        {question.pairs.map((pair) => {
          const wrong = feedback?.wrongPairs?.includes(pair.id);
          return (
            <label
              key={pair.id}
              className={'qr-match-row' + (feedback ? (wrong ? ' wrong' : ' right') : '')}
            >
              <span>{pair.text}</span>
              <select
                disabled={disabled}
                value={given[pair.id] || ''}
                onChange={(e) => onChange({ ...(value || {}), [pair.id]: e.target.value })}
              >
                <option value="">Choose…</option>
                {question.choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
              {feedback && wrong && (
                <small className="qr-mark">
                  Correct match:{' '}
                  {question.choices.find((c) => c.id === feedback.correctPairs?.[pair.id])?.label}
                </small>
              )}
              {feedback && !wrong && <small className="qr-mark">✓ Correct</small>}
            </label>
          );
        })}
      </div>
    );
  }
  const toggle = (id) =>
    onChange(
      question.multiple
        ? picked.includes(id)
          ? picked.filter((x) => x !== id)
          : [...picked, id]
        : id,
    );
  return (
    <div className="qr-options" role={question.multiple ? 'group' : 'radiogroup'}>
      {question.options.map((option) => {
        const chosen = picked.includes(option.id);
        const isKey = feedback?.correctAnswer?.includes(option.id);
        const state = !feedback
          ? chosen
            ? ' picked'
            : ''
          : isKey
            ? ' right'
            : chosen
              ? ' wrong'
              : '';
        return (
          <label key={option.id} className={'qr-option' + state}>
            <input
              type={question.multiple ? 'checkbox' : 'radio'}
              name={'q-' + question.id}
              disabled={disabled}
              checked={chosen}
              onChange={() => toggle(option.id)}
            />
            <span>{option.text}</span>
            {feedback && isKey && chosen && (
              <small className="qr-mark">✓ Correct answer · your choice</small>
            )}
            {feedback && isKey && !chosen && <small className="qr-mark">✓ Correct answer</small>}
            {feedback && !isKey && chosen && <small className="qr-mark">✗ Your choice</small>}
          </label>
        );
      })}
    </div>
  );
}

function Feedback({ question, feedback, onContinue }) {
  const names = (ids) => ids.map((id) => labelOf(question, id)).join('; ');
  return (
    <div
      className={'qr-feedback ' + (feedback.correct ? 'right' : 'wrong')}
      role="status"
      aria-live="polite"
    >
      <strong>{feedback.correct ? '✓ Correct' : '✗ Not quite'}</strong>
      {feedback.explanation && <p>{feedback.explanation}</p>}
      {!feedback.correct && question.multiple && feedback.missed?.length > 0 && (
        <p>You left out: {names(feedback.missed)}.</p>
      )}
      {!feedback.correct && question.multiple && feedback.extra?.length > 0 && (
        <p>You should not have selected: {names(feedback.extra)}.</p>
      )}
      <div className="qr-actions">
        <button type="button" className="fp-action main" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}

export default function QuizRunner({
  questions,
  passingScore,
  session = null,
  alreadyPassed = false,
  summary = null,
  onAnswer,
  onFinish,
  onExit,
  registerGuard,
  children,
}) {
  const [state, dispatch] = useReducer(quizReducer(questions), undefined, () =>
    startQuiz(questions, session),
  );
  const [practising, setPractising] = useState(!alreadyPassed);
  const inflight = useRef(false);
  const heading = useRef(null);
  const question = questions[state.index];
  const locked = question ? state.locked[question.id] : null;
  const answered = answeredCount(questions, state);

  // A request in flight is the only thing that must not be interrupted.
  useEffect(() => {
    registerGuard?.(() =>
      ['saving', 'finishing'].includes(state.status)
        ? window.confirm('Your answer is still being saved. Leave anyway?')
        : true,
    );
    return () => registerGuard?.(null);
  }, [state.status]);

  async function send(value) {
    if (inflight.current || state.status !== 'answering' || !question) return;
    inflight.current = true;
    dispatch({ type: 'saving', value });
    try {
      const feedback = await onAnswer(question.id, value);
      dispatch({ type: 'saved', feedback });
    } catch (e) {
      dispatch({
        type: 'save-failed',
        keepDraft: question.multiple || question.type === 'match',
        message:
          (e.message || 'Your answer could not be saved.') +
          ' Nothing was recorded; please try again.',
      });
    } finally {
      inflight.current = false;
    }
  }

  // Feedback stays long enough to read, then the quiz moves on by itself.
  useEffect(() => {
    if (state.status !== 'feedback') return;
    const timer = setTimeout(() => dispatch({ type: 'advance' }), feedbackDelayMs(locked?.correct));
    return () => clearTimeout(timer);
  }, [state.status, state.index]);
  useEffect(() => {
    if (state.status === 'answering') heading.current?.focus({ preventScroll: true });
  }, [state.index]);

  // The finish is requested once per attempt; the server grades the locked answers.
  useEffect(() => {
    if (state.status !== 'finishing' || inflight.current) return;
    inflight.current = true;
    onFinish()
      .then((result) => dispatch({ type: 'finished', result }))
      .catch((e) =>
        dispatch({
          type: 'finish-failed',
          message: (e.message || 'Your quiz could not be submitted.') + ' Your answers are saved.',
        }),
      )
      .finally(() => {
        inflight.current = false;
      });
  }, [state.status]);

  function again() {
    setPractising(true);
    dispatch({ type: 'restart' });
  }

  if (!questions.length)
    return (
      <p role="status" className="fp-muted">
        No questions are configured for this activity yet (content requirement).
      </p>
    );

  if (!practising)
    return (
      <section className="qr-card" aria-live="polite">
        <h2>You passed this activity ✓</h2>
        {summary && <p>{summary}</p>}
        <div className="qr-actions">
          <button type="button" className="fp-action main" onClick={onExit}>
            Back to onboarding
          </button>
          <button type="button" className="fp-action" onClick={() => setPractising(true)}>
            Practise again
          </button>
        </div>
      </section>
    );

  if (state.status === 'results') {
    const { result } = state;
    const byId = Object.fromEntries(result.questionResults.map((r) => [r.id, r]));
    const right = result.correctCount ?? result.questionResults.filter((r) => r.correct).length;
    return (
      <section className="qr-card" aria-live="polite">
        <h2 className={result.passed ? 'qr-pass' : 'qr-fail'}>
          {result.passed ? 'Passed ✓' : 'Not passed yet'}
        </h2>
        <p className="qr-score">
          <strong>{result.score}%</strong> · pass mark {result.passingScore}% · attempt{' '}
          {result.attempts}
        </p>
        <p>
          {right} correct · {questions.length - right} incorrect of {questions.length}
        </p>
        <p>{result.feedback}</p>
        <h3>Review your answers</h3>
        <ol className="qr-results">
          {questions.map((item) => {
            const mine = state.locked[item.id];
            return (
              <li key={item.id} className={byId[item.id]?.correct ? 'ok' : 'miss'}>
                <strong>{byId[item.id]?.correct ? '✓ Correct' : '✗ Not quite'}</strong>
                <span>{item.prompt}</span>
                {mine?.selected !== undefined && item.type !== 'match' && (
                  <p className="qr-explain">
                    Your answer:{' '}
                    {[]
                      .concat(mine.selected)
                      .map((id) => labelOf(item, id))
                      .join('; ')}
                    {!byId[item.id]?.correct && mine.correctAnswer
                      ? ` · Correct answer: ${mine.correctAnswer.map((id) => labelOf(item, id)).join('; ')}`
                      : ''}
                  </p>
                )}
                {(mine?.explanation || byId[item.id]?.explanation) && (
                  <p className="qr-explain">{mine?.explanation || byId[item.id].explanation}</p>
                )}
              </li>
            );
          })}
        </ol>
        <div className="qr-actions">
          {result.passed ? (
            <button type="button" className="fp-action main" onClick={onExit}>
              Back to onboarding
            </button>
          ) : (
            <>
              <button type="button" className="fp-action main" onClick={again}>
                Retry Quiz
              </button>
              <button type="button" className="fp-action" onClick={onExit}>
                Back to onboarding
              </button>
            </>
          )}
        </div>
      </section>
    );
  }

  if (state.status === 'finishing' || state.status === 'finish-failed')
    return (
      <section className="qr-card" aria-live="polite">
        <h2>All {questions.length} questions answered</h2>
        {state.status === 'finishing' ? (
          <p role="status">Checking your score…</p>
        ) : (
          <>
            <p role="alert" className="fp-inline-error">
              {state.error}
            </p>
            <div className="qr-actions">
              <button
                type="button"
                className="fp-action main"
                onClick={() => dispatch({ type: 'retry-finish' })}
              >
                Try again
              </button>
              <button type="button" className="fp-action" onClick={onExit}>
                Back to onboarding
              </button>
            </div>
          </>
        )}
      </section>
    );

  const busy = state.status === 'saving';
  const open = state.status === 'answering';
  const feedback = state.status === 'feedback' ? locked : null;
  const draft = state.draft;
  const ready = isAnswered(question, { [question.id]: draft });
  const explicitSubmit = question.multiple || question.type === 'match';

  return (
    <section className="qr-card">
      <p className="qr-progress-label">
        Question {state.index + 1} of {questions.length} · {answered} answered
      </p>
      <div
        className="qr-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={questions.length}
        aria-valuenow={answered}
        aria-valuetext={`${answered} of ${questions.length} questions answered`}
        aria-label="Questions answered"
      >
        <span style={{ width: (answered / questions.length) * 100 + '%' }} />
      </div>
      <fieldset className="qr-question" disabled={!open}>
        <legend ref={heading} tabIndex={-1}>
          {question.prompt}
        </legend>
        {question.multiple && (
          <p className="fp-muted">Select all that apply, then choose Submit Answer.</p>
        )}
        {question.type === 'match' && (
          <p className="fp-muted">Match every item, then choose Submit Answer.</p>
        )}
        {!explicitSubmit && open && (
          <p className="fp-muted">
            Choose one answer. It is checked straight away and cannot be changed.
          </p>
        )}
        <Question
          key={question.id}
          question={question}
          value={draft}
          disabled={!open}
          feedback={feedback}
          onChange={(value) => {
            if (explicitSubmit) dispatch({ type: 'choose', value });
            else send(value);
          }}
        />
      </fieldset>
      {busy && (
        <p role="status" className="fp-muted">
          Checking and saving your answer…
        </p>
      )}
      {state.error && open && (
        <p role="alert" className="fp-inline-error">
          {state.error}
        </p>
      )}
      {explicitSubmit && (open || busy) && (
        <div className="qr-actions">
          <button
            type="button"
            className="fp-action main"
            disabled={!ready || busy}
            onClick={() => send(draft)}
          >
            {busy ? 'Saving…' : 'Submit Answer'}
          </button>
        </div>
      )}
      {feedback && (
        <Feedback
          question={question}
          feedback={feedback}
          onContinue={() => dispatch({ type: 'advance' })}
        />
      )}
      {open && children}
    </section>
  );
}
