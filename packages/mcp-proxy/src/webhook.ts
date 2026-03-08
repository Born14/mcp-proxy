/**
 * Webhook Notifications — Fire-and-Forget Event Delivery
 * =======================================================
 *
 * Three events only: blocked, loop_detected, session_complete.
 * No noise, no false alarms.
 *
 * Fire-and-forget with 2s abort timeout. If the endpoint hangs,
 * the proxy doesn't care — it never blocks on webhook delivery.
 *
 * Auto-detects Discord and Telegram from environment variables.
 */

export interface WebhookEvent {
  /** Event type */
  type: 'blocked' | 'loop_detected' | 'session_complete';

  /** ISO timestamp */
  timestamp: string;

  /** Event-specific payload */
  payload: Record<string, unknown>;
}

export interface WebhookConfig {
  /** Webhook URLs to fire on events */
  urls: string[];
}

/**
 * Resolve webhook URLs from CLI flags + environment variables.
 * Discord and Telegram are auto-detected from env vars.
 */
export function resolveWebhooks(cliUrls: string[]): string[] {
  const urls = [...cliUrls];

  // Discord: env var is a full webhook URL
  const discord = process.env.DISCORD_WEBHOOK;
  if (discord && !urls.includes(discord)) {
    urls.push(discord);
  }

  // Telegram: needs bot token + chat ID to construct URL
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChat = process.env.TELEGRAM_CHAT_ID;
  if (telegramToken && telegramChat) {
    const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage?chat_id=${telegramChat}`;
    if (!urls.includes(telegramUrl)) {
      urls.push(telegramUrl);
    }
  }

  return urls;
}

/**
 * Format a webhook event for Discord webhook API.
 * Discord expects { content: string } for simple messages.
 */
function formatForDiscord(event: WebhookEvent): Record<string, unknown> {
  const emoji = event.type === 'blocked' ? '🛑'
    : event.type === 'loop_detected' ? '🔄'
    : '📋';
  const title = event.type === 'blocked' ? 'Tool Call Blocked'
    : event.type === 'loop_detected' ? 'Loop Detected'
    : 'Session Complete';
  const lines = [`${emoji} **${title}**`];

  if (event.type === 'blocked') {
    const p = event.payload;
    lines.push(`Tool: \`${p.tool}\``);
    lines.push(`Reason: ${p.reason}`);
  } else if (event.type === 'loop_detected') {
    const p = event.payload;
    lines.push(`Tool: \`${p.tool}\``);
    lines.push(`Pattern: ${p.pattern}`);
  } else {
    const p = event.payload;
    lines.push(`Calls: ${p.totalCalls} (${p.mutations} mutations, ${p.readonly} reads)`);
    if ((p.blocked as number) > 0) lines.push(`Blocked: ${p.blocked}`);
    if ((p.errors as number) > 0) lines.push(`Errors: ${p.errors}`);
    lines.push(`Duration: ${p.duration}`);
  }

  return { content: lines.join('\n') };
}

/**
 * Format a webhook event for Telegram sendMessage API.
 * Telegram expects { text: string, parse_mode: 'Markdown' }.
 */
function formatForTelegram(event: WebhookEvent): Record<string, unknown> {
  const emoji = event.type === 'blocked' ? '🛑'
    : event.type === 'loop_detected' ? '🔄'
    : '📋';
  const title = event.type === 'blocked' ? 'Tool Call Blocked'
    : event.type === 'loop_detected' ? 'Loop Detected'
    : 'Session Complete';
  const lines = [`${emoji} *${title}*`];

  if (event.type === 'blocked') {
    const p = event.payload;
    lines.push(`Tool: \`${p.tool}\``);
    lines.push(`Reason: ${p.reason}`);
  } else if (event.type === 'loop_detected') {
    const p = event.payload;
    lines.push(`Tool: \`${p.tool}\``);
    lines.push(`Pattern: ${p.pattern}`);
  } else {
    const p = event.payload;
    lines.push(`Calls: ${p.totalCalls} (${p.mutations} mutations, ${p.readonly} reads)`);
    if ((p.blocked as number) > 0) lines.push(`Blocked: ${p.blocked}`);
    if ((p.errors as number) > 0) lines.push(`Errors: ${p.errors}`);
    lines.push(`Duration: ${p.duration}`);
  }

  return { text: lines.join('\n'), parse_mode: 'Markdown' };
}

/**
 * Detect URL type and format payload accordingly.
 */
function formatPayload(url: string, event: WebhookEvent): Record<string, unknown> {
  if (url.includes('discord.com/api/webhooks')) {
    return formatForDiscord(event);
  }
  if (url.includes('api.telegram.org/bot')) {
    return formatForTelegram(event);
  }
  // Generic: send the raw event
  return event as unknown as Record<string, unknown>;
}

/**
 * Fire a webhook event to all configured URLs.
 * Fire-and-forget: 2s abort timeout, errors logged to stderr, never throws.
 */
export function fireWebhook(urls: string[], event: WebhookEvent): void {
  for (const url of urls) {
    const body = formatPayload(url, event);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      // Fire-and-forget — don't block the proxy
    });
  }
}

/**
 * Create a blocked event.
 */
export function blockedEvent(tool: string, reason: string): WebhookEvent {
  return {
    type: 'blocked',
    timestamp: new Date().toISOString(),
    payload: { tool, reason },
  };
}

/**
 * Create a loop_detected event.
 */
export function loopDetectedEvent(tool: string, pattern: string): WebhookEvent {
  return {
    type: 'loop_detected',
    timestamp: new Date().toISOString(),
    payload: { tool, pattern },
  };
}

/**
 * Create a session_complete event.
 */
export function sessionCompleteEvent(stats: {
  totalCalls: number;
  mutations: number;
  readonly: number;
  blocked: number;
  errors: number;
  succeeded: number;
  duration: string;
}): WebhookEvent {
  return {
    type: 'session_complete',
    timestamp: new Date().toISOString(),
    payload: stats,
  };
}
