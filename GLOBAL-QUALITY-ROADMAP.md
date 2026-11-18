# Ethio Call — Global Quality & Product Roadmap

This document records the improvements needed before positioning Ethio Call as a reliable international calling and messaging app. It is a roadmap, not a claim that these features are already implemented.

## Current code review — confirmed from the repository

- The app already includes one-to-one chat, voice/video calls, voice notes, image/file sharing, groups, public group discovery, blocking, group moderation, push notifications, Oromo/Amharic/English UI strings, data-saver settings, account deletion, and coin/referral features.
- The backend phone validator currently accepts Ethiopian +251 numbers only. International launch therefore needs a proper international phone-number strategy.
- Calls load ICE configuration from /ice; the backend defaults to Google STUN and supports TURN only when TURN credentials are configured. TURN is important for reliable calls across mobile networks, restrictive NATs, and firewalls.
- The current app code does not show end-to-end message encryption. Do not advertise chats or calls as end-to-end encrypted until a real, independently reviewed implementation exists.
- The Settings screen has no visible privacy-policy or terms-of-service destination.
- Account deletion is present in the client and calls DELETE /account; the complete deletion and retention behavior should be tested and documented.
- Message translation depends on optional external configuration and may be rate-limited.
- Coin packages and payment instructions are currently Ethiopia-oriented (ETB and configurable local payment details).

## Priority 0 — protect users and prevent launch-blocking failures

1. Reliable calling
   - Configure a production TURN provider and test calls on different carriers, Wi-Fi, mobile data, and restrictive networks.
   - Add clear call states: connecting, ringing, reconnecting, poor network, and call ended.
   - Test speaker/earpiece, Bluetooth headset, wired headset, mute, camera permissions, and audio focus on multiple Android devices.
   - Measure call setup success, dropped-call rate, latency, and audio quality without collecting call content.
2. Security and privacy
   - Commission a security review of OTP, session tokens, API authorization, file access, group permissions, admin routes, and rate limits.
   - Add a real privacy policy and terms of service that accurately describe data collected, purposes, retention, processors, and account deletion.
   - Verify that account deletion removes or anonymizes all eligible user data, media, push tokens, and related records; document legally required retention.
   - Add user-visible controls for reporting abuse and spam, with a reviewed moderation process.
   - Do not claim end-to-end encryption until implemented and independently reviewed.
3. Production readiness
   - Verify production SMS delivery, OTP expiry/attempt limits, abuse prevention, database backups, restore procedure, monitoring, and incident response.
   - Confirm that production mode never returns OTP codes to clients or exposes development diagnostics.
   - Test app updates and signing-key continuity before distributing each release.

## Priority 1 — make the experience welcoming and dependable

1. Simple first-run onboarding explaining registration, contact discovery, calling, data use, and privacy controls.
2. Contact discovery with consent: explain address-book access, request permission only when needed, and offer manual number entry.
3. Better chat controls: message delivery/read states, reply, forward, delete-for-me, delete-for-everyone with clear limits, and search.
4. Better call controls: speakerphone, Bluetooth route support, clear mute/camera state, and a network-quality indicator.
5. Accessibility: scalable text, screen-reader labels, strong contrast, large touch targets, and right-to-left layout support where needed.
6. Language quality: review every visible string and notification in Afaan Oromo, Amharic, and English; avoid untranslated mixed-language screens.
7. Help and feedback: in-app help, report-a-problem flow, support contact, and a visible app version/build number.

## Priority 2 — features that create long-term value

- Optional end-to-end encrypted private chats and calls, designed with established protocols and external security review.
- Message search, pinned chats, favorites, disappearing messages, and per-chat notification controls.
- Group invite links with expiry/revocation, stronger anti-spam controls, and moderator audit history.
- Better media sharing with safe file-type limits, upload progress, retry, and storage cleanup.
- Multi-device account management and the ability to sign out other sessions.
- International phone-number support, localized country formats, and region-appropriate payment options before international monetization.
- Optional desktop/web experience with secure session management.

## Product principles

- Keep basic messaging easy to access; make any call charges, coin costs, ads, and rewards transparent before a user acts.
- Never make users pay unexpectedly or imply that rewards are guaranteed income.
- Ask for permissions only when a feature needs them.
- Make privacy, blocking, reporting, and account deletion easy to find.
- Prefer reliability, safety, low data use, and clear communication over adding many features quickly.

