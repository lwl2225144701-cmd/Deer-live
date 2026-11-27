import { initialWorld } from '../world/world.ts';
import { tick } from '../app/runtime.ts';
import { Store } from '../storage/store.ts';
import type { Brain } from '../agent/brain.ts';
import type { Settings } from '../config/settings.ts';
import type { ExperienceStore } from '../experience/store.ts';
import type { ThinkingStore } from '../thinking/store.ts';
import { CalibrationStore } from '../calibration/store.ts';
import type { MotivationStore } from '../motivation/store.ts';

export class WorldController {
  private running = false;
  private busy = false;
  private error: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private inference?: AbortController;
  private pending?: Promise<void>;
  private store: Store;
  private settings: Settings;
  private brain: Brain;
  private experience?: ExperienceStore;
  private thinking?: ThinkingStore;
  private calibration?: CalibrationStore;
  private motivation?: MotivationStore;
  constructor(store: Store, settings: Settings, brain: Brain, experience?: ExperienceStore, thinking?: ThinkingStore, calibration?: CalibrationStore, motivation?: MotivationStore) {
    this.store = store; this.settings = settings; this.brain = brain; this.experience = experience; this.thinking = thinking; this.calibration = calibration; this.motivation = motivation;
    store.initialize(initialWorld(settings.initialWorld));
  }
  snapshot() {
    const world = this.store.load()!;
    return {
      world, events: this.store.recentEvents(20), memories: this.store.recall(world, this.settings.memory.maxRecall, this.settings.life.hungryAt),
      learning: this.store.learning(world),
      ...(this.experience ? { experience: { enabled: this.settings.memory.experience.enabled, facts: this.experience.facts().length, patterns: this.experience.patterns().length } } : {}),
      ...(this.thinking ? { thinking: { enabled: this.settings.thinking.enabled, active: this.thinking.beliefs('active').map(b => ({ statement: b.statement, confidence: b.confidence })) } } : {}),
      ...(this.calibration ? { calibration: { enabled: this.settings.calibration.enabled, violated: this.calibration.records().filter(r => r.status === 'violated').length } } : {}),
      ...(this.motivation ? { motivation: { enabled: this.settings.motivation.enabled, active: this.motivation.selfDesires(5) } } : {}),
      simulation: { running: this.running, busy: this.busy, error: this.error, model: this.brain.model || this.settings.model.name, strict: this.settings.run.strict },
      thresholds: { hungryAt: this.settings.life.hungryAt, tiredAt: this.settings.life.tiredAt },
    };
  }
  step() {
    if (this.busy || this.running) throw new Error('小鹿正在行动，请先暂停并等待当前行动结束');
    return this.perform();
  }
  start() {
    if (this.running) return;
    if (this.busy) throw new Error('请等待当前行动结束');
    this.running = true;
    void this.cycle();
  }
  pause() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.inference?.abort();
  }
  private async cycle() {
    if (!this.running) return;
    await this.perform();
    if (this.running) this.timer = setTimeout(() => void this.cycle(), this.settings.run.intervalMs);
  }
  private perform(): Promise<void> {
    this.busy = true; this.error = null;
    const inference = new AbortController(); this.inference = inference;
    this.pending = (async () => {
      try {
        await tick(this.store, { brain: this.brain, settings: this.settings, strict: this.settings.run.strict, signal: inference.signal, experience: this.experience, thinking: this.thinking, calibration: this.calibration, motivation: this.motivation });
      } catch (error) {
        if (!inference.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
        this.running = false;
      } finally {
        this.busy = false; this.inference = undefined;
      }
    })();
    return this.pending;
  }
  async close() { this.pause(); await this.pending; }
}
