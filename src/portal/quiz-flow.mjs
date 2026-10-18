// The rules of one quiz attempt, apart from the screen. A question is answered
// once: the answer is sent to the server, which checks it against its own key and
// locks it. Nothing advances until that save has succeeded, and nothing can be
// sent twice (a request in flight, or a locked question, ignores a second one).
//
//   status: answering | saving | feedback | finishing | finish-failed | results

// How long the feedback stays before the quiz moves on by itself: long enough to
// read, longer when the answer was wrong. "Continue now" and "Keep reading" let
// the employee take control either way.
export const feedbackDelayMs = (correct) => (correct ? 3500 : 7000);

export const isLocked = (state, question) => Boolean(state.locked[question.id]);
export const answeredCount = (questions, state) =>
  questions.filter((question) => isLocked(state, question)).length;
export const firstOpenIndex = (questions, locked) =>
  questions.findIndex((question) => !locked[question.id]);

// `session` is the saved attempt in progress: { answers: { [questionId]: { value } } }.
// A resumed quiz continues at its first unanswered question.
export function startQuiz(questions, session = null) {
  const locked = {};
  for (const question of questions) {
    const entry = session?.answers?.[question.id];
    if (entry) locked[question.id] = { resumed: true, selected: entry.value };
  }
  const index = firstOpenIndex(questions, locked);
  return {
    locked,
    index: index === -1 ? questions.length - 1 : index,
    status: index === -1 && questions.length ? 'finishing' : 'answering',
    draft: null,
    error: '',
    result: null,
  };
}

export function quizReducer(questions) {
  return (state, action) => {
    const question = questions[state.index];
    switch (action.type) {
      case 'choose':
        // Only an open question can be changed; once locked or saving it cannot.
        if (state.status !== 'answering' || !question || isLocked(state, question)) return state;
        return { ...state, draft: action.value, error: '' };
      case 'saving':
        if (state.status !== 'answering' || !question || isLocked(state, question)) return state;
        return { ...state, status: 'saving', draft: action.value ?? state.draft, error: '' };
      case 'saved':
        if (state.status !== 'saving') return state;
        return {
          ...state,
          status: 'feedback',
          locked: {
            ...state.locked,
            [question.id]: { ...action.feedback, selected: action.feedback.selected },
          },
        };
      case 'save-failed':
        if (state.status !== 'saving') return state;
        return {
          ...state,
          status: 'answering',
          // A single-choice answer is re-chosen; a multiple selection is kept.
          draft: action.keepDraft ? state.draft : null,
          error: action.message,
        };
      case 'advance': {
        if (state.status !== 'feedback') return state;
        const next = firstOpenIndex(questions, state.locked);
        return next === -1
          ? { ...state, status: 'finishing', draft: null }
          : { ...state, status: 'answering', index: next, draft: null, error: '' };
      }
      case 'finished':
        return { ...state, status: 'results', result: action.result, error: '' };
      case 'finish-failed':
        return { ...state, status: 'finish-failed', error: action.message };
      case 'retry-finish':
        return state.status === 'finish-failed'
          ? { ...state, status: 'finishing', error: '' }
          : state;
      case 'restart':
        return startQuiz(questions);
      default:
        return state;
    }
  };
}
