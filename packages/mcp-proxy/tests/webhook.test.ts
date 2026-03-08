/**
 * Webhook notification tests.
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveWebhooks,
  blockedEvent,
  loopDetectedEvent,
  sessionCompleteEvent,
  fireWebhook,
} from '../src/webhook.js';
import type { WebhookEvent } from '../src/webhook.js';

describe('resolveWebhooks', () => {
  test('returns CLI URLs as-is', () => {
    const urls = resolveWebhooks(['https://example.com/hook']);
    expect(urls).toEqual(['https://example.com/hook']);
  });

  test('returns empty array when no URLs and no env vars', () => {
    // Clean env
    const oldDiscord = process.env.DISCORD_WEBHOOK;
    const oldTgToken = process.env.TELEGRAM_BOT_TOKEN;
    const oldTgChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.DISCORD_WEBHOOK;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const urls = resolveWebhooks([]);
    expect(urls).toEqual([]);

    // Restore
    if (oldDiscord) process.env.DISCORD_WEBHOOK = oldDiscord;
    if (oldTgToken) process.env.TELEGRAM_BOT_TOKEN = oldTgToken;
    if (oldTgChat) process.env.TELEGRAM_CHAT_ID = oldTgChat;
  });

  test('auto-detects Discord webhook from env', () => {
    const old = process.env.DISCORD_WEBHOOK;
    process.env.DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

    const urls = resolveWebhooks([]);
    expect(urls).toContain('https://discord.com/api/webhooks/123/abc');

    if (old) process.env.DISCORD_WEBHOOK = old;
    else delete process.env.DISCORD_WEBHOOK;
  });

  test('auto-detects Telegram from env', () => {
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    const oldChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'bot123';
    process.env.TELEGRAM_CHAT_ID = '456';

    const urls = resolveWebhooks([]);
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('api.telegram.org/botbot123');
    expect(urls[0]).toContain('chat_id=456');

    if (oldToken) process.env.TELEGRAM_BOT_TOKEN = oldToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (oldChat) process.env.TELEGRAM_CHAT_ID = oldChat;
    else delete process.env.TELEGRAM_CHAT_ID;
  });

  test('does not duplicate CLI URL with Discord env', () => {
    const old = process.env.DISCORD_WEBHOOK;
    const url = 'https://discord.com/api/webhooks/123/abc';
    process.env.DISCORD_WEBHOOK = url;

    const urls = resolveWebhooks([url]);
    expect(urls.length).toBe(1);

    if (old) process.env.DISCORD_WEBHOOK = old;
    else delete process.env.DISCORD_WEBHOOK;
  });

  test('requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID', () => {
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    const oldChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'bot123';
    delete process.env.TELEGRAM_CHAT_ID;

    const urls = resolveWebhooks([]);
    expect(urls.length).toBe(0);

    if (oldToken) process.env.TELEGRAM_BOT_TOKEN = oldToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (oldChat) process.env.TELEGRAM_CHAT_ID = oldChat;
  });
});

describe('event constructors', () => {
  test('blockedEvent has correct shape', () => {
    const e = blockedEvent('read_file', 'G2 constraint');
    expect(e.type).toBe('blocked');
    expect(e.payload.tool).toBe('read_file');
    expect(e.payload.reason).toBe('G2 constraint');
    expect(e.timestamp).toBeTruthy();
  });

  test('loopDetectedEvent has correct shape', () => {
    const e = loopDetectedEvent('write_file', 'same error 3x');
    expect(e.type).toBe('loop_detected');
    expect(e.payload.tool).toBe('write_file');
    expect(e.payload.pattern).toBe('same error 3x');
  });

  test('sessionCompleteEvent has correct shape', () => {
    const e = sessionCompleteEvent({
      totalCalls: 47,
      mutations: 8,
      readonly: 35,
      blocked: 2,
      errors: 2,
      succeeded: 43,
      duration: '3.2m',
    });
    expect(e.type).toBe('session_complete');
    expect(e.payload.totalCalls).toBe(47);
    expect(e.payload.mutations).toBe(8);
    expect(e.payload.duration).toBe('3.2m');
  });
});

describe('fireWebhook', () => {
  test('does not throw on empty URL list', () => {
    expect(() => fireWebhook([], blockedEvent('test', 'reason'))).not.toThrow();
  });

  test('does not throw on unreachable URL', () => {
    // Fire-and-forget — should not throw even with bad URLs
    expect(() => {
      fireWebhook(['http://localhost:99999/nonexistent'], blockedEvent('test', 'reason'));
    }).not.toThrow();
  });
});
