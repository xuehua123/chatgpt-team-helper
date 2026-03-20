import { randomUUID } from 'node:crypto'
import axios from 'axios'

const trimString = (value) => String(value ?? '').trim()

const isEnabled = () => {
  const raw = trimString(process.env.ACCOUNT_SYNC_WEBHOOK_ENABLED || 'true').toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const getWebhookConfig = () => {
  const baseUrl = trimString(process.env.ACCOUNT_SYNC_BASE_URL)
  const eventsPath = trimString(process.env.ACCOUNT_SYNC_EVENTS_PATH || '/api/v1/events')
  const sharedSecret = trimString(process.env.ACCOUNT_SYNC_SHARED_SECRET)
  const timeoutMs = Number.parseInt(trimString(process.env.ACCOUNT_SYNC_TIMEOUT_MS || '8000'), 10)

  return {
    enabled: isEnabled(),
    baseUrl,
    eventsPath: eventsPath.startsWith('/') ? eventsPath : `/${eventsPath}`,
    sharedSecret,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000
  }
}

const joinUrl = (baseUrl, path) => `${baseUrl.replace(/\/+$/, '')}${path}`

const buildAccountMetadata = (account) => ({
  localId: Number(account?.id) || null,
  chatgptAccountId: trimString(account?.chatgptAccountId) || null,
  isOpen: Boolean(account?.isOpen),
  isBanned: Boolean(account?.isBanned),
  expireAt: trimString(account?.expireAt) || null,
  sourceSystem: 'chatgpt-team-helper'
})

export async function notifyAccountQuarantined({
  account,
  reason,
  source = 'chatgpt-team-helper.manual',
  payload = {}
} = {}) {
  const config = getWebhookConfig()
  if (!config.enabled || !config.baseUrl) {
    return { delivered: false, skipped: true, reason: 'account_sync_not_configured' }
  }

  const accountId = Number(account?.id)
  const email = trimString(account?.email).toLowerCase()
  if (!Number.isFinite(accountId) || !email) {
    return { delivered: false, skipped: true, reason: 'missing_account_identity' }
  }

  const body = {
    event_id: `cth-${accountId}-${Date.now()}-${randomUUID()}`,
    event_type: 'account.status.changed',
    source,
    occurred_at: new Date().toISOString(),
    account: {
      provider: 'openai_team',
      email,
      remote_id: String(accountId),
      owner_system: 'chatgpt-team-helper',
      metadata: buildAccountMetadata(account)
    },
    status: 'quarantined',
    reason: trimString(reason) || 'account_marked_quarantined',
    version: Date.now(),
    payload: {
      trigger: source,
      local_account_id: accountId,
      chatgpt_account_id: trimString(account?.chatgptAccountId) || null,
      ...payload
    }
  }

  const headers = {
    'Content-Type': 'application/json'
  }
  if (config.sharedSecret) {
    headers['X-Account-Sync-Secret'] = config.sharedSecret
  }

  const url = joinUrl(config.baseUrl, config.eventsPath)

  try {
    const response = await axios.post(url, body, {
      headers,
      timeout: config.timeoutMs
    })

    console.log('[AccountStatusWebhook] delivered quarantine event', {
      accountId,
      url,
      status: response.status
    })

    return {
      delivered: true,
      skipped: false,
      statusCode: response.status
    }
  } catch (error) {
    const statusCode = Number(error?.response?.status || 0) || null
    const message =
      error?.response?.data?.detail ||
      error?.response?.data?.error ||
      error?.message ||
      String(error)

    console.warn('[AccountStatusWebhook] delivery failed', {
      accountId,
      url,
      statusCode,
      message
    })

    return {
      delivered: false,
      skipped: false,
      statusCode,
      message
    }
  }
}
