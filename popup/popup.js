import { buildEmailDocument, isSafeExternalLink } from '../lib/email-frame.js';
import { decodeEntities, replySubject, totalUnread } from '../lib/inbox.js';
import { extractEmail } from '../lib/zoho.js';
import { applyAppearance, effectiveTheme } from '../lib/appearance.js';
import { DEFAULT_SETTINGS } from '../lib/config.js';

const MAX_ROWS_PER_ACCOUNT = 100;
const $ = (id) => document.getElementById(id);
const send = (type, payload) => browser.runtime.sendMessage({ type, ...payload });

let state = null;
let current = null; // { message, html, remoteAllowed } while the reading view is open
let toastTimer = null;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function showToast(text, isError = false) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, isError ? 6000 : 2500);
}

function shortTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

const senderName = (m) => decodeEntities(m.sender) || extractEmail(decodeEntities(m.fromAddress)) || 'Unknown sender';
const subjectOf = (m) => decodeEntities(m.subject) || '(no subject)';

// A circle with the sender's first letter, coloured consistently per sender.
function avatar(message, node = el('span', { className: 'avatar', ariaHidden: 'true' })) {
  const name = senderName(message);
  const key = extractEmail(decodeEntities(message.fromAddress)) || name;
  let hash = 0;
  for (const ch of key.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  node.textContent = [...name.replace(/^[^\p{L}\p{N}]+/u, '')][0] || '?';
  node.style.setProperty('--hue', String(hash));
  return node;
}

function accounts() {
  return (state?.connections || []).flatMap((c) => c.accounts.map((a) => ({ ...a, needsReauth: c.needsReauth })));
}

function emptyState(title, detail, buttonLabel, onClick) {
  const box = el('div', { className: 'empty' }, el('strong', { textContent: title }), detail);
  if (buttonLabel) {
    box.append(el('button', { className: 'primary', textContent: buttonLabel, onclick: onClick }));
  }
  return box;
}

async function act(action, message) {
  try {
    await send('action', { action, accountId: message.accountId, messages: [{ id: message.id, folderId: message.folderId }] });
  } catch (error) {
    showToast(error.message, true);
    return false;
  }
  return true;
}

function renderRow(message) {
  const quick = (name, action, title) => el('button', {
    className: 'icon',
    title,
    onclick: (event) => {
      event.stopPropagation();
      act(action, message);
    },
  }, icon(name));

  const row = el('div', { className: 'row', tabIndex: 0, onclick: () => openMessage(message) },
    avatar(message),
    el('div', { className: 'row-main' },
      el('div', { className: 'row-top' },
        el('span', { className: 'sender', textContent: senderName(message) }),
        el('span', { className: 'time', textContent: shortTime(message.receivedTime) })),
      el('div', { className: 'subject' },
        message.hasAttachment ? icon('clip') : null,
        el('span', { textContent: subjectOf(message) })),
      el('div', { className: 'summary', textContent: decodeEntities(message.summary) })),
    el('div', { className: 'row-actions' },
      quick('check', 'markRead', 'Mark as read'),
      quick('archive', 'archive', 'Archive'),
      quick('trash', 'delete', 'Move to Trash')));
  row.dataset.id = message.id;
  row.message = message;
  return row;
}

function renderList() {
  const container = $('list-view');
  const scroll = container.scrollTop;
  const total = totalUnread(state?.inbox);
  $('unread-count').textContent = `${total} unread`;
  $('unread-count').hidden = !total;

  const nodes = [];
  const all = accounts();
  if (!all.length) {
    nodes.push(emptyState(
      state?.configured ? 'Connect your Zoho account' : 'Set up Inbox Peek for Zoho Mail',
      'Unread mail will show up here once an account is connected.',
      'Open settings',
      () => browser.runtime.openOptionsPage(),
    ));
  }
  for (const account of all) {
    const data = state.inbox.byAccount[account.accountId] || { messages: [] };
    if (all.length > 1 || data.messages.length) {
      const head = el('div', { className: 'group-head' },
        el('span', { className: 'address', textContent: account.email }));
      if (data.messages.length) {
        head.append(el('button', {
          className: 'link',
          textContent: 'Mark all read',
          onclick: () => markAllRead(account, data.messages),
        }));
      }
      nodes.push(head);
    }
    if (data.error) nodes.push(el('div', { className: 'account-error', textContent: data.error }));
    nodes.push(...data.messages.slice(0, MAX_ROWS_PER_ACCOUNT).map(renderRow));
    if (data.messages.length > MAX_ROWS_PER_ACCOUNT) {
      nodes.push(el('div', { className: 'more' }, el('button', {
        className: 'link',
        textContent: 'See the rest in Zoho Mail',
        onclick: () => openMail({ accountId: account.accountId }),
      })));
    }
  }
  if (all.length && !total && !all.some((a) => state.inbox.byAccount[a.accountId]?.error)) {
    nodes.push(emptyState('All caught up', state.inbox.lastCheck ? `Last checked ${shortTime(state.inbox.lastCheck)}` : 'Checking for mail…'));
  }
  container.replaceChildren(...nodes);
  container.scrollTop = scroll;
}

async function markAllRead(account, messages) {
  try {
    await send('action', {
      action: 'markRead',
      accountId: account.accountId,
      messages: messages.map((m) => ({ id: m.id, folderId: m.folderId })),
    });
  } catch (error) {
    showToast(error.message, true);
  }
}

function openMail(payload) {
  send('openMail', payload).catch((error) => showToast(error.message, true));
  window.close();
}

function renderBody() {
  const { srcdoc, hasRemote } = buildEmailDocument(current.html, { allowRemote: current.remoteAllowed });
  $('remote-banner').hidden = !hasRemote || current.remoteAllowed;
  $('body-frame').srcdoc = srcdoc;
}

async function openMessage(message) {
  current = { message, html: null, remoteAllowed: Boolean(state.settings.loadRemoteImages) };
  $('list-view').hidden = true;
  $('read-view').hidden = false;
  $('reply-form').hidden = true;
  $('remote-banner').hidden = true;
  $('body-frame').hidden = true;
  $('read-subject').textContent = subjectOf(message);
  const address = extractEmail(decodeEntities(message.fromAddress));
  const name = senderName(message);
  $('read-from').textContent = address && address !== name ? `${name} <${address}>` : name;
  avatar(message, $('read-avatar'));
  $('read-date').textContent = message.receivedTime ? new Date(message.receivedTime).toLocaleString() : '';
  const status = $('read-status');
  status.textContent = 'Loading…';
  status.hidden = false;

  try {
    const html = await send('getContent', { accountId: message.accountId, folderId: message.folderId, messageId: message.id });
    if (current?.message !== message) return;
    current.html = html;
    status.hidden = true;
    $('body-frame').hidden = false;
    renderBody();
    if (state.settings.markReadOnOpen) act('markRead', message);
  } catch (error) {
    if (current?.message === message) status.textContent = `Could not load this message. ${error.message}`;
  }
}

function closeMessage() {
  current = null;
  $('body-frame').removeAttribute('srcdoc');
  $('read-view').hidden = true;
  $('list-view').hidden = false;
  renderList();
}

async function currentAction(action) {
  if (!current) return;
  const { message } = current;
  if (await act(action, message)) {
    if (current?.message === message) closeMessage();
  }
}

async function startReply() {
  if (!current) return;
  const { message } = current;
  const toField = $('reply-to');
  toField.value = extractEmail(decodeEntities(message.fromAddress));
  $('reply-form').hidden = false;
  $('reply-body').focus();
  const replyTo = await send('getReplyTo', { accountId: message.accountId, folderId: message.folderId, messageId: message.id }).catch(() => '');
  if (replyTo && current?.message === message) toField.value = replyTo;
}

async function submitReply(event) {
  event.preventDefault();
  if (!current) return;
  const { message } = current;
  const sendButton = $('reply-send');
  sendButton.disabled = true;
  try {
    await send('sendReply', {
      accountId: message.accountId,
      messageId: message.id,
      to: $('reply-to').value.trim(),
      subject: replySubject(subjectOf(message)),
      content: $('reply-body').value,
    });
    $('reply-body').value = '';
    $('reply-form').hidden = true;
    showToast('Reply sent');
    await act('markRead', message);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    sendButton.disabled = false;
  }
}

// Emails built for a wider screen are scaled down to the frame's width rather than
// scrolling sideways. Runs again once images load, as they can widen the layout.
function fitToWidth(doc) {
  const root = doc?.documentElement;
  if (!root || !doc.body) return;
  doc.body.style.zoom = '';
  const available = root.clientWidth;
  const needed = root.scrollWidth;
  // The body has a 12px margin, which scrollWidth leaves out on the right.
  if (needed > available + 1) doc.body.style.zoom = String(Math.max(0.4, available / (needed + 12)));
}

// The frame runs no scripts, so links are handled from here and always open in a new tab.
$('body-frame').addEventListener('load', () => {
  const doc = $('body-frame').contentDocument;
  fitToWidth(doc);
  doc?.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', () => fitToWidth(doc), { once: true });
  });
  doc?.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    if (isSafeExternalLink(link.href)) browser.tabs.create({ url: link.href });
  });
  doc?.addEventListener('keydown', onKeydown);
});

