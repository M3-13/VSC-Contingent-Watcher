# Changelog

## 0.3.0

- btw-Fenster (Strg+Alt+Umschalt+B): eine Nebenfrage neben dem Chat, im Extension-Design, ohne Session-Wechsel; Kontext aus Session (inkl. Agent-Aktionen), Git-Diff, bearbeiteten Dateien und Editor; Modell der Session
- `/btw` zusätzlich als Slash-Befehl im Chat (Steering, VS Code ≥ 1.110)
- Verlauf: Arbeit endet mit eigenem Commit (auch auf main), Tickets (PROJ-123, #45, AB#12) bündeln Commits, manuelle Aufgaben, optionaler Ticket-Link
- Übersicht: Widget folgt dem gewählten Stil (Tachometer, Batterie, Ring, Balken); darunter nur „Monat vergangen“
- Zuverlässiger Auto-Refresh, Animation beim manuellen Refresh

## 0.2.0

- Arbeitstage frei wählbar (z. B. Teilzeit Mo/Di/Do): Budget, Tempo, Prognose und Streak rechnen nur mit diesen Tagen
- Einheitliche Benennung: Credits oder Requests je nach Abrechnung, sonst neutral „Kontingent“

- `@btw` im Copilot-Chat: Nebenfragen mit dem gewählten Chat-Modell und Chat-Kontext
- AI-Credits werden bevorzugt angezeigt (einstellbar), Verbrauch pro Modell in Credits
- Bedarf (geschätzt): was der Monat bei deinem Tempo gebraucht hätte
- Streak endet, wenn das Kontingent leer ist
- Geführte Anmeldung für GitHub Enterprise (GHE.com, Enterprise Server)

- btw: `@btw` im Chat, Antwort in einem Fenster daneben, mit Kontext der Haupt-Session; Chat-Modell oder Gratis-Modell
- Copilot-Optionen im Dashboard: Eagerness, Vorschläge pro Sprache, Snooze
- Eigene Statusleisten-Farbe bleibt auch bei Warnungen sichtbar

- Dashboard mit 4 Tabs: Übersicht, Verlauf, Tipps, Einstellungen
- Hinweis, wenn Kontingent am Monatsende ungenutzt verfallen würde
- Verlauf: aktive Zeit und Verbrauch pro Git-Branch, Monatsrückblick, Verbrauch pro Modell (optional mit Token)
- Akzentfarbe, Statusleisten-Icon (Tachometer, Batterie, Ring, Balken) und -Farbe einstellbar

## 0.1.0

- Initial release.
- Copilot quota in the status bar (remaining, used, percent or daily budget).
- Daily budget and pace forecast, optionally excluding weekends and with a reserve.
- Threshold and pace warnings, snooze for 24 hours.
- Saving tips and a getting-started walkthrough.
- English and German localization.
