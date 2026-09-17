# FrameCut – Produkt- und Betriebshandbuch

Stand: 13. September 2026

## 1. Zielbild

FrameCut ist eine zentrale Oberfläche, in der mehrere Benutzer eigene Film- und Comicprojekte planen können. Die Verwaltungsoberfläche läuft dauerhaft im Proxmox-Container. Leistungsintensive Bild-, Video-, Sprach- und Schnittaufgaben werden später über einen lokalen Worker an den Laptop geschickt.

Der wichtigste Anwendungsfall ist Video:

1. Projekt und Episode anlegen.
2. Eine eigene Geschichte schreiben oder ein Tagebuch einfügen.
3. Stil, gewünschte Laufzeit und Bearbeitungsart festlegen.
4. Die KI prüft, ob Inhalt und Laufzeit zusammenpassen.
5. Die KI erkennt Figuren, Orte, Gegenstände und chronologische Szenen.
6. Nach Bestätigung entstehen editierbare Video-Shots.
7. Referenzbilder werden geprüft oder hochgeladen.
8. Freigegebene Shots gehen seriell an den lokalen Render-Worker.
9. Sprache, Geräusche, Musik, Schnitt und Export folgen als Produktionsstufen.

## 1.1 Verifizierter Teststand

Am 14. September 2026 wurde der Ablauf mit dem bestehenden Projekt **Michel Tagebuch** praktisch getestet:

- gespeicherte Story automatisch mit DeepSeek analysiert
- 18 chronologische Szenen erkannt
- 22 Figuren, Orte und Gegenstände angelegt
- 51 editierbare Shots mit insgesamt 268 Sekunden (4:28 Minuten) erstellt
- Tesla-Referenz mit lokaler ComfyUI-Bildinstanz erzeugt und online dem Projekt zugeordnet
- ersten MiniMax-H3-Clip mit dieser Referenz gerendert
- Worker-Zuordnung, Upload, Fehlerbehandlung und Standby-Sperre geprüft

Der Storyplan ist damit einsatzfähig. Vor einem vollständigen Lauf müssen die automatisch vorgeschlagenen Personenmerkmale und Beziehungen geprüft und nach Möglichkeit durch echte Referenzbilder ersetzt werden.

## 2. Aktueller Betrieb

- Anwendung: `http://10.0.60.131:4317`
- Proxmox-Container: `116` (`framecut`)
- Anwendung: `/opt/framecut`
- Dauerhafte Daten: `/srv/framecut-data`
- Dienst: `framecut.service`
- Die Anwendung startet mit dem Container automatisch.
- Wenn der Laptop ausgeschaltet ist, bleiben Planung, Storys, Uploads und Freigaben erreichbar. Lokales Rendering wartet, bis ein Worker verfügbar ist.

### Laptop-Worker

Auf dem Windows-Desktop liegen zwei Starter:

- **FrameCut Worker starten** öffnet ein sichtbares Statusfenster und holt seriell Render-Aufträge ab.
- **FrameCut Worker stoppen** setzt ein Stoppsignal. Ein laufender Einzelschritt wird beendet, danach fährt der Worker sauber herunter.

Solange der Worker läuft, verhindert er den Standby des Computers. Der Bildschirm darf sich weiterhin ausschalten. Beim Beenden wird die normale Energieverwaltung wiederhergestellt.

MiniMax H3 läuft auf Port 8188. Für Standbilder startet der Worker eine separate, versteckte ComfyUI-Instanz auf Port 8190 und beendet nur diese selbst gestartete Instanz beim Worker-Stopp. Modelle werden vor dem Wechsel soweit möglich aus dem VRAM entladen.

## 3. Bedienung

### Als App auf dem Handy oder Computer speichern

FrameCut enthält ein Web-App-Manifest, ein eigenes App-Symbol und einen Service Worker. Über eine HTTPS-Adresse kann es als eigenständige Progressive Web App installiert werden. Über die lokale HTTP-Adresse lässt sich je nach Browser mindestens eine Startbildschirm-Verknüpfung erstellen.

- Android/Chrome: **Als App speichern** oder Browsermenü → **Zum Startbildschirm hinzufügen**
- iPhone/iPad/Safari: **Teilen** → **Zum Home-Bildschirm**
- Computer/Chrome oder Edge: **Als App speichern** beziehungsweise das Installationssymbol in der Adresszeile

Die installierte App öffnet ohne normale Browserleiste. Der Container muss weiterhin erreichbar sein; der Offline-Cache ersetzt den Server und die Anmeldung nicht.

### KI-Anbieter einrichten

Unter **Einstellungen → KI-Anbieter einrichten** kann jeder Benutzer einen eigenen Schlüssel für Gemini, OpenAI oder DeepSeek hinterlegen. Der Schlüssel wird verschlüsselt gespeichert und nach dem Speichern nicht mehr angezeigt.

Standardmodelle bei leerem Modellfeld:

- Gemini: `gemini-2.5-flash`
- OpenAI: `gpt-4.1-mini`
- DeepSeek: `deepseek-chat`

### Auto-Modus

Unter **Handlung & Folgen**:

1. Story schreiben und speichern.
2. **Auto-Modus planen** wählen.
3. Gewünschte Dauer von 15 Sekunden bis 15 Minuten festlegen.
4. Bearbeitungsart wählen:
   - **Filmisch ausbauen:** ergänzt Übergänge, Reaktionen und visuelle Zwischenmomente, verändert aber keine Haupthandlung.
   - **Werkgetreu verdichten:** bleibt möglichst eng am Text.
