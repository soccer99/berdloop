import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HarnessId } from "@berdloop/agent";
import { sessionHarnesses } from "@berdloop/core";

export interface HarnessOptions {
  id: HarnessId;
  name: string;
  models: { value: string; label: string }[];
  error: string | null;
}

export interface HarnessCatalog {
  fetchedAt: number;
  harnesses: HarnessOptions[];
}

export function useHarnessCatalog(enabled: boolean) {
  const [catalog, setCatalog] = useState<HarnessCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const connected = isTauri();
  const refresh = useCallback(async (force = true) => {
    if (!isTauri()) return;
    setLoading(true);
    setError("");
    try {
      setCatalog(
        await invoke<HarnessCatalog>("load_harness_catalog", {
          harnesses: sessionHarnesses.map(({ id, name }) => ({ id, name })),
          force,
        }),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh(false);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !catalog || error) return;
    const expires = (catalog.fetchedAt + 24 * 60 * 60) * 1000;
    const timer = window.setTimeout(
      () => void refresh(false),
      Math.max(1000, expires - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [enabled, catalog, error, refresh]);

  return { catalog, loading, error, refresh, connected };
}
