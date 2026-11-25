import { useEffect, useRef, useState } from 'react';

/**
 * Ensures a loading indicator remains visible for at least `minMs` (default 500ms)
 * once triggered, preventing jarring UI flashes on fast responses.
 */
export function useMinimumLoader(isLoading: boolean, minMs = 500): boolean {
  const [visible, setVisible] = useState(isLoading);
  const startedAtRef = useRef<number | null>(isLoading ? Date.now() : null);

  useEffect(() => {
    if (isLoading) {
      if (startedAtRef.current === null) {
        startedAtRef.current = Date.now();
      }
      setVisible(true);
      return;
    }

    if (startedAtRef.current === null) {
      setVisible(false);
      return;
    }

    const elapsed = Date.now() - startedAtRef.current;
    const remaining = Math.max(0, minMs - elapsed);
    const timer = window.setTimeout(() => {
      startedAtRef.current = null;
      setVisible(false);
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [isLoading, minMs]);

  return visible;
}
