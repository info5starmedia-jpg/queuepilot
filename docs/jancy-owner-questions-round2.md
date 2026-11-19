# QueuePilot × Jancy: round 2 (explanations + a few follow-ups)

Your round-1 answers are recorded in `docs/parity-jancy-2026-11-19.md` §8.
This file explains the questions you weren't sure about, and asks the few
things we still need. Fill in the **Answer:** lines and send it back.

---

## Part A: explanations (no answer needed unless you disagree)

### A1. Tab model (your Q1)

**The difference:**

- **Jancy:** one browser with many tabs. You can switch which profile
  and proxy a tab uses while it's open.
- **QueuePilot:** each profile is its own browser, with its own
  fingerprint (screen, GPU, fonts …), its own saved data folder and its
  own proxy. Tabs live inside that profile's browser.

**Our recommendation:** keep it that way. It's also what you said you
want: a profile you create stays, with its cookies and logins, until you
delete it.

| | Keep profile = identity (recommended) | Jancy-style swapping |
| --- | --- | --- |
| Account safety | One account always shows the same device + IP. Sites see a consistent person | Swapping profile/proxy inside one browser can leak the old fingerprint or cookies to the new account, which links accounts |
| Your data | Each profile keeps its cookies/logins until you delete it | Sessions are tied to tabs and partitions, so they're easier to lose |
| Proof | QP records exactly which fingerprint + IP each launch used, so you can audit after a ban | Hard to tell what a tab was presenting |
| Cost | Each profile is its own browser, so it uses more RAM with many profiles open | Lighter: many tabs in one browser |
| "Basic tab" (no profile) | A **throwaway profile**, used **only when you ask for one**, deleted when closed. Your normal profiles are never throwaway | Built in |

**What changes for you:**

- "Set profile on this tab" becomes "open profile X".
- "Change proxy on this tab" becomes "rotate proxy and relaunch".
- Everything else (passcodes, notes, priority, queue position,
  autofill) works per tab, as in Jancy.

### A2. Autofill (your Q10)

**There is plenty to build on:**

1. Jancy publishes the exact `autofill.map` file format.
2. The Jancy wiki has 56 ready-made maps (Etix, MLB, TM sign-in /
   registration / checkout / OTP, AXS checkout, SeatGeek payment …). We
   use them as test fixtures, and **once we support the format you can
   paste them in as-is**.
3. QueuePilot already fills address + card fields and types like a human
   (WPM).

What's missing is the map *file* that tells it "on this site, this box
gets this field". Building it is J4; you don't need to provide anything.

### A3. Cookie thinger vs your cookie warmer (your Q11)

They are different tools:

