# YouTube Notification Modal

A Tampermonkey userscript that opens your YouTube notifications in a large modal grid. The bell menu shows a handful of notifications at a time; this modal shows dozens.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open [the raw script](https://raw.githubusercontent.com/matthewwyndham/youtube-notification-modal/main/youtube-notifications-modal.user.js). Tampermonkey shows an install page; click **Install**.
3. Reload YouTube.

Tampermonkey checks the same URL for new versions.

## Use

Sign in to YouTube. Then click the grid button beside the bell, or press Alt+Shift+N (Option+Shift+N on a Mac).

- Scroll down to load older notifications.
- **Load all** loads the whole list, up to 2000 notifications.
- The filter box hides the loaded notifications that do not contain its text.
- **Refresh** reloads the list from the newest notification.
- Click a card to open what the notification links to. Ctrl-click or Cmd-click opens it in a new tab.
- Press Esc or click outside the modal to close it.

Opening the modal does not mark notifications as read.

## How it works

The bell menu loads its list from YouTube's internal API. It sends a `POST` to `/youtubei/v1/browse` with the browse ID `FEnotifications_inbox`, and then one request per page with a continuation token. The script sends the same requests from the page. It signs them the way YouTube's own code does, with a hash of your `SAPISID` cookie, so they go only to youtube.com and use the session you are already signed in with.

YouTube renames the fields in these responses from time to time. So the parser does not depend on one path to the list. It looks for the repeated items that each carry a link and a message, and reads the thumbnail, avatar, time and read state from each one.

## When the modal finds nothing

If YouTube changes the response format, the modal shows "Found no notifications in YouTube's response". Click **Copy debug JSON** to copy the raw responses, and attach them to an issue. They contain your notification text, channel names and video titles, so remove anything you do not want to share. The script also logs them in the browser console as `[ytnm] raw responses`.

## License

[MIT](LICENSE)
