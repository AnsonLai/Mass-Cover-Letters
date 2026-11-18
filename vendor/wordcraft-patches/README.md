# Application Station WordCraft build

The secondary V2 trial uses WordCraft v0.18.1, source commit `079f478bd85df7bcc567e3bafa7d7219096f9c3c`, with `compact-startup.patch` applied.

Application Station modifications skip the startup screen, collapse the ribbon by default (while adding a tab-strip toggle button, single-click-to-open tab behavior, and context-menu item), hide rulers and the Discord link, show QU initials, and add embed-only document load, snapshot, revision state, and save acknowledgement APIs. The patch is available here for review and rebuilding. The compiled bundle is distributed under `vendor/wordcraft/`, including upstream license, attribution, and font notices.

Rebuild on Windows with `scripts/build-wordcraft.ps1`. Serve the bundle from the same origin as the application, retaining the generated relative asset paths and hashed filenames. The stock release downloaded by `scripts/fetch-wordcraft.ps1` does not provide the save bridge required by V2.
