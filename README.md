# Copilot Contingent Watcher

VS-Code-Erweiterung, die dein GitHub-Copilot-Kontingent (Premium-Anfragen oder AI Credits) in der Statusleiste anzeigt, ein Tagesbudget berechnet und rechtzeitig warnt.

## Was es macht

- Zeigt verbleibendes Kontingent, Verbrauch, Prozent oder Tagesbudget in der Statusleiste. Das Icon zeigt den Füllstand.
- **Dashboard** (Klick auf die Statusleiste oder das Icon in der Activity Bar) mit 4 Tabs:
  - **Übersicht:** Tachometer, Heute, Tagesbudget, Tempo, Puffer, Prognose, Tagesdiagramm und ein Hinweis gegen Verfall
  - **Verlauf:** woran du gearbeitet hast und wie lange (aktive Zeit und Verbrauch; ein Arbeitspaket endet mit deinem Commit – auch auf main/master – oder mit *Aufgabe abschließen*; Commits zum selben Ticket werden zusammengefasst), Monatsrückblick, Verbrauch pro Modell
  - **Tipps:** Spartipps passend zur aktuellen Lage
  - **Einstellungen:** Anzeige, Warnungen, Budget, Akzentfarbe, Statusleisten-Icon und -Farbe, Copilot-Schalter
- **`/btw` – Nebenfrage wie in Claude Code:** Tippe im Copilot-Chat `/btw deine Frage`, auch während der Agent arbeitet. Ab VS Code 1.110 lenkt das den laufenden Agenten kurz um („Steering“): Er beantwortet die Frage knapp im selben Chat mit dem Kontext und Modell der Session und arbeitet danach weiter. `Strg+Alt+Umschalt+B` / `Cmd+Alt+Shift+B` setzt `/btw ` in die Chat-Eingabe.
- **Credits statt Requests:** Meldet GitHub AI-Credits (nutzungsbasierte Abrechnung), zeigt die Extension Credits an. Das ist einstellbar über `contingentWatcher.unit`.
- **Bedarf (geschätzt):** wie viel dein Monat bei deinem Tempo gebraucht hätte, auch wenn das Kontingent schon leer ist, und wie viel pro Tag gereicht hätte.
- **Hinweis gegen Verfall:** In der letzten Monatswoche meldet die Extension, wenn ein Teil des Kontingents voraussichtlich ungenutzt verfällt.
- Berechnet ein **Tagesbudget** bis zum Reset, verteilt auf **deine Arbeitstage** (z. B. nur Mo, Di, Do bei Teilzeit) und optional mit Reserve.
- Prognostiziert dein Tempo und zeigt, an welchem Tag das Kontingent bei gleichem Verbrauch leer wäre.
- Warnt bei Schwellenwerten (z. B. 50/75/90/100 %) und bei zu hohem Tempo.
- Gibt Spartipps und bringt eine Walkthrough für den Einstieg mit.
- Deutsch und Englisch.

## Wie es funktioniert

- Nutzt die bestehende GitHub-Anmeldung von VS Code. Es gibt keinen eigenen Login und es wird **kein Token gespeichert**.
- Liest den undokumentierten Endpunkt `api.github.com/copilot_internal/user`.
- Alle Daten bleiben lokal; es gibt keine Telemetrie und keinen weiteren Server.

## Einstellungen

| Einstellung | Standard | Beschreibung |
| --- | --- | --- |
| `contingentWatcher.auth.provider` | `auto` | Anmeldung: `auto`, `github` oder `github-enterprise` (GHE.com / Enterprise Server). |
| `contingentWatcher.auth.apiUrl` | leer | Optionale API-Basis-URL, z. B. `https://api.firma.ghe.com`. |
| `contingentWatcher.refreshIntervalMinutes` | `10` | Aktualisierungsintervall in Minuten (2 bis 120). |
| `contingentWatcher.statusBar.display` | `remaining` | Anzeige: `remaining`, `used`, `percent` oder `dailyBudget`. |
| `contingentWatcher.statusBar.alignment` | `right` | Seite der Statusleiste: `left` oder `right`. |
| `contingentWatcher.warnings.enabled` | `true` | Benachrichtigungen ein/aus. |
| `contingentWatcher.warnings.thresholds` | `[50, 75, 90, 100]` | Prozentwerte, bei denen gewarnt wird. |
| `contingentWatcher.warnings.paceWarning` | `true` | Warnung, wenn das Kontingent vor dem Reset leer wäre. |
| `contingentWatcher.budget.workDays` | `mon…fri` | Deine Arbeitstage, z. B. `["mon","tue","thu"]`. Das Kontingent wird nur auf diese Tage verteilt. |
| `contingentWatcher.budget.reserve` | `0` | Reserve, die nicht ins Tagesbudget eingeht. |
| `contingentWatcher.tips.enabled` | `true` | Spartipp im Tooltip anzeigen. |
| `contingentWatcher.appearance.accentColor` | `auto` | Akzentfarbe des Tachometers (`teal`, `violet`, `blue`, `green`, `orange`, `pink` oder `#hex`). |
| `contingentWatcher.statusBar.icon` | `gauge` | Icon-Stil: `gauge`, `battery`, `ring`, `bars`, `none`. |
| `contingentWatcher.statusBar.color` | `auto` | Farbe des Statusleisten-Eintrags (Vorlage oder `#hex`). |
| `contingentWatcher.warnings.surplusHint` | `true` | Hinweis, wenn Kontingent ungenutzt verfallen würde. |
| `contingentWatcher.activity.enabled` | `true` | Aktive Zeit und Verbrauch pro Arbeitspaket (bis zum nächsten eigenen Commit) aufzeichnen (nur lokal). |
| `contingentWatcher.activity.ticketPattern` | Jira, `#123`, `AB#123` | Regex für Ticket-IDs in Commit-Nachricht und Branch-Name. |
| `contingentWatcher.activity.ticketUrl` | leer | Link-Vorlage, z. B. `https://jira.example.com/browse/{id}`. |
| `contingentWatcher.unit` | `auto` | Anzeige: `auto` (Credits, wenn vorhanden), `credits` oder `requests`. |

