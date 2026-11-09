# KundenDialog – WhatsApp-CRM für Hörakustiker mit AkuWin

KundenDialog holt Kundendaten aus **AkuWin** und schreibt Kunden per **WhatsApp** an,
z. B. zum Geburtstag oder wenn die Hörgeräte 6 Jahre alt sind (Neuversorgung durch die Krankenkasse möglich).
Kunden können per WhatsApp antworten. Jede Filiale hat eine **Browser-App (Posteingang)**,
die mit der **Festnetznummer der Filiale** als WhatsApp-Business-Nummer verknüpft ist.

```
 AkuWin ──(CSV-Export oder SQL, stündlich)──► KundenDialog ──► WhatsApp Cloud API (Meta) ──► Kunde
                                                  ▲   │                    │
                         Browser-App je Filiale ──┘   └──◄── Webhook ◄─────┘  (Antworten, Lesebestätigungen)
```

## Funktionen

- **AkuWin-Abgleich**: Kunden (Anrede, Name, Geburtstag, Handynummer, Filiale, Einwilligung, verstorben)
  und Hörsysteme (Hersteller, Modell, Seriennummer, Abgabedatum). Spaltenzuordnung frei konfigurierbar.
  Telefonnummern werden automatisch normalisiert (`0171 / 123 45 67` → `+49 171 1234567`), Festnetznummern
  werden für WhatsApp ignoriert.
- **Automationen**
  - Geburtstagsgruß (am Geburtstag, 29.02. → 28.02. in Nicht-Schaltjahren)
  - Hörgeräte X Jahre alt (Standard 6 Jahre ab Abgabedatum). Wer inzwischen neu versorgt wurde, wird nicht angeschrieben.
  - Jede Nachricht wird **genau einmal** gesendet, nur im Zeitfenster (Standard Mo–Sa 9–18 Uhr),
    nur mit Einwilligung, nie an inaktive/verstorbene Kunden.
  - Vorschau der nächsten 7–60 Tage inkl. Grund, warum jemand übersprungen wird.
- **Filial-Posteingang im Browser**
  - Jede Filiale sieht nur die Chats ihrer eigenen Nummer; Admins sehen alle.
  - Live-Aktualisierung, Hinweiston, Ungelesen-Zähler, Erledigt/Offen, Suche.
  - Kundenkarte mit Daten und Hörsystemen aus AkuWin direkt neben dem Chat.
  - Mitarbeiter-Kürzel an jeder gesendeten Nachricht.
  - 24-Stunden-Regel von WhatsApp eingebaut: danach nur freigegebene Vorlagen.
  - Bilder und Sprachnachrichten von Kunden ansehen/anhören.
  - Kunden aus AkuWin suchen und per Vorlage neu anschreiben.
- **Einwilligung / Abmeldung**: Kunden schreiben `STOPP` → keine Automationen mehr (wird durch spätere
  AkuWin-Importe nicht überschrieben), `START` → wieder angemeldet.
- **Testmodus** (`DRY_RUN=true`): alles läuft, aber es wird nichts wirklich an WhatsApp gesendet.

## Schnellstart (Demo)

Voraussetzung: Node.js ≥ 22.13 (keine weiteren Datenbank-Server nötig, Daten liegen in SQLite).

```bash
npm install
cp .env.example .env          # DRY_RUN=true lassen!
npm run demo                  # erzeugt Beispiel-AkuWin-Export, importiert ihn, legt Demo-Logins an
npm start                     # http://localhost:3000
```

Logins: `admin`, `zentrale`, `nord` – Passwort jeweils `demo-passwort`.

```bash
npm test                      # automatische Tests
```

## Einrichtung für den Echtbetrieb

### 1. WhatsApp Business Platform (Meta) mit Festnetznummern