5. Stilvorgabe beschreiben.
   - Ein beschreibendes Stil-Preset kann als Ausgangspunkt gewählt werden.
   - Die **Style Bible** hält Zeichenmedium, Farbpalette, Licht, Textur, Kamera und Negativregeln fest.
   - Vorhandene Referenzbilder können als verbindliche Stilreferenzen für alle Shots ausgewählt werden.
6. **Geschichte prüfen** wählen.
7. Laufzeitempfehlung, erkannte Elemente und Szenen prüfen.
8. Empfohlene oder ursprünglich gewünschte Laufzeit auswählen.
9. **Produktionsplan übernehmen** wählen.

Bei langen Texten wird nicht sofort ein riesiger Shot-Block verlangt. FrameCut erstellt zuerst eine kompakte Szenenanalyse und erweitert die Szenen anschließend in Gruppen. Das reduziert abgeschnittene Antworten und verbessert die chronologische Kontinuität.

### Manuelle Arbeitsweise

Alle automatisch erzeugten Daten bleiben manuell bearbeitbar:

- Figuren, Orte und Requisiten hinzufügen oder ändern
- Referenzbilder hochladen
- visuelle Leitplanken ändern
- einzelne Shots erstellen
- Dauer, Kameraführung, Prompt, Status und Referenzen pro Shot ändern
- neue Episoden anlegen oder zusätzliche Assets aus der Projektbibliothek verwenden

## 4. Datenmodell

```text
Benutzer
├── eigene verschlüsselte API-Schlüssel
└── Render-Aufträge mit Besitzer-ID

Projekt
├── allgemeine Stilvorgabe
├── projektweite Figuren
├── projektweite Orte
├── projektweite Requisiten
└── Episoden
    ├── Story
    ├── zugeordnete Assets
    ├── Auto-Plan-Entwürfe
    ├── Shots
    │   ├── Dauer
    │   ├── Kamera
    │   ├── Video-Prompt
    │   ├── Status
    │   └── Referenz-Assets
    └── Ergebnisse
```

Die SQLite-Datenbank liegt im persistenten Datenordner. Uploads werden ebenfalls dort gespeichert. Anwendungscode kann aktualisiert werden, ohne diese Daten zu überschreiben.

## 5. Auto-Modus intern

### Phase A – Vorprüfung

Die Story wird zusammen mit Zieldauer, Stil und Bearbeitungsart an den ausgewählten Anbieter geschickt. Die strukturierte Antwort enthält:

- Inhaltszusammenfassung
- Wortzahl
- Machbarkeit der gewünschten Laufzeit
- empfohlene Laufzeit und Begründung
- Figuren, Orte und Gegenstände
- chronologische Szenen mit Gewichtung

Noch werden keine Projektdaten verändert.

### Phase B – Übernahme

Erst nach Benutzerbestätigung werden die erkannten Szenen in Gruppen von höchstens sechs Szenen zu Shots erweitert. Die Laufzeit wird anhand der Szenengewichtung verteilt. Danach werden Assets, Episode-Zuordnungen, Shots und Shot-Referenzen gespeichert.

Die projektweite Style Bible wird in jeden Shot-Prompt übernommen. Gewählte visuelle Referenzen werden mit jedem erzeugten Shot verknüpft. Jede automatisch erkannte Figur und jeder Ort erhält zusätzlich eigene visuelle Leitplanken. Dadurch können spätere Referenzbilder vor dem Video-Rendering erzeugt und freigegeben werden.

Maximalwerte der aktuellen Version:

- Story-Eingabe: 2 MB
- Zieldauer: 15 Minuten
- erkannte Elemente: 40
- erkannte Szenen: 48
- erzeugte Shots: 140

## 6. Sicherheitsmodell

- API-Schlüssel werden mit AES-256-GCM verschlüsselt.
- Der Hauptschlüssel befindet sich als Dienstvariable im Container und nicht in der Datenbank.
- Schlüssel werden nie über die Benutzeroberfläche zurückgegeben.
- Sitzungen verwenden HttpOnly- und SameSite-Cookies.
- Mediendateien sind nur nach Anmeldung erreichbar.
- Der Worker verwendet später einen separaten Worker-Schlüssel und fragt Aufträge aktiv ab; dadurch braucht der Laptop keinen öffentlich erreichbaren Port.

Vor einer Veröffentlichung im Internet fehlen noch Rate-Limits, dauerhaft gespeicherte Sitzungen, Benutzer-/Projektberechtigungen und die geplante Authentik-Anbindung.

## 7. Noch nicht vollständig automatisiert

Folgende Teile sind geplant, aber noch nicht Ende-zu-Ende fertig:

- echtes ComfyUI-Workflow-Payload für Charakter- und Ortsvorschauen
- vollständiger Laptop-Worker mit MiniMax-H3-Ausführung
- automatische Start-/Stopp-Steuerung aller Pinokio-Apps durch den Worker
- TTS, Dialogprüfung und Sprecherprofile
- Musik- und Soundeffekt-Pipeline
- automatischer Schnitt, Untertitel und finaler Export
- Projektrollen, Einladungen und Authentik
- Export/Archivierung kompletter Projekte sowie Papierkorb-Aufbewahrung

## 8. Geplante Produktionszustände

```text
Story → Vorprüfung → Szenenplan → Assets → Referenzvorschau
      → Shot-Draft → Shot-Freigabe → Render-Warteschlange
      → Video → Sprache/SFX/Musik → Schnitt → Export
```

Der Grundsatz lautet: Automatik darf Vorschläge und Entwürfe erzeugen. Zeit- und kostenintensive Render-Schritte beginnen erst nach einer sichtbaren Freigabe oder wenn ein Benutzer ausdrücklich den Vollautomatik-Modus aktiviert.
