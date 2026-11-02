import { DEFAULT_SETTINGS, MAX_INDIVIDUAL_NOTIFICATIONS, POLL_ALARM, REGIONS } from './lib/config.js';
import { AuthExpiredError, refreshAccessToken, revokeRefreshToken } from './lib/auth.js';
import {
  extractEmail, listUnread, normalizeAccount, normalizeFolder, replyToFromHeaders, request, updateMessageBody,
} from './lib/zoho.js';
import { badgeText, decodeEntities, diffNewMessages, totalUnread, updateSeen } from './lib/inbox.js';
import { DND_ALARM, DND_CHOICES, dndEnd, dndStatus, isDndOn } from './lib/dnd.js';

const ACTED_TTL_MS = 60000;
const UPDATE_MODES = { markRead: 'markAsRead', archive: 'archiveMails', spam: 'moveToSpam' };
const UPDATE_CHUNK = 200;

// In-memory only. If the background page unloads these simply start empty again.
let lock = Promise.resolve();
let checkInFlight = null;
const refreshing = new Map();
const recentlyActed = new Map();

// Serialises read-modify-write of stored state. Never hold it across mail API calls.
function withLock(fn) {
  const result = lock.then(fn);
  lock = result.catch(() => {});
  return result;
}

async function loadSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function loadConnections() {
  const { connections = [] } = await browser.storage.local.get('connections');
  return connections;
}

async function loadDnd() {
  const { dnd } = await browser.storage.local.get('dnd');
  return isDndOn(dnd) ? dnd : null;
}

async function loadInbox() {
  const { inbox } = await browser.storage.session.get('inbox');
  return inbox || { byAccount: {}, lastCheck: 0 };
}

function updateConnection(id, changes) {
  return withLock(async () => {
    const connections = await loadConnections();
    const next = connections.map((c) => (c.id === id ? { ...c, ...changes(c) } : c));
    await browser.storage.local.set({ connections: next });
    return next.find((c) => c.id === id);
  });
}

async function accessTokenFor(connectionId, { force = false } = {}) {
  if (refreshing.has(connectionId)) return refreshing.get(connectionId);
  const connection = (await loadConnections()).find((c) => c.id === connectionId);
  if (!connection) throw new Error('This account is no longer connected.');
  if (connection.needsReauth) throw new AuthExpiredError('Zoho sign-in has expired.');
  if (!force && connection.accessToken && connection.expiresAt - 60000 > Date.now()) return connection.accessToken;

  const pending = (async () => {
    try {
      const tokens = await refreshAccessToken(connection, await loadSettings());
      await updateConnection(connectionId, () => tokens);
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof AuthExpiredError) await updateConnection(connectionId, () => ({ needsReauth: true }));
      throw error;
    } finally {
      refreshing.delete(connectionId);
    }
  })();
  refreshing.set(connectionId, pending);
  return pending;
}

async function sessionFor(connection, options) {
  return { mailOrigin: REGIONS[connection.region].mail, accessToken: await accessTokenFor(connection.id, options) };
}

// Runs an API operation, renewing the access token once if Zoho rejects it.
async function withSession(connection, operation) {
  try {
    return await operation(await sessionFor(connection));
  } catch (error) {
    if (!error.isAuthError) throw error;
    return operation(await sessionFor(connection, { force: true }));
  }
}

function findAccount(connections, accountId) {
  for (const connection of connections) {
    const account = connection.accounts.find((a) => a.accountId === accountId);
    if (account) return { connection, account };
  }
  throw new Error('This account is no longer connected.');
}

function pruneRecentlyActed() {
  const cutoff = Date.now() - ACTED_TTL_MS;
  for (const [id, at] of recentlyActed) if (at < cutoff) recentlyActed.delete(id);
}

async function renderBadge(inbox) {
  await browser.action.setBadgeBackgroundColor({ color: '#d93025' });
  await browser.action.setBadgeTextColor({ color: '#ffffff' });
  await browser.action.setBadgeText({ text: badgeText(inbox) });
  const total = totalUnread(inbox);
  const dnd = await loadDnd();
  const quiet = dnd ? ` (do not disturb ${dndStatus(dnd)})` : '';
  await browser.action.setTitle({ title: `Zoho Mail: ${total ? `${total} unread` : 'no unread mail'}${quiet}` });
}

