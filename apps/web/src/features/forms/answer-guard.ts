import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { captureReadBoundary, sameReadSession } from "@/data/read-model";

/**
 * Whether an answer still counts. `capture()` is called as a request is sent; what it returns says later whether the
 * form is still the same opening in the same read session, and, for an answer that would replace the draft, whether the
 * person has left that draft as it was.
 */
export function useAnswerGuard(form: { getValues: () => unknown }) {
  const client = useQueryClient();
  // This opening of the form, while it is on screen.
  const opening = useRef<object | null>(null);
  useEffect(() => { opening.current = {}; return () => { opening.current = null; }; }, []);
  return () => {
    const boundary = captureReadBoundary(client), session = opening.current, original = JSON.stringify(form.getValues());
    const sameOpening = () => session !== null && opening.current === session && sameReadSession(client, boundary);
    return { sameOpening, sameDraft: () => sameOpening() && JSON.stringify(form.getValues()) === original };
  };
}
