# Ethio Call — Huawei AppGallery release gates

## Current package
- Capacitor Android wrapper around the existing Ethio Call web client.
- App ID: `com.mirexf2024.ethiocall`
- Backend remains `https://ethio-voip.onrender.com`.
- Existing Render/Neon backend source is archived under `backend-source/`; it is not deployed or modified by this Android project.

## Do not submit yet
1. **Native incoming-call push is not implemented.** The web client disables Web Push inside the native Capacitor app (`IS_NATIVE_APP`). The current backend's offline-call path depends on browser Web Push subscriptions. Therefore, a recipient whose app is closed/backgrounded may not receive an incoming call in this Android build. Huawei Push Kit integration is a release blocker for the promised closed-app incoming-call behavior.
2. **Media runtime behavior is unverified.** Test microphone/camera permission prompts, speaker/earpiece routing, Bluetooth, and WebRTC on real Huawei and non-Huawei Android phones.
3. **TURN service is not verified.** The existing WebRTC configuration must be tested across mobile networks and NATs; STUN-only connectivity is not reliable on every network.
4. **Privacy and account deletion must be reviewed.** Publish a truthful privacy policy, verify the in-app account deletion flow, and complete AppGallery privacy/data-safety declarations.
5. **Release signing is not configured.** The CI workflow currently produces a debug APK and an unsigned release AAB. Neither is a store-ready signed release.

## Build from GitHub Actions
1. Upload the *contents* of this folder to the root of `mirexf2024-tech/ethio-voip` (not the parent folder). Keep the `.github` folder and its workflow.
2. Commit to the default branch.
3. Open GitHub repository → Actions → **Ethio Call Android build** → **Run workflow**.
4. Wait for the run to complete. Download artifact `ethio-call-android-build` from the run's Artifacts section.
5. Install the debug APK on a test phone and run the test matrix below.

## Required test matrix
- OTP registration and login with a real test number.
- Chat, groups, account settings, logout, and account deletion.
- Audio call and video call between two accounts on two physical phones.
- Grant and deny camera/microphone permissions.
- Switch Wi-Fi ↔ mobile data during a call.
- Test speaker, earpiece, headset and Bluetooth where available.
- Test foreground, background, force-stopped and screen-locked incoming calls. Background/closed-app incoming calls are expected to fail until native push is integrated.
- Verify no test credentials, signing keys, database URLs, SMS keys, or TURN secrets are embedded in the app or committed to GitHub.

## Huawei Push Kit information needed for the next implementation stage
- Huawei AppGallery Connect app created with package name exactly `com.mirexf2024.ethiocall`.
- The official `agconnect-services.json` downloaded for that app (do not publish it in a public repository if it contains project identifiers/secrets; share only through an appropriate private method).
- Huawei Push Kit enabled for the app.
- The intended signing certificate SHA-256 fingerprint registered in AppGallery Connect.

Do not create fake Huawei credentials or claim Push Kit works until an actual device token is registered and a test push is received.
