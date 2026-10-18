import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../portal/Icon';
import AvatarDisplay, { AvatarOffice } from './AvatarDisplay';
import AutomaticPresentation from './AutomaticPresentation';
import { answerPresentation } from './answer-presentation.mjs';
import OnboardingChecklist from './OnboardingChecklist';
export default function AlyaPresentationStage({
  messages,
  selectedAnswerId,
  onSelectAnswer,
  speechRef,
  speaking,
  voicing,
  thinking,
  spokenAnswerId,
  reducedMotion,
  voiceEnabled,
  onReplay,
  // A briefing read without voice: { answerId, label, busy, onConfirm } | null.
  finishReading = null,
  // The onboarding checklist beside Alya while no answer is being presented.
  checklist = null,
  navigate = null,
}) {
  const [systemMotion, setSystemMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setSystemMotion(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const calm = reducedMotion || systemMotion;
  const [avatar, setAvatar] = useState({ phase: 'loading', description: '', retry: null });
  const answers = messages.filter(
    (message) =>
      message.role === 'assistant' && !message.intro && !message.error && message.text?.trim(),
  );
  const selected = answers.find((message) => message.id === selectedAnswerId) || answers.at(-1);
  // Feedback, Ask HR or approval updates replace the message object; only the
  // spoken reply and its question change the scenes.
  const presentation = useMemo(
    () => (selected ? answerPresentation(selected) : null),
    [selected?.id, selected?.reply, selected?.text, selected?.referenceQuestion],
  );
  const latest = messages.at(-1);
  const showing = Boolean(presentation && !thinking && !latest?.error);
  return (
    <section
      className={
        'alya-presentation-stage scene-presentation' +
        (showing ? ' is-presenting' : '') +
        (showing ? ' automatic-stage' : '') +
        (calm ? ' reduce-motion' : '')
      }
      aria-label="Alya and your visual guide"
    >
      <AvatarOffice />
      <header className="ap-stage-heading">
        <div>
          <span>YOUR ONBOARDING COMPANION</span>
          <h1>Ask Alya.</h1>
        </div>
        {showing && answers.length > 1 && (
          <label className="ap-answer-picker">
            <span className="ap-answer-picker-label">Guide</span>
            <select
              aria-label="Choose an answer to illustrate"
              value={selected.id}
              onChange={(event) => onSelectAnswer(event.target.value)}
            >
              {answers.map((answer, index) => (
                <option value={answer.id} key={answer.id}>
                  {index + 1}. {answer.referenceQuestion || 'Answer ' + (index + 1)}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <div className="ap-presenter">
        <AvatarDisplay
          embedded
          presenting={showing}
          speechRef={speechRef}
          speaking={speaking}
          thinking={thinking}
          reducedMotion={calm}
          onStatus={setAvatar}
        />
      </div>
      {showing ? (
        <AutomaticPresentation
          key={selected.id}
          presentation={presentation}
          speechRef={speechRef}
          active={voicing && spokenAnswerId === selected.id}
          reducedMotion={calm}
          onReplay={() => onReplay(selected)}
          voiceEnabled={voiceEnabled}
          finishReading={finishReading?.answerId === selected.id ? finishReading : null}
        />
      ) : (
        <div className="ap-idle-column">
          <div className="ap-welcome" role="status">
            <span className="ap-welcome-rule" />
            <h2>
              {thinking
                ? 'Let’s make it clearer.'
                : latest?.error
                  ? 'Let’s try that again.'
                  : 'A clearer start.\nAt your own pace.'}
            </h2>
            <p>
              {thinking
                ? 'Alya is finding your answer. Your visual explanation will appear here.'
                : latest?.error
                  ? 'Your conversation is still here. Retry the question in chat.'
                  : 'Ask a question in chat. Alya will talk you through the answer, with a visual guide right beside her.'}
            </p>
          </div>

          {checklist && navigate && (
            <OnboardingChecklist checklist={checklist} navigate={navigate} />
          )}
        </div>
      )}
      {showing && checklist && navigate && (
        <OnboardingChecklist checklist={checklist} navigate={navigate} variant="dock" />
      )}
      <div className="ap-stage-caption">
        <span className="ap-live-dot" />
        {showing && avatar.phase !== 'ready' ? (
          <span className="ap-avatar-status" role="status">
            {avatar.phase === 'unavailable' && <Icon name="info" size={13} />}
            <span>{avatar.description}</span>
            {avatar.phase === 'unavailable' && avatar.retry && (
              <button type="button" onClick={avatar.retry}>
                Retry 3D
              </button>
            )}
          </span>
        ) : showing ? (
          'One explanation. Voice, visuals and text together.'
        ) : (
          'Your questions are a good place to begin.'
        )}
      </div>
    </section>
  );
}
