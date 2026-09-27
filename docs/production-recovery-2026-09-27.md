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

Szenenvertrag v5 / Worker 2026.09.27.4 ersetzt Text-only-Guides bei ausgewählten Referenzen durch einen getrennten Ref2VA-Szenenbildschritt. Jede Datei wird frisch geladen und gegen ihren SHA-256 geprüft. Explizite Picture-Bindungen ordnen mehrere Fotos derselben Figur zu. Aus 22 unabhängig erzeugten Frames wird der letzte als Szenenbild gespeichert. Erst dieses Bild geht in den folgenden I2V-Schritt mit externer Audio-Führung; die Porträts gehen niemals in dessen Eingänge. Ohne Referenzen bleibt Text-to-Image möglich. Bei Referenzen gibt es keinen stillen Text-only-Fallback. Alte Worker werden vor der Jobübernahme abgewiesen, statt Aufträge zu verbrauchen. Auch eine alte StripAudio=false-Einstellung darf keinen Modellton mehr ausliefern.

Lokaler GPU-Test am 27.09.2026: zwei tatsächliche Bibliotheksfotos (Leo 64, Opi 81), zunächst handgeschriebener und anschließend durch buildSceneContract generierter Prompt. Beide Szenenbilder zeigten genau einen Leo und einen erwachsenen Opi ohne weiße Referenzkarten. Der zweite Durchlauf wurde zu 3,75 Sekunden Video animiert, mit vorhandener deutscher Leo-Dialogspur dialogue-147-78 als Audio-Führung. Der Testmix übernimmt ausschließlich diese WAV, nicht den Modellton: H.264 608x352 + Stereo-AAC 48 kHz; mean -22,9 dB, peak -4,7 dB. Acht Stichprobenframes zeigten stabile Besetzung, keinen Referenzfoto-Auftakt und Mundbewegungen nur bei Leo. Das ist eine begrenzte Regression, keine Garantie für jede Besetzung. Daniel/Polo, komplexe Mehrpersonen-Szenen, exakte Lippensynchronität und Stimmemotion bleiben Abnahmefälle. Die Hintergrund-Heuristik erkennt keine beliebigen Doppelgänger; die Sichtprüfung bleibt erforderlich.

Testdateien und Workflows lokal: pinokio_agent/skills/api/minimax-h3-pinokio.git/output/local/reference-test-20260927 (außerhalb des Repositorys). Testvideo: leo-opi-test-mit-dialog.mp4. Automatisierte Prüfungen: 37 Node-Tests und 4 Python-Adaptertests. Keine Neuberechnung alter Episoden und keine Löschung vorhandener Ergebnisse.

Live-Bestätigung: Laptop-Update auf .4 um 17:22 Uhr, anschließend Job 2495 mit drei frisch geladenen Fotos. Dessen finaler I2V-Graph enthält null reference_-Nodes und eine Audio-Führung. Der neue Szenenguide zeigt Leo und Polo ohne weiße Karte; der ebenfalls referenzierte Chronobot ist darin nicht sichtbar. Der dynamische Szenentext beschreibt sein Verschwinden durch eine Lüftung. Als nächster Qualitätsschritt ist deshalb die Trennung von Anfangskomposition und späterer Handlung zu prüfen; ein letzter Frame der kurzen Komposition kann sonst schon den Endzustand zeigen. Keine Freigabe für einen pauschalen Neulauf. Das Bild ist unter .inspection/job-2495-reference-keyframe.png lokal gesichert.

GitHub: Code auf codex/reference-keyframes-v5 hochgeladen. Kommentar zu Issue #82 wegen fehlender Issues-Schreibrechte des vorhandenen Tokens abgewiesen; Issue nicht geschlossen.

Auch Stimmemotion und Lippensynchronität müssen anhand einer echten, hörbaren Szenenvorschau bewertet werden. Ein fehlerfreier technischer Mix ist noch keine inhaltliche Abnahme. Gaming-PC nicht als funktionierend bestätigt.

## Vereinbarter späterer Neulauf aller Episoden

1. Erst diese offenen Bild-/Tonprüfungen an einer kleinen Episode abschließen.
2. Datenbank und bisherige Storyboards/Resultate sichern; Geschichten, Besetzung, Fotos, Stimmen und Episoden-Stile behalten.
3. Jede Episode einzeln mit DeepSeek neu planen und validieren; keine alten Daten löschen, bevor der neue Plan erfolgreich vorliegt.
4. Erst Audio erstellen, dann referenztreue Szenenbilder und audio-geführte Videos. Musik separat über mehrere Szenen mischen.
5. Je Episode fertigstellen, MP4 technisch prüfen und Bild/Ton abnehmen. Jobs, Fehler und Ergebnislinks sichtbar halten.

Der Massen-Neulauf wurde mit dieser Änderung ausdrücklich noch nicht gestartet.
