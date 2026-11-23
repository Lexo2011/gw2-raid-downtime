# GW2 Raid Downtime

Shows how much of a raid was spent fighting and how much was idle.

**Live:** https://lexo2011.github.io/gw2-raid-downtime/

## Use

Open `index.html` in a browser. You can double-click it, or serve the folder with `npx serve .`. Then enter:

- **Account name**, such as `Name.1234`
- **Start / End** in local time. Either can be left empty: Start defaults to the first pull and End to the last fight.
- *Optional:* a **dps.report userToken**, to add logs that were uploaded to dps.report but not to Wingman.

## How it works

1. The app fetches `https://gw2wingman.nevermindcreations.de/api/playerStats?account=…`, which returns the account's latest 250 logs with `timeEnd` and `durationMS`. Fight start is `timeEnd - durationMS`.
2. **Duplicates:** the same fight is often uploaded by several squad members. Logs of the same boss whose end times are within 15 s are treated as one fight.
3. Fight intervals are merged, so overlaps are never counted twice, and clipped to the window.
   **Idle = window − fighting.**
4. Idle time is split into four parts: before the first pull, between a wipe and the next attempt, between bosses, and after the last fight.

## Limitations

- Only logs that reached Wingman (or dps.report, with a token) are counted. A fight nobody uploaded shows up as idle time.
- Wingman returns the **latest 250 logs**. The app warns you when the window starts before the oldest log it got.
- Linked alt accounts are merged into the main account by Wingman.

## Files

- `downtime.js` – pure calculation (also loadable from Node)
- `app.js` – fetching and rendering
- `test.js` – `node test.js`
