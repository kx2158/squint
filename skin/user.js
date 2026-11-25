// Squint skin prefs. Applied by launch.ps1 between the markers, nothing else in user.js is touched.
// Only interface prefs live here. Nothing that changes what websites can see.
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);   // lets userChrome.css load
user_pref("browser.startup.homepage", "@@START@@");
user_pref("browser.startup.page", 1);                                    // open the home page
