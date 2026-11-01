"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CityId } from "@/lib/api";
import { readJson, writeJson } from "@/lib/storage";

export type Place = { city: CityId; areaId: string | null };

const KEY = "lb_place";
const DEFAULT: Place = { city: "bengaluru", areaId: null };

let cached: Place | null = null;
const listeners = new Set<() => void>();

function current(): Place {
  cached ??= readJson<Place>(KEY) ?? DEFAULT;
  return cached;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The customer's chosen city and area, remembered on this device.
export function usePlace() {
  const place = useSyncExternalStore(subscribe, current, () => DEFAULT);
  const setPlace = useCallback((next: Place) => {
    cached = next;
    writeJson(KEY, next);
    listeners.forEach((listener) => listener());
  }, []);
  return [place, setPlace] as const;
}
