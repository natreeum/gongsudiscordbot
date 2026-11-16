import { errorMessage, scheduleMinute, type Schedule } from './domain.js';
import { Store } from './store.js';

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly store: Store;
  private readonly guildId: string;
  private readonly send: (schedule: Schedule) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(store: Store, guildId: string, send: (schedule: Schedule) => Promise<void>, log = console.error) {
    this.store = store;
    this.guildId = guildId;
    this.send = send;
    this.log = log;
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => { void this.tick().catch(error => this.log(`스케줄러 오류: ${errorMessage(error)}`)); };
    this.timer = setInterval(tick, 15_000);
    tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.deliver(now);
    try { await this.running; } finally { this.running = undefined; }
  }

  private async deliver(now: Date): Promise<void> {
    const slot = scheduleMinute(now);
    const schedules = this.store.dueSchedules(this.guildId, slot.day, slot.hour, slot.minute);
    // Claim before sending. An ambiguous network failure must not cause duplicate alerts.
    await Promise.all(schedules.map(async schedule => {
      if (!this.store.claimSchedule(schedule.id, slot.occurrence)) return;
      try {
        await this.send(schedule);
        this.store.finishSchedule(schedule.id, slot.occurrence);
      } catch (error) {
        const detail = errorMessage(error);
        this.store.finishSchedule(schedule.id, slot.occurrence, detail);
        this.log(`스케줄 [${schedule.id}] ${slot.occurrence} 발송 실패: ${detail}`);
      }
    }));
  }
}
