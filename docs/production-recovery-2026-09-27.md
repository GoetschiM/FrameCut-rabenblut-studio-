# Produktionskorrekturen und sicherer Neulauf

## Stand dieser Änderung

- Storyboard: „Szene mit Ton ansehen“ erzeugt auf dem Server eine MP4-Tonvorschau mit den fertigen, aktuellen Dialog-/Erzähler-/SFX-Spuren dieser Szene. Der Modellton und die Episodenmusik werden nicht übernommen. Fehlende Spuren werden angezeigt. Kein neuer GPU-Render und keine automatische Freigabe.
- Cache nach Videodatei, Quellrevision, Audio-Dateien, Zeitversatz und Lautstärke. Geänderte Spuren erhalten eine neue Vorschau. Maximal zwei gleichzeitige Vorschau-Mixe.
- Worker bricht bei fehlgeschlagener Audio-Führung oder nicht entfernbarer Modelltonspur ab, statt still ein falsches Ergebnis auszuliefern.
- Gemischte Stiltexte behalten Licht/Texturen; angehängte Werkstatt-/Bus-/Zahnrad-Inhalte werden getrennt. Gespeicherte Stiltexte bleiben unverändert.
- Worker-Release 2026.09.27.3: vollständiger aktueller Code, inklusive Kaltstart- und H3-Timeout-Fixes. PowerShell-Dateien im Paket enthalten UTF-8-BOM für Windows PowerShell 5.1.
- Updater kopiert Adapter dateiweise an die korrekten Pfade, mit Sicherung und Rücknahme bei Kopierfehlern; `adapters/adapters` durch rekursives Verzeichniskopieren wird vermieden. Ein fehlgeschlagenes Update lässt den alten Worker wieder starten.
- Versionsmeldung quittiert tatsächlich angeforderte Updates und erhält den bisherigen Runtime-Status, statt fehlende Modelle als bereit auszugeben.

## Nachprüfbare Tests

`node --test test/*.test.mjs` sowie `python -m unittest discover -s test -p test_minimax_h3_ref2va.py`.
Die neuen Tests erzeugen mit ffmpeg echte MP4/WAV-Testdateien, prüfen hörbaren Pegel, Dauer, Cache, Szenengrenzen und den authentifizierten HTTP-Vorschaupfad. Keine KI- oder GPU-Renderjobs in den Tests.
Release bauen: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-worker-release.ps1`.
Eine veröffentlichte Versionsnummer nicht wiederverwenden. ZIP zuerst, Manifest zuletzt veröffentlichen. Nur zwischen Jobs aktualisieren.

## Noch NICHT gelöst oder freigegeben

Die aktuelle Szenenbild-Erzeugung verwendet weiterhin Textbeschreibungen der Referenzfotos. Die Foto-Identität ist nicht zuverlässig garantiert. Die frühere direkte Ref2VA-Zuführung ist bewusst nicht blind wieder aktiviert worden: dabei waren Referenzkarten/Doppelungen aufgetreten. Lokale vorhandene Modelle wurden überprüft; ein fertiger, visuell abgenommener referenzkonditionierter Bild-Workflow ist noch offen.

Auch Stimmemotion und Lippensynchronität müssen anhand einer echten, hörbaren Szenenvorschau bewertet werden. Ein fehlerfreier technischer Mix ist noch keine inhaltliche Abnahme. Gaming-PC nicht als funktionierend bestätigt.

## Vereinbarter späterer Neulauf aller Episoden

1. Erst diese offenen Bild-/Tonprüfungen an einer kleinen Episode abschließen.
2. Datenbank und bisherige Storyboards/Resultate sichern; Geschichten, Besetzung, Fotos, Stimmen und Episoden-Stile behalten.
3. Jede Episode einzeln mit DeepSeek neu planen und validieren; keine alten Daten löschen, bevor der neue Plan erfolgreich vorliegt.
4. Erst Audio erstellen, dann referenztreue Szenenbilder und audio-geführte Videos. Musik separat über mehrere Szenen mischen.
5. Je Episode fertigstellen, MP4 technisch prüfen und Bild/Ton abnehmen. Jobs, Fehler und Ergebnislinks sichtbar halten.

Der Massen-Neulauf wurde mit dieser Änderung ausdrücklich noch nicht gestartet.
