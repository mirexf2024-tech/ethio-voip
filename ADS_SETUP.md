# Ethio Call v1.2 — Ads, Group chat, Video call

## Faayilota
Haaraa: `ads.js`, `groups.js`
Jijjiirame: `index.js`, `payments.js` (tokko qofa: `adminOk` baasa), `app.html`, `admin.html`
Hin jijjiirramne: `calls.js`, `chat.js`, `db.js`, `push.js`, `growth.js`, `telegram.js`, `translate.js`, `package.json`
(`calls.js` video ni deeggara ture; app.html qofti hin qabu ture.) Faayila hunda GitHub keessatti bakka isaanii bu'ii, Render deploy godhi. Tables haaraan ofumaa uumamu.

## 1. Adsterra banner
1. Adsterra irratti website/app keessan galmeessaa, "Banner" (ykn "Native Banner") zone uumaa, koodii isaa kopii godhaa.
2. `https://<site-kee>/admin` → key galchaa → kaardii **Ads** → koodii maxxansaa → bukkee (height) galchaa → Save.
3. Banner sun app keessatti gad-aanaa (nav jala) mul'ata, garuu qofa: Chats, Groups, Calls, Wallet. Settings, chat, call keessatti hin mul'atu.
4. Banner frame cuqaaleffame (sandbox) keessa deema: koodiin ad token login keessan dubbisuu hin danda'u.

**Seera Adsterra:** Adsterra namoota ad ilaaluuf/tuquuf mindaa'an (incentivized traffic) dhorka. Kanaaf banner Adsterra koyinii wajjin hin wal qabsiifamne. "Banner tuqi" jedhee nama hin gaafatinaa.

## 2. Watch and earn (Start.io)
Start.io rewarded video **app Android/iOS** keessatti qofa hojjeta (SDK app ti, website script miti). Kanaaf button "Viidiyoo ilaali, koyinii argadhu" app browser/PWA keessatti hin mul'atu; app Android (WebView) keessatti qofa mul'ata.

Server (`ads.js`) ofumaa eega: viidiyoo tokko tokko, yeroo ilaaluu xiqqaa, gidduu yeroo, daangaa guyyaa. Render Environment irratti jijjiiramu:

| Variable | Default | Hiikaa |
|---|---|---|
| `REWARD_COINS` | 1 | koyinii viidiyoo tokkoof (0 = cufaa) |
| `REWARD_DAILY_MAX` | 10 | viidiyoo guyyaa tokkoof nama tokkoof |
| `REWARD_MIN_SECONDS` | 15 | yeroo ilaaluu xiqqaa |
| `REWARD_GAP_SECONDS` | 30 | viidiyoo lamaan gidduu |

