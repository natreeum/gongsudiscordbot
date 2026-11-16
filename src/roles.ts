import {
  errorMessage, SerialQueue,
  type PanelState, type RoleEmoji,
} from './domain.js';
import { Store } from './store.js';

export interface PanelGateway {
  exists(panel: PanelState): Promise<boolean>;
  delete(panel: PanelState): Promise<void>;
  create(content: string): Promise<string>;
  react(messageId: string, emoji: string): Promise<void>;
  setRole(userId: string, roleId: string, enabled: boolean): Promise<void>;
}

export interface ReactionEvent {
  guildId: string | null;
  channelId: string;
  messageId: string;
  userId: string;
  emojiKey: string | null;
  added: boolean;
}

export function panelContent(mappings: RoleEmoji[]): string {
  const rows = mappings.map(mapping => `${mapping.emojiDisplay} <@&${mapping.roleId}>`).join('\n');
  return [
    '**역할 선택**',
    '아래 이모지를 누르면 역할을 받고, 취소하면 역할이 제거됩니다. 여러 역할을 선택할 수 있습니다.',
    '',
    rows || '현재 선택 가능한 역할이 없습니다.',
    '',
    '안내 메시지가 새로 생성되어도 기존 역할은 유지됩니다. 해제하려면 해당 이모지를 눌렀다가 취소하세요.',
  ].join('\n');
}

export class RoleService {
  private readonly queue = new SerialQueue();
  private readonly store: Store;
  private readonly guildId: string;
  private readonly channelId: string;
  private readonly gateway: PanelGateway;
  private readonly log: (message: string) => void;

  constructor(store: Store, guildId: string, channelId: string, gateway: PanelGateway, log = console.error) {
    this.store = store;
    this.guildId = guildId;
    this.channelId = channelId;
    this.gateway = gateway;
    this.log = log;
  }

  async idle(): Promise<void> { await this.queue.idle(); }

  async ensurePanel(): Promise<void> {
    return this.queue.run(async () => {
      let panel = this.store.panel(this.guildId);
      if (!panel) {
        panel = { guildId: this.guildId, channelId: this.channelId, messageId: null, dirty: true };
        this.store.savePanel(panel);
      }
      if (panel.channelId !== this.channelId || !panel.messageId) {
        this.store.markPanelDirty(this.guildId);
      } else if (!panel.dirty && !await this.gateway.exists(panel)) {
        this.store.markPanelDirty(this.guildId);
      }
      if (this.store.panel(this.guildId)?.dirty) await this.refresh();
    });
  }

  async change<T>(work: () => Promise<T>): Promise<{ value: T; panelUpdated: boolean }> {
    return this.queue.run(async () => {
      const value = await work();
      try {
        await this.refresh();
        return { value, panelUpdated: true };
      } catch (error) {
        // Configuration is already committed. A periodic repair retries the panel only.
        this.log(`역할 안내 메시지 갱신 실패: ${errorMessage(error)}`);
        return { value, panelUpdated: false };
      }
    });
  }

  async handleReaction(event: ReactionEvent): Promise<void> {
    if (event.guildId !== this.guildId || event.channelId !== this.channelId || !event.emojiKey) return;
    return this.queue.run(async () => {
      const panel = this.store.panel(this.guildId);
      if (!panel || panel.dirty || panel.messageId !== event.messageId) return;
      const mapping = this.store.roleEmojis(this.guildId).find(row => row.emojiKey === event.emojiKey);
      if (!mapping) return;
      await this.gateway.setRole(event.userId, mapping.roleId, event.added);
    });
  }

  // Called only while holding the queue. Pending events for the old message are
  // discarded by message ID; events for the new message run after it is ready.
  private async refresh(): Promise<void> {
    const old = this.store.panel(this.guildId);
    if (old) this.store.markPanelDirty(this.guildId);
    if (old?.messageId) await this.gateway.delete(old);

    const panel: PanelState = {
      guildId: this.guildId, channelId: this.channelId, messageId: null, dirty: true,
    };
    this.store.savePanel(panel);
    const mappings = this.store.roleEmojis(this.guildId);
    panel.messageId = await this.gateway.create(panelContent(mappings));
    // Persist the message before adding reactions, so a partial failure is repairable.
    this.store.savePanel(panel);
    for (const mapping of mappings) {
      await this.gateway.react(panel.messageId, mapping.emojiReaction);
    }
    panel.dirty = false;
    this.store.savePanel(panel);
  }
}
