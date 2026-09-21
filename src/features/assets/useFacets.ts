import { useEffect, useState } from 'react';
import { getFacets } from '@/api/client';
import { isAbortError } from '@/api/errors';
import type { Facets } from '@/lib/types';

// Facets are stable reference data (API.md: "safe to cache hard"), so one
// successful response is kept for the life of the page.
let cached: Facets | null = null;

/** `null` until loaded, or if it failed — the tag picker degrades, nothing else depends on it. */
export function useFacets(): Facets | null {
  const [facets, setFacets] = useState<Facets | null>(cached);

  useEffect(() => {
    if (cached) return;
    const controller = new AbortController();
    getFacets(controller.signal).then(
      (result) => {
        cached = result;
        setFacets(result);
      },
      (err: unknown) => {
        if (!isAbortError(err)) setFacets(null);
      },
    );
    return () => controller.abort();
  }, []);

  return facets;
}