**Android app keessatti bridge:** app.html `window.EthioNative.showRewarded()` waama; viidiyoon guutummaatti erga ilaalamee (ykn hafe) booda app Android `window.onEthioRewarded(true|false)` waamuu qaba. Fakkeenya (Start.io docs waliin mirkaneeffadhaa, SDK version irratti garaagarummaa jiraachuu danda'a):

```kotlin
class EthioBridge(private val act: Activity, private val web: WebView) {
  private fun done(ok: Boolean) = act.runOnUiThread {
    web.evaluateJavascript("window.onEthioRewarded && window.onEthioRewarded($ok)", null)
  }
  @JavascriptInterface fun showRewarded() = act.runOnUiThread {
    val ad = StartAppAd(act)
    ad.setVideoListener { done(true) }                       // video xumurame
    ad.loadAd(StartAppAd.AdMode.REWARDED_VIDEO, object : AdEventListener {
      override fun onReceiveAd(a: Ad) { ad.showAd() }
      override fun onFailedToReceiveAd(a: Ad?) { done(false) }
    })
  }
}
webView.addJavascriptInterface(EthioBridge(this, webView), "EthioNative")
```

**Daangaa amanamummaa:** Start.io server-to-server verification (server irraa mirkaneessuu) jiraachuu isaa hin mirkaneessine. Kanaaf viidiyoon xumurame app irraa dhufa; server daangaa (guyyaa, yeroo, gidduu) qofa eega. Nama app sirreessuu danda'u guyyaatti `REWARD_DAILY_MAX × REWARD_COINS` olitti hin argatu.

Website/PWA irratti rewarded video barbaaddan: AppLixir (web rewarded video) jira, garuu API isaa asitti hin mirkaneeffanne, kanaaf hin dabalamne.

## 3. Group chat (Telegram-style)
Tab 👥 **Groups**. Ergaa, suuraa, sagalee, faayila ni erga.

**Gosa garee**
- **Ifaa (public):** maqaa fayyadamaa (`@oromofans`, 5-32 qubee/lakkoofsa/_) qaba. Namni kamiyyuu barbaadee (search) seenuu danda'a.
- **Dhuunfaa (private):** linkii affeerraa (`https://<site>/?join=...`) qofaan seenama. Search keessatti hin mul'atu. Namni link banu app hin seenin yoo ta'e, login booda ofumaa garee seensisa.

**Gahee (roles)**: namni gahee wal-qixa ykn olaanaa irratti hojjechuu hin danda'u.
| Gahee | Waan hojjechuu danda'u |
|---|---|
| Owner (abbaa garee) | Hunda: admin filachuu, gosa garee/maqaa fayyadamaa jijjiiruu, abbaa garee nama biraaf kennuu, garee haquu |
| Admin | Maqaa/ibsa jijjiiruu, nama dabaluu, linkii haaraa, ban/unban, moderator filachuu, + kan moderator |
| Moderator | Ergaa miseensaa haquu, mute/unmute, garee keessaa baasuu (kick) |
| Member | Dubbisuu fi barreessuu (yoo mute hin taane) |

- **Mute:** sa'a 1, guyyaa 1, yeroo hundaaf. Nama mute ta'e ergaa erguu hin danda'u.
- **Kick:** garee keessaa baasa; garee ifaa ykn linkiin deebi'ee seenuu danda'a.
- **Ban:** baasee deebi'ee akka hin seenne cufa (linkii wajjin illee). Admin "Unban" godhuu danda'a.
- Owner yoo ba'e, admin duraa (hin jiraannaan moderator, achiis miseensa duraa) owner ta'a. Namni dhumaa yoo ba'e garee ofumaa haqama.
- Garee duraan uumame (version 1.2 duraa) owner isaa ofumaa "Owner" ta'a, link isaas ofumaa uumama.

Daangaa (Environment): `GROUP_MAX_MEMBERS` (50), `GROUP_MAX_OWNED` (10).
Chat 1-1 keessatti ergaa Afaan hiikuu garee keessattis ni hojjeta.

**Qorannoo:** gahee, mute/kick/ban, link, search, haquu: handler dhugaa Postgres dhugaa irratti 71 qorame, hundi darbe. UI Chromium keessatti API fake waliin qorame.
**Hin jirre (amma):** suuraa garee olkaa'uu (UI), reply/edit/forward/reactions/pin/search ergaa, "typing", poll, slow mode, join request. Kana booda dabalama.

## 4. Video call (chat 1-1)
Chat header keessatti 🎥, tab Calls keessattis "Viidiyoo" button. Callee ni gaafata; kaameraa dhaamsuu/banuu, kaameraa jijjiiruu (duubaa/duuba), mute ni danda'ama.
Gatii: `VIDEO_COINS_PER_MINUTE` (default 3 koyinii/daqiiqaa, Caller irraa). "Data saver" yoo banaa ta'e viidiyoon xiqqaa dha (320×240, 15fps).
**Gorsa:** viidiyoo network hunda irratti hojjechuuf TURN server (Metered `TURN_USERNAME`/`TURN_CREDENTIAL`) qabaachuun barbaachisaa dha.
