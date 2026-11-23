# Evaluation: Wie baut man einen Copilot-Kontingent-Wächter?

Stand: November 2026

## 1. Datenquelle (das Kernproblem)

| Option | Vorteile | Nachteile | Entscheidung |
|---|---|---|---|
| **`GET api.github.com/copilot_internal/user`** | Liefert Kontingent, Rest und Reset-Datum. Funktioniert mit dem GitHub-Login, den VS Code ohnehin hat. Kein Setup nötig. | Undokumentiert und kann sich ändern | **Primär** |
| Offizielle Billing-API (`/users/{user}/settings/billing/premium_request/usage`) | Offiziell, mit Details pro Modell | Braucht einen PAT mit Plan-Berechtigung. Liefert nur Verbrauch, kein Kontingent. | Später als optionaler Fallback |
| Copilot-Extension-API / Copilot SDK (`account.getQuota`) | Offiziell | Für Drittanbieter-Extensions in VS Code (noch) nicht nutzbar | Beobachten |
| Manuell zählen (Chat-Events) | Unabhängig von GitHub | Ungenau, Multiplikatoren unbekannt | Verworfen |

**Risiko:** Laut Recherche hat GitHub zum 1. Juni 2026 bei vielen Plänen auf nutzungsbasierte Abrechnung mit „AI Credits“ umgestellt. Premium Requests gibt es dann nur noch im Legacy-Modell. Das ist noch nicht gegen die offizielle Doku verifiziert.
→ Der Parser ist daher **einheitenneutral** (`requests` | `credits`) und behandelt jedes Feld als optional. Er wählt das erste gemessene Kontingent, das nicht `chat` oder `completions` ist.

## 2. Was hilft wirklich, bis zum Monatsende auszukommen?

Eine Prozentanzeige allein hilft nicht. Entscheidend ist der **Vergleich von Verbrauch und verstrichener Zeit**:

- **Tagesbudget** = (Rest − Reserve) / verbleibende Budgettage. Standardmäßig zählen nur Arbeitstage.
- **Tempo** = Verbrauchsrate der letzten 7 Tage. Ist zu wenig Historie da, gilt der Monatsschnitt.
- **Prognose:** Datum, an dem das Kontingent beim aktuellen Tempo leer ist.
- **Status:** `onTrack` → `ahead` (> 15 % über dem linearen Plan, gelb) → `critical` (läuft mehr als 3 Tage vor dem Reset leer, rot) → `exhausted`

## 3. UX-Prinzipien („merkt man, fühlt sich nativ an“)

- Ein **Statusleisten-Item** direkt neben dem Copilot-Icon (`$(copilot)`), mit Theme-Farben `statusBarItem.warning/errorBackground` statt eigener Farben
- Ein **Rich Hover** mit Fortschrittsbalken, Tagesbudget, Prognose und einem passenden Tipp
- **Quick Pick** für Details und Tipps statt einer eigenen Webview: leichtgewichtig und tastaturfreundlich
- **Benachrichtigungen** nur bei neu überschrittenen Schwellen (einmal pro Zyklus) und höchstens eine Tempo-Warnung pro Tag. Pausieren ist möglich.
- Ein **Walkthrough** im „Erste Schritte“-Bereich von VS Code
- **l10n** über `vscode.l10n`, aktuell in Englisch und Deutsch
- Polling nur bei fokussiertem Fenster, Refresh beim Fokuswechsel. Der Cache sorgt für eine sofortige Anzeige beim Start.

## 4. Sicherheit

- Kein eigener Token. Die Extension nutzt die GitHub-Session von VS Code (`user:email`) und fragt nur still ab. Ein Login-Dialog erscheint nur nach einem Klick.
- Daten bleiben lokal (`globalState`): kein Telemetrie-Versand, keine Dritt-Server
- Null Runtime-Dependencies

## 5. Nächste Schritte

1. Den Endpoint mit einem echten Account prüfen, insbesondere die Felder nach der Credits-Umstellung
2. Optionalen PAT-Fallback auf die offizielle Billing-API bauen (Token im SecretStorage)
3. Verbrauch pro Modell aus der Billing-API anzeigen, um zu sehen, welches Modell am meisten kostet
4. Org- und Business-Accounts testen, ggf. Unterstützung für org-weites Budget
