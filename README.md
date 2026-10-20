# The Great Lynn Paint Off

Live 3-round painting contest at https://paintoff.sebland.com — built for Edwin.

- Rounds 1 and 2: 5–6 painters each. The audience votes after each round; the top 2 of each go to the Final (4 painters).
- The Final: the audience votes the champion.
- Bidding: anyone joined can pledge on any canvas in the current round while bidding is open. Each bid must beat the current high by the min raise. **Pledges only — no payment processing.**

## Views

| Path | Who | What |
|------|-----|------|
| `/` | anyone | create an event (host link saved in this browser) |
| `/h/<id>?k=<hostToken>` | host | lineup, photos, run of show, tie-breaks, bid log, bidding rules |
| `/e/<id>` | audience (phone) | join with a name, vote once per round, bid |
| `/s/<id>` | projector | round grid, bids ticker, QR, bracket strip, champion reveal |
| `/b/<id>` | anyone | full bracket |

## Round lifecycle

`pending → painting (bidding open) → voting → closed (results, advancers suggested; tie flag if the cut line is tied) → done`.
The host can reopen voting, toggle bidding, toggle live vote bars, remove a bid, and pick advancers by hand.
Vote counts stay hidden from the audience until voting closes unless the host turns on live bars.

## Stack

Bun (`server.ts`): HTTP API + WebSocket fan-out (`pub:<id>` / `host:<id>` topics). State is one JSON row per event in SQLite at `./data/artbattle.db`; photos in `./data/photos/`. Both survive restarts (bind mount). Vanilla JS client in `public/`.

One vote per device per round: a random device id in localStorage + cookie, enforced server-side. Clearing site data gives a new id, so this is honest-crowd protection, not fraud-proof.

## Run

```bash
docker compose up -d --build     # host port 20084, Caddy: paintoff.sebland.com
/root/seb/scripts/cf-purge
```