## Release gate

Do not call the app globally ready until the team has tested the release on multiple Android versions and device brands, multiple networks, low-bandwidth conditions, and with users who speak each supported language. Resolve all critical security and calling failures first.
## Implementation progress — 18 November 2026

The following client-side improvements have now been committed to the native Android source (`www/index.html`):
- Live call quality estimate based on WebRTC round-trip time and inbound audio packet loss, with Afaan Oromoo, Amharic and English labels.
- Visible reconnecting / connected / failed network states during calls.
- Call-quality polling is stopped when a call ends to avoid background work.
- Privacy Policy and Terms pages are bundled under `www/docs/` so the native app can open them without relying on a remote page.

These changes do not configure TURN, prove call quality on real devices, or replace multi-network testing. TURN configuration, incoming-call native notification testing, security review, and real-device call regression remain release blockers.


## Additional native-client work — 18 November 2026

- Improved Settings language coverage for Afaan Oromoo, Amharic, and English: appearance/storage labels and account-safety guidance now follow the selected language.
- Added keyboard-operable semantics and accessible labels to the bottom navigation, live-region announcements for app status messages, visible keyboard focus, and reduced-motion support.
- Kept the Android client scope isolated to `www/index.html`; the Render backend and live web client were not changed.
- Android release workflow is now manual-dispatch only. A GitHub push will no longer automatically create another APK. Do not create a new release until the two-phone regression checks are completed.

## Remaining work that cannot honestly be marked complete yet

- International phone registration: current server validation accepts Ethiopian +251 numbers only. This needs a deliberate backend/API and OTP-provider change; the backend is intentionally unchanged in this client-only pass.
- TURN: server supports TURN through environment variables, but production TURN credentials must be configured privately in the hosting environment and calls tested on separate networks.
- Abuse reporting: blocking is present, but a report-review endpoint and moderation workflow are not confirmed in the current backend. Do not show a nonfunctional report button.
- Rewarded ads: an ad network account, native SDK/placement configuration, consent flow, and test-device validation are prerequisites. Do not promise rewards or ship a fake rewarded-ad action.
- Ethiopian Sign Language and speech-to-text: require reviewed local-language/sign-language content and tested speech services. Oromo recognition support must be verified before advertising it.
- Release gate remains two-phone testing of login/OTP, chat, media, incoming-call notifications, speaker/earpiece/Bluetooth, calls on Wi-Fi and mobile data, and update/signature continuity.

## Backend services update — 18 November 2026

- Added database storage and authenticated submission for abuse reports, with allowed reason categories, duplicate-report protection, a five-report daily limit, and optional message-context validation.
- Added a private admin moderation queue with pending/reviewed/actioned/dismissed states and moderator notes. Account suspension remains a separate deliberate admin action.
- Added E.164 international phone-number parsing and validation while retaining Ethiopian local-number convenience. Actual OTP delivery to each destination country still depends on the configured SMS gateway, carrier permissions, and delivery testing; international delivery is not yet certified.
- Added optional browser speech-to-text using the device Web Speech API. Availability and Afaan Oromoo recognition vary by browser/device; the app reports unsupported or failed recognition rather than claiming universal support.
- Rewarded-ad coin issuance now defaults to disabled until a real, approved native ad provider/placement is configured and validated. Normal banner ads remain separate and are never rewarded.
- Added safe service-readiness indicators to the admin dashboard for international number format, reporting, TURN configuration, and rewarded ads.

### External configuration and release blockers

- TURN is code-ready but still requires valid private TURN credentials in Render environment variables (TURN_USERNAME, TURN_CREDENTIAL, and optionally TURN_HOST) or a verified ICE_SERVERS JSON value. No credentials were added to source control.
- International OTP delivery requires the SMS gateway to support the destination country and the SIM/provider to permit sending there. Test delivery, rates, and regulatory requirements before opening international registration.
- Rewarded ads remain off by default. A platform owner/adult account, approved ad-network account, native SDK/placement, consent configuration, and real test-device callbacks are required before enabling rewards.
- Afaan Oromoo speech recognition is not guaranteed by Web Speech API. A dedicated provider or verified device-language support is needed before presenting it as a supported production feature.
- The two-phone regression gate remains mandatory. These commits do not authorize an APK build or certify production call quality.
