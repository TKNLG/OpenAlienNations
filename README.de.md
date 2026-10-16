[English](README.md) · **Deutsch**

# OpenAlienNations

OpenAlienNations ist ein Open-Source-Nachbau des Strategiespiels **Die Völker** (englisch:
**Alien Nations**) von 1999, der in deinem Webbrowser läuft. Du spielst damit die Kampagnen,
Tutorials und das Endlosspiel des Originals, die Insel-Kampagnen und Schiffe des **Addons der
Gold-Edition** und im **Mehrspielermodus** mit Freunden im Browser, auf Wunsch mit einer
schärferen **HD-Oberfläche**.

Es ist **nicht** das Spiel selbst und enthält **keine Spieldateien**: Es verwendet die Dateien
deiner eigenen installierten Version von Die Völker / Alien Nations.

**Stand:** sehr nah am Original, einschließlich seiner Eigenheiten. Wenn sich etwas anders
spielt als im Original, [melde es bitte als Issue](../../issues).

## Was du brauchst

- **Die Völker / Alien Nations installiert** auf deinem Computer: die GOG-Version oder die
  Original-CD / Gold-Edition.
- **Windows** oder **Linux** (64 Bit, x86). Oder etwas, auf dem **Docker** läuft (Server / NAS).
- Einen **aktuellen Webbrowser** (Chrome, Edge, Firefox, Safari).

## Grundspiel und Addon der Gold-Edition

OpenAlienNations funktioniert mit dem **Grundspiel allein** und mit der **Gold-Edition**
(Grundspiel + Addon). Du gibst immer **einen Spielordner** an: den Ordner, der den Ordner `Data`
(mit der Datei `dv.gd` darin) und den Ordner `Bin` enthält. Groß- und Kleinschreibung der
Ordner- und Dateinamen spielt keine Rolle (`Data` oder `data`, `Bin` oder `bin`).

| Was du hast | Was du als Spielordner wählst | Was du bekommst |
|---|---|---|
| GOG-Version (z. B. `C:\GOG Games\Alien Nations`) | diesen Ordner | Grundspiel mit Musik. Die GOG-Version enthält das Addon nicht. |
| CD-Version (Grundspiel) | den Installationsordner | Grundspiel; Musik siehe unten |
| Gold-Edition (Grundspiel + Addon auf einer CD) | den Installationsordner der Gold-Edition | Grundspiel **und** Addon; Musik siehe unten |

**Wann erscheinen die Addon-Menüs?** Wenn der Ordner `Data` im Spielordner die Addon-Dateien
enthält (`Addon.odb`, `Addon.gd`, `Addon.od`, `Addon.tdb`, `addon.wdb`, die Missions- und
Kartendateien `...AO.mdb` / `...AO.dvm`). Eine Gold-Edition-Installation hat sie alle. Dann zeigt
das Einzelspieler-Menü die „Addon Kampagnen“, und die Einstellungen für Endlosspiel und
Mehrspieler bekommen einen Schalter „Addon:“ für die Inselwelt. Ohne diese Dateien sehen die
Menüs aus wie im Grundspiel, alles andere funktioniert ganz normal.

Grundspiel und Addon müssen im **selben** Ordner liegen: Nimm einfach den Installationsordner
der Gold-Edition. Nur die Addon-Dateien in einen GOG-Ordner zu kopieren, wird nicht unterstützt,
weil die Gold-Edition auch eigene Fassungen einiger Grundspiel-Dateien hat (zum Beispiel die
Menügrafiken).

**Musik.** Das Spiel sucht den Soundtrack in dieser Reihenfolge:

1. `Bin/music/Track02.ogg` … `Track11.ogg` im Spielordner. Die GOG-Version hat diese Dateien.
2. Den Ordner, der mit `--music <Ordner>` (oder der Umgebungsvariable `AN_MUSIC`) angegeben ist.
   Die Dateien darin werden an ihrer Titelnummer erkannt, zum Beispiel `Track02.ogg`,
   `track2.flac` oder `02 - Titel.mp3`; Formate `.ogg`, `.mp3`, `.flac` oder `.wav`. Verwendet
   werden die Titel 2 bis 11.
