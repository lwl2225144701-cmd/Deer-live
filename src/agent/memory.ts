import type { Event, World } from '../world/world.ts';

export type Memory = { id: string; tick: number; x: number; y: number; place: string; foodRemaining: number; text: string };
export type Experience = { tick: number; action: Event['action']; outcome: string; before: World['agent']; after: World['agent'] };
