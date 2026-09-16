# Letting other people reach the studio

The studio was built for one person on one laptop. It answers on `127.0.0.1`,
and that was not a limitation anybody worked around — it was the security model.

Everything in this file is about what has to change before that stops being
true, and the honest summary is: **anybody who can sign in can spend your money
and publish to production under your brand.** There is no read-only mode. Plan
around that rather than hoping nobody presses anything.

---

## What the studio can do, so you know what you are handing out

| | |
|---|---|
| Start a run | £0.85 to £2.29 of model and speech spend, per press |
| Approve and render | The irreversible half of the spend |
| Publish | To `api.audiovibe.co`, under your channel, visible to everybody |
| Unpublish | Deletes a live episode |
| Read `accounts.json` | Never served, but it is on the same disk |

A person who should only *look* at things cannot currently be given only that.
If somebody needs read-only, say so and it is worth building; do not solve it by
hoping.

---

## Do not open a port

Port-forwarding your router to 4317 puts a machine on your desk on the public
internet, addressed by IP, with one password in front of it. Every option below
is easier than that and none of them require an inbound port at all.

---

## Option 1 — Tailscale (recommended)

A private network between your machines. **Nothing is exposed to the internet**:
your co-founders reach the studio because they are on your tailnet, not because
the studio has a public address.

```bash
# On this machine, once
winget install tailscale.tailscale
tailscale up

# Each co-founder installs Tailscale and you invite them to the tailnet
```

Then start the studio listening on the tailnet:

```bash
FOUNDRY_HOST=0.0.0.0 npm run foundry -- studio
```

They visit `http://<your-machine-name>:4317`.

Best where the audience is three people you know. No DNS, no certificates, no
public surface, and revoking somebody is removing them from the tailnet.

The one caveat: it is `http` inside the tailnet, so the session cookie is not
sent over TLS. Tailscale encrypts the link itself, so this is fine — but see
"the cookie" below if you use anything else.

---

## Option 2 — Cloudflare Tunnel with Access

A real `https://` address, gated by Google sign-in on a named list of emails,
with **no inbound port**. The tunnel dials out from your machine.

```bash
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create foundry
cloudflared tunnel route dns foundry foundry.audiovibe.co

# Point it at the studio
cloudflared tunnel run --url http://127.0.0.1:4317 foundry
```

Then in the Cloudflare dashboard, **Zero Trust → Access → Applications**, add
`foundry.audiovibe.co` with a policy allowing your co-founders' email addresses.

**Do the Access policy before the DNS record resolves.** A tunnel without a
policy is your studio on the open internet with one password in front of it,
which is the thing this option exists to avoid.

With Access in front, the studio's own password is a second lock rather than the
only one.

---

## Before either: name the people

A shared password cannot say who published something. Set named operators:

```bash
FOUNDRY_USERS=anant:a-long-password-here,sam:another-long-one
```

`FOUNDRY_ADMIN_PASSWORD` still works on its own for a single-person studio and
signs you in as `operator`.

With names, the run journal records who did what:

```
started by sam
approved in the studio by anant
approved for 2026-09-17T07:00:00.000Z by anant
published by sam
```

That is the entire reason names exist. It is not access control — everybody can
do everything — it is being able to answer "who published that" afterwards.

### Passwords

Twelve characters minimum, enforced only when `FOUNDRY_HOST` is not loopback,
because a minimum on a laptop-only server is theatre. The studio refuses to
start otherwise, rather than starting and being weak.

Changing any password signs everybody out, which is what removing somebody is
asking for.

---

## The cookie

The session cookie is marked `Secure` automatically whenever `FOUNDRY_HOST` is
not loopback. Over plain `http` on a public address, a `Secure` cookie is never
sent — so **the studio will appear to reject every sign-in if you expose it
without TLS.** That is deliberate: the alternative is a session token travelling
in clear to anybody on the path, and whoever reads it can publish as you.

Tailscale and Cloudflare Tunnel both solve this. Exposing `FOUNDRY_HOST=0.0.0.0`
straight to the internet over `http` does not.

---

## Guessing

Eight wrong passwords from one source and it stops answering that source for
fifteen minutes, then forgets. Behind a tunnel the socket address is the
tunnel's, so `cf-connecting-ip` and `x-forwarded-for` are read first.

Deliberately not a lockout on the account: that would let a stranger lock your
co-founder out.

---

## Keeping it running

The studio is one `ts-node` process that stops when you close the terminal, and
it compiles `src` once at boot — a red bar appears when it is running code older
than what is on disk. Restart it after a change.

For something that stays up, run it under a process manager and restart it on
deploy. Do not run it under a file watcher that restarts mid-job: an
interrupted run has already spent its money.

---

## What is NOT solved by any of this

- **No read-only role.** Everybody who signs in can publish.
- **The runs live on this machine.** 1.1 GB of audio on local disk; the studio
  serves it from there, so it only works while this machine is on.
- **Releasing only runs while the studio does.** `foundry release` under Task
  Scheduler is the answer for publishing whether or not the laptop is awake.
