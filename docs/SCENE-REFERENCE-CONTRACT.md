# Referenzgeführte Szenen (Pipeline v2)

## Verhalten

- Explizite Shot-Zuordnungen sind verbindlich; Namenssuche im Freitext entscheidet nicht mehr über die Besetzung.
- Hauptfoto und zusätzliche Fotos werden pro Asset gruppiert, identische Inhalte dedupliziert. Mehrere Ansichten sind dieselbe Figur, nicht zusätzliche Figuren.
- Alle Fotos werden pro Auftrag neu heruntergeladen und gegen SHA-256 geprüft. Fehlende Fotos oder mehr als neun Bilder stoppen den Auftrag mit einer Meldung statt stiller Auslassung.
- MiniMax Ref2VA erhält Identitäts-, Orts-, Objekt- und Stilreferenzen mit getrennten Anweisungen. Referenzgeführte Szenen verwenden kein textgeneriertes Z-Image-Startbild. Alte `approved-keyframes/shot-ID.png` und importierte `source_image_path` werden nicht übernommen. Explizite Shot-Fotos sind semantische Referenzen, kein erzwungenes erstes Frame.
- Ohne Referenzen darf weiterhin Z-Image ein Szenenbild erzeugen. Hier ist keine bildbasierte Identitätstreue möglich.
- Ein Szenen-Fingerprint bindet Handlung, Kamera, Seed, Dauer, Story, Stil, Ausschlüsse, Beschreibungen und Foto-Inhalte. Änderungen verhindern die Übernahme eines veralteten Renderauftrags und machen frühere Sichtfreigaben ungültig.
- Auto-Planung speichert den gewählten Stil in der Episode, nicht global im Projekt. Ein konservativer Legacy-Filter entfernt Sätze mit bekannten konkreten Requisiten/Schauplätzen aus dem Render-Stil und meldet sie; er verändert den gespeicherten Stiltext nicht. Das ist keine vollständige semantische Stilzerlegung. Stiltexte sollten weiterhin nur Medium, Farben, Licht und Gestaltung beschreiben.

## Sichtprüfung

Nach dem Rendern steht am Clip **Sichtprüfung offen**. Mit **Clip prüfen und freigeben** den ganzen Clip prüfen und die fünf Punkte bestätigen: Identität, Anzahl, Alter/Größe, Stil, Handlung. Der Schnitt und automatische Audio-Master warten auf aktuelle Freigaben aller Szenen. Die Audiosynthese selbst wurde nicht verändert.

Alte Clips ohne v2-Provenienz bleiben sichtbar und herunterladbar, benötigen für diese Freigabe aber einen neuen Render. Manuelles Bestätigen ist keine automatische Gesichtserkennung. Ein Bildmodell kann trotz korrekter Referenzübergabe Doppelungen oder Abweichungen erzeugen: dann Prompt/Besetzung prüfen und die Szene neu rendern, nicht freigeben.

## Betrieb und Tests

Server und Worker gemeinsam aktualisieren. Den Worker nach einem Update neu starten; ein laufender PowerShell-Prozess lädt Funktionsänderungen nicht nach. Keine Originalreferenzen löschen. Neue Job-Verzeichnisse/Graphen isolieren Aufträge; bestätigte Arbeitskopien werden über die bestehende Worker-Bereinigung entfernt.

Tests: `node --test test/*.test.mjs`, `python -m unittest discover -s test -p test_minimax_h3_ref2va.py`, PowerShell-Parser und `node --check server.mjs`.

Die Tests prüfen Verträge, mehrere Fotos, fehlende Referenzen, Referenzlimit, Revisionen, manuelle Freigabe, echte lokale HTTP-Übergabe und den H3-Graphen ohne erzwungenes Startbild. Sie beweisen keine visuelle Modellqualität; dafür ist ein neuer echter Vorschauclip mit Sichtprüfung erforderlich.
