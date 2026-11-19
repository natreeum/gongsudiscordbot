import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
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
import { MusicService } from './music.js';
import { DiscordMusicPlayback, musicChannel } from './music-voice.js';
import { YouTubeSource } from './youtube.js';

const info = (message: string): void => console.log(`[${new Date().toISOString()}] ${message}`);
const log = (message: string): void => console.error(`[${new Date().toISOString()}] ${message}`);

function beginInitializationStep(name: string): () => void {
  const startedAt = performance.now();
  info(`[초기화] ${name} 시작`);
  return () => info(`[초기화] ${name} 완료 (${Math.round(performance.now() - startedAt)}ms)`);
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  info('[초기화] 봇 시작');
  const finishConfig = beginInitializationStep('환경 변수 로드');
  const config = readConfig();
  finishConfig();

  const finishDatabase = beginInitializationStep('SQLite DB 초기화');
  const dataDirectory = resolve('data');
  mkdirSync(dataDirectory, { recursive: true });
  const store = new Store(resolve(dataDirectory, 'bot.sqlite'));
  finishDatabase();

  const finishClient = beginInitializationStep('Discord 클라이언트 생성');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates],
    // Old messages and uncached users must still emit reaction removal events after restart.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    allowedMentions: { parse: [] },
  });
  finishClient();

  let context: CommandContext | undefined;
  let roles: RoleService | undefined;
  let scheduler: Scheduler | undefined;
  let music: MusicService | undefined;
  let repairTimer: NodeJS.Timeout | undefined;
  let startup: Promise<void> | undefined;
  let closing = false;
  const commandsInFlight = new Set<Promise<void>>();

  async function shutdown(exitCode = 0): Promise<void> {
    if (closing) return;
    closing = true;
    process.exitCode = exitCode;
    if (repairTimer) clearInterval(repairTimer);
    const deadline = setTimeout(() => process.exit(exitCode), 15_000);
    deadline.unref();
    try {
      await startup?.catch(() => undefined);
      // Abort metadata retrieval and streaming before waiting for music commands.
      await Promise.all([scheduler?.stop(), music?.close()]);
      await Promise.allSettled(commandsInFlight);
      await roles?.idle();
      await client.destroy();
      store.close();
      info('봇을 종료했습니다.');
    } catch (error) {
      log(`종료 처리 실패: ${errorMessage(error)}`);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }

  async function initialize(readyClient: Client<true>): Promise<void> {
    const finishChannels = beginInitializationStep('스케줄·역할 채널 조회');
    const [scheduleChannel, roleChannel] = await Promise.all([
      textChannel(readyClient, config.scheduleChannelId),
      textChannel(readyClient, config.roleChannelId),
    ]);
    if (scheduleChannel.guildId !== roleChannel.guildId) throw new Error('두 채널은 같은 서버에 있어야 합니다.');
    finishChannels();

    const finishPermissions = beginInitializationStep('봇 권한 확인');
    await Promise.all([
      assertChannelPermissions(scheduleChannel, false),
      assertChannelPermissions(roleChannel, true),
    ]);
    finishPermissions();
    if (closing) return;

    const guild = roleChannel.guild;
    const finishCommands = beginInitializationStep(`슬래시 명령어 ${commandDefinitions.length}개 등록`);
    // Upsert only this bot's commands; do not bulk-delete unrelated commands.
    await Promise.all(commandDefinitions.map(definition => guild.commands.create(definition.toJSON())));
    finishCommands();
    if (closing) return;

    const finishPanel = beginInitializationStep('역할 안내 메시지 동기화');
    roles = new RoleService(store, guild.id, roleChannel.id, new DiscordPanelGateway(readyClient, roleChannel), log);
    context = { store, roles, guild, scheduleChannel };
    let panelReady = false;
    try {
      await roles.ensurePanel();
      panelReady = true;
      finishPanel();
    }
    catch (error) { log(`역할 안내 메시지 초기화 실패 (자동 재시도 예정): ${errorMessage(error)}`); }
    if (closing) return;

    const finishRepair = beginInitializationStep('역할 안내 메시지 복구 타이머 설정 (30초 간격)');
    let repairing = false;
    repairTimer = setInterval(() => {
      if (closing || repairing || !roles) return;
      repairing = true;
      void roles.ensurePanel()
        .catch(error => log(`역할 안내 메시지 복구 실패: ${errorMessage(error)}`))
        .finally(() => { repairing = false; });
    }, 30_000);
    finishRepair();

    const finishScheduler = beginInitializationStep('스케줄러 설정 (15초 간격)');
    scheduler = new Scheduler(store, guild.id, async schedule => {
      if (!readyClient.isReady()) throw new Error('Discord 연결이 준비되지 않았습니다.');
      await sendSchedule(scheduleChannel, schedule);
    }, log);
    scheduler.start();
    finishScheduler();

    if (config.music) {
      const finishMusic = beginInitializationStep('음악 실행 환경 확인 및 DB 재생목록 복원');
      const source = new YouTubeSource(config.music, log);
      try {
        await source.check();
        await musicChannel(readyClient, guild.id, config.music);
        const djRole = await guild.roles.fetch(config.music.djRoleId);
        if (!djRole || djRole.id === guild.id) throw new Error('MUSIC_DJ_ROLE_ID는 @everyone 이외의 서버 역할이어야 합니다.');
        if (closing) return;
        const playback = new DiscordMusicPlayback(readyClient, guild.id, config.music, source, log);
        music = new MusicService(store, guild.id, source, playback, info);
        context.music = music;
        context.musicDjRoleId = config.music.djRoleId;
        await music.resume();
        info(`[음악] DB 재생목록 복원 | ${store.musicTracks(guild.id).length}곡 | 음성채널: ${config.music.voiceChannelId}`);
        finishMusic();
      } catch (error) {
        log(`음악 초기화 점검 실패 (DB 재생목록 보존): ${errorMessage(error)}`);
      }
      if (closing) return;
    } else info('[초기화] 음악 기능 비활성화 | MUSIC_VOICE_CHANNEL_ID·MUSIC_DJ_ROLE_ID 미설정');

    const panelStatus = panelReady ? '동기화 완료' : '복구 대기 (30초 간격)';
    info(`${readyClient.user.tag} 준비 완료 | 서버: ${guild.name} | 시간대: Asia/Seoul | 역할 안내 메시지: ${panelStatus} | 음악: ${music ? '활성화' : '비활성화'} | 초기화 소요: ${Math.round(performance.now() - startedAt)}ms`);
  }

  client.once(Events.ClientReady, readyClient => {
    if (closing) return;
    finishLogin();
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

  const finishLogin = beginInitializationStep('Discord 로그인 및 Gateway 연결');
  try { await client.login(config.token); }
  catch (error) {
    log(`Discord 로그인 실패: ${errorMessage(error)}`);
    await shutdown(1);
  }
}

void main().catch(error => {
  log(`실행 실패: ${errorMessage(error)}`);
  process.exitCode = 1;
});