function messageUrl(region, folderPath, messageId) {
  const folder = encodeURIComponent((folderPath || 'inbox').replace(/^\/+/, '').toLowerCase());
  return `${REGIONS[region].mail}/zm/#mail/folder/${folder}/p/${messageId}`;
}

function playChime() {
  const context = new AudioContext();
  [[660, 0], [880, 0.14]].forEach(([frequency, delay]) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + delay;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.36);
  });
  setTimeout(() => context.close(), 800);
}

async function notifyNewMail(newMessages, connections, settings) {
  // Mail that arrives during do not disturb is still marked seen, so it stays quiet afterwards too.
  if (!newMessages.length || await loadDnd()) return;
  if (settings.sound) {
    try {
      playChime();
    } catch (error) {
      console.warn('Could not play the notification sound', error);
    }
  }
  if (!settings.notify) return;

  const urlFor = (message) => {
    const { connection, account } = findAccount(connections, message.accountId);
    const folder = account.folders?.find((f) => f.id === message.folderId);
    return messageUrl(connection.region, folder?.path, message.id);
  };
  const iconUrl = browser.runtime.getURL('icons/icon.svg');
  const { notificationLinks = {} } = await browser.storage.session.get('notificationLinks');

  if (newMessages.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
    const senders = [...new Set(newMessages.map((m) => decodeEntities(m.sender) || extractEmail(m.fromAddress)))];
    const id = await browser.notifications.create(`summary:${Date.now()}`, {
      type: 'basic',
      iconUrl,
      title: `${newMessages.length} new messages`,
      message: settings.notifyPreview ? `From ${senders.slice(0, 4).join(', ')}${senders.length > 4 ? ' and others' : ''}` : 'Zoho Mail',
    });
    const { connection } = findAccount(connections, newMessages[0].accountId);
    notificationLinks[id] = `${REGIONS[connection.region].mail}/zm/`;
  } else {
    for (const message of newMessages) {
      const sender = decodeEntities(message.sender) || extractEmail(decodeEntities(message.fromAddress)) || 'New mail';
      const body = settings.notifyPreview
        ? [decodeEntities(message.subject) || '(no subject)', decodeEntities(message.summary)].filter(Boolean).join('\n')
        : 'New message in Zoho Mail';
      const id = await browser.notifications.create(`message:${message.id}`, {
        type: 'basic', iconUrl, title: sender, message: body,
      });
      notificationLinks[id] = urlFor(message);
    }
  }
  await browser.storage.session.set({ notificationLinks });
}

function friendlyError(error) {
  if (error instanceof AuthExpiredError) return 'Sign-in expired. Reconnect this account in settings.';
  if (error.status === 429) return 'Zoho rate limit reached. Will retry on the next check.';
  return error.message || 'Could not reach Zoho Mail.';
}

async function fetchAccount(connection, account) {
  try {
    const result = await withSession(connection, (session) => listUnread(session, account.accountId, account.watchedFolderIds || []));
    return { accountId: account.accountId, ...result, error: null };
  } catch (error) {
    console.warn(`Check failed for account ${account.accountId}`, error);
    return { accountId: account.accountId, failed: true, error: friendlyError(error) };
  }
}

async function runCheck() {
  const connections = await loadConnections();
  const jobs = connections.flatMap((c) => c.accounts.map((a) => fetchAccount(c, a)));
  const results = await Promise.all(jobs);

  await withLock(async () => {
    pruneRecentlyActed();
    const previous = await loadInbox();
    const { seen = {} } = await browser.storage.local.get('seen');
    const byAccount = {};
    const nextSeen = {};
    const newMessages = [];
    for (const result of results) {
      const { accountId } = result;
      if (result.failed) {
        // Keep showing the last good list rather than blanking on a network blip.
        byAccount[accountId] = { messages: [], capped: false, ...previous.byAccount[accountId], error: result.error };
        if (seen[accountId]) nextSeen[accountId] = seen[accountId];
        continue;
      }
      const messages = result.messages.filter((m) => !recentlyActed.has(m.id));
      byAccount[accountId] = { messages, capped: result.capped, error: null };
      newMessages.push(...diffNewMessages(messages, seen[accountId]));
      nextSeen[accountId] = updateSeen(messages, seen[accountId]);
    }
    const inbox = { byAccount, lastCheck: Date.now() };
    await browser.storage.local.set({ seen: nextSeen });
    await browser.storage.session.set({ inbox });
    await renderBadge(inbox);
    await notifyNewMail(newMessages, connections, await loadSettings());
  });
}

