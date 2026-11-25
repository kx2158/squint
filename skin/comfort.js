// Comfort mode: history, bookmarks, saved logins and open tabs stay on this computer.
// This leaves Tor Browser's permanent private browsing. What websites can store about you
// (cookies, site storage, cache) is still wiped every time the browser closes.
user_pref("browser.privatebrowsing.autostart", false);
user_pref("places.history.enabled", true);
user_pref("browser.startup.page", 3);                 // reopen the tabs you had open
user_pref("browser.sessionstore.privacy_level", 0);
user_pref("browser.sessionstore.resume_from_crash", true);

// password manager: logins are encrypted by the primary password you set (see README)
user_pref("signon.rememberSignons", true);
user_pref("signon.autofillForms", false);             // fill only when you click, so pages cannot probe it
user_pref("signon.autofillForms.http", false);
user_pref("signon.management.page.breach-alerts.enabled", false);
user_pref("signon.firefoxRelay.feature", "disabled");
user_pref("browser.formfill.enable", false);

// wipe on exit: everything a site could use to recognise you later
user_pref("privacy.sanitize.sanitizeOnShutdown", true);
user_pref("privacy.clearOnShutdown.cookies", true);
user_pref("privacy.clearOnShutdown.cache", true);
user_pref("privacy.clearOnShutdown.offlineApps", true);
user_pref("privacy.clearOnShutdown.sessions", true);
user_pref("privacy.clearOnShutdown.history", false);
user_pref("privacy.clearOnShutdown.formdata", false);
user_pref("privacy.clearOnShutdown.downloads", false);
user_pref("privacy.clearOnShutdown.siteSettings", false);
user_pref("privacy.clearOnShutdown_v2.cookiesAndStorage", true);
user_pref("privacy.clearOnShutdown_v2.cache", true);
user_pref("privacy.clearOnShutdown_v2.historyFormDataAndDownloads", false);
user_pref("privacy.clearOnShutdown_v2.siteSettings", false);
user_pref("network.cookie.lifetimePolicy", 2);        // cookies last for one session only
