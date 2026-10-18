import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../portal/Icon';
import ClothingScene from './ClothingPresentation';
import OnboardingIllustration from './OnboardingIllustration';
import AutomaticCaption from './AutomaticCaption';
import { presentationSceneAt } from './answer-presentation.mjs';
import { canConfirmRead } from './briefing-flow.mjs';
import {
  autoAdvanceDelay,
  nextStep,
  previousStep,
  sceneOrder,
  shownScene,
  stepAnnouncement,
  stepBounds,
} from './scene-steps.mjs';

function OnboardingScene({ scene, visible, index, caption }) {
  return (
    <div
      className={'automatic-scene' + (visible ? ' is-current' : '')}
      aria-hidden={!visible}
      data-scene={index}
    >
      <div className="automatic-scene-title">
        <span className="automatic-eyebrow">{scene.eyebrow}</span>
        <h2>{scene.label}</h2>
      </div>
      {scene.visuals.map((visual, side) => (
        <figure key={side} className={'automatic-cue ' + (side ? 'from-right' : 'from-left')}>
          <div className="automatic-floating-art">
            <div className="automatic-art">
              <OnboardingIllustration visual={visual} />
            </div>
          </div>
          <figcaption>{visual.label}</figcaption>
          <span className="automatic-cue-rule" />
        </figure>
      ))}
      <AutomaticCaption text={scene.body} {...caption} />
    </div>
  );
}

const firstStep = { scene: 0, page: 0 };