function focusRow(step) {
  const rows = [...document.querySelectorAll('.row')];
  if (!rows.length) return;
  const index = rows.indexOf(document.activeElement);
  rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + step))].focus();
}

function onKeydown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.matches?.('input, textarea')) return;
  if (current) {
    const keys = {
      u: closeMessage, Backspace: closeMessage,
      e: () => currentAction('archive'),
      d: () => currentAction('delete'),
      m: () => currentAction('markRead'),
      '!': () => currentAction('spam'),
      r: startReply,
    };
    if (keys[event.key]) {
      event.preventDefault();
      keys[event.key]();
    }
    return;
  }
  const row = document.activeElement?.closest?.('.row');
  const keys = {
    j: () => focusRow(1), ArrowDown: () => focusRow(1),
    k: () => focusRow(-1), ArrowUp: () => focusRow(-1),
    Enter: () => row && openMessage(row.message),
    e: () => row && act('archive', row.message),
    d: () => row && act('delete', row.message),
    m: () => row && act('markRead', row.message),
  };
  if (keys[event.key]) {
    event.preventDefault();
    keys[event.key]();
  }
}

async function refresh() {
  const button = $('refresh');
  button.classList.add('spin');
  try {
    await send('check');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.classList.remove('spin');
  }
}

function renderThemeToggle() {
  const dark = effectiveTheme(state?.settings.theme) === 'dark';
  const button = $('theme-toggle');
  button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  button.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
}

