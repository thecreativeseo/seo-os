"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { saveDraftAction } from "@/server/actions/onboarding";

export type AutosaveStatus = "idle" | "saving" | "saved";

/**
 * Debounced autosave for an onboarding step.
 *
 * Persists raw input server-side while the user types, so leaving the page
 * mid-answer loses nothing. Drafts never touch validated answers or real records —
 * only "Save & continue" commits.
 *
 * Failures are swallowed on purpose: an autosave error must not interrupt typing,
 * and a genuine problem still surfaces on submit.
 */
export function useAutosave(formRef: React.RefObject<HTMLFormElement | null>, delay = 900) {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const flush = useCallback(async () => {
    const form = formRef.current;
    if (!form || inFlight.current) return;

    inFlight.current = true;
    setStatus("saving");
    try {
      await saveDraftAction(new FormData(form));
      setStatus("saved");
    } catch {
      setStatus("idle");
    } finally {
      inFlight.current = false;
    }
  }, [formRef]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  }, [delay, flush]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { status, schedule };
}
