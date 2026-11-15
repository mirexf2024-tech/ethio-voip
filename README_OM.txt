ETHIO CALL — ANDROID / HUAWEI APPGALLERY PREPARATION

WAA'EE QOPHAA'E
- UI appii aslii app.html irraa www/index.html keessatti qabameera.
- API fi Socket.IO traffic gara https://ethio-voip.onrender.com ergameera.
- Socket.IO client local bundle ta'a; npm run copy:socket kana qopheessa.
- Capacitor appId: com.mirexf2024.ethiocall
- Android permissions fragment: android-config/AndroidManifest-permissions.xml
- Backend source ZIP irraa koppii addaa backend-source/ keessatti jira; production server hin jijjiiru.

WAA'EE HIN XUMURAMNE
- Kun source project qofa; APK/AAB release miti.
- Android native project Gradle hin uumamne. `npx cap add android` computer Android SDK qabu irratti raawwatamuu qaba.
- Native incoming-call push (Huawei Push Kit / FCM) hin ijaar amne. Native app keessatti browser Web Push off dha; kanaaf app cufamee/background jiru irratti incoming call notification hin hojjetu. Kun AppGallery release blocker dha.
- WebRTC camera/microphone runtime permission fi audio routing bilbila Huawei/Android irratti qorachuu qaba.
- TURN server production credentials hin mirkanoofne; STUN qofa fayyadamuun network tokko tokko irratti call kufuu danda'a.
- Privacy Policy dhugaa, account deletion, data safety form, app screenshots fi release signing key barbaachisu. Unka privacy policy docs/ keessatti qophaa'eera; odeeffannoo dhugaa guutuu malee hin maxxansin.

BUILD (COMPUTER BARBAACHISA)
1. Node.js LTS, JDK 17/21 fi Android Studio (Android SDK) install godhi.
2. Folder kana keessatti terminal bani.
3. npm install
4. npm run copy:socket
5. npx cap add android        (yeroo jalqaba qofa)
6. Merge permissions android-config/AndroidManifest-permissions.xml gara AndroidManifest generated keessaatti.
7. npm run cap:sync
8. npx cap open android
9. Android Studio keessatti build/test godhi; booda Build > Generate Signed Bundle / APK.

TEST DIRQAMA
- Register/login OTP + API
- Socket reconnect
- Audio call fi video call bilbila lama gidduutti
- Camera/mic permission deny/allow
- Wi-Fi/mobile data/NAT network
- Background incoming call (hanga native push itti dabalamutti NOT SUPPORTED)
- Logout, data deletion fi privacy links

NAGEENYA
- JWT_SECRET, Neon DATABASE_URL, SMS keys, TURN credentials ykn release keystore/password ZIP/GitHub keessatti hin kaa'in.
- AppGallery irratti upload gochuun dura privacy policy fi data safety odeeffannoo sirrii dhiyeessi.

BUILD GITHUB ACTIONS (COMPUTER HIN BARBAACHISU)
- Faayiloota folder ethio_appgallery_mobile keessaa hundaa GitHub repository irratti root irratti upload godhi (folder keessaa .github folder dabalatee).
- GitHub > Actions bani.
- 'Ethio Call Android build' filadhu > Run workflow.
- Build erga xumuramee booda workflow run keessaa Artifacts > ethio-call-android-build buufadhu.
- APK inni achi jiru DEBUG/test APK dha; AAB release immoo unsigned dha. Store irratti maxxansuuf release signing/keystore fi native push integration dabalataan barbaachisa.


RELEASE GATES
- APPGALLERY_RELEASE_GATE.md dubbisi.
- docs/PRIVACY_POLICY_TEMPLATE_OM.md unka qofa; odeeffannoo dhugaa guuti.