- **Cookie warmer** (yours, and QP's existing "warmup" feature): visits
  sites with a profile so it builds natural browsing history and cookies
  before it's used.
- **Cookie thinger** (Jancy): a small text file of instructions for
  **moving or deleting specific cookies between open tabs**. Examples:
  - "delete the `_GRECAPTCHA` cookie on ticketmaster in all selected tabs"
  - "copy the login cookies from tab 1 into tabs 2–20"

  It's mostly used to clone a session across tabs or clear a bad cookie
  quickly.

We'll build the cookie thinger (J5) **and** import your warmer (see B4).

### A4. Format strings / custom sort / key binds (your Q13)

- **Format strings:** a small template that decides what a tab's title
  shows. For example:
  - `profile email – queue position`
  - `event – artist`
  - the 2FA code
- **Custom sort:** a rule for ordering the Tab View, e.g. lowest queue
  position on top, or by profile rank.
- **Key binds:** keyboard shortcuts, e.g. Ctrl+Q = "clear cookies + hard
  reload selected tabs".

You don't need to write any of these. **We'll ship the Jancy wiki's
recipes as ready-made presets** you can pick from a list:

- email in title
- queue position in title
- event/venue/artist in title
- codes in title
- sort by queue position / profile rank / random
- standard Jancy shortcuts such as Ctrl+1…6 autofill

### A5. Saved sessions (your Q14)

- QueuePilot saves each profile's browser data under the profile's
  **internal ID**, not its name or email.
- So renaming a profile, or moving it to another group, **keeps** its
  cookies and logins.
- Nothing to decide; we keep it as is.

### A6. Jancy plug-ins (your Q18)

Some services publish their own **Jancy plug-in**: a small add-on that
teaches Jancy how to fetch a code, a password or proxies from them.
Example scenarios:

- An SMS provider not on our list ships a Jancy plug-in. With a
  "compatibility layer", you'd drop it into QueuePilot and it works.
  Without it, we'd write an adapter for that provider.
- A team tool that logs queue positions to their own server via a Jancy
  plug-in.

Since you don't use any today, we'll **park this** and write adapters
directly (J2). Tell us if you ever get handed a Jancy plug-in file.

### A7. Proxies from a link (your Q19)

**Already built** (v0.16, "rotation links"):

- you paste the provider's URL;
- every launch fetches a fresh `host:port:user:pass` from it;
- each launch gets its own IP, and QueuePilot records which IP was used.

This works with Bright Data, Oxylabs, Smartproxy-style endpoint links.

Jancy's "Proxy Resolver" is a different thing: a service that **looks up
the proxy assigned to a specific profile** through its API. We'll add it
later (J8) if a provider you use offers it.

---

## Part B: still needed from you

### B1. Sample messages (your Q6)

For each item, send **one recent real message**, redacted.

**How to send:**

- **Email:** open it in Gmail, then ⋮ → "Show original" → "Download
  original" (a `.eml` file).
- **SMS:** the exact text.
- **Redact** names, your email and phone, and account numbers. Keep the
  **code's position, the sender address, and the subject line exactly as
  they are**. A fake code like 123456 in place of the real one is fine.

| # | Site | Message |
| --- | --- | --- |
| 1 | Ticketmaster US | Sign-in verification code email |
| 2 | Ticketmaster US | Password-reset code email |
| 3 | Ticketmaster US | 2FA SMS |
| 4 | Ticketmaster UK | Sign-in code email (and password reset if different) |
| 5 | Ticketmaster MX | Sign-in code email + SMS |
| 6 | am.ticketmaster.com (Account Manager) | Code email |
| 7 | Live Nation | Code email |
| 8 | AXS | Code email + SMS |
| 9 | SeatGeek | Sign-in code email + SMS |
| 10 | Etix | Any verification email |
| 11 | MLB | Code email + SMS |
| 12 | Any TM code email **forwarded from Hotmail/Outlook into Gmail** | (forwarding changes the format) |
| 13 | One SMS each as delivered by your **Ejoin**, **Diafaan** and **SMSDeliverer** setups (if those forward SMS to email, send the email) | |
| 14 | Anything else you log into (presale sites, Seated, Laylo, AEG, Dice, Fever, Fanatics …) | One per site you care about |

**Answer** (which ones you can send, and when):

### B2. AYCD Inbox

1. Are your code emails **all** in AYCD Inbox, or do some only live in
   Gmail?
2. Do you use catch-all domains or forwarding (AYCD "Mail Task
   Templates")?
3. Is AYCD Inbox running on this PC while you work? Its API only answers
   while the desktop app is open. (Our AYCD connection currently reports
   "connection refused", so it was not running when we checked.)

**Answer:**

### B3. Discord

You want notifications + "cookie/with IP export" sent to Discord.

1. **Webhook or bot?**
   - A **webhook** URL (simplest: paste one URL, send-only) is our
     recommendation.
   - A **bot** is only needed if you want to type commands back from
     Discord.
2. **Which events?** Tick any:
   - queue passed
   - queue position captured
   - 2FA code resolved / failed
   - profile launched / crashed / proxy failed
   - checkout reached
   - daily summary
3. **Cookie/IP export:** what exactly should be sent, and when?
   - Proposal: on demand per profile (or per selected profiles), post a
     file with that profile's cookies (JSON or Netscape format) + its
     current exit IP + proxy name.
   - **⚠ Security:** cookies are logged-in sessions. Anyone who can read
     that channel can take over those accounts.
   - So we'd make it **opt-in, private channel only**, with an option to
     **encrypt** the file with a password you choose.

   OK?

**Answer:**

### B4. Your cookie warmer: found, no access needed

The desktop shortcuts point to `C:\multilogin\mlxwarmup\mlx-warmup`, the
"Warmup Console for Multilogin X".

**What it does:** a daemon, web UI, CLI and MCP server running
persona-driven browsing:

- arrives via a Google search
- accepts the cookie banner
- log-normal dwell (about 45 s)
- scroll bursts
- 1–3 same-site clicks
- filters out login/cart pages
- batches of 5 spread over days

It drives profiles over CDP.

**Plan:** bring its **browsing engine and persona JSON files** into
QueuePilot's warmups, so it can warm QueuePilot profiles directly. The
existing record/replay recipes stay as a second mode. The Multilogin
launcher part is replaced by QueuePilot's own start/stop. Your existing
console keeps working for Multilogin.

1. Keep the Multilogin version running separately (yes/no)?
2. Are the cloud-phone (adb) warmups needed in QueuePilot too, or
   browsers only?

**Answer:**

### B5. arc2 profile provider

You load profiles from arc2. Do you have its API docs or a login/API key
we can test with? What does arc2 give you (profiles only, or cards and
passwords too)?

**Answer:**

### B6. Confirm the tab model (A1)

After reading A1:

- **yes**: keep profile = identity, throwaway profiles only on request.
- **no**: say what worries you.

**Answer:**
