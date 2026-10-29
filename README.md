# Natural 21

Casino blackjack in the browser. Runs entirely on GitHub Pages with no server or build step. Made by [4FDR Studios](https://4fdr.dev). Play chips only: no real money is ever wagered or paid out.

## Features

- **Real table rules, fully enforced and configurable:** 1, 2, 6 or 8 decks from a shoe with a cut card; dealer stands or hits on soft 17; blackjack pays 3 to 2 or 6 to 5; dealer checks for blackjack under an ace or ten; insurance and even money; double on any two cards, 9 to 11, or 10 and 11; double after split; split up to 2, 3 or 4 hands, with options for resplitting aces, hitting split aces and splitting unlike tens; late surrender. Presets for Las Vegas Strip, Downtown, Atlantic City and single deck 6 to 5.
- **Coach:** explains the basic strategy play for the exact table rules, with the dealer's bust chance and your own bust chance counted from the cards left in the shoe. It also advises on insurance and bet size from the count. Optional mistake alerts.
- **Points and count:** chips are your points. Session stats track net chips, wins, losses, pushes, blackjacks, biggest win and your strategy accuracy. The Count tab shows the Hi-Lo running and true count, decks left and how far into the shoe the dealer is, with an option to show the count on the table.
- **Solo vs Dealer:** play up to three hands at once. Your chips are saved on your device.
- **Pass & Play:** up to five players at one table, each with their own chips.
- **Play Online:** host a table for up to five and share the link or code. The host's browser deals, with a betting timer, a shot clock, chat and reconnecting.
- **Extras:** custom cards and chips, five felt colours, four card backs, four-colour deck, light/dark mode, sounds, fast dealing, round history, resume your table, and installable as an offline app.

## Put it on GitHub Pages

1. Create a repository, for example `blackjack`, and upload every file to its root (there are no folders).
2. **Settings > Pages**: Deploy from a branch, `main`, `/ (root)`.
3. The `CNAME` file points it at `blackjack.4fdr.dev`. In Cloudflare add a CNAME record for `blackjack` pointing to `<your-username>.github.io`.

## Files

```
index.html            page layout
style.css             styling, table and themes
rules.js              rules engine: shoe, dealing, insurance, splits, doubles, surrender, dealer play, payouts, basic strategy
art.js                original SVG cards, card backs, chips and icons
app.js                interface, game flow, coach, count tracker, pass and play, online tables
sw.js                 offline cache
manifest.webmanifest  install-as-app metadata
icon.svg              site icon
CNAME                 custom domain
.nojekyll             serve files as-is
```

## Keyboard shortcuts

H hit, S stand, D double, P split, R surrender, Enter deal, Shift+C show or hide the count.

The rules engine was stress-tested on 16,000 rounds across every preset with several players, checking that every chip is accounted for and the dealer always follows the house rule.
