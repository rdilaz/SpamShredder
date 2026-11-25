# Spam Shredder

A Chrome extension that finds the senders filling your Gmail with promotions and clears them out in a click.

[Get it on the Chrome Web Store](https://chromewebstore.google.com/detail/spam-shredder/cbfeclcjnbhalmengbpmbkbkgcpgnidk) · [Privacy policy](https://gist.github.com/rdilaz/5ebdc944f4a1cfa7f6f4547e7cb08448)

## What it does

1. Signs in with your Google account through Chrome's identity API.
2. Scans your 500, 1,000 or 1,500 most recent emails in Gmail's Promotions category.
3. Groups them by sender and ranks the senders by how many emails they sent.
4. For each sender, offers **Unsubscribe** and **Delete All**.

- **Delete All** moves that sender's emails to Gmail's Trash in batches. Nothing is permanently deleted, so it can be undone from Trash.
- **Unsubscribe** uses the sender's own `List-Unsubscribe` header: one-click unsubscribe where the sender supports it, or a pre-filled Gmail draft for senders that only accept email.

## Privacy

Spam Shredder runs entirely in your browser and talks only to the Gmail API. It has no server of its own and stores nothing outside your browser's extension storage. It asks for the full Gmail scope (`https://mail.google.com/`) because moving mail to Trash in bulk needs it.

## Run from source

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.

Signing in needs an OAuth client ID that matches the extension's ID, so a copy loaded from source may need its own client ID in `manifest.json`.

## Built with

JavaScript, Chrome Extensions Manifest V3, the Gmail API.