function checkAll() {
  if (!checkInFlight) checkInFlight = runCheck().finally(() => { checkInFlight = null; });
  return checkInFlight;
}

async function scheduleAlarm() {
  const { pollMinutes } = await loadSettings();
  const periodInMinutes = Math.min(60, Math.max(1, Number(pollMinutes) || DEFAULT_SETTINGS.pollMinutes));
  await browser.alarms.create(POLL_ALARM, { delayInMinutes: periodInMinutes, periodInMinutes });
}

function removeFromInbox(accountId, ids) {
  const removed = new Set(ids);
  return withLock(async () => {
    const inbox = await loadInbox();
    const account = inbox.byAccount[accountId];
    if (!account) return;
    account.messages = account.messages.filter((m) => !removed.has(m.id));
    await browser.storage.session.set({ inbox });
    await renderBadge(inbox);
  });
}

async function performAction({ action, accountId, messages }) {
  const { connection } = findAccount(await loadConnections(), accountId);
  const ids = messages.map((m) => m.id);
  const now = Date.now();
  ids.forEach((id) => recentlyActed.set(id, now));
  ids.forEach((id) => browser.notifications.clear(`message:${id}`));
  await removeFromInbox(accountId, ids);
  try {
    await withSession(connection, async (session) => {
      if (action === 'delete') {
        // Without expunge=true, Zoho moves the message to Trash rather than destroying it.
        await Promise.all(messages.map((m) => request(session, 'DELETE', `/accounts/${accountId}/folders/${m.folderId}/messages/${m.id}`)));
        return;
      }
      const mode = UPDATE_MODES[action];
      if (!mode) throw new Error(`Unknown action: ${action}`);
      for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
        const body = updateMessageBody(mode, ids.slice(i, i + UPDATE_CHUNK));
        await request(session, 'PUT', `/accounts/${accountId}/updatemessage`, { body });
      }
    });
  } catch (error) {
    ids.forEach((id) => recentlyActed.delete(id));
    checkAll();
    throw new Error(friendlyError(error));
  }
}

async function getContent({ accountId, folderId, messageId }) {
  const { connection } = findAccount(await loadConnections(), accountId);
  const data = await withSession(connection, (session) => request(session, 'GET', `/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`));
  return data?.content || '';
}

// Replies should honour Reply-To, which the list API does not expose. Failure here is
// not fatal: the popup falls back to the From address, and the user can edit the field.
async function getReplyTo({ accountId, folderId, messageId }) {
  const { connection } = findAccount(await loadConnections(), accountId);
  try {
    const data = await withSession(connection, (session) => request(session, 'GET', `/accounts/${accountId}/folders/${folderId}/messages/${messageId}/header`));
    return replyToFromHeaders(data?.headerContent);
  } catch (error) {
    console.warn('Could not read Reply-To', error);
    return '';
  }
}

async function sendReply({ accountId, messageId, to, subject, content }) {
  const { connection, account } = findAccount(await loadConnections(), accountId);
  const body = JSON.stringify({
    fromAddress: account.email,
    toAddress: to,
    subject,
    content,
    mailFormat: 'plaintext',
    action: 'reply',
  });
  try {
    await withSession(connection, (session) => request(session, 'POST', `/accounts/${accountId}/messages/${messageId}`, { body }));
  } catch (error) {
    throw new Error(friendlyError(error));
  }
}

