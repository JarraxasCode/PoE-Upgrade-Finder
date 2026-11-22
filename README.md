# PoE Upgrade Finder

Finds gear upgrades for your Path of Exile build. Pick a build saved in Path of Building and a slot, and the app searches the official trade site for rare items in your price range. It then scores every listing in Path of Building, so you see real DPS and EHP changes, not guesses.

## Download

Get the zip from [Releases](../../releases), unzip it, and run `poe-upgrade-finder-<version>.exe`. Nothing is installed.

- Windows may say "Windows protected your PC" (the exe isn't signed): click **More info**, then **Run anyway**.
- Sign in to pathofexile.com when the app asks (tick *Remember me*).
- To remove it: Settings → **Remove from this PC**, then delete the exe.

Windows 10 or 11, 64-bit. Path of Exile 1 only.

## Building from source

Windows and Node 26.

```
npm install
npm run check      # types and tests
npm run app        # run it (needs a PoB copy: see tools/pob-update)
npm run package    # build the exe into out/package
```

## Credits

Builds are loaded and items scored by [Path of Building Community](https://github.com/PathOfBuildingCommunity/PathOfBuilding) (MIT), bundled unchanged. Not affiliated with or endorsed by Grinding Gear Games.