3. Die Windows-`.exe` und der Linux-Download finden außerdem selbst den Ordner `Bin/music` einer
   anderen Installation auf demselben Computer (zum Beispiel eine GOG-Version neben der
   Gold-Edition) und merken ihn sich.

Die CD-Version und die Gold-Edition haben ihre Musik direkt von der CD abgespielt (Audiotitel),
deshalb liegen in ihrem Installationsordner keine Musikdateien. Installiere entweder zusätzlich
die GOG-Version, oder lies die Audiotitel 2–11 der CD in einen Ordner aus und gib ihn mit
`--music` an. Ohne Musik läuft das Spiel ganz normal, nur ohne Hintergrundmusik.

## Herunterladen und spielen

Die neueste Version gibt es auf der Seite [Releases](../../releases).

### Windows

1. Lade `OpenAlienNations-<Version>-windows-x64.exe` herunter und doppelklicke darauf.
2. Die Datei ist nicht signiert, daher warnt Windows SmartScreen eventuell vor einer
   „unbekannten App“. Klicke auf **Weitere Informationen** und dann auf **Trotzdem ausführen**.
3. Beim ersten Start fragt das Programm nach deinem Spielordner. Wurde eine Installation
   gefunden, ist sie schon ausgewählt; sonst wähle den Ordner, der `Data` und `Bin` enthält.
4. Dein Browser öffnet sich mit dem Spiel. Ein Konsolenfenster zeigt die Adressen an. **Lass
   dieses Fenster offen, solange du spielst**; wenn du es schließt, wird der Spielserver beendet.
5. Wenn die Windows-Firewall fragt: Erlaube den Zugriff in privaten Netzwerken, wenn du mit
   anderen spielen willst (Einzelspieler funktioniert so oder so).

### Linux (x64)

```
tar xzf OpenAlienNations-<Version>-linux-x64.tar.gz
./OpenAlienNations
```

Beim ersten Start fragt das Programm nach deinem Spielordner, mit einem Dialog (zenity oder
kdialog) oder im Terminal. Eine Wine- oder Lutris-Installation geht auch, z. B.
`~/.wine/drive_c/GOG Games/Alien Nations`. Danach öffnet sich dein Browser mit dem Spiel.

### Spielordner ändern

Deine Auswahl wird gespeichert, beim nächsten Start geht es also direkt ins Spiel:

- Windows: `%APPDATA%\OpenAlienNations\config.json`
- Linux: `~/.config/openaliennations/config.json`
- macOS: `~/Library/Application Support/OpenAlienNations/config.json`

Um neu zu wählen, starte das Programm einmal mit `--setup`, zum Beispiel
`OpenAlienNations.exe --setup` in der Eingabeaufforderung oder `./OpenAlienNations --setup`.
(Ältere Versionen haben die Auswahl in einem Ordner `AlienNations` gespeichert; sie wird
automatisch übernommen.)

## Mit Freunden spielen (Mehrspieler)

1. Ein Spieler ist der **Gastgeber** und startet OpenAlienNations wie oben beschrieben.
2. Das Konsolenfenster zeigt die Adressen für Freunde an, zum Beispiel `http://192.168.1.20:8080/`.
3. Die Freunde öffnen diese Adresse in ihrem Browser. Sie laden alles, auch die Spieldateien,
   vom Gastgeber, und **brauchen daher nur einen Browser**.
4. Im Spiel eröffnet der Gastgeber im Mehrspieler-Menü einen Raum, die anderen treten bei.

So erreichen die Freunde den Gastgeber:

- **Im selben Netzwerk (LAN / WLAN):** die angezeigte Adresse verwenden.
- **Übers Internet mit einem VPN** wie Tailscale, ZeroTier oder Hamachi: Alle treten demselben
  VPN bei und verwenden die VPN-Adresse des Gastgebers (die Konsole zeigt sie ebenfalls an).
- **Portweiterleitung:** Am Router des Gastgebers den TCP-Port (Standard 8080) an dessen
  Computer weiterleiten; die Freunde verwenden dann die öffentliche IP-Adresse des Gastgebers.

