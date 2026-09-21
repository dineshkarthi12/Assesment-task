import { useLayoutEffect } from 'react';

declare global {
  interface Window {
    __renders?: Record<string, number>;
  }
}

/**
 * Dev-only instrumentation: counts committed renders per component name in
 * `window.__renders`, so "toggling one card re-renders one card" is something
 * you can check in the console rather than take on trust. A layout effect with
 * no deps runs once per commit, so StrictMode's double render is not counted
 * twice. `import.meta.env.DEV` is a build-time constant: the hook is the same
 * on every render, and the whole thing is stripped from production builds.
 */
export function useRenderCount(name: string) {
  if (!import.meta.env.DEV) return;
  useLayoutEffect(() => {
    const counts = (window.__renders ??= {});
    counts[name] = (counts[name] ?? 0) + 1;
  });
}
