Forum: forum.iobroker.net #84538 — reply to Reiner 0 (post #66, "Connection refused" tcp://127.0.0.1:42307 from iobroker.cameras)
Sprache: DE, NodeBB-Markdown. Stil: sachlich-technisch, keine AI-Marker.

---

Hallo Reiner,

das "Connection refused" ist kein Zertifikats- oder SSL-Problem (sonst käme ein TLS-Fehler, nicht ein abgewiesener TCP-Connect). Ursache ist, wie der lokale RTSP-Proxy bisher gearbeitet hat: Er hat seinen Port nur geöffnet, solange ein Livestream lief. iobroker.cameras holt sich das Bild aber in eigenen Intervallen. Fällt so ein Abruf in einen Moment, in dem der Stream gerade aus ist, ist der Port zu und ffmpeg meldet `Connection refused`. Nach jedem Adapter-Neustart, Privacy-Wechsel oder Ablauf einer Sitzung war der Port zudem wieder zu bzw. die Portnummer hatte sich geändert, weshalb die fest eingetragene `42307` irgendwann nicht mehr gepasst hat.

In v1.5.4 gibt es dafür eine saubere Lösung: eine neue Option "RTSP-Endpunkt dauerhaft erreichbar halten" unter Einstellungen → API-Anfragen / Energiesparen. Wenn aktiv, hält der Adapter den Port pro Kamera dauerhaft offen, auch wenn kein Livestream läuft. Die eigentliche Kamera-Sitzung wird erst dann aufgebaut, wenn iobroker.cameras sich verbindet, und nach einer kurzen Leerlaufzeit (Standard 60 s) ohne Verbindung wieder freigegeben. So ist der Endpunkt jederzeit erreichbar, ohne dauerhaft eine der 3 gleichzeitigen Sitzungen zu belegen.

Einrichtung:

1. Adapter auf v1.5.4 aktualisieren.
2. In den Adapter-Einstellungen "RTSP-Endpunkt dauerhaft erreichbar halten" einschalten und speichern.
3. `cameras.<id>.stream_host` / `stream_port` / `stream_path` in iobroker.cameras eintragen (Protokoll auf TCP stellen). Die drei Werte sind ab Adapter-Start gesetzt und bleiben über Neustarts stabil. `livestream_enabled` musst du dafür nicht mehr anfassen.

Falls du nicht updaten möchtest, ist der schnelle Workaround weiterhin: `cameras.<id>.livestream_enabled = true` setzen und dann den aktuell angezeigten `stream_port` (der ist nicht mehr 42307) in iobroker.cameras übernehmen. Das hält aber nur, solange der Stream läuft.

Gruß
