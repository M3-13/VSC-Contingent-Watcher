# Copilot Contingent Watcher

VS-Code-Erweiterung, die dein GitHub-Copilot-Kontingent (Premium-Anfragen oder AI Credits) in der Statusleiste anzeigt, ein Tagesbudget berechnet und rechtzeitig warnt.

## Was es macht

- Zeigt verbleibendes Kontingent, Verbrauch, Prozent oder Tagesbudget in der Statusleiste.
- Berechnet ein **Tagesbudget** bis zum Reset (optional ohne Wochenenden, mit Reserve).
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
| `contingentWatcher.refreshIntervalMinutes` | `10` | Aktualisierungsintervall in Minuten (2 bis 120). |
| `contingentWatcher.statusBar.display` | `remaining` | Anzeige: `remaining`, `used`, `percent` oder `dailyBudget`. |
| `contingentWatcher.statusBar.alignment` | `right` | Seite der Statusleiste: `left` oder `right`. |
| `contingentWatcher.warnings.enabled` | `true` | Benachrichtigungen ein/aus. |
| `contingentWatcher.warnings.thresholds` | `[50, 75, 90, 100]` | Prozentwerte, bei denen gewarnt wird. |
| `contingentWatcher.warnings.paceWarning` | `true` | Warnung, wenn das Kontingent vor dem Reset leer wäre. |
| `contingentWatcher.budget.countWeekends` | `false` | Wochenenden als Budgettage zählen. |
| `contingentWatcher.budget.reserve` | `0` | Reserve, die nicht ins Tagesbudget eingeht. |
| `contingentWatcher.tips.enabled` | `true` | Spartipp im Tooltip anzeigen. |

## Befehle

| Befehl | Beschreibung |
| --- | --- |
| `Copilot Contingent: Kontingent aktualisieren` | Daten sofort neu laden. |
| `Copilot Contingent: Kontingent-Details anzeigen` | Übersicht mit Schnellaktionen. |
| `Copilot Contingent: Spartipps anzeigen` | Liste der Spartipps. |
| `Copilot Contingent: Einstellungen öffnen` | Öffnet die Einstellungen der Erweiterung. |
| `Copilot Contingent: Mit GitHub anmelden` | Anmeldung anstoßen. |
| `Copilot Contingent: Warnungen für 24 Stunden stummschalten` | Snooze. |

## Spartipps

- Für Routine ein enthaltenes Modell (0x) nutzen, Premium-Modelle für schwierige Probleme aufsparen. Die Modellauswahl zeigt die Kosten.
- Inline-Vervollständigungen und Next Edit Suggestions kosten kein Kontingent.
- Für kleine Änderungen Ask/Edit statt Agent-Modus.
- Kontext gleich mitgeben, Fragen bündeln, pro Thema einen neuen Chat starten.
- Wiederkehrende Regeln in `.github/copilot-instructions.md` ablegen.
- In der GitHub-Abrechnung ein Ausgabenlimit setzen.

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