export default function AutomaticPresentation({
  presentation,
  speechRef,
  active,
  reducedMotion,
  onReplay,
  voiceEnabled,
  finishReading = null,
  // While no voice is playing, and none has played for this answer, the guide moves on by
  // itself at reading pace. A voice that plays takes over; after it, the reader steps.
  autoAdvance = true,
}) {
  // Voice-led position, read from the audio player's clock.
  const [position, setPosition] = useState({ index: -1, character: 0, started: false });
  // Reader-led position when there is no voice to follow.
  const [step, setStep] = useState(firstStep),
    [pageCounts, setPageCounts] = useState({}),
    [announcement, setAnnouncement] = useState(''),
    [manual, setManual] = useState(false),
    [heardVoice, setHeardVoice] = useState(false),
    [stalled, setStalled] = useState(false);
  const heard = useRef(false);
  const order = sceneOrder(presentation);
  useEffect(() => {
    // Starting the voice begins the guide again. When a voice that really played ends, the
    // guide rests on its last scene instead of jumping back to the first.
    setStep(
      !active && heard.current ? { scene: Math.max(0, order.length - 1), page: 999 } : firstStep,
    );
    setManual(false);
    setAnnouncement('');
    setPosition({ index: -1, character: 0, started: false });
    if (!active) return;
    let frame;
    function follow() {
      // null while the next sentence buffers or sound is blocked: hold the scene.
      const character = speechRef.current?.getProgress();
      // Audio really playing (not just starting, nor failed): the voice leads from now on.
      if (character != null) {
        heard.current = true;
        setHeardVoice(true);
      }
      if (character != null)
        setPosition((previous) => {
          const next = presentationSceneAt(presentation, character);
          return previous.started && previous.index === next && previous.character === character
            ? previous
            : { index: next, character, started: true };
        });
      frame = requestAnimationFrame(follow);
    }
    follow();
    return () => cancelAnimationFrame(frame);
  }, [presentation, speechRef, active]);
  // A voice that never starts (blocked, still buffering or failed) must not freeze the guide.
  useEffect(() => {
    if (!active || position.started) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), 3500);
    return () => clearTimeout(timer);
  }, [active, position.started]);
  const led = active && !stalled;
  const countPages = useCallback(
    (index, count) =>
      setPageCounts((previous) =>
        previous[index] === count ? previous : { ...previous, [index]: count },
      ),
    [],
  );
  const current = shownScene(presentation, {
    voiceLed: led,
    started: position.started,
    spokenIndex: position.index,
    step,
    order,
  });
  const bounds = stepBounds(step, order, pageCounts);
  // A briefing read without voice is confirmed on its last page only.
  const canFinish =
    !!finishReading && !led && canConfirmRead({ voiceAvailable: false, step, order, pageCounts });
  const pages = pageCounts[current] || 1;
  // Without a voice the guide advances at reading pace, so nobody has to press Next.
  // Reduced motion only calms the animation; it never turns the guide into a Next button.
  useEffect(() => {
    if (!autoAdvance || led || heardVoice || manual || bounds.last) return;
    const scene = presentation.scenes[order[step.scene]];
    const words = String(scene?.body || '')
      .split(/\s+/)
      .filter(Boolean).length;
    const perPage = Math.max(1, pageCounts[order[step.scene]] || 1);
    const wait = autoAdvanceDelay(words, perPage);
    const timer = setTimeout(() => {
      const next = nextStep(step, order, pageCounts);
      setStep(next);
      if (next.scene !== step.scene) setAnnouncement(stepAnnouncement(presentation, order, next));
    }, wait);
    return () => clearTimeout(timer);
  }, [autoAdvance, led, heardVoice, manual, step, pageCounts, presentation]);
  function move(next) {
    setManual(true);
    setStep(next);
    if (next.scene !== step.scene) setAnnouncement(stepAnnouncement(presentation, order, next));
  }
  return (
    <section
      className={
        'automatic-presentation' +
        (reducedMotion ? ' is-calm' : '') +
        (led ? ' is-voice-led' : ' is-stepping')
      }
      aria-label="Visual guide"
      data-presentation-kind={presentation.kind}
    >
      {presentation.scenes.map((scene, index) => {
        if (!scene.visible) return null;
        const Scene = scene.garments?.length ? ClothingScene : OnboardingScene;
        const shown = current === index;
        const caption = led
          ? {
              character:
                shown && position.started ? Math.max(0, position.character - scene.start) : 0,
            }
          : { page: shown ? step.page : 0 };
        return (
          <Scene
            key={index}
            scene={scene}
            index={index}
            visible={shown}
            caption={{ ...caption, onPages: (count) => countPages(index, count) }}
          />
        );
      })}
      {led && position.started && current >= 0 && (
        <div className="automatic-sequence" aria-hidden="true">
          <span className="automatic-voice-dot" />
          <span>ALYA EXPLAINS</span>
          <div>
            {order.map((scene) => (
              <i key={scene} className={scene <= current ? 'has-played' : ''} />
            ))}
          </div>
          <span>
            {order.indexOf(current) + 1} / {order.length}
          </span>
        </div>
      )}
      {!led && order.length > 0 && (
        <div className="automatic-steps">
          {voiceEnabled && !finishReading && (
            <button type="button" className="automatic-listen" onClick={onReplay}>
              <Icon name="volume" size={14} />
              <span>Listen again</span>
            </button>
          )}
          {/* The guide moves by itself; Previous and Next exist only where auto-advance is off. */}
          {!autoAdvance && (
            <div className="automatic-step-nav" role="group" aria-label="Step through the guide">
              <button
                type="button"
                className="automatic-step-previous"
                aria-label="Previous step"
                disabled={bounds.first}
                onClick={() => move(previousStep(step, order, pageCounts))}
              >
                <Icon name="chevron" size={15} />
                <span>Previous</span>
              </button>
              <span className="automatic-step-count">
                {step.scene + 1} / {order.length}
                {pages > 1 && (
                  <small>
                    {' '}
                    · part {Math.min(step.page, pages - 1) + 1} of {pages}
                  </small>
                )}
              </span>
              <button
                type="button"
                className="automatic-step-next"
                aria-label="Next step"
                disabled={bounds.last}
                onClick={() => move(nextStep(step, order, pageCounts))}
              >
                <span>Next</span>
                <Icon name="chevron" size={15} />
              </button>
            </div>
          )}
          {canFinish && (
            <button
              type="button"
              className="automatic-read-done"
              disabled={finishReading.busy}
              onClick={finishReading.onConfirm}
            >
              <Icon name="check" size={14} />
              <span>{finishReading.busy ? 'Saving…' : finishReading.label}</span>
            </button>
          )}
        </div>
      )}
      <p className="automatic-announcement" role="status">
        {led ? '' : announcement}
      </p>
    </section>
  );
}
