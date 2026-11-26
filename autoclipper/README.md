# ClipKit Auto Clipper

Watches Twitch chat for the streamers you pick and makes a Twitch clip when chat suddenly explodes
(a big jump in chat speed, emote spam like KEKW or Pog, or people typing "clip it").

Runs as a Cloudflare Worker with one Durable Object, on the free Workers plan.

## How it decides

- Learns each streamer's normal chat speed during the first minute after they go live, then keeps updating it.
- Clips when chat runs several times faster than normal and a good share of messages are hype emotes or words,
  or when several people ask for a clip.
- Waits between clips of the same streamer, and stops after a set number per stream.

## Twitch access

Uses Twitch's device sign-in, so no client secret is stored. Scopes: `user:read:chat`, `clips:edit`, `editor:manage:clips`.
Clips are made on the signed-in account. Twitch only lets apps download clips from channels the account is an editor for;
other clips can be downloaded from the Creator Dashboard (Content → Clips → Clips I've created).

## Deploy

Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick this repo,
set the root directory to `autoclipper`, and deploy. Then open the workers.dev link it gives you.
