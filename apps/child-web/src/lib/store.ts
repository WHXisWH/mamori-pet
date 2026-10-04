'use client';

import type { CharacterId, DataSource, GradeBand, MoodWeather } from '@ijime/api-types';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Memory = { memoryId: string; text: string; category: string; createdAt: string };

export type ChildState = {
  hydrated: boolean;
  paired: boolean;
  childId: string;
  assented: boolean;
  gradeBand: GradeBand;
  characterId: CharacterId | null;
  hiddenVariantId: string | null;
  petName: string;
  dataSources: Record<DataSource, boolean>;
  todayMood: { date: string; weather: MoodWeather } | null;
  lastHomeCheckin: string | null;
  petLock: string | null;
  unlockedUntil: number;
  memories: Memory[];
  readAloud: boolean;
};

export type ChildActions = {
  setHydrated: () => void;
  pair: (childId: string) => void;
  assent: (dataSources: Record<DataSource, boolean>) => void;
  choosePet: (characterId: CharacterId, petName: string, hiddenVariantId?: string) => void;
  setGradeBand: (g: GradeBand) => void;
  setDataSource: (k: DataSource, v: boolean) => void;
  setMood: (weather: MoodWeather | null) => void;
  markHomeCheckin: () => void;
  setPetLock: (pin: string | null) => void;
  unlock: () => void;
  addMemory: (m: Memory) => void;
  deleteMemory: (id: string) => void;
  setReadAloud: (v: boolean) => void;
  reset: () => void;
};

export const DEFAULT_DATA_SOURCES: Record<DataSource, boolean> = {
  voice: true,
  typing: true,
  artwork_save: false,
  home_checkin: true,
  calendar: true,
};

const initial: ChildState = {
  hydrated: false,
  paired: false,
  childId: '',
  assented: false,
  gradeBand: 'high',
  characterId: null,
  hiddenVariantId: null,
  petName: '',
  dataSources: DEFAULT_DATA_SOURCES,
  todayMood: null,
  lastHomeCheckin: null,
  petLock: null,
  unlockedUntil: 0,
  memories: [],
  readAloud: false,
};

export const UNLOCK_MS = 30 * 60 * 1000;

export function todayJst(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}

export const useChildStore = create<ChildState & ChildActions>()(
  persist(
    (set) => ({
      ...initial,
      setHydrated: () => set({ hydrated: true }),
      pair: (childId) => set({ paired: true, childId }),
      assent: (dataSources) => set({ assented: true, dataSources }),
      choosePet: (characterId, petName, hiddenVariantId) =>
        set({ characterId, petName, hiddenVariantId: hiddenVariantId ?? null }),
      setGradeBand: (gradeBand) => set({ gradeBand }),
      setDataSource: (k, v) => set((s) => ({ dataSources: { ...s.dataSources, [k]: v } })),
      setMood: (weather) => set({ todayMood: weather ? { date: todayJst(), weather } : null }),
      markHomeCheckin: () => set({ lastHomeCheckin: todayJst() }),
      setPetLock: (pin) => set({ petLock: pin, unlockedUntil: pin ? Date.now() + UNLOCK_MS : 0 }),
      unlock: () => set({ unlockedUntil: Date.now() + UNLOCK_MS }),
      addMemory: (m) => set((s) => ({ memories: [m, ...s.memories] })),
      deleteMemory: (id) => set((s) => ({ memories: s.memories.filter((m) => m.memoryId !== id) })),
      setReadAloud: (readAloud) => set({ readAloud }),
      reset: () => set({ ...initial, hydrated: true }),
    }),
    {
      name: 'mamori-child',
      storage: createJSONStorage(() => safeLocalStorage()),
      partialize: (s) => {
        const rest: Record<string, unknown> = { ...s };
        delete rest['hydrated'];
        delete rest['unlockedUntil'];
        delete rest['memories'];
        return rest as unknown as ChildState;
      },
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<ChildState>),
        memories: [],
      }),
      onRehydrateStorage: () => (state) => state?.setHydrated(),
    },
  ),
);

function safeLocalStorage(): Storage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // ignore
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
}
