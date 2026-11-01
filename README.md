# Checker Plus for Zoho Mail

A Firefox extension for Zoho Mail, inspired by Checker Plus for Gmail. By David Keats-Croft. It is an independent project, not affiliated with or endorsed by Zoho or Jason Savard.

## Features

- Unread count on the toolbar button, across every connected account
- Desktop notifications and a sound for new mail, with a summary when several arrive at once
- A popup to read mail, mark it read, archive, report spam, move to Trash and send plain-text replies
- Several Zoho logins, each with a choice of folders to watch
- Remote images blocked by default, so senders can't tell when you open their mail
- Keyboard use: `Alt+Shift+Z` opens the popup, `j`/`k` move, `Enter` opens, `m` marks read, `e` archives, `d` trashes, `r` replies (in the reading view), `!` reports spam (in the reading view), `u` goes back

## Install

### Try it now (removed when Firefox restarts)

1. Go to `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select `manifest.json` in this folder.

### Keep it permanently

Release Firefox only keeps signed add-ons. Signing is free and the add-on doesn't have to be publicly listed:

1. Run `sh build.sh` to create the zip in `dist/`.
2. Upload it at <https://addons.mozilla.org/developers/addon/submit/distribution> and choose **On your own**.
3. Install the signed `.xpi` that Mozilla returns.

## Connect your account

The settings page opens on install and walks through this:

1. Choose your region, then open the Zoho API Console from the link.
2. Add a **Server-based Applications** client.
3. Set its Authorized Redirect URI to the address shown on the settings page. The address stays the same because it comes from the add-on's fixed ID.
4. Paste the Client ID and Client Secret, then choose **Connect a Zoho account**.

If you connect a login from a different Zoho region from the one the client was created in, turn on Multi-DC for the client in the API Console.

## Privacy and security

- The extension only talks to Zoho. There is no other server and no analytics.
- The client secret and refresh token are stored unencrypted in your Firefox profile. Anyone with access to that profile could read them.
- The unread list, including subjects and previews, is held in memory only. Message IDs are saved to disk, so old mail doesn't notify you twice. Message bodies are never stored.
- Email HTML renders in a sandboxed frame with scripts disabled and a content security policy that blocks network access, apart from images you choose to load.
- Move to Trash never permanently deletes mail.

## Tests

`perl tests/firefox-test.pl <screenshot-dir>` installs the extension into a throwaway headless Firefox profile, runs `tests/run.js` with Zoho's servers mocked, and screenshots the pages. It needs Firefox in `/Applications`, so it is macOS only as written. It does not touch your normal profile or a real mailbox.

## Licence

MIT. See [LICENSE](LICENSE).
