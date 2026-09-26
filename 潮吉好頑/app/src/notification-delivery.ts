import { fetchWithTimeout, serviceHeaders } from "./http";
export type NotificationChannel = "line" | "telegram";

export interface NotificationDeliveryEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?: string;
  LINE_NOTIFY_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_NOTIFY_ENABLED?: string;
}

type NotificationClaim = {
  id: string;
  claim_token: string;
  status: "pending" | "processing" | "sent" | "failed";
  attempt_count: number;
  payload: Record<string, unknown>;
  claimed: boolean;
  recipient_id?: string;
};

type DeliveryAttempt = {
  sent: boolean;
  statusCode: number | null;
  retryable: boolean;
  retryAfterSeconds: number;
  errorMessage: string | null;
};

/**
 * `sent`: the provider accepted the message during this call (or earlier).
 * `handled`: nothing is left for a caller to re-drive. The row is sent, owned
 * by the retry cron, or the channel is disabled; false only when no claim row
 * could be recorded, so the event must be offered again later.
 */
export type DeliveryResult = { sent: boolean; handled: boolean };

const DEFAULT_LEASE_SECONDS = 120;

/** True only for HTTP failures that should be retried automatically. */
export function isRetryableNotificationStatus(status: number) {
  return status === 429 || status >= 500;
}

/** Exponential retry delay, respecting an explicit provider Retry-After value. */
export function notificationRetryDelaySeconds(attempt: number, retryAfter?: number | null) {
  const exponential = Math.min(3600, 30 * (2 ** Math.max(0, Math.min(attempt - 1, 7))));
  const providerDelay = Number.isFinite(retryAfter) ? Math.max(0, Number(retryAfter)) : 0;
  return Math.max(exponential, providerDelay);
}

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

async function rpc<T>(env: NotificationDeliveryEnv, name: string, body: Record<string, unknown>): Promise<T | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify(body)
  });
  if (!response.ok) return null;
  return await response.json() as T;
}

/** Atomically claims a notification key, or reports the existing delivery state. */
async function claimNotification(
  env: NotificationDeliveryEnv,
  channel: NotificationChannel,
  eventKey: string,
  recipientId: string,
  eventType: string,
  payload: Record<string, unknown>
) {
  return rpc<NotificationClaim>(env, "claim_notification_delivery", {
    p_channel: channel,
    p_event_key: eventKey,
    p_recipient_id: recipientId,
    p_event_type: eventType,
    p_payload: payload,
    p_lease_seconds: DEFAULT_LEASE_SECONDS
  });
}

async function completeNotification(
  env: NotificationDeliveryEnv,
  channel: NotificationChannel,
  claim: NotificationClaim,
  attempt: DeliveryAttempt
) {
  return rpc<boolean>(env, "complete_notification_delivery", {
    p_channel: channel,
    p_id: claim.id,
    p_claim_token: claim.claim_token,
    p_sent: attempt.sent,
    p_status_code: attempt.statusCode,
    p_error_message: attempt.errorMessage,
    p_retryable: attempt.retryable,
    p_retry_after_seconds: attempt.retryAfterSeconds
  });
}

async function sendLine(
  env: NotificationDeliveryEnv,
  recipientId: string,
  payload: Record<string, unknown>,
  attemptCount: number
): Promise<DeliveryAttempt> {
  if (!env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) {
    return { sent: false, statusCode: null, retryable: false, retryAfterSeconds: 0, errorMessage: "LINE token missing" };
  }
  try {
    const response = await fetchWithTimeout("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: recipientId, messages: payload.messages })
    });
    if (response.ok) return { sent: true, statusCode: response.status, retryable: false, retryAfterSeconds: 0, errorMessage: null };
    const retryable = isRetryableNotificationStatus(response.status);
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    const detail = (await response.text()).slice(0, 400);
    return {
      sent: false,
      statusCode: response.status,
      retryable,
      retryAfterSeconds: retryable ? notificationRetryDelaySeconds(attemptCount, retryAfter) : 0,
      errorMessage: `LINE ${response.status}: ${detail || "通知發送失敗"}`
    };
  } catch (error) {
    return {
      sent: false,
      statusCode: null,
      retryable: true,
      retryAfterSeconds: notificationRetryDelaySeconds(attemptCount),
      errorMessage: `LINE network: ${error instanceof Error ? error.message : "通知發送失敗"}`
    };
  }
}

