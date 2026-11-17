# Ethio Call — Welcome, Chats & Settings Redesign

## Visual direction
Use the supplied reference as inspiration, not as a pixel-for-pixel copy:
- Ethio Call identity: deep blue, bright yellow, white, with subtle Ethiopian visual cues.
- First-run welcome screen with logo/phone-video mark, short "Stay Connected" message, a locally appropriate hero image/illustration, primary "Seensa / Get started" action, and secondary Login action.
- Keep the phone-first layout, safe-area support, readable text, and low-data performance. Do not require a large remote image to open the app.

## Main navigation
- Chats
- Contacts
- Calls
- Groups
- Settings

Keep wallet/coins accessible from the profile or a clearly labeled wallet entry; do not make monetization more prominent than messaging and calling.

## Private chat experience
Improve the existing one-to-one chat UI with:
- clear profile header and voice/video call actions;
- reply, forward, copy, delete-for-me, and delete-for-everyone only where the backend supports them;
- delivery/read indicators, message timestamps, media previews, voice notes, and safe file handling;
- in-chat search, pinned messages, per-chat mute, and report/block controls;
- composer attachment menu and accessible send/record controls.

## Group chat experience
Build on the existing group system:
- clear group photo/name/member count and group info page;
- Telegram-inspired reply/forward/pin/reactions/polls only after backend support is verified;
- member list, roles, invite link controls, moderation, mute and report;
- private/public group labels and join approval where configured.

## Profile and settings
- Profile page: photo, display name, username if supported, about, phone number, edit profile.
- Settings sections: account/security, privacy, notifications, data/storage, appearance, language, help/feedback, legal information, blocked users, app version, logout, account deletion.
- Ask for permissions only when the user activates the feature that needs them.

## Implementation boundaries
- Native APK and shared client UI may be updated.
- Do not change the deployed web app or Render backend without an explicitly reviewed backend requirement.
- Preserve current authentication, existing conversations, groups, call functionality, payment records, and signing-key continuity.
- Never display fabricated demo chats or fake contacts in production.
- Do not claim end-to-end encryption unless implemented and independently reviewed.
- Any feature needing backend changes must be designed and tested separately before enabling its UI.

## Delivery phases
1. Audit current client and backend contracts; add a safe welcome screen and blue/yellow design tokens.
2. Redesign main chat list/navigation and profile/settings without changing API behavior.
3. Improve private-chat and group-chat interactions, enabling only features supported by tested APIs.
4. Accessibility, localization (Afaan Oromo, Amharic, English), low-data and small-screen QA.
5. Native APK regression tests, including login, chat, group, calls, speaker routing, notifications, and update/signing continuity.