// Fetches a newly authorised login's mailboxes, defaulting each to watching its Inbox.
async function addConnection(tokens) {
  const session = { mailOrigin: REGIONS[tokens.region].mail, accessToken: tokens.accessToken };
  const rawAccounts = (await request(session, 'GET', '/accounts')) || [];
  if (!rawAccounts.length) throw new Error('This Zoho login has no mail accounts.');
  const accounts = await Promise.all(rawAccounts.map(async (raw) => {
    const account = normalizeAccount(raw);
    const folders = ((await request(session, 'GET', `/accounts/${account.accountId}/folders`)) || []).map(normalizeFolder);
    const inbox = folders.find((f) => f.type === 'Inbox') || folders[0];
    return { ...account, folders, watchedFolderIds: inbox ? [inbox.id] : [] };
  }));

  await withLock(async () => {
    const connections = await loadConnections();
    const ids = new Set(accounts.map((a) => a.accountId));
    // Reconnecting the same login replaces it, keeping the user's folder choices.
    const existing = connections.find((c) => c.accounts.some((a) => ids.has(a.accountId)));
    for (const account of accounts) {
      const prior = existing?.accounts.find((a) => a.accountId === account.accountId);
      if (prior?.watchedFolderIds?.length) account.watchedFolderIds = prior.watchedFolderIds;
    }
    const connection = { id: existing?.id || crypto.randomUUID(), ...tokens, needsReauth: false, accounts };
    const others = connections.filter((c) => c !== existing);
    await browser.storage.local.set({ connections: [...others, connection] });
  });
  await checkAll();
}

async function removeConnection({ connectionId }) {
  const removed = await withLock(async () => {
    const connections = await loadConnections();
    const target = connections.find((c) => c.id === connectionId);
    await browser.storage.local.set({ connections: connections.filter((c) => c.id !== connectionId) });
    const { seen = {} } = await browser.storage.local.get('seen');
    target?.accounts.forEach((a) => delete seen[a.accountId]);
    await browser.storage.local.set({ seen });
    return target;
  });
  if (removed) {
    // Best effort. The local copy is already gone even if Zoho cannot be reached.
    revokeRefreshToken(removed).catch((error) => console.warn('Could not revoke token', error));
  }
  await checkAll();
}

async function refreshFolders({ accountId }) {
  const { connection } = findAccount(await loadConnections(), accountId);
  const folders = ((await withSession(connection, (session) => request(session, 'GET', `/accounts/${accountId}/folders`))) || []).map(normalizeFolder);
  await updateConnection(connection.id, (c) => ({
    accounts: c.accounts.map((a) => (a.accountId === accountId ? { ...a, folders } : a)),
  }));
}

async function setWatchedFolders({ accountId, folderIds }) {
  const { connection } = findAccount(await loadConnections(), accountId);
  await updateConnection(connection.id, (c) => ({
    accounts: c.accounts.map((a) => (a.accountId === accountId ? { ...a, watchedFolderIds: folderIds } : a)),
  }));
  // Forget history so mail already sitting in a newly watched folder does not all notify.
  await withLock(async () => {
    const { seen = {} } = await browser.storage.local.get('seen');
    delete seen[accountId];
    await browser.storage.local.set({ seen });
  });
  await checkAll();
}

// Summaries for pages: never includes tokens.
async function getState() {
  const [connections, settings, inbox, dnd] = await Promise.all([loadConnections(), loadSettings(), loadInbox(), loadDnd()]);
  return {
    configured: Boolean(settings.clientId && settings.clientSecret),
    dnd: dnd ? { until: dnd.until, status: dndStatus(dnd) } : null,
    settings: {
      markReadOnOpen: settings.markReadOnOpen,
      loadRemoteImages: settings.loadRemoteImages,
    },
    connections: connections.map((c) => ({
      id: c.id,
      region: c.region,
      needsReauth: Boolean(c.needsReauth),
      accounts: c.accounts,
    })),
    inbox,
  };
}

async function focusOrOpen(origin, url) {
  // Query fails only if the host permission was withdrawn, and then a new tab is right anyway.
  const tabs = await browser.tabs.query({ url: `${origin}/zm/*` }).catch(() => []);
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
  } else {
    await browser.tabs.create({ url });
  }
}