1. Meta-Business-Konto anlegen und **Unternehmensverifizierung** abschließen (business.facebook.com).
2. Unter developers.facebook.com eine App vom Typ *Business* anlegen, Produkt **WhatsApp** hinzufügen.
3. Je Filiale die **Festnetznummer** im WhatsApp Manager hinzufügen:
   - Verifizierung per **Sprachanruf** wählen (SMS geht bei Festnetz nicht). Der Anruf muss direkt am
     Telefon ankommen – eine Telefonanlage/Ansage (IVR) kurzzeitig umgehen.
   - Die Nummer darf nicht gleichzeitig in der normalen WhatsApp- oder WhatsApp-Business-App registriert sein.
     Die Browser-App von KundenDialog ersetzt die App.
   - Normale Anrufe auf der Festnetznummer funktionieren weiterhin wie bisher.
4. Die **Phone Number ID** jeder Nummer notieren (WhatsApp Manager → API-Setup).
5. Einen **System-User** mit dauerhaftem Token anlegen (Rechte `whatsapp_business_messaging`,
   `whatsapp_business_management`) → `WHATSAPP_TOKEN`. App-Secret → `WHATSAPP_APP_SECRET`.
6. Webhook einrichten: URL `https://<ihr-server>/webhook`, Verify-Token = `WHATSAPP_VERIFY_TOKEN`,
   Feld **messages** abonnieren.

### 2. Nachrichtenvorlagen anlegen

Automatische Nachrichten (und alles nach 24 h ohne Kundennachricht) müssen von Meta freigegebene
**Vorlagen** sein. Im WhatsApp Manager anlegen (Sprache Deutsch), z. B.:

| Name | Kategorie | Text (Vorschlag) |
|---|---|---|
| `geburtstag_gruss` | Marketing | Hallo {{1}}, Ihr Team von {{2}} wünscht Ihnen alles Gute zum Geburtstag und einen wundervollen Tag! Abmelden: STOPP |
| `neuversorgung_6_jahre` | Marketing | Hallo {{1}}, Ihre Hörsysteme haben wir Ihnen am {{2}} angepasst. Nach 6 Jahren übernimmt Ihre Krankenkasse in der Regel neue Geräte. Gerne beraten wir Sie unverbindlich – antworten Sie einfach auf diese Nachricht. Ihr Team von {{3}}. Abmelden: STOPP |
| `rueckmeldung_bitte` | Utility | Hallo {{1}}, wir haben eine Nachricht für Sie. Bitte antworten Sie kurz, damit wir Ihnen schreiben können. Ihr Team von {{2}} |
| `abholung_bereit` | Utility | Hallo {{1}}, Ihre Hörsysteme sind fertig und können bei {{2}} abgeholt werden. |

Die Zuordnung der Platzhalter steht in `config/automations.json` (`{anrede}`, `{vorname}`, `{nachname}`,
`{kundennr}`, `{filiale}`, `{anpassdatum}`, `{geraet}`).

### 3. AkuWin anbinden

**Variante A – CSV-Export (empfohlen für den Start):** In AkuWin eine Kundenliste und eine Geräteliste als
CSV exportieren (z. B. über die Listen-/Exportfunktion oder einen geplanten Export) und im Ordner
`data/import/` ablegen (`kunden.csv`, `geraete.csv`). KundenDialog prüft regelmäßig, ob sich die Dateien
geändert haben, und gleicht dann ab. Kommt der Export von einem anderen Rechner, den Ordner als Netzlaufwerk
freigeben oder den Pfad in `config/akuwin.json` anpassen.

**Variante B – direkt aus der Datenbank:** Läuft AkuWin auf einem MS-SQL-Server, kann KundenDialog mit einem
**Nur-Lese-Benutzer** direkt lesen (`"source": "sql"`, `npm install mssql`, Abfragen in `config/akuwin.json`).
Tabellen- und Spaltennamen bitte mit dem AkuWin-Support/Systembetreuer klären.

Dann die Spaltennamen in `config/akuwin.json` an den Export anpassen:

```bash
cp config/akuwin.example.json config/akuwin.json
cp config/branches.example.json config/branches.json
cp config/automations.example.json config/automations.json
npm run import        # zeigt an, wie viele Kunden/Geräte erkannt wurden, und warum Zeilen übersprungen wurden
```