async function sendTelegram(
  env: NotificationDeliveryEnv,
  recipientId: string,
  payload: Record<string, unknown>,
  attemptCount: number
): Promise<DeliveryAttempt> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { sent: false, statusCode: null, retryable: false, retryAfterSeconds: 0, errorMessage: "Telegram token missing" };
  }
  try {
    const response = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: recipientId, text: String(payload.text || "").slice(0, 4096) })
    });
    const responsePayload = await response.json().catch(() => null) as {
      ok?: boolean;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    const sent = response.ok && responsePayload?.ok === true;
    if (sent) return { sent: true, statusCode: response.status, retryable: false, retryAfterSeconds: 0, errorMessage: null };
    const retryable = isRetryableNotificationStatus(response.status);
    const retryAfter = responsePayload?.parameters?.retry_after ?? parseRetryAfter(response.headers.get("Retry-After"));
    return {
      sent: false,
      statusCode: response.status,
      retryable,
      retryAfterSeconds: retryable ? notificationRetryDelaySeconds(attemptCount, retryAfter) : 0,
      errorMessage: `Telegram ${response.status}: ${(responsePayload?.description || "通知發送失敗").slice(0, 400)}`
    };
  } catch (error) {
    return {
      sent: false,
      statusCode: null,
      retryable: true,
      retryAfterSeconds: notificationRetryDelaySeconds(attemptCount),
      errorMessage: `Telegram network: ${error instanceof Error ? error.message : "通知發送失敗"}`
    };
  }
}

async function deliverClaim(
  env: NotificationDeliveryEnv,
  channel: NotificationChannel,
  claim: NotificationClaim,
  recipientId: string
) {
  const attempt = channel === "line"
    ? await sendLine(env, recipientId, claim.payload, claim.attempt_count)
    : await sendTelegram(env, recipientId, claim.payload, claim.attempt_count);
  // The claim token fences completions from an earlier worker whose lease
  // expired while its provider request was still in flight. A provider may
  // have accepted that earlier request, so delivery remains at-least-once.
  await completeNotification(env, channel, claim, attempt);
  return attempt.sent;
}

/** Queue/claim and deliver one LINE notification. Duplicate sent rows are successful no-ops. */
export async function deliverLineNotification(
  env: NotificationDeliveryEnv,
  eventKey: string,
  recipientId: string,
  eventType: string,
  message: unknown
): Promise<DeliveryResult> {
  if (env.LINE_NOTIFY_ENABLED === "false" || !env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN || !recipientId) return { sent: false, handled: true };
  const claim = await claimNotification(env, "line", eventKey, recipientId, eventType, { messages: [message] });
  if (!claim) return { sent: false, handled: false };
  if (!claim.claimed) return { sent: claim.status === "sent", handled: true };
  return { sent: await deliverClaim(env, "line", claim, recipientId), handled: true };
}

/** Queue/claim and deliver one Telegram notification. Its result is independent from LINE. */
export async function deliverTelegramNotification(
  env: NotificationDeliveryEnv,
  eventKey: string,
  recipientId: string,
  eventType: string,
  message: string
): Promise<DeliveryResult> {
  if (env.TELEGRAM_NOTIFY_ENABLED === "false" || !env.TELEGRAM_BOT_TOKEN || !recipientId) return { sent: false, handled: true };
  const claim = await claimNotification(env, "telegram", eventKey, recipientId, eventType, { text: message.slice(0, 4096) });
  if (!claim) return { sent: false, handled: false };
  if (!claim.claimed) return { sent: claim.status === "sent", handled: true };
  return { sent: await deliverClaim(env, "telegram", claim, recipientId), handled: true };
}

async function claimDue(env: NotificationDeliveryEnv, channel: NotificationChannel) {
  return (await rpc<NotificationClaim[]>(env, "claim_due_notification_deliveries", {
    p_channel: channel,
    p_limit: 25,
    p_lease_seconds: DEFAULT_LEASE_SECONDS
  })) || [];
}

/** Reclaims retry-due failures and expired processing leases without cross-channel coupling. */
export async function retryDueNotificationDeliveries(env: NotificationDeliveryEnv) {
  const tasks: Promise<boolean>[] = [];
  if (env.LINE_NOTIFY_ENABLED !== "false" && env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) {
    const claims = await claimDue(env, "line");
    tasks.push(...claims.map((claim) => deliverClaim(env, "line", claim, String(claim.recipient_id || ""))));
  }
  if (env.TELEGRAM_NOTIFY_ENABLED !== "false" && env.TELEGRAM_BOT_TOKEN) {
    const claims = await claimDue(env, "telegram");
    tasks.push(...claims.map((claim) => deliverClaim(env, "telegram", claim, String(claim.recipient_id || ""))));
  }
  await Promise.allSettled(tasks);
}