async function toggleTheme() {
  const theme = effectiveTheme(state.settings.theme) === 'dark' ? 'light' : 'dark';
  state.settings.theme = theme;
  applyAppearance(state.settings);
  renderThemeToggle();
  const { settings } = await browser.storage.local.get('settings');
  await browser.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, theme } });
}

async function loadState() {
  state = await send('getState');
  applyAppearance(state.settings);
  renderThemeToggle();
  if (!current) renderList();
}

$('refresh').addEventListener('click', refresh);
$('theme-toggle').addEventListener('click', toggleTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeToggle);
$('compose').addEventListener('click', () => openMail({ compose: true }));
$('open-inbox').addEventListener('click', () => openMail({}));
$('settings').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});
$('back').addEventListener('click', closeMessage);
$('reply').addEventListener('click', startReply);
$('reply-form').addEventListener('submit', submitReply);
$('reply-cancel').addEventListener('click', () => { $('reply-form').hidden = true; });
$('open-message').addEventListener('click', () => {
  if (current) openMail({ accountId: current.message.accountId, message: current.message });
});
$('load-images').addEventListener('click', () => {
  current.remoteAllowed = true;
  renderBody();
});
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => currentAction(button.dataset.action));
});
document.addEventListener('keydown', onKeydown);
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.inbox) loadState();
});

await loadState();
refresh();