Wie beim Originalspiel wird erwartet, dass jeder Spieler eine eigene Version von
Die Völker / Alien Nations besitzt.

## Optionen

Alle Optionen funktionieren mit der Windows-`.exe`, dem Linux-Programm und
`node dist/server.mjs`. Die meisten lassen sich auch über eine Umgebungsvariable setzen.

| Option | Umgebungsvariable | Was sie bewirkt |
|---|---|---|
| `--game <Ordner>` | `AN_GAME` | dein Spielordner (der mit `Data` und `Bin`); die Frage nach dem Ordner entfällt |
| `--music <Ordner>` | `AN_MUSIC` | Soundtrack-Ordner, wird verwendet, wenn der Spielordner kein `Bin/music` hat (siehe oben) |
| `--hd <Ordner>` | `AN_HD` | das HD-Oberflächenpaket aus diesem Ordner statt des eingebauten verwenden |
| `--port <n>` | `AN_PORT` | Netzwerk-Port (Standard 8080). Ohne diese Option wird der nächste freie Port genommen, wenn 8080 belegt ist; mit ihr muss genau dieser Port frei sein |
| `--host <Adresse>` | `AN_HOST` | Adresse, auf der der Server lauscht. Standard `0.0.0.0` = dieser Computer und dein Netzwerk; `127.0.0.1` = nur dieser Computer |
| `--setup` oder `--reset` | | den Spielordner neu wählen |
| `--no-browser` | | den Browser nicht automatisch öffnen |
| `--open` | | den Browser öffnen (ein einfacher Start mit `node dist/server.mjs` tut das sonst nicht) |
| `--lang de` / `--lang en` | `AN_LANG` | Sprache der Konsole und der Dialoge (Standard: die Systemsprache) |
| `--version` | | die Version anzeigen |
| `--help` | | alle Optionen auflisten |

Bei der `.exe` und dem Linux-Programm öffnet sich der Browser automatisch, außer du gibst
`--no-browser` oder `--host` an oder es gibt keinen Desktop (zum Beispiel über SSH).

## Einstellungen im Spiel, die man kennen sollte

- **HD-Oberfläche:** Einstellungen → Grafik → **HD-Grafik** schaltet die hochskalierten Menüs
  und Seitenleisten ein oder aus.
- **Erweiterte Optionen:** Einstellungen → **Erweitert** enthält optionale Komfortfunktionen, die
  vom Original abweichen (Auswahlringe, flüssige Bewegung, Cursor-Hinweise,
  Berater-Warteschlange). Alle sind standardmäßig aus; aus bedeutet genau das Verhalten des
  Originals.

## Server / NAS (Docker)

Ein fertiges Image gibt es für amd64 und arm64. Binde deinen Spielordner schreibgeschützt unter
`/game` ein:

```
docker run -d --name openaliennations -p 8080:8080 \
  -v "/pfad/zu/Alien Nations:/game:ro" \
  -e AN_LANG=de \
  ghcr.io/tknlg/openaliennations
```

Dann `http://<Serveradresse>:8080/` öffnen. Liegt der Soundtrack in einem anderen Ordner, ergänze
`-v "/pfad/zur/musik:/music:ro" -e AN_MUSIC=/music`. `-e AN_LANG=de` sorgt für deutsche Texte in
der Konsole (ohne spricht der Container Englisch).

Docker Compose:

```yaml
services:
  openaliennations:
    image: ghcr.io/tknlg/openaliennations
    ports:
      - "8080:8080"
    volumes:
      - "/pfad/zu/Alien Nations:/game:ro"
      # - "/pfad/zur/musik:/music:ro"
    environment:
      AN_LANG: de
      # AN_MUSIC: /music
    restart: unless-stopped
```

Unraid: Einen Container mit diesem Image anlegen, Port 8080 zuordnen und einen schreibgeschützten
Pfad von deinem Spielordner nach `/game`. Das Image selbst bauen: `docker build -t openaliennations .`

## Spielstände

Spielstände werden **in deinem Browser** gespeichert (IndexedDB), getrennt für jeden Browser und
jede Adresse. `http://localhost:8080/` und `http://192.168.1.20:8080/` (oder ein anderer Port)
gelten als verschiedene Adressen mit eigenen Spielständen, und wenn du die Websitedaten des
Browsers löschst, sind sie weg.