async function openMail({ accountId, message, compose }) {
  const connections = await loadConnections();
  const { connection, account } = accountId
    ? findAccount(connections, accountId)
    : { connection: connections[0] };
  const region = connection?.region || (await loadSettings()).region;
  const origin = REGIONS[region].mail;
  if (message) {
    const folder = account?.folders?.find((f) => f.id === message.folderId);
    await browser.tabs.create({ url: messageUrl(region, folder?.path, message.id) });
  } else if (compose) {
    await browser.tabs.create({ url: `${origin}/zm/#compose` });
  } else {
    await focusOrOpen(origin, `${origin}/zm/`);
  }
}

// Brings the right-click menu and toolbar tooltip in line with the stored do-not-disturb state.
async function renderDnd() {
  const dnd = await loadDnd();
  await browser.menus.update('dnd', { title: dnd ? `Do not disturb (${dndStatus(dnd)})` : 'Do not disturb' });
  await browser.menus.update('dnd-separator', { visible: Boolean(dnd) });
  await browser.menus.update('dnd-off', { visible: Boolean(dnd) });
  await withLock(async () => renderBadge(await loadInbox()));
}

async function setDoNotDisturb({ choice }) {
  await menusReady;
  await browser.alarms.clear(DND_ALARM);
  if (choice) {
    const until = dndEnd(choice);
    await browser.storage.local.set({ dnd: { choice, until } });
    if (until !== null) await browser.alarms.create(DND_ALARM, { when: until });
  } else {
    await browser.storage.local.remove('dnd');
  }
  await renderDnd();
}

async function createMenus() {
  await browser.menus.removeAll();
  const item = (props) => browser.menus.create({ contexts: ['action'], ...props });
  item({ id: 'open', title: 'Open Zoho Mail' });
  item({ id: 'compose', title: 'Compose' });
  item({ id: 'refresh', title: 'Refresh' });
  item({ id: 'dnd', title: 'Do not disturb' });
  for (const choice of DND_CHOICES) item({ id: `dnd:${choice.id}`, parentId: 'dnd', title: choice.title });
  item({ id: 'dnd-separator', parentId: 'dnd', type: 'separator', visible: false });
  item({ id: 'dnd-off', parentId: 'dnd', title: 'Turn off', visible: false });

  // A period that ran out while Firefox was closed has no alarm left to end it.
  const { dnd } = await browser.storage.local.get('dnd');
  if (dnd && !isDndOn(dnd)) await browser.storage.local.remove('dnd');
  else if (dnd?.until) await browser.alarms.create(DND_ALARM, { when: dnd.until });
  await renderDnd();
}

const MENU_COMMANDS = {
  open: () => openMail({}),
  compose: () => openMail({ compose: true }),
  refresh: checkAll,
  'dnd-off': () => setDoNotDisturb({ choice: null }),
};

browser.menus.onClicked.addListener(({ menuItemId }) => {
  const id = String(menuItemId);
  const command = id.startsWith('dnd:') ? () => setDoNotDisturb({ choice: id.slice(4) }) : MENU_COMMANDS[id];
  Promise.resolve(command?.()).catch((error) => console.warn(`Menu command ${id} failed`, error));
});

const HANDLERS = {
  getState,
  check: checkAll,
  action: performAction,
  getContent,
  getReplyTo,
  sendReply,
  addConnection: ({ tokens }) => addConnection(tokens),
  removeConnection,
  refreshFolders,
  setWatchedFolders,
  openMail,
  setDoNotDisturb,
  settingsChanged: scheduleAlarm,
};

browser.runtime.onMessage.addListener((message) => {
  const handler = HANDLERS[message?.type];
  return handler ? Promise.resolve(handler(message)) : undefined;
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) checkAll();
  if (alarm.name === DND_ALARM) setDoNotDisturb({ choice: null });
});

browser.notifications.onClicked.addListener(async (id) => {
  const { notificationLinks = {} } = await browser.storage.session.get('notificationLinks');
  if (notificationLinks[id]) await browser.tabs.create({ url: notificationLinks[id] });
  browser.notifications.clear(id);
});

async function startUp() {
  await scheduleAlarm();
  await checkAll();
}

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  await startUp();
  if (reason === 'install') browser.runtime.openOptionsPage();
});
browser.runtime.onStartup.addListener(startUp);

// Rebuilt whenever the background page loads, so the menu always matches the stored state.
const menusReady = createMenus().catch((error) => console.warn('Could not create the menu', error));
