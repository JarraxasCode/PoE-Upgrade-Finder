# PoE Upgrade Finder

Finds gear upgrades for your Path of Exile build. Pick a build saved in Path of Building and a slot, and the app searches the official trade site for rare items in your price range. It then scores every listing in Path of Building, so you see real DPS and EHP changes, not guesses.

## Download

Download the zip from [Releases](../../releases), unzip it, and double-click the exe. Nothing is installed.

- **You need a pathofexile.com account.** The trade site's weighted searches only work when signed in, so the app opens pathofexile.com's own sign-in page in its window (tick **Remember me**). The app never sees your password.
- **Windows may say "Windows protected your PC"**, because the exe isn't signed: click **More info**, then **Run anyway**.
- **Size:** the exe is about 370 MB. On first start it unpacks itself to `%LOCALAPPDATA%\poe-upgrade-finder\app\` (about 800 MB; allow about 1 GB free), which takes a few seconds; later starts are quick. Settings and logs are in `%APPDATA%\poe-upgrade-finder\`.
- **To remove it:** Settings → **Remove from this PC**, then delete the exe.

Windows 10 or 11, 64-bit. Path of Exile 1 only. Your builds must be saved in Path of Building; the app only reads them, never writes them.

## What it connects to

- **pathofexile.com**: signing in, and the trade site's search and fetch, through one rate limiter that stays well inside the site's limits. Buy links open in your own browser. It never whispers, buys or touches the game.
- **web.poecdn.com**: item images, and GGG's public Currency Exchange data for the divine rate (about one request an hour).
- **GitHub** (raw.githubusercontent.com, api.github.com): on start, a check for a newer Path of Building release; the update itself only when you start it in Settings.

Nothing else. No accounts, no server of its own, no tracking.

## Credits

Builds are loaded and items scored by [Path of Building Community](https://github.com/PathOfBuildingCommunity/PathOfBuilding) (MIT), bundled with its licence. The bundled copy is a PoB release with its code unchanged; it leaves out the passive tree images and other art, which headless scoring doesn't use, and rebuilds PoB's trade mod table with PoB's own code. Not affiliated with or endorsed by Grinding Gear Games.
