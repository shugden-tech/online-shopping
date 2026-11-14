import { effect, type ReadonlySignal } from "@preact/signals-core";
import { useEffect, useState } from "preact/hooks";

/** Subscribe a Preact component to a signal (tiny stand-in for the @preact/signals integration). */
export function useSig<T>(s: ReadonlySignal<T>): T {
  const [value, set] = useState<T>(() => s.peek());
  useEffect(() => effect(() => set(s.value)), [s]);
  return value;
}
