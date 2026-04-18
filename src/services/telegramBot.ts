import { Bot, GrammyError, webhookCallback } from 'grammy';
import crypto from 'crypto';
import prisma from '../prisma';
import { getRedis } from './redis';

const RESET_CODE_PREFIX = 'pwd-reset:';
const RESET_CODE_TTL = 300; // 5 minutes

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

let bot: Bot | null = null;

function isBotBlocked(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 403;
}

async function unlinkTelegramChat(chatId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { telegramChatId: chatId },
    data: { telegramChatId: null },
  });
}

export function getTelegramBot(): Bot {
  if (!BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
  if (!bot) {
    bot = new Bot(BOT_TOKEN);
    registerHandlers(bot);
  }
  return bot;
}

function registerHandlers(bot: Bot) {
  bot.command('start', async (ctx) => {
    const login = ctx.match; // /start <username or phone>
    const chatId = ctx.chat.id.toString();

    try {
      if (!login) {
        await ctx.reply(
          'Welcome to SpeakUp! To link your account, send:\n/start <username or phone>'
        );
        return;
      }

      let user = await prisma.user.findUnique({ where: { username: login } });
      if (!user) {
        user = await prisma.user.findUnique({ where: { phone: login } });
      }
      if (!user) {
        await ctx.reply('Account not found. Please check your username or phone number.');
        return;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatId },
      });

      await ctx.reply(
        `✅ Account linked successfully!\nHello, ${user.fullName}. You will receive password reset codes here.`
      );
    } catch (err) {
      if (isBotBlocked(err)) {
        await unlinkTelegramChat(chatId);
        return;
      }
      throw err;
    }
  });
}

/** Generate a 6-digit reset code and send it via Telegram */
export async function sendPasswordResetCode(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  if (!user.telegramChatId) throw new Error('Telegram not linked');

  const code = crypto.randomInt(100000, 999999).toString();
  const redis = getRedis();
  await redis.set(`${RESET_CODE_PREFIX}${userId}`, code, 'EX', RESET_CODE_TTL);

  const telegramBot = getTelegramBot();
  try {
    await telegramBot.api.sendMessage(
      user.telegramChatId,
      `🔐 Your password reset code: *${code}*\n\nThis code expires in 5 minutes. If you didn't request this, ignore this message.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    if (isBotBlocked(err)) {
      await unlinkTelegramChat(user.telegramChatId);
      throw new Error('Telegram bot was blocked by the user');
    }
    throw err;
  }
}

/** Verify a 6-digit reset code */
export async function verifyResetCode(userId: string, code: string): Promise<boolean> {
  const redis = getRedis();
  const stored = await redis.get(`${RESET_CODE_PREFIX}${userId}`);
  if (!stored || stored !== code) return false;
  await redis.del(`${RESET_CODE_PREFIX}${userId}`);
  return true;
}

/** Express middleware for grammyjs webhook */
export function createWebhookHandler() {
  const telegramBot = getTelegramBot();
  return webhookCallback(telegramBot, 'express');
}
