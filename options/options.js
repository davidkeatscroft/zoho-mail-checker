import { DEFAULT_SETTINGS, REGIONS } from '../lib/config.js';
import { authorize } from '../lib/auth.js';

const $ = (id) => document.getElementById(id);
const send = (type, payload) => browser.runtime.sendMessage({ type, ...payload });

// Folders that never hold mail worth a notification.
const UNWATCHABLE_FOLDER_TYPES = ['Sent', 'Drafts', 'Templates', 'Snoozed', 'Outbox', 'Spam', 'Trash'];

const PREF_CHECKBOXES = {
  notify: 'notify',
  'notify-preview': 'notifyPreview',
  sound: 'sound',
  'mark-read-on-open': 'markReadOnOpen',
  'load-remote-images': 'loadRemoteImages',
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter(Boolean));
  return node;
}

async function loadSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(changes) {
  const settings = await loadSettings();
  await browser.storage.local.set({ settings: { ...settings, ...changes } });
}

function setStatus(text, isError = false) {
  const status = $('connect-status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function updateConsoleLink() {
  $('console-link').href = REGIONS[$('region').value].console;
}

async function connect() {
  const clientId = $('client-id').value.trim();
  const clientSecret = $('client-secret').value.trim();
  if (!clientId || !clientSecret) {
    setStatus('Enter the Client ID and Client Secret first.', true);
    return;
  }
  // Firefox lets people withhold host permissions, and without them every Zoho call fails.
  // This must stay ahead of any other await, as it needs the click's user gesture.
  const origins = browser.runtime.getManifest().host_permissions;
  if (!(await browser.permissions.request({ origins }))) {
    setStatus('The extension needs permission to reach Zoho before it can connect.', true);
    return;
  }
  const region = $('region').value;
  await saveSettings({ clientId, clientSecret, region });
  const button = $('connect');
  button.disabled = true;
  setStatus('Waiting for you to approve access in the Zoho window…');
  try {
    const tokens = await authorize({ clientId, clientSecret, region });
    setStatus('Fetching your mail accounts…');
    await send('addConnection', { tokens });
    setStatus('Connected.');
    await renderAccounts();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderAccount(account) {
  const watched = new Set(account.watchedFolderIds || []);
  const folders = (account.folders || []).filter((f) => !UNWATCHABLE_FOLDER_TYPES.includes(f.type));
  const boxes = folders.map((folder) => {
    const box = el('input', { type: 'checkbox', checked: watched.has(folder.id) });
    box.addEventListener('change', async () => {
      if (box.checked) watched.add(folder.id);
      else watched.delete(folder.id);
      await send('setWatchedFolders', { accountId: account.accountId, folderIds: [...watched] });
    });
    return el('label', { className: 'check' }, box, ` ${(folder.path || folder.name).replace(/^\/+/, '')}`);
  });
  return el('div', { className: 'account' },
    el('div', { className: 'account-name', textContent: account.email }),
    el('div', { className: 'folders-label', textContent: 'Check these folders:' }),
    el('div', { className: 'folders' }, ...boxes));
}

async function renderAccounts() {
  const { connections } = await send('getState');
  const container = $('accounts');
  if (!connections.length) {
    container.replaceChildren(el('p', { className: 'empty', textContent: 'No accounts connected yet.' }));
    return;
  }
  container.replaceChildren(...connections.map((connection) => {
    const disconnect = el('button', { type: 'button', textContent: 'Disconnect' });
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true;
      await send('removeConnection', { connectionId: connection.id });
      await renderAccounts();
    });
    return el('div', { className: 'connection' },
      el('div', { className: 'connection-head' },
        el('span', { className: 'region', textContent: REGIONS[connection.region].label }),
        disconnect),
      connection.needsReauth
        ? el('p', { className: 'warning', textContent: 'Sign-in expired. Use "Connect a Zoho account" above to reconnect.' })
        : null,
      ...connection.accounts.map(renderAccount));
  }));
}

async function init() {
  const select = $('region');
  select.append(...Object.entries(REGIONS).map(([id, region]) => el('option', { value: id, textContent: region.label })));

  const settings = await loadSettings();
  select.value = settings.region;
  $('client-id').value = settings.clientId;
  $('client-secret').value = settings.clientSecret;
  $('poll-minutes').value = String(settings.pollMinutes);
  for (const [id, key] of Object.entries(PREF_CHECKBOXES)) {
    $(id).checked = settings[key];
    $(id).addEventListener('change', () => saveSettings({ [key]: $(id).checked }));
  }
  updateConsoleLink();

  const redirectUri = browser.identity.getRedirectURL();
  $('redirect-uri').textContent = redirectUri;
  $('copy-redirect').addEventListener('click', async () => {
    await navigator.clipboard.writeText(redirectUri);
    $('copy-redirect').textContent = 'Copied';
    setTimeout(() => { $('copy-redirect').textContent = 'Copy'; }, 1500);
  });

  select.addEventListener('change', async () => {
    updateConsoleLink();
    await saveSettings({ region: select.value });
  });
  $('poll-minutes').addEventListener('change', async () => {
    await saveSettings({ pollMinutes: Number($('poll-minutes').value) });
    await send('settingsChanged');
  });
  $('connect').addEventListener('click', connect);

  await renderAccounts();
}

init();