Für eine Sicherung oder um Spielstände in einen anderen Browser oder auf einen anderen Computer
mitzunehmen: Im Menü **Spiel laden** lädt **Exportieren** einen Spielstand als `.ansave`-Datei
herunter, und **Importieren** liest ihn wieder ein.

## Wenn etwas nicht klappt

- **„Port 8080 ist schon belegt“:** Ein anderes Programm (oder ein zweites OpenAlienNations)
  benutzt ihn. Ohne `--port` wird automatisch der nächste freie Port genommen; mit `--port` einen
  anderen wählen, z. B. `--port 9000`.
- **Firewall-Frage unter Windows:** Für Mehrspieler private Netzwerke erlauben; Einzelspieler
  geht auch ohne.
- **Keine Musik:** siehe [Musik](#grundspiel-und-addon-der-gold-edition) oben; mit
  `--music <Ordner>` starten.
- **Addon-Menüs fehlen:** Der gewählte Spielordner muss die Gold-Edition-Installation sein, mit
  den `Addon.*`-Dateien in ihrem Ordner `Data`. Mit `--setup` einen anderen Ordner wählen.
- **„Kein Alien-Nations-Ordner“:** Wähle den Ordner, der `Data` (mit `dv.gd`) und `Bin` enthält,
  nicht einen Ordner darin.
- **Spielstände sind weg:** Prüfe, ob du dieselbe Adresse mit demselben Port geöffnet hast wie
  vorher (siehe [Spielstände](#spielstände)).
- **SmartScreen-Warnung:** Der Download ist nicht signiert; **Weitere Informationen** →
  **Trotzdem ausführen**.

## Für Entwickler

Voraussetzung: Node.js 22 oder neuer; sonst keine Abhängigkeiten.

```
node build.mjs                                           # nach dist/ bauen
node dist/server.mjs --game "/pfad/zu/Alien Nations"     # starten, dann http://localhost:8080/ öffnen
npx -p typescript@5.6.3 tsc -p .                         # Typprüfung
npm test                                                 # Tests
```

Die datenabhängigen Tests brauchen `AN_DATA=<Spiel>/Data` und `AN_GOLD=<Gold-Edition>/data`;
ohne sie werden sie übersprungen. Release-Builds: [docs/release.md](docs/release.md).

**Clean-Room-Regel:** Das Originalprogramm wird nur analysiert, um Spezifikationen in normaler
Sprache in [`docs/`](docs/) zu schreiben; der Code entsteht nur aus diesen Dokumenten, nie aus
dekompiliertem Code. Analysematerial (`re/`) und Spieldateien werden nie veröffentlicht.

Der Einstieg ist [CLAUDE.md](CLAUDE.md) (Regeln und Werkzeuge) und
[docs/status.md](docs/status.md) (Projektstand, offene Punkte, Funktionsübersicht); die
Entwicklerdokumentation ist auf Englisch. Beiträge sind willkommen: Fehler und Abweichungen vom
Original bitte als [Issue](../../issues) melden, Korrekturen als Pull Request schicken.

## Lizenz und Rechtliches

- Code und Dokumentation von OpenAlienNations stehen unter der
  **GNU General Public License v3.0 oder neuer** ([LICENSE](LICENSE)).
- Das Projekt enthält **keine Spieldateien**. Du brauchst deine eigene Originalversion des Spiels.
- „Alien Nations“ und „Die Völker“ sind Marken ihrer jeweiligen Inhaber. OpenAlienNations ist
  ein unabhängiges Fanprojekt und steht in keiner Verbindung zu ihnen und wird nicht von ihnen
  unterstützt.
- Das **HD-Oberflächenpaket** in `hd/` ist aus den Oberflächengrafiken des Originalspiels
  hochskaliert und fällt daher **nicht** unter die GPL; es gilt das Urheberrecht der
  ursprünglichen Rechteinhaber. Es liegt nur bei, damit Besitzer des Spiels es nutzen können,
  und lässt sich abschalten oder entfernen.

Einzelheiten (englisch): [NOTICE](NOTICE).