- `customerColumns.mobile` darf mehrere Spalten enthalten – die erste gültige Handynummer wird genommen.
- `customerColumns.optIn`: Spalte/Merkmal in AkuWin, in dem die WhatsApp-Einwilligung gepflegt wird
  (z. B. ein Zusatzfeld „WhatsApp = ja“). Ohne diese Spalte kann die Einwilligung in der Browser-App gesetzt werden.
- `customerColumns.inactive`: z. B. „Verstorben“ – diese Kunden werden nie automatisch angeschrieben.
- `branches.json` → `akuwinCodes`: Filialkennungen, wie sie in AkuWin stehen.

### 4. Logins anlegen

```bash
npm run set-password -- admin '<sicheres-passwort>'                 # Admin, alle Filialen
npm run set-password -- zentrale '<sicheres-passwort>' zentrale     # Login der Filiale „zentrale“
```

In jeder Filiale den Browser auf `https://<ihr-server>/` öffnen, mit dem Filial-Login anmelden
(bleibt 30 Tage angemeldet) und Benachrichtigungen erlauben.

### 5. Betrieb

- Server mit öffentlicher **HTTPS**-Adresse (für den Meta-Webhook), z. B. hinter nginx/Caddy oder als Windows-Dienst
  mit Reverse-Proxy. `NODE_ENV=production` setzen (sichere Cookies).
- `.env` ausfüllen, `DRY_RUN=false` erst setzen, wenn Vorlagen freigegeben sind und die Vorschau unter
  „Automationen“ stimmt.
- Datei `data/kundendialog.db` regelmäßig sichern.

## Datenschutz (bitte unbedingt beachten)

- **Einwilligung**: Werbliche WhatsApp-Nachrichten (Geburtstag, Neuversorgung) brauchen eine nachweisbare
  Einwilligung (UWG § 7, DSGVO). Am besten schriftlich bei der Anpassung einholen und in AkuWin vermerken.
  Standard ist `requireOptIn: true` – ohne Einwilligung wird nichts automatisch gesendet.
- **Gesundheitsdaten**: Dass jemand Hörgeräte trägt, ist ein Gesundheitsdatum (Art. 9 DSGVO). Die Einwilligung
  sollte ausdrücklich die Kommunikation über WhatsApp (Meta) umfassen. Vorlagentexte möglichst knapp halten.
- Mit Meta besteht über die WhatsApp-Business-Bedingungen ein Auftragsverarbeitungsvertrag; in die
  Datenschutzerklärung aufnehmen.
- Abmeldung per `STOPP` ist eingebaut und in jeder Marketing-Vorlage zu erwähnen.
- Kosten: Meta berechnet Vorlagen-Nachrichten pro Nachricht (Marketing teurer als Utility);
  Antworten innerhalb von 24 h auf Kundennachrichten sind kostenlos.

## Aufbau

```
src/
  server.js              Web-Server, REST-API, Live-Updates (SSE)
  config.js              .env + config/*.json
  db.js                  SQLite-Schema
  phone.js               Telefonnummern normalisieren
  messaging.js           Konversationen, Ein-/Ausgang, Opt-in/STOPP, 24-h-Fenster
  placeholders.js        Platzhalter für Vorlagen
  auth.js                Logins (Filiale / Admin)
  akuwin/                CSV-Parser, Spaltenzuordnung, Import (CSV/SQL), periodischer Abgleich
  whatsapp/              Cloud-API-Client, Webhook (mit Signaturprüfung)
  automations/engine.js  Geburtstag / Geräte-Alter, Zeitfenster, Einmal-Versand
public/                  Browser-App (ohne Build-Schritt)
config/*.example.json    Vorlagen für Filialen, AkuWin-Zuordnung, Automationen
scripts/                 import, set-password, demo
test/                    automatische Tests
```

### Weitere Regeln ergänzen

Neue Regeltypen (z. B. Batterie-/Service-Erinnerung, Nachsorge 6 Wochen nach Anpassung) in
`src/automations/engine.js` → `findCandidates` ergänzen und in `config/automations.json` eintragen.
