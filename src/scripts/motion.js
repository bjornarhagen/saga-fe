export const MOTIONS = Object.freeze(['system', 'full', 'reduce']);
export const normalizeMotion = value => MOTIONS.includes(value) ? value : 'system';
export function resolveMotion(preference, systemReducesMotion) {
  const motion = normalizeMotion(preference);
  return motion === 'system' ? systemReducesMotion ? 'reduce' : 'full' : motion;
}
export function reducedMotion(win) {
  const resolved = win.document?.documentElement?.dataset?.motion;
  return resolved === 'reduce' || resolved !== 'full' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
