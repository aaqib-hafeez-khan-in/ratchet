/**
 * Which beat of the scroll explainer should be showing.
 *
 * Extracted as a pure function so the logic is testable without a browser —
 * the animation itself cannot be exercised in a headless pane, where
 * requestAnimationFrame is paused and scroll events are not dispatched.
 *
 * @param {number} rectTop     stage.getBoundingClientRect().top
 * @param {number} stageHeight stage.offsetHeight
 * @param {number} viewport    window.innerHeight
 * @param {number} beats       number of beats
 * @returns {number} zero-based beat index
 */
export function beatFor(rectTop, stageHeight, viewport, beats) {
  const scrollable = stageHeight - viewport;
  // A stage shorter than the viewport cannot be scrolled through; show the
  // first beat rather than dividing by zero.
  if (scrollable <= 0 || beats < 1) return 0;
  const progress = Math.min(1, Math.max(0, -rectTop / scrollable));
  return Math.min(beats - 1, Math.floor(progress * beats));
}
