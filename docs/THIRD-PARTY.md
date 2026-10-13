# Third-party software and UI references

This project ships original application code and an npm dependency lockfile. Installed dependencies carry their own licenses. In particular, the bundled TikTok adapter depends on `tiktok-live-connector` 2.5.x, which describes its license as modified AGPL, and `tiktok-live-proto`, which declares AGPL-3.0-only. Read their supplied LICENSE files when distributing or operating the connector. Choosing a different ingestion provider through the existing API contract avoids coupling the rest of the project to that library.

The four UI repositories listed in UI-SOURCES.md declare MIT licenses for their free source. No source from those repositories has been copied into the shipped dashboard. Retain their respective notices if you later import their components.

The app does not include any provider credentials, generated local passwords, production bank details or customer datasets.