## Befehle

| Befehl | Beschreibung |
| --- | --- |
| `Copilot Contingent: Kontingent aktualisieren` | Daten sofort neu laden. |
| `Copilot Contingent: Kontingent-Details anzeigen` | Übersicht mit Schnellaktionen. |
| `Copilot Contingent: Spartipps anzeigen` | Liste der Spartipps. |
| `Copilot Contingent: Einstellungen öffnen` | Öffnet die Einstellungen der Erweiterung. |
| `Copilot Contingent: Mit GitHub anmelden` | Anmeldung anstoßen. |
| `Copilot Contingent: Warnungen für 24 Stunden stummschalten` | Snooze. |

## Verbrauch pro Modell (optional)

Das zeigt, welches Modell wie viel deines Kontingents verbraucht. Dafür braucht es einen *fine-grained* GitHub-Token mit der Account-Berechtigung **Plan (read)**. Du richtest ihn im Dashboard unter *Verlauf* oder über den Befehl *Verbrauch pro Modell einrichten* ein. Der Token liegt sicher im SecretStorage von VS Code.

## Enterprise-Accounts & Fehlersuche

- **Copilot Business/Enterprise auf github.com:** Hier ist nichts einzustellen. Es wird der normale GitHub-Login genutzt.
- **GHE.com (`firma.ghe.com`) oder GitHub Enterprise Server:** In VS Code `github-enterprise.uri` setzen, z. B. `https://firma.ghe.com`. Die Extension erkennt das automatisch und nutzt den Anbieter `github-enterprise`.
- **403 / SSO:** Deine Organisation verlangt evtl. eine SAML-SSO-Freigabe für den VS-Code-Login, oder sie blockiert den Endpunkt.
- **Log:** Über *Copilot Contingent: Log anzeigen* siehst du, welcher Anbieter und welche URL genutzt wurden und welchen HTTP-Status die Abfrage hatte. Tokens werden nie geloggt.

## Spartipps

Seit Mitte 2026 rechnen viele Pläne Copilot nutzungsbasiert ab, in AI-Credits nach Tokens. Der größte Kostentreiber ist deshalb die Kontextgröße.

- **Neuer Chat pro Aufgabe:** Lange Verläufe werden bei jeder Anfrage mitgeschickt.
- **Gezielter Kontext:** Häng `#file` oder `#selection` an statt `#codebase`, und füge aus Logs nur die relevanten Zeilen ein.
- **Weniger Tools:** Aktiviere nur die Tools und MCP-Server, die die Aufgabe braucht.
- **Passendes Modell:** Nimm das günstigste Modell, das reicht, oder *Auto*. Starke Reasoning-Modelle sind für schwere Probleme da.
- **Instructions und Prompt-Dateien:** Projektregeln gehören in `.github/copilot-instructions.md`, wiederkehrende Aufgaben in `.prompt.md`-Dateien.
- **Kostenlos:** Inline-Vorschläge und Next Edit Suggestions verbrauchen kein Kontingent.

Im Dashboard zeigt der Tab *Tipps* immer nur die Tipps, die gerade zu deiner Lage passen. Es sind rund 40, je nach Status, Zeitpunkt im Monat und drohendem Verfall.

## Entwicklung

```bash
npm install
npm test          # kompiliert und führt die Tests aus
# F5 in VS Code startet den Extension Development Host
npx vsce package  # erzeugt die .vsix
```

## Hinweise

- Der Endpunkt `copilot_internal/user` ist **nicht dokumentiert** und kann sich jederzeit ändern oder wegfallen.
- GitHub hat 2026 für viele Pläne auf nutzungsbasierte AI Credits umgestellt. Die Erweiterung ist einheitenunabhängig und zeigt je nach Plan Anfragen oder Credits.
- Kein offizielles GitHub-Produkt.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
