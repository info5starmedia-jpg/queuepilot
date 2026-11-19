# QueuePilot × Jancy parity: questions for the owner

Fill in each **Answer:** line, then send the file back. Short answers are
fine; "skip" or "not sure" is fine too.

Full context for every question is in `docs/parity-jancy-2026-11-19.md`
(section 7).

---

### 1. Tab model
Keep each profile as its own identity (one browser per profile), with
throwaway profiles standing in for Jancy's "basic tabs", and no swapping
profile or proxy on a live tab? (yes / no / discuss)

**Answer:**
i am not sure i understand  this question, but i know if i create a profile i want to keep it cause its important untill i delete it. you can also disscuss thismore with me of the pros and cons and why we may need it or not etc

### 2. Existing `.jyl` parser files
Do you have Jancy parser `.jyl` files to drop in? Roughly how many, and
for which sites?

**Answer:**
no i dont

### 3. Email transport
Do your code mailboxes use Google Workspace (Gmail API), IMAP app
passwords, or both? Which mail providers (Gmail, Outlook/Hotmail, Yahoo,
other)?

**Answer:**
we use gmail and aycd 

### 4. SMS services
Which do you use, in priority order?
TextChest (simple or 512-line async), SeatHeroes, SMSGateway/TelTik,
TextTrove, QuickText, Wired, or Ejoin / Diafaan / SMSDeliverer forwarding
to email.

**Answer:**
yes we use all above

### 5. Password services
Automatiq, 1Ticket, Lysted, TicketSuite, Victory Live, or only fixed `$`
passwords?

**Answer:**
yes we use all above including ticketmaster, axs mlb 

### 6. Sample messages
For sites with no `.jyl` file, can you send one redacted raw email (Gmail
"Show original") or SMS text per site?

**Answer:**
you will let me know what examples you need so i can provide

### 7. Sites in priority order
TM US / UK / MX, Live Nation, AXS, SeatGeek, Etix, FIFA, MLB, others?

**Answer:**
we need all above but dont include fifa

### 8. Queue-position logging
Needed? Output to CSV, Google Sheet, or both? Extra columns (username,
group, profile name)?

**Answer:**yes we need all above. 

### 9. Ticketmaster page actions
Which do you want: dismiss overlay, auto no-insurance, auto terms, phrase
search, beep when queue is passed, cart timer in the tab subtitle?

**Answer:** yes all above we need, 

### 10. Autofill
Which sites or pages first? Do you have an existing Jancy `autofill.map`
to import?

**Answer:**

im not sure this is a big step and i dont know if we have sample code to build on

### 11. Cookie thinger
Do you use it today? Do you have a `cookie-thinger.txt` to import?

**Answer:**

i am not sure what really is a cookie thinger if its the warm up  feature but i also build a cookie warmer i will like to import. the link is https://github.com/info5starmedia-jpg/Randomz i know there is alot of other stuff in there but i did create a uniqie warmer for browser profiles. 

### 12. Settings you actually use
Examples: start with proxies enabled, images on/off, audio muted,
multi-tab delay + focus first, random/next profile, auto-reload options.
Anything else critical? (Full list: report section 2.9.)

**Answer:**
yes so far all the option for this question i like and want

### 13. Format strings / custom sort / key binds
Do you rely on any? If yes, paste them below. They become presets.

**Answer:**
not sure how to answer this i may need more advice and explantion

### 14. Saved sessions
Should saved sessions follow the email address (survives profile
renames), or is group + profile name fine?

**Answer:**
yes we all save sessions profile should be fine. you may also need to advise me more on this as i do not know how to answer

### 15. Mail libraries
OK to add the `imapflow` and `mailparser` libraries, so `.jyl` IMAP
searches behave exactly as in Jancy? (yes / no)

**Answer:**
yes we can follow jancy flow seeing it works

### 16. Out of scope
Confirm these stay out: Namath purchase capture/coordination,
Slack/Discord notifications, broker plug-ins (Vivid Seats, StubHub,
Lysted listing, DTI, Events for Purchase), Ticketcount inventory.

**Answer:**
so i only want the discord notificatons and cookie/with ip export sent to discord

### 17. Build order
Start with J1 (2FA codes working end to end), or bring J6
(Queue-it / Ticketmaster add-ons) forward?

**Answer:**
sure 

### 18. Third-party Jancy plug-ins
Do you run any (provider-supplied resolvers, proxy providers,
queue-position sinks) you'd want working unchanged? Which?

**Answer:**

not sure how to answer this question i may need to be advised and give senarios this could be helpful

### 19. Proxy Resolver
Does any provider give you per-profile proxies through an API? Which one?

**Answer:**i also dont know how to answer this question i will need to be advised on  this and how it works. but i did see a feature webshat and other have where you submit a url link and the app pull proxies and triffice from it so each task has unique ip

### 20. Profile source
Do your profiles come from CSV files, Google Sheets, or the arc2 profile
provider?

**Answer:**
all of the above

