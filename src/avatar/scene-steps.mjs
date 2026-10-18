import { visualPageAt } from './visual-text-pagination.mjs';

// Rules for the visual guide on Alya's stage. While her voice plays, the scene
// follows the audio clock. When voice is off, unavailable or finished, the
// employee steps through the same scenes at their own pace instead.

// The scenes a reader can step through: the visible ones, in spoken order.
export function sceneOrder(presentation) {
  return (presentation?.scenes || []).flatMap((scene, index) => (scene.visible ? [index] : []));
}

// The caption page to show: under the voice, or the one the reader chose.
export function captionPage(pages, { character = 0, page = null } = {}) {
  if (page == null || !Number.isFinite(page)) return visualPageAt(pages, character);
  return Math.max(0, Math.min(Math.trunc(page), pages.length - 1));
}

// One step is one caption page of one scene. `pageCounts` maps a scene index
// to its number of caption pages; a scene not measured yet counts as one page.
const pagesOf = (order, pageCounts, scene) => Math.max(1, pageCounts?.[order[scene]] || 1);

export function nextStep(step, order, pageCounts = {}) {
  const pages = pagesOf(order, pageCounts, step.scene);
  const page = Math.min(step.page, pages - 1);
  if (page < pages - 1) return { scene: step.scene, page: page + 1 };
  if (step.scene < order.length - 1) return { scene: step.scene + 1, page: 0 };
  return step;
}

export function previousStep(step, order, pageCounts = {}) {
  const page = Math.min(step.page, pagesOf(order, pageCounts, step.scene) - 1);
  if (page > 0) return { scene: step.scene, page: page - 1 };
  if (step.scene > 0)
    return { scene: step.scene - 1, page: pagesOf(order, pageCounts, step.scene - 1) - 1 };
  return { scene: 0, page: 0 };
}

export function stepBounds(step, order, pageCounts = {}) {
  return {
    first: step.scene <= 0 && step.page <= 0,
    last: step.scene >= order.length - 1 && step.page >= pagesOf(order, pageCounts, step.scene) - 1,
  };
}

// How long a step stays on screen when the guide advances by itself (no voice):
// reading pace, about 160 words a minute, never under 3.5 s nor over 14 s.
export function autoAdvanceDelay(words, pages = 1) {
  const perPage = words / Math.max(1, pages);
  return Math.min(14000, Math.max(3500, Math.round(perPage * 380)));
}

// The scene index the stage shows, or -1 for none. Voice-led: the scene under
// Alya's voice (-1 during a deliberate gap). Before her first audio arrives,
// the opening scene, so slower voices never leave the stage blank.
export function shownScene(presentation, { voiceLed, started, spokenIndex, step, order }) {
  if (voiceLed) {
    if (started) return spokenIndex;
    return presentation?.scenes[0]?.visible ? 0 : -1;
  }
  return order[step.scene] ?? -1;
}

// What a screen reader hears after the reader moves to another scene.
export function stepAnnouncement(presentation, order, step) {
  const scene = presentation?.scenes[order[step.scene]];
  if (!scene) return '';
  return `Step ${step.scene + 1} of ${order.length}. ${scene.label}. ${scene.body}`;
}
