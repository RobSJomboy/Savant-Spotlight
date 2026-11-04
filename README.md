# Savant Spotlight

Baseball Savant graphics for any big leaguer, for Talkin' Baseball. A control page drives a
1920×1080 OBS display, and the graphic sits in the safe area between Trev's and Jake's cams.

- **Control:** `control.html` (pick a player, pick a graphic, put it on air)
- **Display:** `display.html?room=…` (OBS Browser Source; **Copy OBS URL** on the control page builds it)

## Graphics

**Pitchers:** Overview (card + movement) · Percentile card · Arsenal table · Pitch movement
(pitcher's view, arm angle) · Location heat maps per pitch · Velocity ridgelines · Pitch mix by count

**Hitters:** Overview (card + spray) · Percentile card · Spray chart · Hot zones (xwOBA / AVG /
EV / whiff / swing %) · Exit velo × launch angle · Flight paths · Bat tracking

**Both:** Stats — the season line, career totals, or season by season (gold = career best), from
MLB StatsAPI. **Auto-rotate** flips season ↔ career (optionally season by season too) every 10, 12
or 15 seconds, with a gold timer bar; the display keeps the clock, so it rotates even if the control
page is closed.

**Auto-cycle:** tick it to step through the graphics on a timer (10 seconds by default, 3–120). The
"in the loop" checkboxes pick which graphics it walks; the one on air gets a red dot in the control
page. Clicking a graphic while it's cycling jumps the loop there. Like the stats rotation, the display
keeps the clock and preloads every graphic in the loop, so each one lands without a spinner.

**Compare:** tick Compare, then the list fills slot A or B (⇄ swaps). Two headers with a VS badge;
Percentiles/Overview become a mirrored head-to-head card, Stats becomes a tale of the tape (gold =
better), and every other graphic runs side by side. A pitcher vs a hitter works too — each half shows
what fits its player.

Filters where they apply: opponent hand, pitch outcome (all / whiffs / strikeouts / hard-hit),
batted-ball type (all / hits / XBH / HR), zone stat. Season picker back to 2015. **Auto** uses this
season unless the player barely played, in which case it uses last season.

Every row in the header shows season and career stat lines from MLB StatsAPI.

## Data

Nothing ships with the app. Both pages fetch live data:
- **MLB StatsAPI:** every player this season, the free-agent feed, and stat lines
- **Savant leaderboards:** percentiles, custom stats, pitch arsenal, sprint speed, arm, OAA, and
  bat tracking, one set per season
- **Statcast search:** every pitch for the selected player and season (about 1–2MB, ~5s cold,
  cached after that)

Savant's percentile card only ranks qualified players. A part-timer with 100+ PA (or 80+ batters
faced) gets his real number ranked against the qualified pool. Those rows are marked `*`.

The display renders even while off air, so the next player's data is already loaded when he goes up.

## Transport

The Jomboy Cloudflare relay (`/r/<room>`, WebSocket plus a 30s poll) plus BroadcastChannel.
The wire only carries the player id, graphic and options.
