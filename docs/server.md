# Server, NAS and multiplayer hosting

How to run OpenAlienNations on a server or NAS with Docker, and how friends reach a host over
the network or the internet.

Back to the [README](../README.md).

## Docker

A ready-made image is published for amd64 and arm64 as `ghcr.io/tknlg/openaliennations`. It
contains only the OpenAlienNations code and the HD interface pack, no game files. Mount your
game folder (the one containing `Data` and `Bin`) read-only at `/game`:

```
docker run -d --name openaliennations -p 8080:8080 \
  -v "/path/to/Alien Nations:/game:ro" \
  ghcr.io/tknlg/openaliennations
```

Then open `http://<server address>:8080/`.

### Docker Compose

```yaml
services:
  openaliennations:
    image: ghcr.io/tknlg/openaliennations
    ports:
      - "8080:8080"
    volumes:
      - "/path/to/Alien Nations:/game:ro"
      # - "/path/to/music:/music:ro"
    # environment:
    #   AN_MUSIC: /music
    #   AN_LANG: de
    restart: unless-stopped
```

### Ports, volumes and environment

| Setting | Value in the image | Notes |
|---|---|---|
| Port | `8080` (TCP) | the game and multiplayer use this one port. To use another port on the host, change the left side, e.g. `-p 9000:8080` |
| `/game` | volume | your game folder, mounted read-only (`:ro`) |
| `/music` | (optional) | a soundtrack folder, see below |
| `AN_GAME` | `/game` | set by the image |
| `AN_PORT` | `8080` | set by the image |
| `AN_HOST` | `0.0.0.0` | set by the image |
| `AN_MUSIC` | (unset) | e.g. `/music` |
| `AN_LANG` | (unset) | `de` or `en` |
| `AN_HD` | (unset) | a mounted folder with another HD pack, or an empty folder for none |

All variables are described in [options.md](options.md).

### Music in a container

With a soundtrack in another folder (for example a CD/Gold Edition install, whose music was
on the CD), add `-v "/path/to/music:/music:ro" -e AN_MUSIC=/music`. Which files are recognised:
see [install.md](install.md#music).

### Language in a container

The console texts follow the system language, and the container has none set, so it speaks
English. For German console texts add `-e AN_LANG=de` (Compose: `AN_LANG: de`). The game's
menus are not affected; they come from your game files.

### Unraid and other NAS

Unraid: add a container with this image, map port 8080 and a read-only path from your
Alien Nations folder (the one containing `Data` and `Bin`) to `/game`. Other NAS systems with
Docker work the same way: image `ghcr.io/tknlg/openaliennations`, port 8080, a read-only path
to `/game`.

### Building the image yourself

```
docker build -t openaliennations .
```

Release images are tagged `ghcr.io/tknlg/openaliennations:<version>` and `latest`
(see [release.md](release.md)).

## Multiplayer hosting

1. One player is the **host** and starts OpenAlienNations (the `.exe`, the Linux binary, or a
   Docker container). If Windows Firewall asks, allow access on private networks; singleplayer
   works either way.
2. The console window lists the addresses for friends, for example `http://192.168.1.20:8080/`.
   On Windows, keep that window open while you play; closing it stops the game server.
3. Friends open that address in their browser. They load everything, including the game files,
   from the host, so they **need nothing but a browser**.
4. In the game, the host opens a room in the multiplayer menu and the others join it.

As with the original game, every player is expected to own a copy of Alien Nations.

### How friends reach the host

- **Same network (LAN / Wi-Fi):** use the address shown.
- **Over the internet with a VPN** such as Tailscale, ZeroTier or Hamachi: everyone joins the same
  VPN, then use the host's VPN address (the console lists it as well).
- **Port forwarding:** forward the TCP port (default 8080) on the host's router to the host's
  computer, then friends use the host's public IP address.

To allow only the host's own computer (no friends), start with `--host 127.0.0.1`.

Saved games are stored per address, so friends who use a different address for the same host
see different saves; see [faq.md](faq.md#saves).
