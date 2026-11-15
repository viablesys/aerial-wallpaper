# The Aerial video library

The videos are **not** in this repo and never will be: they are Apple's footage, about 45 GB, and every
machine downloads its own copy from Apple. This file is everything an agent needs to build, check and
curate the library that `bin/wall-aerial` plays. Install of the extension itself: CLAUDE.md.

## Where it lives

Fixed paths; `wall-aerial` and `aerial-fetch` hard-code them.

```
~/Videos/aerial/
  Space/        22 videos   ~5.4 GB
  Underwater/   21 videos   ~7.2 GB
  Cities/       30 videos   ~11 GB
  Landscapes/   41 videos   ~22 GB     (114 videos, ~45 GB in all, from the 2022 catalogue)
  .meta/
    entries.json           the catalogue (from Apple's resources archive)
    resources.tar          that archive, kept as fetched
    default                the default playlist name, one line (optional)
    playlists/NAME.txt     playlists (optional)
    skip.txt               videos never to play (optional)
    played.log             appended by bin/log-played.lua on every video start
```

Each video is `~/Videos/aerial/<Category>/<Label> [<shotID>].mov`, e.g.
`Underwater/Costa Rica Dolphins [A009_C007].mov`. The shot ID in brackets is what playlists and the
skip list match; the label is Apple's `accessibilityLabel` with characters other than letters, digits,
space and `-` replaced by `_`.

Sizes and counts above are one machine's library on 2026-11-14 with catalogue `version` 1; re-check with
`du -sh ~/Videos/aerial/*/` rather than trusting them.

## Building it

```sh
bin/aerial-fetch                    # everything, Space and Underwater first
bin/aerial-fetch Space Underwater   # only these categories (the darkest; best on a projector)
```

What it does:

1. If `.meta/entries.json` is missing, downloads `https://sylvan.apple.com/Aerials/resources-16.tar`
   (tvOS Aerial resources, ~2 MB) into `.meta/resources.tar` and extracts `entries.json`.
2. For each asset, downloads the `url-4K-SDR` variant (HEVC) with curl to `<name>.mov.part` and renames it
   when complete. Existing `.mov` files are skipped, so an interrupted run resumes; a stray `.part` is
   re-downloaded. It prints `ok` or `FAIL` per video; re-run to retry failures.

Notes:
- `sylvan.apple.com`'s certificate chain does not validate with curl, so both downloads use `curl -k`.
  That is a known trade-off for public video files; don't extend it to anything else.
- The full run is ~45 GB from Apple's CDN: check free space (`df -h ~`) and ask the user before starting
  it on a metered or slow link. One category is a reasonable first test.
- `entries.json` also lists `url-4K-HDR`, `url-1080-SDR`, `url-1080-HDR` and `url-1080-H264` variants.
  The player is set up for 4K SDR; HDR needs a display pipeline this project doesn't configure.
- Newer catalogues may exist (`resources-17.tar` and up); `resources-16` is the one this was built and
  tested with. If Apple moves the URLs, the archive is the thing to find again.

## Checking it

```sh
for d in ~/Videos/aerial/*/; do echo "$(basename "$d") $(ls "$d" | grep -c '\.mov$')"; done
find ~/Videos/aerial -name '*.part'                    # unfinished downloads
python3 -c "import json,os; e=json.load(open(os.path.expanduser('~/Videos/aerial/.meta/entries.json'))); print(len(e['assets']), 'assets')"
mpv --frames=60 --no-audio --vo=null "$(ls ~/Videos/aerial/Space/*.mov | head -1)"   # decodes?
```

Playback needs an mpv whose ffmpeg decodes HEVC (the decode test above shows it; on Fedora, RPM Fusion's
ffmpeg is one way to get it) and works best with hardware decoding (`wall-aerial` passes `--hwdec=auto-safe`; `aerial-wallpaper status` and
mpv's `hwdec-current` property show what was picked).

## Choosing what plays

`wall-aerial` takes one argument, or reads it from settings:

| Argument | Plays |
|---|---|
| `NAME` with `.meta/playlists/NAME.txt` present | the shot IDs listed there, from all categories |
| `Space`, `Underwater`, `Cities`, `Landscapes` (one or more on the command line; one in the `playlist` setting) | whole categories |
| `all` | everything |
| nothing | `.meta/default` (a playlist name or categories), else everything |

In wallpaper mode the argument comes from the extension: the monitor's `playlist` setting (global or per
monitor, see CLAUDE.md), which takes either a playlist name or a category. Everything is shuffled and
looped.

Playlist file: one shot ID per line, exactly as in the brackets of the file name; `#` starts a comment.

```
# deepsea: dolphins, sharks and other sea life (Underwater). One shot ID per line.
# Dolphins
B002_C011  # California Dolphins
A009_C007  # Costa Rica Dolphins
```

To find shot IDs: `ls ~/Videos/aerial/Underwater/`, or the catalogue:
`python3 -c "import json,os; [print(a['shotID'], a['accessibilityLabel']) for a in json.load(open(os.path.expanduser('~/Videos/aerial/.meta/entries.json')))['assets']]"`.
Playlist matching looks for the literal `[ID]` in the path, so IDs must be exact and complete.

`skip.txt`, same format, removes videos everywhere (playlists and categories). It matches any fixed
fragment of the path, so a shot ID or part of a label both work. Use it for clips that look
bad on the user's display; note why and when in the comment, e.g. `A006_C003  # flickers (2026-11-11)`.
Skips are display-specific: don't copy another machine's list.

`played.log` (`time<TAB>path` per start) answers "what was that?" after the fact; in wallpaper mode each
monitor's current video is also in `$XDG_RUNTIME_DIR/aerial-wallpaper/now-<monitor>` and
`aerial-wallpaper now --monitor M`.

## Ground rules for agents

- Never add videos, `entries.json` or `resources.tar` to git. `.meta` contents are per machine
  (playlists, skip list and logs reflect one user's display and taste); ask before copying them anywhere.
- Don't delete videos to make room without asking; re-downloading is ~45 GB.
- Curate with playlists and `skip.txt`, not by moving or renaming files: names carry the shot IDs that
  everything matches on, and `aerial-fetch` re-downloads anything missing.
