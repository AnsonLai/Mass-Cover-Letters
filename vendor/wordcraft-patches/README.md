# Application Station WordCraft build

The secondary V2 trial uses WordCraft v0.6.1, source commit `7dfa6b0ee2aeeafec004c51fdd2ab9a697da3cc4`, with `compact-startup.patch` applied.

Application Station modifications skip the startup screen, collapse the ribbon, hide rulers and the Discord link, show QU initials, and add embed-only document load, snapshot, revision state, and save acknowledgement APIs. The patch is available here for review and rebuilding. The compiled bundle is distributed under `vendor/wordcraft/`, including upstream license, attribution, and font notices.

Rebuild on Windows with `scripts/build-wordcraft.ps1`. Serve the bundle from the same origin as the application, retaining the generated relative asset paths and hashed filenames. The stock release downloaded by `scripts/fetch-wordcraft.ps1` does not provide the save bridge required by V2.
