import { useCallback, useEffect, useRef, useState } from "react";
import { formatKeyCombo } from "./useShortcuts";

interface UseKeyCaptureReturn {
  /** Enter capture mode. The next valid key combo will be captured. */
  startCapture: () => void;
  /** Cancel capture mode without recording anything. */
  cancel: () => void;
  /** True while waiting for a key press. */
  isCapturing: boolean;
}

/**
 * Hook for recording a keyboard shortcut in the Settings UI.
 *
 * Usage:
 *   const { startCapture, cancel, isCapturing } = useKeyCapture();
 *   // On "修改" button click:
 *   startCapture();
 *   // In callback, receive the combo string.
 *
 * The `onCapture` callback fires once per successful capture and
 * is expected to call `cancel()` or the hook resets automatically.
 */
export function useKeyCapture(
  onCapture: (combo: string) => void,
): UseKeyCaptureReturn {
  const [isCapturing, setIsCapturing] = useState(false);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;

  const cancel = useCallback(() => {
    setIsCapturing(false);
  }, []);

  const startCapture = useCallback(() => {
    setIsCapturing(true);
  }, []);

  useEffect(() => {
    if (!isCapturing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Pressing Escape cancels capture.
      if (e.key === "Escape") {
        e.preventDefault();
        setIsCapturing(false);
        return;
      }

      const combo = formatKeyCombo(e);
      if (!combo) return; // Pure modifier — keep listening.

      e.preventDefault();
      onCaptureRef.current(combo);
      setIsCapturing(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isCapturing]);

  return { startCapture, cancel, isCapturing };
}
