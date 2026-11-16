import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Client, Events, GatewayIntentBits, MessageFlags, Partials,
  type MessageReaction, type PartialMessageReaction, type PartialUser, type User,
} from 'discord.js';
import { readConfig } from './config.js';
import { commandDefinitions, handleCommand, type CommandContext } from './commands.js';
import { errorMessage, reactionKey } from './domain.js';
import { assertChannelPermissions, DiscordPanelGateway, sendSchedule, textChannel } from './discord.js';
import { RoleService } from './roles.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';

async function main(): Promise<void> {
  const config = readConfig();
  const dataDirectory = resolve('data');
  mkdirSync(dataDirectory, { recursive: true });
  const store = new Store(resolve(dataDirectory, 'bot.sqlite'));
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
    // Old messages and uncached users must still emit reaction removal events after restart.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    allowedMentions: { parse: [] },
  });

  let context: CommandContext | undefined;
  let roles: RoleService | undefined;
  let scheduler: Scheduler | undefined;
  let repairTimer: NodeJS.Timeout | undefined;
  let startup: Promise<void> | undefined;
  let closing = false;
  const commandsInFlight = new Set<Promise<void>>();
  const log = (message: string): void => console.error(`[${new Date().toISOString()}] ${message}`);

  async function shutdown(exitCode = 0): Promise<void> {
    if (closing) return;
    closing = true;
    process.exitCode = exitCode;
    if (repairTimer) clearInterval(repairTimer);
    const deadline = setTimeout(() => process.exit(exitCode), 15_000);
    deadline.unref();
    try {
      await startup?.catch(() => undefined);
      await scheduler?.stop();
      await Promise.allSettled(commandsInFlight);
      await roles?.idle();
      await client.destroy();
      store.close();
      console.log('봇을 종료했습니다.');
    } catch (error) {
      log(`종료 처리 실패: ${errorMessage(error)}`);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }

  async function initialize(readyClient: Client<true>): Promise<void> {
    const [scheduleChannel, roleChannel] = await Promise.all([
      textChannel(readyClient, config.scheduleChannelId),
      textChannel(readyClient, config.roleChannelId),
    ]);
    if (scheduleChannel.guildId !== roleChannel.guildId) throw new Error('두 채널은 같은 서버에 있어야 합니다.');
    await Promise.all([
      assertChannelPermissions(scheduleChannel, false),
      assertChannelPermissions(roleChannel, true),
    ]);
    if (closing) return;

    const guild = roleChannel.guild;
    // Upsert only this bot's eight commands; do not bulk-delete unrelated commands.
    await Promise.all(commandDefinitions.map(definition => guild.commands.create(definition.toJSON())));
    if (closing) return;

    roles = new RoleService(store, guild.id, roleChannel.id, new DiscordPanelGateway(readyClient, roleChannel), log);
    context = { store, roles, guild, scheduleChannel };
    try { await roles.ensurePanel(); }
    catch (error) { log(`역할 안내 메시지 초기화 실패 (자동 재시도 예정): ${errorMessage(error)}`); }
    if (closing) return;

    let repairing = false;
    repairTimer = setInterval(() => {
      if (closing || repairing || !roles) return;
      repairing = true;
      void roles.ensurePanel()
        .catch(error => log(`역할 안내 메시지 복구 실패: ${errorMessage(error)}`))
        .finally(() => { repairing = false; });
    }, 30_000);
    scheduler = new Scheduler(store, guild.id, async schedule => {
      if (!readyClient.isReady()) throw new Error('Discord 연결이 준비되지 않았습니다.');
      await sendSchedule(scheduleChannel, schedule);
    }, log);
    scheduler.start();
    console.log(`${readyClient.user.tag} 준비 완료 | 서버: ${guild.name} | 시간대: Asia/Seoul`);
  }

  client.once(Events.ClientReady, readyClient => {
    if (closing) return;
    startup = initialize(readyClient);
    void startup.catch(error => {
      log(`초기화 실패: ${errorMessage(error)}`);
      void shutdown(1);
    });
  });

  client.on(Events.InteractionCreate, interaction => {
    if (closing || !interaction.isChatInputCommand()) return;
    if (!context) {
      void interaction.reply({ content: '봇 초기화 중입니다. 잠시 후 다시 시도하세요.', flags: MessageFlags.Ephemeral })
        .catch(error => log(`초기화 안내 실패: ${errorMessage(error)}`));
      return;
    }
    const pending = handleCommand(interaction, context).catch(error => log(`명령어 처리 실패: ${errorMessage(error)}`));
    commandsInFlight.add(pending);
    void pending.finally(() => commandsInFlight.delete(pending));
  });

  function reaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, added: boolean): void {
    if (closing || !roles || user.id === client.user?.id || user.bot) return;
    // IDs and emoji metadata are available on partials: no message fetch is required here.
    void roles.handleReaction({
      guildId: reaction.message.guildId,
      channelId: reaction.message.channelId,
      messageId: reaction.message.id,
      userId: user.id,
      emojiKey: reactionKey(reaction.emoji),
      added,
    }).catch(error => log(`역할 ${added ? '부여' : '제거'} 실패 (사용자 ${user.id}): ${errorMessage(error)}`));
  }

  client.on(Events.MessageReactionAdd, (value, user) => reaction(value, user, true));
  client.on(Events.MessageReactionRemove, (value, user) => reaction(value, user, false));

  function deletedMessage(id: string, guildId: string | null): void {
    if (closing || !roles || !guildId) return;
    const panel = store.panel(guildId);
    // Ignore our own deletion when moving the panel to another configured channel.
    if (!panel || panel.dirty || panel.messageId !== id) return;
    store.markPanelDirty(guildId);
    void roles.ensurePanel().catch(error => log(`삭제된 안내 메시지 복구 실패: ${errorMessage(error)}`));
  }
  client.on(Events.MessageDelete, message => deletedMessage(message.id, message.guildId));
  client.on(Events.MessageBulkDelete, messages => {
    for (const message of messages.values()) deletedMessage(message.id, message.guildId);
  });
  client.on(Events.Error, error => log(`Discord 오류: ${errorMessage(error)}`));
  client.on(Events.Warn, warning => log(`Discord 경고: ${warning}`));
  client.on(Events.ShardError, error => log(`Discord 연결 오류: ${errorMessage(error)}`));
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  try { await client.login(config.token); }
  catch (error) {
    log(`Discord 로그인 실패: ${errorMessage(error)}`);
    await shutdown(1);
  }
}

void main().catch(error => {
  console.error(`실행 실패: ${errorMessage(error)}`);
  process.exitCode = 1;
});
