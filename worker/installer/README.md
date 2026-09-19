# FrameCut Worker Installer

Windows-Bootstrap für zusätzliche GPU-Worker. Der Installer wird auf dem Render-PC gestartet und verbindet sich ausgehend mit FrameCut; am Render-PC muss kein Port geöffnet werden.

```text
Install-FrameCutWorker.bat
```

Der Benutzer gibt einen einmaligen, kurzlebigen Registrierungscode ein. Danach lädt der Installer das versionierte Worker-Archiv vom Server, prüft die SHA-256-Prüfsumme, verschlüsselt das Worker-Token mit Windows DPAPI und richtet den Autostart ein.

Der Server muss dafür liefern:

- `GET /api/worker/installer/manifest` → `version`, `downloadUrl`, `sha256`, `entrypoint`
- `POST /api/worker/register` → `workerId`, `workerToken`

MiniMax-/ComfyUI-Modelle gehören nicht in das Worker-Archiv. Sie werden lokal über Pinokio installiert bzw. heruntergeladen.
