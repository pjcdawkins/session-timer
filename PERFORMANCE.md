# Performance setup checklist

## Network (local mode, recommended)

- Use a dedicated travel router, not the Mac's Internet Sharing.
- Put the router near the stage; run Ethernet from it to the laptop at the desk, so Wi-Fi only covers the last few metres (a full audience absorbs 2.4 GHz).
- 5 GHz, fixed channel, a dedicated SSID + password.
- Give the router an internet uplink (4G dongle/SIM or venue internet) if possible: phones then see a "real" network, which avoids Android's offline anti-theft lock and "no internet → switch to mobile data". Timer traffic still stays local.
- Reserve a fixed IP for the laptop in the router's DHCP settings so the URL never changes.

## Laptop

- `npm run show` (auto-restarts the server, keeps the Mac awake, state survives restarts).
- On mains power; disable automatic updates; Do Not Disturb on.
- Lead page: `http://localhost:8787/lead`. A login lasts 24 hours after the screen was last used (an open lead page keeps renewing it), so check each lead screen is signed in during setup. Turn on **Show lock** once set up (it locks every lead screen, not just this one).
- To perform from a lead screen (e.g. a phone), tap **Perform mode**: it hides the controls (apart from a Start button while stopped; there is no Pause). During the count-in the button becomes **Cancel** (or press Esc), which puts the timer back where Start was pressed, even under Show lock; it ignores taps for its first second so a double tap on Start can't undo it, and disappears at zero, shows the time large, and turns on Show lock. It only enters Perform mode if the lock could be turned on. The status bar shows a screens count, with how many are quiet or lost. Tap **Exit perform mode** to get the controls back; the lock stays on.
- Space = Start, Esc = Pause. Reset needs two clicks. Show lock disables Pause too: only Start works while it is on.
- Start begins a 5s count-in (or whatever start time is set): every screen washes amber, pulsing on each second with the count on the clock face, and flashes green at zero, so whoever didn't press Start notices it.

## QLab (optional)

To have QLab start a cue exactly when the timer reaches zero, run the bridge on the QLab Mac (it can follow the local server or the online one):

```
npm run qlab -- --cue 2 --passcode 1234
npm run qlab -- --cue 2 --passcode 1234 --server https://timer.ligetiquartet.com
```

- In QLab, Workspace Settings → Network → OSC Access: give a passcode **View** and **Control** access (or allow them without a passcode and leave out `--passcode`).
- Check the bridge prints `QLab ready: /cue/2 "<cue name>"` and `Connected to timer`, and that "QLab bridge (cue 2)" shows in the Screens panel. Keep its Terminal window open (and the Mac awake: `caffeinate -dims` alongside, or run it on the `npm run show` Mac).
- It fires only when the timer crosses zero while running, i.e. after a count-in. Starting from 0 or later, or pausing or cancelling before zero, doesn't fire it. It logs how precisely it fired.
- Rehearse it: start from the count-in and listen for the cue on the green flash.
- If QLab is on another Mac, add `--qlab <ip>` (port 53000 by default).

## Stage screens

- Open `http://<laptop-ip>:8787/?name=Stage%20L` (the name appears in the lead's Screens panel; it can also be changed by tapping it).
- Set Auto-Lock / screen timeout to **Never** (Wake Lock doesn't work over plain HTTP).
- Do Not Disturb on; keep on chargers.
- iPhone/iPad: Guided Access to pin the page; turn off Wi-Fi Assist.
- Android: turn off Theft protection → Offline device lock and Theft detection lock (Settings → Google → All services → Theft protection; path varies), plus any manufacturer equivalent. When warned "no internet", choose stay connected; disable "switch to mobile data".
- Prefer dedicated tablets over performers' own phones.

## Rehearse it

- Run the exact devices on the exact network, untouched, for longer than the piece (40+ minutes).
- Check every screen shows green in the lead's Screens panel; try walking one out of range and back.

## Online backup

- `https://timer.ligetiquartet.com` (viewer) and `/lead` — have it open in a second tab on each device.
- To switch mid-piece: pause, set the current time, start.
