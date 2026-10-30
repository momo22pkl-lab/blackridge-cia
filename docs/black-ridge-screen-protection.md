# BLACK RIDGE SCREEN PROTECTION

## What the website now does

- The main CIA interface (including its embedded IBP and warning views), standalone IBP pages, OSD, and OSD share viewer load a shared protection layer.
- When the browser reports that a page is hidden, frozen, or leaving, an opaque black layer covers the page. On return, the application rechecks its existing CIA socket session, IBP session token, OSD cookie session, or OSD share authorization before revealing the page.
- If session validation fails because the connection is unavailable, the screen stays covered and offers a retry. An expired or rejected session is returned to the applicable sign-in screen while the old page remains covered.
- If this page itself starts screen sharing with `getDisplayMedia()`, its live video-capture track is detected and the page stays covered until sharing ends and the session is checked again.

These controls reduce exposure during browser-reported app/tab changes. They cannot guarantee that every operating-system app-switcher snapshot is taken after the page has been covered; browser and OS event timing varies.

## What is and is not prevented

| Capability | Web behavior |
|---|---|
| App/tab backgrounding | Detected through `visibilitychange`, `pagehide`/`pageshow`, and supported page lifecycle events; the page is masked and its session is checked on return. Best effort, not a guarantee against an early OS snapshot. |
| Screen sharing started by this page | A live `getDisplayMedia()` video track is detected and the page is masked while it is active. |
| Screen recording started by the OS or another app | A normal website has no general API to detect it. |
| Screenshots on Android Chrome or iPhone Safari | A normal website cannot reliably detect or prevent them. JavaScript and CSS do not provide screenshot blocking. |
| Camera photograph, external capture device, browser developer tools, or copied data | Not prevented by this screen layer. Server-side authorization and data minimization remain necessary. |

No right-click, browser-menu, keyboard-shortcut, or text-selection suppression is used as a screenshot defense.

## Mobile and future native apps

- **Android Chrome:** Web pages cannot set Android's `FLAG_SECURE`; it is available to a future native Android activity and can block screenshots and non-secure display capture for that activity. Device/OEM behavior still needs testing.
- **iPhone Safari:** Web pages cannot request general screenshot blocking. A native iOS app also has no universal screenshot-prevention switch. It can cover content during app-switcher snapshots, receive a screenshot notification after a screenshot is taken, and react to supported screen-capture state changes; these are mitigation/detection, not universal prevention. FairPlay protects supported video playback, not arbitrary app screens.
- **No Android app was created as part of this change.**

## Verification record

Automated Node tests cover hidden/visible transitions, pagehide/pageshow, validation success and failure, retry, and page-initiated display capture. The repository's Node test suite is run for this change. No physical Android Chrome or iPhone Safari device, and no broad real-browser matrix, is available in this task environment; those device checks are not claimed as performed.
